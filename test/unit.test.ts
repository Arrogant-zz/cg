// Модульные тесты: заглушки, шаблоны, JSONPath, строки результата команд, план команд, проверка ссылок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StubState, matchStub, renderResponse, condMatches } from '../src/stubs/engine.js';
import type { BasketDef, StubDef } from '../src/config/types.js';
import { renderLines, renderValue } from '../src/util/template.js';
import { queryPath, setPath } from '../src/util/jsonpath.js';
import { parseCapture, parseCurator } from '../src/agent/commands.js';
import { buildPlan } from '../src/runner/plan.js';
import { loadRegistry } from '../src/config/loader.js';
import { resolveRun } from '../src/runner/resolve.js';
import { loadEnv } from '../src/env.js';
import { ResultsStore } from '../src/results/store.js';
import { RECORD_FORMAT } from '../src/results/format.js';
import { operatorLabel } from '../src/results/compare.js';
import { TestOperators, stepLabel } from '../src/runner/operators.js';
import { StandLog } from '../src/mcp/server.js';
import { settleWrites } from '../src/util/fsx.js';
import { checkAllowedHost } from '../src/agent/client.js';
import { CONFIG, REPO } from './helpers.js';
import { BODY_LIMIT, clip, maskedHeaders, startExchange } from '../src/util/httplog.js';
import { maskHeaders } from '../src/util/core.js';
import YAML from 'yaml';
import { buildPlan as agentPlan, rulesOf } from '../dev/fake-agent/agent.js';
import { cases as casesView } from '../src/api/views.js';

const stub = (s: Partial<StubDef>, index: number): StubDef => ({ id: `s${index}`, tool: 't', origin: 'case', index, ...s });

test('заглушка: побеждает более точное условие, при равенстве — первая', () => {
  const list = [stub({ result: { json: 1 } }, 0), stub({ when: { card: '1' }, result: { json: 2 } }, 1), stub({ when: { card: '1', kind: { regex: '^v' } }, result: { json: 3 } }, 2)];
  assert.equal(matchStub(list, undefined, { card: '1', kind: 'visa' })?.stub.id, 's2');
  assert.equal(matchStub(list, undefined, { card: '1', kind: 'mir' })?.stub.id, 's1');
  assert.equal(matchStub(list, undefined, { card: '2' })?.stub.id, 's0');
  assert.equal(matchStub([], [stub({ result: { text: 'd' } }, 0)], {})?.stub.id, 's0', 'затем умолчания контракта');
  assert.equal(matchStub([stub({ when: { a: 1 }, result: { text: 'x' } }, 0)], undefined, { a: 2 }), null);
  assert.ok(condMatches(5, '5'), 'скаляры сравниваются как строки');
  assert.ok(condMatches('b', { in: ['a', 'b'] }));
  assert.ok(condMatches(undefined, { exists: false }));
});

test('заглушка: последовательность, эффект и состояние выполнения', () => {
  const s = stub({ sequence: [{ result: { json: { status: '{{state.card}}' } }, effect: { card: 'active' } }, { error: 'already_active' }] }, 0);
  const st = new StubState({ card: 'blocked' });
  const ctx = () => ({ state: st.state, args: {} });
  const r1 = renderResponse(st.next(s).response, ctx(), st);
  assert.deepEqual(r1.value, { status: 'blocked' });
  assert.equal(st.state.card, 'active');
  const r2 = renderResponse(st.next(s).response, ctx(), st);
  assert.equal(r2.isError, true);
  const r3 = renderResponse(st.next(s).response, ctx(), st);
  assert.equal(r3.isError, true, 'последний ответ повторяется');
  const other = new StubState({ card: 'blocked' });
  assert.equal(other.state.card, 'blocked', 'состояние одного выполнения не влияет на другое');
});

test('шаблоны: тип значения сохраняется, пустые строки стартового сообщения выпадают', () => {
  assert.equal(renderValue('{{args.n}}', { args: { n: 7 } }), 7);
  assert.equal(renderValue('n={{args.n}}', { args: { n: 7 } }), 'n=7');
  assert.equal(renderLines('Тематика: {{case.topic}}\nКарта: {{start.card}}', { case: { topic: 'Карты' }, start: {} }), 'Тематика: Карты');
});

