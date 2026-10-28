// Устойчивость к повреждённому и чужому входу: проверки сверх стресс-тестов test/stress (npm run test:stress).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import YAML from 'yaml';
import { loadRegistry } from '../src/config/loader.js';
import { condMatches, yamlSnippet } from '../src/stubs/engine.js';
import { ResultsStore } from '../src/results/store.js';
import { RECORD_FORMAT } from '../src/results/format.js';
import { runListItem } from '../src/api/views.js';
import { loadEnv } from '../src/env.js';
import { parseReply } from '../src/agent/client.js';
import { redactSecrets } from '../src/runner/inputs.js';
import { CONFIG, startStand } from './helpers.js';

/** Копия штатных справочников: root/config — каталог справочников, рядом в root — «чужие» файлы. */
function tempConfig(t: TestContext): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-robust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'config');
  fs.cpSync(CONFIG, dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.json'), JSON.stringify({ canary: 'outside-config' }));
  return { root, dir };
}

const edit = (file: string, fn: (text: string) => string) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));

test('справочники: шаблоны тела агента и стартового сообщения читаются только из каталога справочников', async (t) => {
  const { dir } = tempConfig(t);
  edit(path.join(dir, 'agents/fake-agent.yaml'), (s) => s.replace(/^( {2}body:).*$/m, '$1 ../outside.json'));
  edit(path.join(dir, 'contracts/tools.json'), (s) => s.replace('"startMessage": "contracts/start-message.txt"', '"startMessage": "../outside.json"'));
  const reg = await loadRegistry(dir);
  const body = reg.issues.find((i) => i.file === 'agents/fake-agent.yaml' && i.field === 'request.body');
  assert.ok(body && body.severity === 'error' && /выходит за каталог справочников/.test(body.reason), JSON.stringify(body));
  assert.equal(body.line, 11, 'строка поля request.body');
  assert.equal(reg.agents.get('fake-agent')?.request.bodyFile, null, 'внешний файл не прочитан');
  const sm = reg.issues.find((i) => i.file === 'contracts/tools.json' && i.field === 'startMessage');
  assert.ok(sm && sm.severity === 'error', JSON.stringify(reg.issues.filter((i) => i.file === 'contracts/tools.json')));
  assert.equal(reg.contract?.startMessage.text, '', 'внешний файл не прочитан');
  assert.ok(!JSON.stringify(reg.agents.get('fake-agent')).includes('outside-config'));
});

