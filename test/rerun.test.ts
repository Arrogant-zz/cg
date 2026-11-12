// Повтор на месте, дозапуск завершённого прогона и переоценка (решение владельца от 12 ноября 2026 года).
// Технический сбой кейса — сбой LLM-оператора, /reset или агента — сразу повторяется на той же позиции. После прогона
// сбойные и не начатые позиции проверки перезапускаются, остановленная линия обучения продолжается с места остановки,
// а упавшая оценка судьи переоценивается по сохранённому диалогу. Дозапуск собирается из снимка прогона.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG, REPO, startStand, until, type Stand } from './helpers.js';
import { loadRegistry } from '../src/config/loader.js';
import { loadEnv } from '../src/env.js';
import { resolveRun } from '../src/runner/resolve.js';
import { RECORD_FORMAT, loadRunRecord } from '../src/results/format.js';
import { ResultsStore } from '../src/results/store.js';
import { checkSnapshot, snapshotReasons } from '../src/runner/rerun.js';
import { compareRuns } from '../src/results/compare.js';
import { createProvider } from '../src/llm/provider.js';
import { OPERATOR_SCHEMA, OPERATOR_SYSTEM } from '../src/operator/prompts.js';
import { startFakeAgent } from '../dev/fake-agent/server.js';
import { startFakeGigaChat } from '../dev/fake-gigachat/server.js';
import type { RunRecord } from '../src/runner/types.js';

const runFile = (id: string, basket: string, extra = '', models = '{ operator: fake-operator, judge: fake-judge }') =>
  `id: ${id}\ntitle: ${id}\nbasket: ${basket}\nagent: fake-agent\nmodels: ${models}\nmetrics: all\n${extra}\n`;
const basketFile = (id: string, type: 'checking' | 'training', solutions: string[], extra = '') =>
  [`id: ${id}`, `title: ${id}`, `type: ${type}`, ...(extra ? [extra] : []), 'items:', ...solutions.map((s) => `  - solution: ${s}`), ''].join('\n');