test('JSONPath: чтение с [*] и запись по пути', () => {
  const o = { result: { parts: [{ text: 'a' }, { text: 'b' }] } };
  assert.deepEqual(queryPath(o, '$.result.parts[*].text'), ['a', 'b']);
  const b: any = {};
  setPath(b, '$.params.metadata.model', 'x');
  assert.equal(b.params.metadata.model, 'x');
});

test('строки результата capture и curator ищутся по всему ответу с обёртками', () => {
  const c = parseCapture('Сохраняю.\n`Case captured: learning/cases/pending/a.md — signal: strong`\nГотово');
  assert.deepEqual([c.kind, (c as any).path, (c as any).signal], ['captured', 'learning/cases/pending/a.md', 'strong']);
  assert.equal(parseCapture('«Case capture skipped: нет обращения»').kind, 'skipped');
  assert.equal(parseCapture('Case capture failed: pii').kind, 'failed');
  assert.equal(parseCapture('Готово').kind, 'unrecognized');
  const u = parseCurator('**Curator complete: 3 processed, ? left, 1 updated, 0 routing fixes, 2 created, 0 conflicts. Report: r.md**');
  assert.equal(u.kind, 'complete');
  assert.equal((u as any).left, null);
  assert.equal(parseCurator('No pending cases.').kind, 'empty');
});

test('план команд: curator каждые 2 и финальный проход неполной пачки; в проверке curator нет', () => {
  const items = [1, 2, 3, 4, 5].map((i) => ({ kind: 'solution' as const, index: i - 1, solution: `s${i}`, limits: {}, note: '' }));
  const b: BasketDef = { id: 'b', title: 'b', type: 'training', description: '', curator: { enabled: true, every: 2, final: true, resetBefore: true }, checking: { confirmations: 'approve' }, items, source: { file: 'b', hash: '', text: '' } };
  const passes = buildPlan(b).filter((s) => s.kind === 'curator') as any[];
  assert.deepEqual(passes.map((p) => [p.afterPos, p.reason]), [
    [2, 'every'],
    [4, 'every'],
    [5, 'final'],
  ]);
  const plan = buildPlan({ ...b, type: 'checking', curator: { ...b.curator, enabled: false } });
  assert.ok(plan.every((s) => s.kind === 'case' && !s.capture));
});

test('белый список хостов агента', () => {
  assert.equal(checkAllowedHost('http://127.0.0.1:8091/a', ['127.0.0.1']), null);
  assert.match(checkAllowedHost('https://prod.bank/a', ['stand.local']) ?? '', /не входит/);
  assert.equal(checkAllowedHost('https://a.stand.local/x', ['.stand.local']), null);
});

test('каталоги: справочники CLAWGYM_CONFIG и данные CLAWGYM_VAR независимы; старые переменные и вложенность — ошибка', () => {
  const def = loadEnv({}, '/srv/gym');
  assert.deepEqual([def.configDir, def.varDir, def.webDir], ['/srv/gym/config', '/srv/gym/var', '/srv/gym/web']);
  const set = loadEnv({ CLAWGYM_CONFIG: '/mnt/config', CLAWGYM_VAR: 'state' }, '/srv/gym');
  assert.deepEqual([set.configDir, set.varDir], ['/mnt/config', '/srv/gym/state'], 'относительный путь — от рабочего каталога');
  assert.equal(loadEnv({ CLAWGYM_VAR: 'config-var' }, '/srv/gym').varDir, '/srv/gym/config-var', 'общий префикс имени — не вложенность');
  assert.throws(() => loadEnv({ CLAWGYM_HOME: '/srv/gym' }, '/srv/gym'), /CLAWGYM_HOME больше не используется/);
  assert.throws(() => loadEnv({ CLAWGYM_DATA: '/srv/var' }, '/srv/gym'), /CLAWGYM_DATA больше не используется/);
  assert.throws(() => loadEnv({ CLAWGYM_HOME: '.', CLAWGYM_DATA: 'var' }, '/srv/gym'), /CLAWGYM_HOME, CLAWGYM_DATA больше не используются/);
  assert.throws(() => loadEnv({ CLAWGYM_VAR: 'config/var' }, '/srv/gym'), /не должны совпадать или лежать один в другом/);
  assert.throws(() => loadEnv({ CLAWGYM_CONFIG: '/data', CLAWGYM_VAR: '/data' }, '/srv/gym'), /не должны совпадать/);
});