test('справочники: ответ заглушки из data/ читается, путь за пределы data/ — ошибка с полем и строкой', async (t) => {
  const { dir } = tempConfig(t);
  fs.mkdirSync(path.join(dir, 'data/answers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/answers/ok.json'), JSON.stringify({ status: 'ok' }));
  fs.writeFileSync(
    path.join(dir, 'cases/files.yaml'),
    ['id: files', 'title: Files', 'topic: Topic', 'tools:', '  t:', '    - sequence:', '        - result: { file: answers/ok.json }', '        - result: { file: /etc/hosts }'].join('\n'),
  );
  const reg = await loadRegistry(dir);
  const c = reg.cases.get('files')!;
  assert.deepEqual(c.dataFiles.map((f) => f.file), ['data/answers/ok.json']);
  const issue = reg.issues.find((i) => i.file === 'cases/files.yaml' && i.severity === 'error');
  assert.equal(issue?.field, 'tools.t[0].sequence[1].result.file');
  assert.equal(issue?.line, 8);
  assert.match(issue!.reason, /выходит за каталог data\//);
});

test('справочники: служебное имя в ключе effect — ошибка с полем и строкой', async (t) => {
  const { dir } = tempConfig(t);
  fs.writeFileSync(
    path.join(dir, 'cases/effect.yaml'),
    ['id: effect', 'title: Effect', 'topic: Topic', 'tools:', '  t:', '    - result: { json: {} }', '      effect:', '        card.status: closed', '        __proto__.polluted: yes', '        constructor.prototype.x: 1'].join('\n'),
  );
  const reg = await loadRegistry(dir);
  const found = reg.issues.filter((i) => i.file === 'cases/effect.yaml' && i.severity === 'error').map((i) => [i.field, i.line, i.reason]);
  assert.deepEqual(found, [
    ['tools.t[0].effect.__proto__.polluted', 9, 'Имя «__proto__» недопустимо в пути effect'],
    ['tools.t[0].effect.constructor.prototype.x', 10, 'Имя «constructor» недопустимо в пути effect'],
  ]);
  assert.equal(({} as any).polluted, undefined);
});

test('условия заглушек: regex работает как раньше, долгий перебор прерывается и даёт «не выполнено»', () => {
  assert.equal(condMatches('OP-17', { regex: '^OP-' }), true);
  assert.equal(condMatches('XX-17', { regex: '^OP-' }), false);
  assert.equal(condMatches('CL-2', { in: [{ regex: '^CL-\\d$' }, 'other'] }), true, 'regex внутри in');
  assert.equal(condMatches('CL-2', { not: { regex: '^CL-' } }), false, 'regex внутри not');
  const t0 = Date.now();
  assert.equal(condMatches('a'.repeat(32) + '!', { regex: '^(a+)+$' }), false);
  assert.ok(Date.now() - t0 < 1000, `проверка заняла ${Date.now() - t0} мс`);
  assert.equal(condMatches('aaa', { regex: '^(a+)+$' }), true, 'после прерванной проверки выражения работают');
});

test('YAML-фрагмент ответа человека: разбор возвращает ровно введённый текст', () => {
  for (const text of ['', '\n', 'одна строка', 'в конце перевод\n', 'два перевода\n\n', '  ведущие пробелы\nи дальше', '\n\n  пустые строки в начале\n', '\tтаб', 'хвост  \nпробелы ', 'строка\r\nс возвратом каретки', 'нулевой \u0000 символ']) {
    const snippet = yamlSnippet('tool', { id: 1 }, { text });
    assert.equal(YAML.parse(snippet).tools.tool[0].result.text, text, JSON.stringify(text));
  }
  assert.match(yamlSnippet('tool', {}, { text: 'перевод\n' }), /text: \|\n/, 'обычный текст остаётся блоком');
  assert.match(yamlSnippet('tool', {}, { text: 'a\r\nb' }), /text: "a\\r\\nb"/, '\\r — строкой в кавычках');
});

test('записи var/: прежние форматы загружаются, повреждённые пропускаются с причиной, список не падает без подключения', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-robust-var-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  };
  const store = new ResultsStore(dir);
  await store.init();
  put('results/run-0001/run.json', { id: 1, settings: { skillset: 'build' }, lines: [{ index: 1, senderId: 'lab-1', items: [] }] });
  put('results/run-0002/run.json', { format: 1, id: 2, settings: {}, lines: [{ index: 1, senderId: 'lab-2', items: [] }] });
  put('results/run-0003/run.json', { format: RECORD_FORMAT, id: 3, settings: {}, snapshot: { files: [] }, lines: [{ items: [{ kind: 'case' }] }] });
  put('results/run-0004/run.json', { format: RECORD_FORMAT, id: 4, settings: {}, snapshot: { files: [] }, lines: [{ items: null, history: [] }] });
  put('sessions/m-0001.json', { id: 1, execution: null });
  put('sessions/m-0002.json', { format: RECORD_FORMAT, id: 2, history: null, senderId: 'lab-x' });
  put('operators.json', { format: RECORD_FORMAT, operators: { 'lab-1': 'не список' } });
  const skipped: string[] = [];
  const onSkip = (file: string, reason: string) => skipped.push(`${file}: ${reason}`);
  const runs = await store.loadRuns(onSkip);
  assert.deepEqual(runs.map((r) => r.id), [1, 2], 'форматы 0 и 1 приводятся к текущему виду и проходят проверку');
  assert.deepEqual((await store.loadSessions(onSkip)).map((s) => s.id), [1]);
  assert.equal(await store.loadOperators(onSkip), undefined);
  assert.deepEqual(skipped, [
    'results/run-0003/run.json: запись повреждена: нет поля «lines[0].history»',
    'results/run-0004/run.json: запись повреждена: «lines[0].items» — не массив',
    'sessions/m-0002.json: запись повреждена: нет поля «createdAt»; нет поля «case»',
    'operators.json: запись повреждена: «operators.lab-1» — не массив',
  ]);
  assert.equal(runListItem(runs[0]).agent.id, null, 'запись без подключения агента видна в списке');
});

test('API: имя журнала кейса с выходом из каталога прогона — 400, секрет request_ref не отдаётся', async () => {
  const s = await startStand();
  try {
    const { data } = await s.api('POST', '/api/runs', { config: 'demo-check' });
    const run = await s.waitRun(data.id);
    const name = run.lines[0].items.find((i: any) => i.kind === 'case').execName;
    assert.equal((await s.api('GET', `/api/runs/${run.id}/executions/${name}`)).status, 200);
    const secret = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'secret.json'), 'utf8')).secret;
    for (const p of [`/api/runs/${run.id}/executions/..%2F..%2F..%2Fsecret`, `/api/runs/${run.id}/executions/..%2Frun`, `/api/runs/${run.id}/executions/..%2F..%2F..%2Fsessions%2Fm-0001/http`]) {
      const r = await fetch(s.base + p);
      const text = await r.text();
      assert.equal(r.status, 400, `${p}: ${text}`);
      assert.ok(!text.includes(secret), p);
    }
  } finally {
    await s.close();
  }
});