/** Копия демонстрационных справочников с корзинами и настройками прогонов для повторов; patch — правка копии. */
function config(patch: (dir: string) => void = () => {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-rerun-'));
  fs.cpSync(CONFIG, dir, { recursive: true });
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
  write('baskets/retry-check.yaml', basketFile('retry-check', 'checking', ['spasibo-bonus-missing/facts-only', 'card-hold-amount/facts-only', 'card-operation-dispute/facts-only'], 'checking:\n  confirmations: approve'));
  write('baskets/one-check.yaml', basketFile('one-check', 'checking', ['spasibo-bonus-missing/facts-only'], 'checking:\n  confirmations: approve'));
  write('baskets/retry-train.yaml', basketFile('retry-train', 'training', ['spasibo-bonus-missing/explain-now', 'card-operation-dispute/explain-now', 'spasibo-bonus-missing/explain-on-ask'], 'curator:\n  every: 2\n  final: true'));
  write('baskets/one-train.yaml', basketFile('one-train', 'training', ['card-operation-dispute/explain-now'], 'curator:\n  every: 2\n  final: true'));
  write('runs/retry-check.yaml', runFile('retry-check', 'retry-check'));
  write('runs/retry-check-off.yaml', runFile('retry-check-off', 'retry-check', 'retries: 0'));
  write('runs/one-check.yaml', runFile('one-check', 'one-check'));
  write('runs/no-judge.yaml', runFile('no-judge', 'one-check', '', '{ operator: fake-operator }'));
  write('runs/retry-train.yaml', runFile('retry-train', 'retry-train'));
  write('runs/retry-train-off.yaml', runFile('retry-train-off', 'retry-train', 'retries: 0'));
  write('runs/one-train.yaml', runFile('one-train', 'one-train'));
  patch(dir);
  return dir;
}

/** Сбой модели: X-Fake-Fail и сколько запросов роли падают (dev/fake-gigachat). У модели один HTTP-повтор: вызов — два запроса. */
function failModel(dir: string, model: 'fake-operator' | 'fake-judge', headers: Record<string, string>): void {
  fs.appendFileSync(path.join(dir, `models/${model}.yaml`), `headers:\n${Object.entries(headers).map(([k, v]) => `  ${k}: '${v}'`).join('\n')}\n`);
}

/** Стенд на копии справочников; копия удаляется вместе со стендом. */
async function stand(dir: string, env: Record<string, string> = {}): Promise<Stand> {
  const s = await startStand({ CLAWGYM_CONFIG: dir, ...env });
  const close = s.close.bind(s);
  s.close = async () => {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return s;
}

const cases = (run: any): any[] => run.lines[0].items.filter((i: any) => i.kind === 'case');
const start = async (s: Stand, config: string, overrides?: unknown): Promise<number> => {
  const r = await s.api('POST', '/api/runs', { config, ...(overrides ? { overrides } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
};
const journal = async (s: Stand, id: number, name: string) => (await s.api('GET', `/api/runs/${id}/executions/${name}`)).data;
const detail = async (s: Stand, id: number) => (await s.api('GET', `/api/runs/${id}`)).data;

// ------------------------------------------------------------------ формат записи и заглушки

test('запись формата 2 читается с пустыми попытками и дозапусками и на диске не меняется; запись новее не читается', async () => {
  const raw = {
    format: 2,
    id: 7,
    settings: { basket: { id: 'b' } },
    snapshot: { files: [], settings: null },
    lines: [{ index: 1, history: [], items: [{ index: 1, kind: 'case', pos: 1, status: 'completed', outcome: 'passed' }] }],
  };
  const r = loadRunRecord(structuredClone(raw));
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const item = r.record.lines[0].items[0];
  assert.deepEqual([item.attempts, item.resultSeq, item.reevaluated, r.record.reruns], [[], null, false, []]);
  assert.equal(r.record.settings.retries, undefined, 'повтора на месте в прежних записях не было');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-format3-'));
  try {
    const file = path.join(dir, 'results/run-0007/run.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(raw));
    const before = fs.readFileSync(file, 'utf8');
    const runs = await new ResultsStore(dir).loadRuns();
    assert.deepEqual(runs.map((x) => [x.id, x.reruns.length, x.lines[0].items[0].attempts.length]), [[7, 0, 0]]);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'запись на диске не меняется, пока её не пересохранят');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const newer = loadRunRecord({ ...raw, format: RECORD_FORMAT + 1 });
  assert.equal(newer.ok, false);
  assert.match(newer.ok ? '' : newer.reason, /новее поддерживаемого/);
});

test('заглушки: сбой только первых N запросов — FAKE_AGENT_FAIL_TIMES у агента, X-Fake-Fail-Times и X-Fake-Fail-After у модели', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-fake-'));
  const agent = await startFakeAgent({ port: 0, mcpUrl: 'http://127.0.0.1:9/mcp', workspaces: ws, buildSkills: path.join(REPO, 'dev/fake-agent/build'), failOn: '^/reset$', failTimes: 1 });
  const llm = await startFakeGigaChat();
  try {
    const send = (text: string) =>
      fetch(`${agent.url}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-a2a-sender-id': 'lab-fake', 'x-task-id': 't-1' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm', contextId: 't-1', role: 'ROLE_USER', parts: [{ mediaType: 'text/plain', text }] } } }),
      });
    assert.equal((await send('/reset')).status, 500, 'первый /reset — сбой');
    assert.equal((await send('/reset')).status, 200, 'второй — ответ');

    const reg = await loadRegistry(CONFIG);
    const base = reg.models.get('fake-operator')!;
    const env = { FAKE_GIGACHAT_URL: llm.url };
    const req = { system: OPERATOR_SYSTEM, user: '```json\n{}\n```', schema: OPERATOR_SCHEMA as any, schemaName: 'operator_decision' };
    const call = (headers: Record<string, string>) => createProvider({ ...base, headers, params: { ...base.params, retries: 0 } }, env).complete(req).then(
      () => 'ok',
      () => 'fail',
    );
    const times = { 'X-Fake-Fail': 'operator', 'X-Fake-Fail-Times': '1' };
    assert.deepEqual([await call(times), await call(times), await call(times)], ['fail', 'ok', 'ok']);
    // Счётчик у роли свой: сбои судьи начинаются заново. Первые два запроса проходят, следующие два падают.
    const judgeReq = { ...req, system: 'Оценка (подсказка judge-v1)' };
    const judge = { 'X-Fake-Fail': 'judge', 'X-Fake-Fail-After': '2', 'X-Fake-Fail-Times': '2' };
    const jcall = () => createProvider({ ...base, headers: judge, params: { ...base.params, retries: 0 } }, env).complete(judgeReq).then(() => 'ok', () => 'fail');
    assert.deepEqual([await jcall(), await jcall(), await jcall(), await jcall(), await jcall()], ['ok', 'ok', 'fail', 'fail', 'ok']);
  } finally {
    await new Promise<void>((r) => agent.server.close(() => r()));
    agent.server.closeAllConnections?.();
    await llm.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('retries в настройке прогона: целое от 0 до 3, по умолчанию одна повторная попытка', async () => {
  const dir = config((d) => {
    fs.writeFileSync(path.join(d, 'runs/many-retries.yaml'), runFile('many-retries', 'retry-check', 'retries: 5'));
    fs.writeFileSync(path.join(d, 'runs/half-retries.yaml'), runFile('half-retries', 'retry-check', 'retries: 1.5'));
  });
  try {
    const reg = await loadRegistry(dir);
    const error = (file: string) => reg.issues.find((i) => i.file === file && i.severity === 'error');
    assert.equal(error('runs/many-retries.yaml')?.field, 'retries');
    assert.equal(error('runs/half-retries.yaml')?.field, 'retries', 'только целое');
    assert.ok(!reg.issues.some((i) => i.file === 'runs/retry-check.yaml'), 'поле известно схеме');
    assert.equal(reg.runs.get('retry-check')!.retries, 1);
    assert.equal(reg.runs.get('retry-check-off')!.retries, 0);
    const p = resolveRun(reg, loadEnv({ CLAWGYM_CONFIG: dir }, REPO), 'retry-check-off');
    assert.equal(p.resolved!.retries, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ повтор на месте

test('повтор на месте: сбой LLM-оператора исправлен второй попыткой, у каждой попытки свой журнал и x-task-id', async () => {
  // Два запроса оператора падают: первый вызов — оба его HTTP-запроса — кончается «Сбой LLM-оператора».
  const s = await stand(config((d) => failModel(d, 'fake-operator', { 'X-Fake-Fail': 'operator', 'X-Fake-Fail-Times': '2' })));
  try {
    assert.equal((await s.api('GET', '/api/run-configs/retry-check/preview')).data.resolved.retries, 1, 'предпросмотр показывает повтор');
    const run = await s.waitRun(await start(s, 'retry-check'));
    assert.equal(run.status, 'completed', run.error ?? '');
    assert.equal(run.settings.retries, 1);
    const [first, second] = cases(run);
    assert.deepEqual(first.attempts.map((a: any) => [a.n, a.execName, a.status, a.outcome]), [[1, 'L1-P01', 'operator_error', 'technical']]);
    assert.equal(first.execName, 'L1-P01-2');
    assert.ok(first.outcome && first.outcome !== 'technical', JSON.stringify(first));
    assert.deepEqual([second.execName, second.attempts], ['L1-P02', []]);

    const ex1 = await journal(s, run.id, 'L1-P01');
    const ex2 = await journal(s, run.id, 'L1-P01-2');
    assert.deepEqual([ex1.status, ex1.item.status, ex1.item.outcome], ['operator_error', 'operator_error', 'technical'], 'журнал прежней попытки — с её итогом');
    assert.equal(ex2.item.execName, 'L1-P01-2');
    assert.deepEqual(ex2.attempts.map((a: any) => [a.n, a.execName, a.current]), [[1, 'L1-P01', false], [2, 'L1-P01-2', true]]);
    assert.ok(!ex1.taskIds.some((t: string) => ex2.taskIds.includes(t)), 'у попыток разные x-task-id');
    assert.equal(ex1.caseNumber, ex2.caseNumber, 'номер обращения один');
    assert.ok(ex2.turns >= 1 && ex2.turns <= 20, 'ходы второй попытки — свои');
    const status = ex2.events.find((e: any) => e.type === 'status');
    assert.equal(first.resultSeq, status.seq - 1, 'граница результата — последнее событие диалога');
    assert.ok((await s.api('GET', `/api/runs/${run.id}/executions/L1-P01/http`)).data.length > 0, 'HTTP-обмены прежней попытки сохранены');
    assert.equal((await s.api('GET', `/api/runs/${run.id}/executions/${encodeURIComponent('L1-P01/../x')}`)).status, 400);

    const m = run.summary.find((x: any) => x.builtin === 'operator-errors');
    assert.equal(m.value, 1);
    assert.match(m.note, /у 1 итог получен повтором/);
    assert.deepEqual(run.retried, { attempts: 1, reevaluated: 0 });
    const list = (await s.api('GET', '/api/runs')).data.runs.find((x: any) => x.id === run.id);
    assert.notEqual(list.bars[0][0], 'tech', 'отметка позиции — по итоговой попытке');

    const runDir = path.join(s.dataDir, 'results', `run-${String(run.id).padStart(4, '0')}`);
    assert.ok(['L1-P01.json', 'L1-P01-2.json', 'L1-P01.http.json', 'L1-P01-2.http.json'].every((f) => fs.existsSync(path.join(runDir, 'executions', f))));
    assert.equal((await s.api('DELETE', `/api/runs/${run.id}`)).status, 200);
    assert.ok(!fs.existsSync(runDir), 'журналы всех попыток удалены с прогоном');
  } finally {
    await s.close();
  }
});

test('повтор на месте: обе попытки упали — технический сбой позиции, линия идёт дальше', async () => {
  // Четыре запроса оператора подряд падают: обе попытки первой позиции.
  const s = await stand(config((d) => failModel(d, 'fake-operator', { 'X-Fake-Fail': 'operator', 'X-Fake-Fail-Times': '4' })));
  try {
    const run = await s.waitRun(await start(s, 'retry-check'));
    const [first, second] = cases(run);
    assert.deepEqual([first.status, first.outcome, first.execName, first.attempts.length], ['operator_error', 'technical', 'L1-P01-2', 1]);
    assert.ok(second.outcome && second.outcome !== 'technical', 'следующая позиция выполнена');
    assert.equal(run.summary.find((x: any) => x.builtin === 'operator-errors').value, 1);
  } finally {
    await s.close();
  }
});

test('повтор на месте выключен — retries: 0; таймаут агента сразу не повторяется', async () => {
  const off = await stand(config((d) => failModel(d, 'fake-operator', { 'X-Fake-Fail': 'operator', 'X-Fake-Fail-Times': '2' })));
  try {
    const run = await off.waitRun(await start(off, 'retry-check-off'));
    const [first] = cases(run);
    assert.deepEqual([first.status, first.outcome, first.execName, first.attempts], ['operator_error', 'technical', 'L1-P01', []]);
  } finally {
    await off.close();
  }
  const slow = await stand(config(), { TURN_TIMEOUT_MS: '700', FAKE_AGENT_SLOW_ON: 'Тематика', FAKE_AGENT_SLOW_MS: '2000', AGENT_BUSY_WAIT_MS: '4000' });
  try {
    const run = await slow.waitRun(await start(slow, 'one-check'));
    const [only] = cases(run);
    assert.deepEqual([only.status, only.outcome, only.execName, only.attempts], ['agent_timeout', 'technical', 'L1-P01', []]);
    assert.equal(slow.agentRequests.filter((r) => r.text.includes('Тематика')).length, 1, 'стартовое сообщение ушло один раз');
  } finally {
    await slow.close();
  }
});

test('повтор на месте в обучении: capture и счётчик curator — по итоговой попытке, поправка неудачной попытки не делает следующую повторной', async () => {
  // Агент падает на первой поправке оператора — реплике с правилом L-spasibo-004: первая попытка кончается «Сбой агента».
  const s = await stand(config(), { FAKE_AGENT_FAIL_ON: 'Перед ответом проверить историю операций', FAKE_AGENT_FAIL_TIMES: '1' });
  try {
    const run = await s.waitRun(await start(s, 'retry-train'));
    assert.equal(run.status, 'completed', run.error ?? '');
    const [first] = cases(run);
    assert.deepEqual(first.attempts.map((a: any) => [a.execName, a.status]), [['L1-P01', 'agent_error']]);
    assert.ok(first.outcome !== 'technical', JSON.stringify(first));
    const ex1 = await journal(s, run.id, 'L1-P01');
    const ex2 = await journal(s, run.id, 'L1-P01-2');
    assert.equal(ex1.item.steps.capture.status, 'not_sent', 'после неудачной попытки capture не уходил');
    const captures = s.agentRequests.filter((r) => r.text.startsWith('/case-capture'));
    assert.equal(captures.length, cases(run).filter((i) => i.outcome !== 'technical').length, 'capture — один на позицию');
    assert.ok(captures.some((c) => c.text.includes(`request_ref=${ex2.taskIds[0]}`)), 'capture позиции — по итоговой попытке');
    assert.ok(!captures.some((c) => ex1.taskIds.some((t: string) => c.text.includes(t))));
    const corrected = ex2.events.filter((e: any) => e.type === 'operator_message' && e.marks?.lessonId === 'L-spasibo-004');
    assert.ok(corrected.length, 'во второй попытке оператор снова поправил L-spasibo-004');
    assert.ok(corrected.every((e: any) => !e.marks.repeated), 'поправка неудачной попытки не делает её повторной');
    assert.deepEqual(first.repeated, []);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ перезапуск проверяющего прогона

test('перезапуск сбоев проверяющего прогона: только технические и не начатые позиции, на том же операторе, метрики пересчитаны', async () => {
  // /reset первых двух позиций падает; повтора на месте нет — обе остаются техническим сбоем.
  const s = await stand(config(), { FAKE_AGENT_FAIL_ON: '^/reset$', FAKE_AGENT_FAIL_TIMES: '2' });
  try {
    const id = await start(s, 'retry-check-off');
    const run = await s.waitRun(id);
    const [p1, p2, p3] = cases(run);
    assert.deepEqual([p1.status, p2.status], ['reset_failed', 'reset_failed']);
    const before = await detail(s, id);
    assert.deepEqual(before.dorun.rerun, { available: true, items: ['L1-P01', 'L1-P02'], reasons: [] });
    assert.deepEqual([before.dorun.resume.lines, before.dorun.reevaluate.items], [[], []]);

    const evaluated = await s.api('POST', `/api/runs/${id}/rerun`, { items: ['L1-P03'] });
    assert.equal(evaluated.status, 409, 'оценённая позиция не перезапускается');
    assert.ok(evaluated.data.details.some((d: string) => d.startsWith('L1-P03:')), JSON.stringify(evaluated.data));
    assert.equal((await s.api('POST', `/api/runs/${id}/rerun`, { items: ['L1-P99'] })).status, 400);
    assert.equal((await s.api('POST', `/api/runs/${id}/rerun`, { items: 'L1-P01' })).status, 400);
    assert.equal((await s.api('POST', `/api/runs/${id}/resume`, {})).status, 409, 'продолжение — только для обучения');

    const sent = s.agentRequests.length;
    const queued = await s.api('POST', `/api/runs/${id}/rerun`, { items: ['L1-P02'] });
    assert.equal(queued.status, 200, JSON.stringify(queued.data));
    assert.equal(queued.data.status, 'queued');
    assert.equal((await s.api('POST', `/api/runs/${id}/rerun`, {})).status, 409, 'прогон в очереди или идёт');
    assert.equal((await s.api('DELETE', `/api/runs/${id}`)).status, 409);
    const after = await s.waitRun(id);
    assert.equal(after.status, 'completed');
    const [q1, q2, q3] = cases(after);
    assert.deepEqual([q1.status, q1.execName, q1.attempts], ['reset_failed', 'L1-P01', []], 'невыбранная позиция не тронута');
    assert.deepEqual([q2.execName, q2.attempts.map((a: any) => a.status)], ['L1-P02-2', ['reset_failed']]);
    assert.ok(q2.outcome && q2.outcome !== 'technical', JSON.stringify(q2));
    assert.deepEqual(q3, p3, 'оценённая позиция не тронута');
    assert.deepEqual(after.reruns.map((r: any) => [r.n, r.kind, r.items, r.status]), [[1, 'rerun', ['L1-P02'], 'completed']]);
    const fresh = s.agentRequests.slice(sent);
    assert.equal(fresh[0].text, '/reset', 'позиция начинается с /reset');
    assert.ok(fresh.every((r) => r.sender === after.lines[0].senderId), 'на том же тестовом операторе');
    const success = (r: any) => r.summary.find((m: any) => m.builtin === 'success');
    const evaluatedNow = ['passed', 'failed'].includes(q2.outcome) ? 1 : 0;
    assert.equal(success(after).denominator, success(run).denominator + evaluatedNow, 'метрики пересчитаны');

    await s.api('POST', `/api/runs/${id}/rerun`, {});
    const done = await s.waitRun(id);
    assert.ok(cases(done).every((i) => i.outcome !== 'technical'));
    assert.deepEqual((await detail(s, id)).dorun.rerun.items, []);
    assert.equal(done.reruns.length, 2);
  } finally {
    await s.close();
  }
});

test('перезапуск остановленного проверяющего прогона: остановленная позиция и не начатые', async () => {
  const s = await stand(config(), { FAKE_AGENT_SLOW_ON: 'Тематика', FAKE_AGENT_SLOW_MS: '800' });
  try {
    const id = await start(s, 'retry-check');
    await until(async () => (await detail(s, id)).lines[0].items[0].status === 'running', 10000, 'первый кейс');
    await s.api('POST', `/api/runs/${id}/stop`);
    const stopped = await s.waitRun(id);
    assert.equal(stopped.status, 'stopped');
    assert.deepEqual((await detail(s, id)).dorun.rerun.items, ['L1-P01', 'L1-P02', 'L1-P03']);
    await s.api('POST', `/api/runs/${id}/rerun`, {});
    const after = await s.waitRun(id, 60_000);
    assert.equal(after.status, 'completed', after.error ?? '');
    assert.ok(cases(after).every((i) => i.outcome && i.outcome !== 'technical'), JSON.stringify(cases(after).map((i) => [i.pos, i.status])));
    assert.equal(cases(after)[0].attempts[0].status, 'stopped');
  } finally {
    await s.close();
  }
});

test('остановка дозапуска: посреди работы — не начатые позиции остаются «Не начат»; пока ждёт сессию — прогон как до него', async () => {
  // Одна сессия агента на стенд: ручная сессия на новом операторе держит её, и дозапуск ждёт в очереди.
  const s = await stand(config(), { FAKE_AGENT_SLOW_ON: 'Тематика', FAKE_AGENT_SLOW_MS: '800', MAX_PARALLEL_SESSIONS: '1' });
  try {
    const id = await start(s, 'retry-check');
    await until(async () => (await detail(s, id)).lines[0].items[0].status === 'running', 10000, 'первый кейс');
    await s.api('POST', `/api/runs/${id}/stop`);
    const stopped = await s.waitRun(id);
    assert.deepEqual(cases(stopped).map((i) => i.status), ['stopped', 'not_started', 'not_started']);

    const session = await s.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent' });
    assert.equal(session.status, 200, JSON.stringify(session.data));
    const queued = await s.api('POST', `/api/runs/${id}/rerun`, {});
    assert.equal(queued.status, 200, JSON.stringify(queued.data));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await detail(s, id)).status, 'queued', 'ждёт свободную сессию');
    await s.api('POST', `/api/runs/${id}/stop`);
    const back = await until(async () => {
      const r = await detail(s, id);
      return r.status !== 'queued' && r.reruns[0]?.status === 'stopped' ? r : null;
    }, 10000, 'дозапуск снят');
    assert.equal(back.status, 'stopped', 'прогон — как до дозапуска');
    assert.deepEqual(back.lines.map((l: any) => l.status), stopped.lines.map((l: any) => l.status));
    assert.deepEqual(cases(back).map((i) => [i.status, i.attempts.length]), [['stopped', 0], ['not_started', 0], ['not_started', 0]]);
    assert.equal(back.reruns[0].error, 'Убран из очереди до старта');
    await until(async () => !(await s.api('GET', `/api/manual/${session.data.id}`)).data.busy, 20000, 'ручная сессия свободна');
    assert.equal((await s.api('POST', `/api/manual/${session.data.id}/finish`, {})).status, 200);

    // Остановка посреди дозапуска: начатая позиция — «Остановлен», не начатые остаются не начатыми.
    assert.equal((await s.api('POST', `/api/runs/${id}/rerun`, {})).status, 200);
    await until(async () => (await detail(s, id)).lines[0].items[0].execName === 'L1-P01-2', 10000, 'вторая попытка первой позиции');
    await s.api('POST', `/api/runs/${id}/stop`);
    const halted = await s.waitRun(id);
    assert.equal(halted.status, 'stopped');
    assert.deepEqual(halted.reruns.map((r: any) => r.status), ['stopped', 'stopped']);
    const [h1, h2, h3] = cases(halted);
    assert.equal(h1.attempts.length, 1);
    assert.ok(['stopped', 'not_started'].includes(h2.status) && h3.status === 'not_started', JSON.stringify(cases(halted).map((i) => i.status)));
    assert.deepEqual((await detail(s, id)).dorun.rerun.items.slice(1), ['L1-P02', 'L1-P03'], 'остаток можно перезапустить снова');
  } finally {
    await s.close();
  }
});

test('дозапуск собирается из снимка: правка справочников после прогона на него не влияет', async () => {
  const dir = config();
  const s = await stand(dir, { FAKE_AGENT_FAIL_ON: '^/reset$', FAKE_AGENT_FAIL_TIMES: '1' });
  try {
    const id = await start(s, 'retry-check-off');
    const run = await s.waitRun(id);
    assert.equal(cases(run)[0].status, 'reset_failed');
    // Кейса первой позиции больше нет в справочниках: перезапуск из текущих настроек был бы невозможен.
    fs.rmSync(path.join(dir, 'cases/spasibo-bonus-missing.yaml'));
    await s.api('POST', '/api/config/reload');
    const d = (await detail(s, id)).dorun.rerun;
    assert.deepEqual([d.available, d.reasons], [true, []]);
    await s.api('POST', `/api/runs/${id}/rerun`, {});
    const after = await s.waitRun(id);
    const [first] = cases(after);
    assert.ok(first.outcome && first.outcome !== 'technical', JSON.stringify(first));
    assert.equal(first.case.hash, cases(run)[0].case.hash);
  } finally {
    await s.close();
  }
});

test('условия перезапуска: проверяющий прогон оператора не мешает, ручная сессия и обучение — мешают', async () => {
  const s = await stand(config(), { FAKE_AGENT_FAIL_ON: '^/reset$', FAKE_AGENT_FAIL_TIMES: '1' });
  try {
    const id = await start(s, 'retry-check-off');
    const run = await s.waitRun(id);
    const sender = run.lines[0].senderId;
    // Проверка на том же операторе скиллы не меняет.
    const check = await s.waitRun(await start(s, 'one-check', { continueFrom: id }));
    assert.equal(check.lines[0].senderId, sender);
    assert.deepEqual((await detail(s, id)).dorun.rerun.reasons, []);
    // Оператор занят ручной сессией.
    const session = await s.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent', sender: { mode: 'existing', id: sender } });
    assert.equal(session.status, 200, JSON.stringify(session.data));
    const busy = (await detail(s, id)).dorun.rerun;
    assert.equal(busy.available, false);
    assert.ok(busy.reasons.some((r: string) => r.includes('занят ручной сессией')), JSON.stringify(busy));
    assert.equal((await s.api('POST', `/api/runs/${id}/rerun`, {})).status, 409);
    await until(async () => !(await s.api('GET', `/api/manual/${session.data.id}`)).data.busy, 20000, 'ручная сессия свободна');
    const finished = await s.api('POST', `/api/manual/${session.data.id}/finish`, {});
    assert.equal(finished.status, 200, JSON.stringify(finished.data));
    // После ручной сессии скиллы оператора могли поменяться: в ней можно отправить /case-capture и /skill-curator.
    const after = (await detail(s, id)).dorun.rerun;
    assert.ok(after.reasons.some((r: string) => r.includes('после прогона прошёл') && r.includes('ручная')), JSON.stringify(after));
    // Обучение на этом операторе — тоже.
    const train = await s.waitRun(await start(s, 'one-train', { continueFrom: id }));
    const reasons = (await detail(s, id)).dorun.rerun.reasons;
    assert.ok(reasons.some((r: string) => r.includes(`#${train.id} обучение`)), JSON.stringify(reasons));
    const refused = await s.api('POST', `/api/runs/${id}/rerun`, {});
    assert.equal(refused.status, 409);
    assert.ok(refused.data.details.some((r: string) => r.includes(`#${train.id} обучение`)));
  } finally {
    await s.close();
  }
});

test('условия перезапуска по снимку: настройки стенда, подсказки, модель судьи, запись без перечня и скрытый секрет', async () => {
  const s = await stand(config(), { FAKE_AGENT_FAIL_ON: '^/reset$', FAKE_AGENT_FAIL_TIMES: '1' });
  try {
    const id = await start(s, 'retry-check-off');
    await s.waitRun(id);
    const record = structuredClone(s.app.runs.get(id)) as RunRecord;
    const snap = path.join(s.app.store.runDir(id), 'snapshot');
    const env = (extra: Record<string, string>) => loadEnv({ ...s.app.env.raw, ...extra }, REPO);

    const same = await checkSnapshot(record, snap, s.app.env);
    assert.deepEqual([same.errors, same.diffs, same.hidden], [[], [], []], 'на том же стенде снимок совпадает');

    const timeout = await checkSnapshot(record, snap, env({ TURN_TIMEOUT_MS: '123456' }));
    assert.ok(snapshotReasons(timeout, 'rerun').includes('Настройки стенда: TURN_TIMEOUT_MS: 900000 → 123456'), JSON.stringify(timeout.diffs));
    assert.deepEqual(snapshotReasons(timeout, 'reevaluate'), [], 'переоценке таймаут хода не важен');

    const prompt = structuredClone(record);
    Object.assign(prompt.snapshot.files.find((f) => f.file === 'prompts/operator-v4.txt')!, { sha256: '0'.repeat(64) });
    const changed = await checkSnapshot(prompt, snap, s.app.env);
    assert.ok(snapshotReasons(changed, 'rerun').some((r) => r.includes('prompts/operator-v4.txt')));
    assert.deepEqual(snapshotReasons(changed, 'reevaluate'), [], 'подсказка оператора переоценке не важна');
    const judgePrompt = structuredClone(record);
    Object.assign(judgePrompt.snapshot.files.find((f) => f.file === 'prompts/judge-v1.txt')!, { sha256: '0'.repeat(64) });
    assert.ok(snapshotReasons(await checkSnapshot(judgePrompt, snap, s.app.env), 'reevaluate').some((r) => r.includes('prompts/judge-v1.txt')));

    const moved = await checkSnapshot(record, snap, env({ FAKE_GIGACHAT_URL: 'http://127.0.0.1:1' }));
    assert.ok(snapshotReasons(moved, 'reevaluate').some((r) => r.startsWith('Модели оператора и оценки: judge.url:')), JSON.stringify(moved.diffs));

    const legacy = structuredClone(record);
    legacy.snapshot.settings = null;
    const old = await checkSnapshot(legacy, snap, s.app.env);
    assert.ok(snapshotReasons(old, 'rerun')[0].includes('до 28.10.2026'));

    const agentFile = path.join(snap, 'agents/fake-agent.yaml');
    fs.writeFileSync(agentFile, fs.readFileSync(agentFile, 'utf8').replace(/headers:\n/, 'headers:\n    Authorization: "***"\n'));
    const hidden = await checkSnapshot(record, snap, s.app.env);
    assert.deepEqual(hidden.hidden, ['agents/fake-agent.yaml']);
    assert.ok(snapshotReasons(hidden, 'rerun').some((r) => r.includes('скрыт секрет')));
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------ продолжение обучающей линии и перезапуск ClawGym

test('продолжение обучающей линии с позиции остановки: остаток по порядку, capture, проход curator и финальный проход', async () => {
  const s = await stand(config(), { FAKE_AGENT_SLOW_ON: 'Тематика', FAKE_AGENT_SLOW_MS: '600' });
  try {
    const id = await start(s, 'retry-train');
    await until(async () => (await detail(s, id)).lines[0].items[1].status === 'running', 20000, 'вторая позиция');
    await s.api('POST', `/api/runs/${id}/stop`);
    const stopped = await s.waitRun(id);
    assert.equal(stopped.status, 'stopped');
    const [, second, third] = cases(stopped);
    assert.deepEqual([second.status, third.status], ['stopped', 'not_started']);
    assert.equal(stopped.lines[0].counter, 1);
    const d = (await detail(s, id)).dorun;
    assert.deepEqual(d.resume.lines, [{ line: 1, from: second.index, pos: 2 }]);
    assert.equal(d.resume.available, true, JSON.stringify(d.resume));
    assert.equal((await s.api('POST', `/api/runs/${id}/rerun`, {})).status, 409, 'перезапуск позиций — только у проверки');

    const captured = s.agentRequests.filter((r) => r.text.startsWith('/case-capture')).length;
    const resumed = await s.api('POST', `/api/runs/${id}/resume`, { lines: [1] });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
    const after = await s.waitRun(id, 60_000);
    assert.equal(after.status, 'completed', after.error ?? '');
    const [, p2, p3] = cases(after);
    assert.deepEqual(p2.attempts.map((a: any) => a.status), ['stopped']);
    assert.ok(p2.outcome !== 'technical' && p3.outcome !== 'technical');
    assert.equal(s.agentRequests.filter((r) => r.text.startsWith('/case-capture')).length, captured + 2, 'capture после каждой продолженной позиции');
    const passes = after.lines[0].curatorPasses;
    assert.ok(passes.some((p: any) => p.reason === 'every' && p.afterPos === 2 && p.status === 'ok'), 'проход curator после первой продолженной позиции');
    assert.ok(passes.some((p: any) => p.reason === 'final' && p.status === 'ok'), JSON.stringify(passes));
    assert.deepEqual(after.reruns.map((r: any) => [r.kind, r.lines, r.status]), [['resume', [1], 'completed']]);
    assert.equal(after.lines[0].status, 'completed');
    assert.deepEqual((await detail(s, id)).dorun.resume.lines, []);
  } finally {
    await s.close();
  }
});

test('продолжение: технический сбой в середине завершённой линии — пропуск, продолжения нет', async () => {
  const s = await stand(config(), { FAKE_AGENT_FAIL_ON: '^/reset$', FAKE_AGENT_FAIL_TIMES: '1' });
  try {
    const id = await start(s, 'retry-train-off');
    const run = await s.waitRun(id);
    assert.equal(cases(run)[0].status, 'reset_failed');
    assert.ok(cases(run).slice(1).every((i) => i.outcome && i.outcome !== 'technical'), 'линия дошла до конца корзины');
    assert.ok(run.lines[0].curatorPasses.some((p: any) => p.afterPos > 1 && p.status === 'ok'), 'после сбоя оператор прошёл curator');
    assert.deepEqual((await detail(s, id)).dorun.resume.lines, []);
    const refused = await s.api('POST', `/api/runs/${id}/resume`, { lines: [1] });
    assert.equal(refused.status, 409);
    assert.ok(refused.data.details.some((r: string) => r.startsWith('Линия 1:')), JSON.stringify(refused.data));
  } finally {
    await s.close();
  }
});

test('продолжение: линия остановлена во время финального прохода — продолжение выполняет только его', async () => {
  const s = await stand(config(), { FAKE_AGENT_SLOW_ON: '^/skill-curator', FAKE_AGENT_SLOW_MS: '1500' });
  try {
    const id = await start(s, 'one-train');
    await until(async () => (await detail(s, id)).lines[0].curatorPasses.some((p: any) => p.status === 'running'), 20000, 'финальный проход');
    await s.api('POST', `/api/runs/${id}/stop`);
    const stopped = await s.waitRun(id);
    assert.ok(!stopped.lines[0].curatorPasses.some((p: any) => p.status === 'ok'));
    const d = (await detail(s, id)).dorun;
    assert.deepEqual(d.resume.lines, [{ line: 1, from: null, pos: null }]);
    const before = s.agentRequests.length;
    const resumed = await s.api('POST', `/api/runs/${id}/resume`, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
    const after = await s.waitRun(id, 60_000);
    // Прерванный /skill-curator агент мог доделать сам: тогда повторный проход находит пустую очередь — он тоже выполнен.
    const final = after.lines[0].curatorPasses.filter((p: any) => p.reason === 'final');
    assert.equal(final.length, 2, JSON.stringify(final.map((p: any) => p.status)));
    assert.ok(['ok', 'skipped'].includes(final[1].status), final[1].status);
    assert.ok(s.agentRequests.slice(before).every((r) => r.text === '/reset' || r.text.startsWith('/skill-curator')), 'кейсы не повторялись');
    assert.deepEqual((await detail(s, id)).dorun.resume.lines, [], 'финальный проход выполнен — продолжать нечего');
  } finally {
    await s.close();
  }
});

test('перезапуск ClawGym во время прогона: прерванный кейс — технический сбой с причиной, не начатые — «Не начат», затем продолжение', async () => {
  const first = await stand(config());
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-restart-'));
  // Стенд перезапускают на тех же адресах агента и модели: они входят в снимок прогона.
  const ports = { FAKE_AGENT_PORT: new URL(first.agentUrl).port, FAKE_GIGACHAT_PORT: new URL(first.app.env.raw.FAKE_GIGACHAT_URL!).port };
  let id = 0;
  try {
    id = await start(first, 'retry-train');
    const done = await first.waitRun(id);
    assert.equal(done.status, 'completed', done.error ?? '');
    fs.cpSync(first.dataDir, copy, { recursive: true });
  } finally {
    await first.close();
  }
  // Запись — как в момент перезапуска: позиция 1 оценена, а её capture прерван; позиция 2 в диалоге, позиция 3 не начиналась;
  // идёт проход curator.
  const file = path.join(copy, 'results', `run-${String(id).padStart(4, '0')}`, 'run.json');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  r.status = 'running';
  r.finishedAt = null;
  const line = r.lines[0];
  line.status = 'running';
  line.counter = 0;
  const [p1, p2, p3] = line.items.filter((i: any) => i.kind === 'case');
  Object.assign(p1, { status: 'running', steps: { ...p1.steps, capture: null, curatorPass: null } });
  Object.assign(p2, { status: 'running', outcome: null, reason: '', finishedAt: null, checks: null, scores: null, stats: null, steps: { ...p2.steps, dialog: null, checks: null, judge: null, capture: null, curatorPass: null } });
  Object.assign(p3, { status: 'pending', outcome: null, reason: '', execName: null, startedAt: null, finishedAt: null, checks: null, scores: null, stats: null, steps: { reset: null, dialog: null, checks: null, judge: null, capture: null, curatorPass: null } });
  line.curatorPasses = [{ pass: 1, afterPos: 1, reason: 'explicit', status: 'running', startedAt: r.createdAt, durationMs: null, reset: null, text: '', reply: null, parsed: null, report: null }];
  fs.writeFileSync(file, JSON.stringify(r));
  fs.rmSync(path.join(copy, 'results', `run-${String(id).padStart(4, '0')}`, 'executions', 'L1-P03.json'), { force: true });

  const s = await stand(config(), { CLAWGYM_VAR: copy, ...ports });
  try {
    const run = await detail(s, id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /перезапущен во время прогона/);
    const [q1, q2, q3] = cases(run);
    assert.deepEqual([q1.status, q1.outcome !== 'technical', q1.steps.capture.status], [q1.steps.dialog, true, 'interrupted'], 'итог остаётся, capture прерван');
    assert.deepEqual([q2.status, q2.outcome, q2.reason], ['internal_error', 'technical', 'ClawGym перезапущен во время кейса']);
    assert.equal(q3.status, 'not_started');
    assert.deepEqual(run.lines[0].curatorPasses.map((p: any) => [p.status, p.error]), [['failed', 'ClawGym перезапущен во время прохода curator']]);
    const ex = await journal(s, id, q2.execName);
    assert.deepEqual([ex.status, ex.events[ex.events.length - 1].type, ex.events[ex.events.length - 1].status], ['internal_error', 'status', 'internal_error']);
    const list = (await s.api('GET', '/api/runs')).data.runs.find((x: any) => x.id === id);
    assert.deepEqual(list.bars[0].slice(1), ['tech', ''], 'полоса: прерванный кейс — технический сбой, следующий — не начат');

    const d = run.dorun.resume;
    assert.deepEqual([d.lines, d.reasons], [[{ line: 1, from: q2.index, pos: 2 }], []]);
    const resumed = await s.api('POST', `/api/runs/${id}/resume`, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
    const after = await s.waitRun(id, 60_000);
    assert.equal(after.status, 'completed', after.error ?? '');
    const [, a2, a3] = cases(after);
    assert.deepEqual(a2.attempts.map((a: any) => a.status), ['internal_error']);
    assert.ok(a2.outcome !== 'technical' && a3.outcome !== 'technical');
    assert.equal(after.error, null);
  } finally {
    await s.close();
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ переоценка

test('переоценка на месте: сбой судьи по критериям сразу повторяется, итог — по вердикту повтора', async () => {
  const s = await stand(config((d) => failModel(d, 'fake-judge', { 'X-Fake-Fail': 'judge', 'X-Fake-Fail-Times': '2' })));
  try {
    const run = await s.waitRun(await start(s, 'retry-check'));
    const [first, second] = cases(run);
    assert.equal(first.steps.judge.status, 'ok', JSON.stringify(first.steps));
    assert.equal(first.reevaluated, true);
    assert.equal(second.reevaluated, false);
    const ex = await journal(s, run.id, first.execName);
    const judges = ex.events.filter((e: any) => e.type === 'judge');
    assert.deepEqual(judges.map((e: any) => [e.status, e.repeat ?? null]), [['failed', null], ['ok', 'inline']]);
    assert.equal(judges[0].replacedBy, judges[1].seq);
    assert.equal(run.retried.reevaluated, 1);
  } finally {
    await s.close();
  }
});

test('переоценка на месте: упавший прогон A_judge повторяется, удачные — нет; повторный сбой — «не оценено», как раньше', async () => {
  // Вызов судьи по критериям и первый прогон A_judge проходят, второй прогон падает — оба HTTP-запроса.
  const s = await stand(config((d) => failModel(d, 'fake-judge', { 'X-Fake-Fail': 'judge', 'X-Fake-Fail-After': '2', 'X-Fake-Fail-Times': '2' })));
  try {
    const run = await s.waitRun(await start(s, 'one-check'));
    const [only] = cases(run);
    const ex = await journal(s, run.id, only.execName);
    const a = ex.events.filter((e: any) => e.type === 'scores').pop().answer;
    assert.equal(a.status, 'ok', JSON.stringify(a));
    assert.deepEqual(a.runs.map((r: any) => [r.n, r.repeat ?? null]), [[1, null], [2, 'inline'], [3, null]]);
    assert.deepEqual(a.retried.map((r: any) => r.n), [2]);
    assert.equal(only.reevaluated, true);
  } finally {
    await s.close();
  }
  // Судья по критериям падает и при повторе: итог «не оценено», если действия верны.
  const down = await stand(config((d) => failModel(d, 'fake-judge', { 'X-Fake-Fail': 'judge', 'X-Fake-Fail-Times': '4' })));
  try {
    const run = await down.waitRun(await start(down, 'one-check'));
    const [only] = cases(run);
    assert.equal(only.steps.judge.status, 'failed');
    if (only.steps.checks.passed === only.steps.checks.total) assert.deepEqual([only.outcome, only.reason.startsWith('сбой судьи')], ['not_evaluated', true]);
    assert.equal(only.reevaluated, false);
  } finally {
    await down.close();
  }
});

test('переоценка после прогона: только упавшая оценка, по сохранённому диалогу, без запросов агенту и без capture', async () => {
  // В обучении: судья по критериям первой позиции падает дважды — оценка остаётся упавшей.
  const s = await stand(config((d) => failModel(d, 'fake-judge', { 'X-Fake-Fail': 'judge', 'X-Fake-Fail-Times': '4' })));
  try {
    const id = await start(s, 'retry-train');
    const run = await s.waitRun(id);
    const [first, second] = cases(run);
    assert.equal(first.steps.judge.status, 'failed');
    const d = (await detail(s, id)).dorun.reevaluate;
    assert.deepEqual(d, { available: true, items: ['L1-P01'], reasons: [] });
    assert.equal((await s.api('POST', `/api/runs/${id}/reevaluate`, { items: [`L1-P0${second.pos}`] })).status, 409, 'удачная оценка не переоценивается');

    const sent = s.agentRequests.length;
    assert.equal((await s.api('POST', `/api/runs/${id}/reevaluate`, {})).status, 200);
    const after = await s.waitRun(id);
    assert.equal(after.status, 'completed');
    assert.equal(s.agentRequests.length, sent, 'агенту не ушло ни одного запроса — ни диалога, ни capture');
    const [a1] = cases(after);
    assert.deepEqual([a1.steps.judge.status, a1.reevaluated, a1.execName], ['ok', true, first.execName]);
    assert.ok(['passed', 'failed'].includes(a1.outcome) || a1.outcome === first.outcome);
    const ex = await journal(s, id, a1.execName);
    const judges = ex.events.filter((e: any) => e.type === 'judge');
    const fresh = judges.filter((e: any) => e.repeat === 'after');
    assert.equal(fresh.at(-1).status, 'ok');
    assert.ok(judges.filter((e: any) => e.status === 'failed').every((e: any) => e.replacedBy), 'прежние сбои помечены заменёнными');
    assert.deepEqual(after.reruns.map((r: any) => [r.kind, r.items, r.status]), [['reevaluate', ['L1-P01'], 'completed']]);
    assert.deepEqual((await detail(s, id)).dorun.reevaluate.items, []);
  } finally {
    await s.close();
  }
  // Модель оценки не выбрана: оценка не падала — переоценивать нечего.
  const plain = await stand(config());
  try {
    const run = await plain.waitRun(await start(plain, 'no-judge'));
    assert.deepEqual((await detail(plain, run.id)).dorun.reevaluate.items, []);
  } finally {
    await plain.close();
  }
});

// ------------------------------------------------------------------ сравнение

test('сравнение: разный retries виден, но не делает сравнение несопоставимым; итог повтором — в ограничениях', async () => {
  const s = await stand(config());
  try {
    const id = await start(s, 'retry-check');
    await s.waitRun(id);
    const a = structuredClone(s.app.runs.get(id)) as RunRecord;
    const b = structuredClone(a);
    b.id = a.id + 100;
    a.settings.retries = 0;
    const item = b.lines[0].items.find((i) => i.pos === 2)!;
    item.attempts = [{ n: 1, execName: 'L1-P02', status: 'agent_error', outcome: 'technical', reason: 'HTTP 500', startedAt: null, finishedAt: null }];
    const c = compareRuns(a, b);
    const row = c.rows.find((r) => r.key === 'retries')!;
    assert.deepEqual([row.a, row.b, row.same, row.neutral], ['выключен', '1 повтор', false, true]);
    assert.equal(c.comparable, true, c.conclusion);
    assert.ok(c.limitations.some((l) => l.includes(`позиция 2 — итог повторной попытки в B (#${b.id})`)), JSON.stringify(c.limitations));
  } finally {
    await s.close();
  }
});