test('номера прогонов и сессий: одновременные запросы получают разные номера, общий счётчик не теряет приращений', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-counters-'));
  try {
    const store = new ResultsStore(dir);
    await store.init();
    const runs = Promise.all([1, 2, 3, 4].map(() => store.nextNumber('run')));
    const sessions = Promise.all([1, 2, 3].map(() => store.nextNumber('session')));
    assert.deepEqual(await runs, [1, 2, 3, 4]);
    assert.deepEqual(await sessions, [1, 2, 3]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'counters.json'), 'utf8')), { run: 4, session: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('формат записей: сохранение ставит версию, старые записи приводятся к текущему виду, более новые и повреждённые пропускаются с причиной', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-format-'));
  const write = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof data === 'string' ? data : JSON.stringify(data));
  };
  try {
    const store = new ResultsStore(dir);
    await store.init();
    // Формат 0, до 27.10.2026: набор скиллов вместо тестового оператора, без истории оператора и метрик аналитика.
    write('results/run-0001/run.json', { id: 1, settings: { skillset: { title: 'Карты', version: 'V2' } }, lines: [{ index: 1, senderId: 'lab-1', items: [{ kind: 'case', execName: 'L1-P01' }] }] });
    write('results/run-0001/executions/L1-P01.json', { id: 'run1-L1-P01', events: [{ seq: 1, type: 'skills', text: 'установлен набор V2' }] });
    write('results/run-0002/run.json', { format: RECORD_FORMAT + 1, id: 2, settings: {}, lines: [] });
    write('results/run-0003/run.json', '{ оборван');
    // Формат 1, 28.10.2026: снимок без полных хешей и настроек окружения, в истории оператора только прогоны.
    write('results/run-0004/run.json', {
      format: 1,
      id: 4,
      settings: { testOperator: { mode: 'continue', run: 1 } },
      snapshot: { createdAt: '2026-10-28T09:00:00.000Z', files: [{ file: 'contracts/tools.json', hash: 'a91c' }] },
      lines: [{ index: 1, senderId: 'lab-1', history: [{ run: 1, title: 'Проверка', type: 'checking', line: 1 }], items: [] }],
    });
    write('sessions/m-0001.json', { id: 1, execution: { events: [{ seq: 1, type: 'skills', text: 'установлен набор V2' }] } });
    const skipped: string[] = [];
    const runs = await store.loadRuns((file, reason) => skipped.push(`${file}: ${reason}`));
    assert.deepEqual(runs.map((r) => r.id), [1, 4]);
    const [old, v1] = runs;
    assert.deepEqual(old.settings.testOperator, { mode: 'new' });
    assert.equal(operatorLabel(old), 'набор Карты V2');
    assert.deepEqual(old.lines[0].history, []);
    assert.equal(old.lines[0].items[0].scores, null);
    assert.equal(old.snapshot.settings, null);
    assert.ok(!('format' in old), 'версия — только в файле');
    assert.deepEqual(v1.snapshot, { createdAt: '2026-10-28T09:00:00.000Z', files: [{ file: 'contracts/tools.json', hash: 'a91c', group: null, sha256: null }], settings: null });
    assert.equal(operatorLabel(v1), 'после #1 проверка', 'шаг истории — прогон');
    assert.equal(skipped.length, 2, skipped.join('\n'));
    assert.ok(skipped[0].startsWith(`results/run-0002/run.json: формат ${RECORD_FORMAT + 1} новее поддерживаемого ${RECORD_FORMAT}`), skipped[0]);
    assert.ok(skipped[1].startsWith('results/run-0003/run.json: файл не читается'), skipped[1]);
    assert.equal((await store.loadExecution(1, 'L1-P01'))!.events[0].type, 'note', 'событие skills — заметка');
    const [session] = await store.loadSessions();
    assert.equal(session.execution!.events[0].type, 'note');
    assert.equal(session.history, null, 'история оператора до сессии неизвестна');
    // Сохранение ставит текущую версию первым полем; повторная загрузка даёт ту же запись.
    await store.saveRun(old);
    assert.match(fs.readFileSync(path.join(dir, 'results/run-0001/run.json'), 'utf8'), new RegExp(`^\\{\\s*"format": ${RECORD_FORMAT},`));
    assert.deepEqual((await store.loadRuns())[0], old);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('условия заглушек: regex проверяется при загрузке с флагом u, как при вызове; ошибка — с полем и строкой, прогон не запускается', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-regex-'));
  try {
    fs.cpSync(CONFIG, dir, { recursive: true });
    const file = path.join(dir, 'cases/spasibo-bonus-missing.yaml');
    const stubs = [
      'tools:',
      '  get_client_cards:',
      // [\w-.] допустимо в обычном JavaScript, но не с флагом u.
      "    - when: { clientId: { regex: '[\\w-.]+' } }",
      '      result: { json: { cards: [] } }',
      "    - when: { clientId: { in: [{ regex: '(' }, CL-1] } }",
      '      result: { json: { cards: [] } }',
      // Не оператор: у объекта есть и другие ключи — regex здесь обычное поле аргумента, выражение не компилируется.
      "    - when: { filter: { regex: '(', status: open } }",
      '      result: { json: { cards: [] } }',
      "    - when: { clientId: { regex: '^CL-\\d+$' } }",
      '      result: { json: { cards: [] } }',
    ].join('\n');
    // Функция, а не строка замены: в строке «$'» из выражения стало бы шаблоном replace.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^tools:$/m, () => stubs));
    const lineOf = (needle: string) => fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(needle)) + 1;
    const reg = await loadRegistry(dir);
    const found = reg.issues.filter((i) => i.file === 'cases/spasibo-bonus-missing.yaml' && i.reason.startsWith('Регулярное выражение не компилируется'));
    assert.deepEqual(
      found.map((i) => [i.severity, i.field, i.line]),
      [
        ['error', 'tools.get_client_cards[0].when.clientId.regex', lineOf("'[\\w-.]+'")],
        ['error', 'tools.get_client_cards[1].when.clientId.in[0].regex', lineOf("regex: '(' }, CL-1")],
      ],
    );
    assert.ok(reg.cases.has('spasibo-bonus-missing'), 'кейс загружен, ошибка видна у файла');
    const p = resolveRun(reg, loadEnv({ CLAWGYM_CONFIG: dir }, REPO), 'demo-check');
    assert.equal(p.ok, false, 'прогон с этим кейсом не запускается');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('битая ссылка в корзине: ошибка с файлом и полем, прогон не запускается', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-cfg-'));
  for (const d of ['contracts', 'cases', 'solutions', 'agents', 'models', 'metrics', 'templates']) {
    fs.cpSync(path.join(CONFIG, d), path.join(home, d), { recursive: true });
  }
  fs.mkdirSync(path.join(home, 'baskets'));
  fs.mkdirSync(path.join(home, 'runs'));
  fs.writeFileSync(path.join(home, 'baskets/broken.yaml'), 'id: broken\ntitle: Битая\ntype: training\nitems:\n  - solution: spasibo-bonus-missing/explain-now\n  - solution: transfer-delay/explain-on-ask\n');
  fs.writeFileSync(path.join(home, 'runs/broken.yaml'), 'id: broken\nbasket: broken\nagent: fake-agent\nmodels: { operator: fake-operator, judge: fake-judge }\n');
  try {
    const reg = await loadRegistry(home);
    const issue = reg.issues.find((i) => i.file === 'baskets/broken.yaml' && i.severity === 'error');
    assert.ok(issue);
    assert.equal(issue!.field, 'items[1].solution');
    assert.match(issue!.reason, /transfer-delay\/explain-on-ask/);
    const p = resolveRun(reg, loadEnv({ CLAWGYM_CONFIG: home }, REPO), 'broken');
    assert.equal(p.ok, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('журнал HTTP: авторизация скрыта, большое тело обрезается', () => {
  const h = maskedHeaders({ Authorization: 'Bearer secret-token-123', 'x-task-id': 'cg-1', 'Set-Cookie': 'sid=abcdef123456', 'X-Gateway-Token': 'gw-secret-777', 'X-Gateway-Key': 'gw-key-888888', 'Mcp-Session-Id': 'abc-session-42' });
  assert.equal(h['x-task-id'], 'cg-1');
  assert.equal(h['mcp-session-id'], 'abc-session-42');
  assert.ok(!h.authorization.includes('secret-token-123'));
  assert.ok(!h['set-cookie'].includes('abcdef123456'));
  assert.ok(!h['x-gateway-token'].includes('gw-secret-777') && !h['x-gateway-key'].includes('gw-key-888888'));
  // Значение из окружения скрывается при любом имени заголовка.
  assert.ok(!maskHeaders({ 'X-Tenant': 'tenant-from-env-1' }, ['X-Tenant'])['X-Tenant'].includes('tenant-from-env-1'));
  const x = startExchange('agent', 't', { method: 'POST', url: 'https://user:pa55word@stand.local/a2a?api_key=k-123456789&lang=ru', headers: {}, body: '{}' });
  assert.ok(!x.request.url.includes('pa55word') && !x.request.url.includes('k-123456789') && x.request.url.includes('lang=ru'));
  assert.equal(startExchange('mcp', 't', { method: 'POST', url: '/mcp', headers: {}, body: '' }).request.url, '/mcp');
  // Срок обмена — таймаут запроса от начала; без таймаута срока нет.
  const timed = startExchange('agent', 't', { method: 'POST', url: '/a2a', headers: {}, body: '{}' }, {}, 1500);
  assert.equal(Date.parse(timed.deadline!) - Date.parse(timed.startedAt), 1500);
  assert.equal(x.deadline, null);
  for (const ch of ['я', '€', '😀']) {
    const big = clip(ch.repeat(BODY_LIMIT));
    assert.equal(big.truncated, true);
    assert.ok(Buffer.byteLength(big.body) <= BODY_LIMIT && !big.body.endsWith('\uFFFD'));
  }
  assert.equal(clip('{}').truncated, false);
});

test('fake-agent: запрет «экспертизу не выставлять» из поправки убирает ветку экспертизы, история операций остаётся', () => {
  const skill = fs.readFileSync(path.join(REPO, 'dev/fake-agent/build/skills/learned/card-hold/SKILL.md'), 'utf8');
  const lines = skill.split('\n').filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s+/, ''));
  const steps = (text: string) => agentPlan(rulesOf(text)).map((x) => (x.kind === 'call' ? x.tool : 'answer'));
  assert.deepEqual(steps(lines.join('\n')), ['get_stages_expertise', 'get_card_history', 'create_expertise', 'postpone_expertises'], 'V1 ведёт блокировку суммы как спорную операцию');
  const lesson = YAML.parse(fs.readFileSync(path.join(CONFIG, 'cases/card-hold-amount.yaml'), 'utf8')).reference.lessons[0].rule;
  assert.deepEqual(steps([...lines, lesson].join('\n')), ['get_card_history', 'answer', 'get_close_with_answer'], 'после урока — ответ и закрытие');
});

test('продолжение на тестовом операторе: последний завершённый прогон настройки, тот же агент, свободный оператор, история', async () => {
  const reg = await loadRegistry(CONFIG);
  const env = loadEnv({}, REPO);
  const checking = { kind: 'run', run: 1, title: 'Проверка', type: 'checking', line: 1 };
  const run = (id: number, over: Record<string, unknown> = {}) =>
    ({
      id,
      configId: 'demo-train',
      title: 'Обучение',
      type: 'training',
      status: 'completed',
      settings: { agent: { id: 'fake-agent' } },
      lines: [{ index: 1, senderId: `s-${id}`, startedAt: `2026-10-28T10:0${id}:00.000Z`, history: [checking] }],
      ...over,
    }) as any;
  const errors = (p: ReturnType<typeof resolveRun>) => p.issues.filter((i) => i.severity === 'error').map((i) => i.reason);
  assert.match(errors(resolveRun(reg, env, 'demo-check-trained', {}, []))[0], /Нет завершённого прогона «demo-train»/);
  // Берётся последний завершённый прогон настройки; история оператора дополняется этим прогоном.
  const ok = resolveRun(reg, env, 'demo-check-trained', {}, [run(2), run(3), run(4, { status: 'failed' })]);
  assert.equal(ok.ok, true, JSON.stringify(errors(ok)));
  const op = ok.resolved!.operator;
  assert.equal(op.mode, 'continue');
  if (op.mode === 'continue') {
    assert.equal(op.source.id, 3);
    assert.deepEqual(op.lines, [{ senderId: 's-3', history: [checking, { kind: 'run', run: 3, title: 'Обучение', type: 'training', line: 1 }] }]);
  }
  assert.equal(resolveRun(reg, env, 'demo-check-trained', { continueFrom: 'new' }, [run(3)]).resolved!.operator.mode, 'new', 'при запуске можно выбрать нового');
  assert.match(errors(resolveRun(reg, env, 'demo-check', { continueFrom: 5 }, [run(5, { settings: { agent: { id: 'aef-claw' } } })]))[0], /работал с агентом «aef-claw»/);
  assert.match(errors(resolveRun(reg, env, 'demo-check', { continueFrom: 6 }, [run(6, { status: 'running' })]))[0], /не завершён/);
  const busy = resolveRun(reg, env, 'demo-check', { continueFrom: 7 }, [run(7), run(8, { status: 'queued', lines: [{ index: 1, senderId: 's-7', history: [] }] })]);
  assert.match(errors(busy)[0], /занят прогоном #8/);

  // Продолжение от старого прогона: после него оператор прошёл обучение #8 — история и скиллы текущие, отката нет (ревью 28.10.2026).
  const later = resolveRun(reg, env, 'demo-check', { continueFrom: 7 }, [
    run(7),
    run(8, { lines: [{ index: 1, senderId: 's-7', startedAt: '2026-10-28T10:09:00.000Z', history: [checking, { kind: 'run', run: 7, title: 'Обучение', type: 'training', line: 1 }] }] }),
  ]);
  assert.equal(later.ok, true, JSON.stringify(errors(later)));
  const lop = later.resolved!.operator;
  assert.deepEqual(lop.mode === 'continue' ? lop.lines[0].history.map(stepLabel) : null, ['#1 проверка', '#7 обучение', '#8 обучение']);
  assert.ok(later.issues.some((i) => i.severity === 'warning' && /После прогона #7 его оператор прошёл #8 обучение: агент продолжит с текущими скиллами/.test(i.reason)));
});

test('тестовые операторы: резерв на весь прогон или сессию, журнал переживает удаление прогона и перезапуск', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-operators-'));
  const stand = new StandLog();
  try {
    const store = new ResultsStore(dir);
    await store.init();
    const ops = new TestOperators(store, stand);
    await ops.init([], []);
    // Резерв — один синхронный шаг: второй запуск на занятом операторе получает 409, частичного резерва нет.
    const a = ops.reserve(['s-1'], 'run', 'прогоном #1');
    assert.throws(() => ops.reserve(['s-2', 's-1'], 'manual', 'ручной сессией m-0001'), (e: any) => e.status === 409 && /занят прогоном #1: дождитесь его завершения/.test(e.message));
    assert.equal(ops.holder('s-2'), null, 'при отказе ничего не занято');
    a.add('s-3');
    assert.equal(ops.holder('s-3'), 'прогоном #1');
    a.release();
    assert.equal(ops.holder('s-1'), null);
    ops.reserve(['s-1'], 'manual', 'ручной сессией m-0001').release();

    // Журнал: шаги пишутся при старте и сохраняются; после перезапуска история та же, даже если прогон #2 удалён.
    ops.record('s-1', { kind: 'run', run: 1, title: 'Проверка', type: 'checking', line: 1 });
    ops.record('s-1', { kind: 'run', run: 2, title: 'Обучение', type: 'training', line: 1 });
    ops.record('s-1', { kind: 'manual', session: 1, key: 'm-0001', title: 'Кейс' });
    await settleWrites(dir);
    const again = new TestOperators(store, stand);
    await again.init([], []);
    assert.deepEqual(again.history('s-1').map(stepLabel), ['#1 проверка', '#2 обучение', 'm-0001 ручная']);

    // Без журнала история собирается из записей: удалённый #2 восстанавливается из истории, сохранённой в #3.
    fs.rmSync(path.join(dir, 'operators.json'));
    const line = (run: number, at: string, history: unknown[]) => ({ id: run, title: `П${run}`, type: 'checking', lines: [{ index: 1, senderId: 's-1', startedAt: at, history }] });
    const runs = [
      line(1, '2026-10-28T10:00:00.000Z', []),
      line(3, '2026-10-28T10:20:00.000Z', [
        { kind: 'run', run: 1, title: 'П1', type: 'checking', line: 1 },
        { kind: 'run', run: 2, title: 'П2', type: 'training', line: 1 },
      ]),
    ] as any[];
    const rebuilt = new TestOperators(store, stand);
    await rebuilt.init(runs, []);
    assert.deepEqual(rebuilt.history('s-1').map(stepLabel), ['#1 проверка', '#2 обучение', '#3 проверка']);
    await settleWrites(dir);
    assert.ok(fs.existsSync(path.join(dir, 'operators.json')), 'собранный журнал сохранён');

    // Журнал более новой версии не перезаписывается: история ведётся в памяти, причина — в журнале стенда.
    fs.writeFileSync(path.join(dir, 'operators.json'), JSON.stringify({ format: RECORD_FORMAT + 1, operators: {} }));
    const newer = new TestOperators(store, stand);
    await newer.init(runs, []);
    newer.record('s-1', { kind: 'run', run: 4, title: 'П4', type: 'checking', line: 1 });
    await settleWrites(dir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'operators.json'), 'utf8')).format, RECORD_FORMAT + 1);
    assert.ok(stand.entries.some((e) => e.kind === 'store.skipped' && /Журнал тестовых операторов operators\.json не загружен/.test(e.message)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('перечень входных данных: стартовый шаблон и заглушки по умолчанию останавливают запуск; в перечне — все зависимости и подстановки окружения', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-inputs-'));
  try {
    fs.cpSync(CONFIG, dir, { recursive: true });
    // Модель оператора — из окружения: файл тот же, а модель другая.
    const model = path.join(dir, 'models/fake-operator.yaml');
    fs.writeFileSync(model, fs.readFileSync(model, 'utf8').replace(/^model: fake-operator$/m, 'model: ${env:FAKE_OPERATOR_MODEL:-fake-operator}'));
    const env = loadEnv({ CLAWGYM_CONFIG: dir, FAKE_OPERATOR_MODEL: 'fake-operator-2', TURN_TIMEOUT_MS: '600000' }, REPO);
    const p = resolveRun(await loadRegistry(dir), env, 'demo-check');
    assert.equal(p.ok, true, JSON.stringify(p.issues.filter((i) => i.severity === 'error')));
    const files = new Map(p.inputs.files.map((f) => [f.file, f.group]));
    for (const [file, group] of [
      ['runs/demo-check.yaml', 'run'],
      ['baskets/second-line-check.yaml', 'basket'],
      ['contracts/tools.json', 'contract'],
      ['contracts/start-message.txt', 'contract'],
      ['contracts/tool-defaults.yaml', 'contract'],
      ['agents/fake-agent.yaml', 'agent'],
      ['templates/aefclaw-a2a-message.json', 'agent'],
      ['models/fake-operator.yaml', 'models'],
      ['prompts/operator-v2.txt', 'prompts'],
      ['prompts/operator-v2.schema.json', 'prompts'],
    ]) {
      assert.equal(files.get(file), group, file);
    }
    assert.deepEqual(p.involvedFiles, [...files.keys()].sort(), 'проверка ошибок — по тому же перечню');
    const settings = Object.fromEntries(p.inputs.settings.map((s) => [s.key, s.value]));
    assert.equal(settings['operator.model'], 'fake-operator-2');
    assert.equal(settings.TURN_TIMEOUT_MS, '600000');
    assert.match(settings['agent.url'], /^http:\/\/127\.0\.0\.1:8091\/a2a$/);

    // Нет стартового шаблона — загрузчик пишет ошибку, и прогон с этим контрактом не запускается.
    fs.rmSync(path.join(dir, 'contracts/start-message.txt'));
    const noStart = resolveRun(await loadRegistry(dir), env, 'demo-check');
    assert.equal(noStart.ok, false);
    assert.ok(noStart.issues.some((i) => i.severity === 'error' && i.file === 'contracts/start-message.txt' && /Нет шаблона стартового сообщения/.test(i.reason)));
    // Заглушка по умолчанию без ответа и нечитаемый файл ответа умолчаний — тоже.
    fs.writeFileSync(path.join(dir, 'contracts/start-message.txt'), fs.readFileSync(path.join(CONFIG, 'contracts/start-message.txt')));
    const defaults = path.join(dir, 'contracts/tool-defaults.yaml');
    const text = fs.readFileSync(defaults, 'utf8');
    fs.writeFileSync(defaults, text.replace('json: { assigned: true }', 'file: missing.json'));
    const noData = resolveRun(await loadRegistry(dir), env, 'demo-check');
    assert.ok(noData.issues.some((i) => i.severity === 'error' && i.file === 'contracts/tool-defaults.yaml' && /Файл ответа data\/missing\.json не прочитан/.test(i.reason)));
    assert.equal(noData.ok, false);
    fs.writeFileSync(defaults, text.replace("    - id: default-assigned\n      result:\n        json: { assigned: true }", '    - id: default-assigned'));
    const noAnswer = resolveRun(await loadRegistry(dir), env, 'demo-check');
    assert.ok(noAnswer.issues.some((i) => i.severity === 'error' && i.file === 'contracts/tool-defaults.yaml' && /Заглушка без ответа/.test(i.reason)));
    assert.equal(noAnswer.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('кейсы в подкаталогах cases/: ссылки по id, папка в списке, черновики на «_» пропускаются, повтор id — ошибка', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-folders-'));
  try {
    for (const d of ['contracts', 'cases', 'solutions', 'agents', 'models', 'metrics', 'templates', 'baskets', 'runs']) fs.cpSync(path.join(CONFIG, d), path.join(home, d), { recursive: true });
    fs.mkdirSync(path.join(home, 'cases/cards/disputes'), { recursive: true });
    fs.renameSync(path.join(home, 'cases/card-hold-amount.yaml'), path.join(home, 'cases/cards/card-hold-amount.yaml'));
    fs.renameSync(path.join(home, 'cases/card-operation-dispute.yaml'), path.join(home, 'cases/cards/disputes/card-operation-dispute.yaml'));
    fs.mkdirSync(path.join(home, 'cases/_drafts'));
    fs.writeFileSync(path.join(home, 'cases/_drafts/draft.yaml'), 'id: draft\n');
    fs.writeFileSync(path.join(home, 'cases/cards/_wip.yaml'), 'id: wip\n');
    const reg = await loadRegistry(home);
    assert.deepEqual(reg.issues.filter((i) => i.severity === 'error'), []);
    assert.equal(reg.cases.get('card-operation-dispute')!.source.file, 'cases/cards/disputes/card-operation-dispute.yaml');
    assert.ok(!reg.cases.has('draft') && !reg.cases.has('wip'), 'черновики на «_» пропущены');
    assert.equal(resolveRun(reg, loadEnv({ CLAWGYM_CONFIG: home }, REPO), 'demo-check').ok, true, 'корзина находит решения кейсов из папок');
    // Сначала верхний уровень, затем папки; внутри — по id.
    assert.deepEqual(
      casesView({ registry: reg } as any).cases.map((c) => [c.folder, c.id]),
      [
        ['', 'notifications-channel-change'],
        ['', 'spasibo-bonus-missing'],
        ['cards', 'card-hold-amount'],
        ['cards/disputes', 'card-operation-dispute'],
      ],
    );
    // Один id в двух папках — ошибка с указанием другого файла.
    fs.copyFileSync(path.join(home, 'cases/cards/card-hold-amount.yaml'), path.join(home, 'cases/card-hold-amount.yaml'));
    const dup = (await loadRegistry(home)).issues.find((i) => i.severity === 'error' && /card-hold-amount/.test(i.reason));
    assert.match(dup?.reason ?? '', /уже есть в cases\/(cards\/)?card-hold-amount\.yaml/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