test('окружение: числа — целые в своих границах, ноль сессий не подменяется единицей', () => {
  const env = (vars: Record<string, string>) => loadEnv(vars, '/tmp/robust-config-root');
  assert.throws(() => env({ MAX_PARALLEL_SESSIONS: '0' }), /MAX_PARALLEL_SESSIONS=«0»: нужно целое число не меньше 1/);
  assert.throws(() => env({ TURN_TIMEOUT_MS: '3000000000' }), /TURN_TIMEOUT_MS=«3000000000»: нужно целое число от 1 до 2147483647/, 'предел setTimeout');
  assert.throws(() => env({ MCP_PORT: '1e3' }), /MCP_PORT/);
  assert.throws(() => env({ AGENT_MCP_TIMEOUT_MS: '0' }), /AGENT_MCP_TIMEOUT_MS/);
  const ok = env({ PORT: '0', MCP_PORT: '', AGENT_BUSY_WAIT_MS: '0', OPERATOR_DECISION_MARGIN_MS: '0', MAX_PARALLEL_SESSIONS: ' 3 ' });
  assert.deepEqual([ok.port, ok.mcpPort, ok.agentBusyWaitMs, ok.operatorMarginMs, ok.maxParallelSessions], [0, null, 0, 0, 3]);
  assert.equal(env({}).turnTimeoutMs, 900_000, 'значение по умолчанию');
});

test('ответ агента: токены usage — неотрицательные целые, строка с числом принимается', async () => {
  const def = (await loadRegistry(CONFIG)).agents.get('fake-agent')!;
  const agent = { ...def, response: { ...def.response, usage: { inputPath: '$.input', outputPath: '$.output', totalPath: '$.total' } } };
  const reply = (usage: Record<string, unknown>) => parseReply(agent, { result: { task: { status: { message: { parts: [{ text: 'ok' }] } } } }, ...usage }).usage;
  assert.deepEqual(reply({ input: '120', output: 7, total: 0 }), { input: 120, output: 7, total: 0 });
  assert.deepEqual(reply({ input: 1.5, output: '1e3', total: ' 9 ' }), { input: null, output: null, total: 9 });
  assert.equal(reply({ input: -1, output: 'Infinity', total: null }), null, 'нет ни одного значения — «нет данных»');
});

test('снимок подключения: секрет скрыт на месте, остальной текст и штатные файлы не меняются', () => {
  for (const dir of ['agents', 'models', 'templates']) {
    for (const f of fs.readdirSync(path.join(CONFIG, dir))) {
      const text = fs.readFileSync(path.join(CONFIG, dir, f), 'utf8');
      assert.equal(redactSecrets(text), text, `${dir}/${f}: секретов нет — текст и SHA-256 прежние`);
    }
  }
  const yaml = [
    'apiKey: sk-live-123  # ключ шлюза',
    'url: http://user:pa55@gw.local/a2a?token=abc&q=1',
    'headers:',
    '  X-Request-Source: clawgym',
    '  Authorization: Bearer ${env:GW_TOKEN}',
    'params: { maxTokens: 4000, temperature: 0.2 }',
    'tls: { passphrase: hunter2 }',
    '',
  ].join('\n');
  assert.equal(
    redactSecrets(yaml),
    [
      'apiKey: "***"  # ключ шлюза',
      'url: "http://user:***@gw.local/a2a?token=***&q=1"',
      'headers:',
      '  X-Request-Source: clawgym',
      '  Authorization: Bearer ${env:GW_TOKEN}',
      'params: { maxTokens: 4000, temperature: 0.2 }',
      'tls: { passphrase: "***" }',
      '',
    ].join('\n'),
  );
  const json = JSON.stringify({ headers: { 'X-Api-Key': 'k-1', Accept: 'application/json' }, auth: { token: 'nested-secret' } }, null, 2);
  const hidden = redactSecrets(json);
  assert.deepEqual(JSON.parse(hidden), { headers: { 'X-Api-Key': '***', Accept: 'application/json' }, auth: { token: '***' } });
  assert.match(redactSecrets('key: [unclosed'), /^# Содержимое скрыто/, 'неразобранный файл не попадает в снимок');
});

test('HTTP API: неразборный адрес, номер не цифрами и тело не объектом — 400 с причиной', async () => {
  const s = await startStand();
  // node:http отправляет путь как есть: fetch нормализовал бы «//» и %-последовательности.
  const send = (method: string, p: string, body?: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(s.base, { method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body);
    });
  try {
    for (const p of ['//', '/api/runs/0x1', '/api/runs/1e0', '/api/runs/-1', '/api/compare?a=x&b=1', '/api/run-configs/demo-check-trained/preview?continueFrom=yes']) {
      const r = await send('GET', p);
      assert.equal(r.status, 400, `${p}: ${r.status} ${r.text}`);
      assert.ok(JSON.parse(r.text).error, `${p}: причина в ответе`);
    }
    const arr = await send('POST', '/api/runs', '[{"config":"demo-check"}]');
    assert.deepEqual([arr.status, JSON.parse(arr.text).error], [400, 'Тело запроса — не JSON-объект']);
    assert.equal((await send('GET', '/health')).status, 200);
  } finally {
    await s.close();
  }
});
