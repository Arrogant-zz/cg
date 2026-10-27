// Запрос к агенту и прерванный ход. Запрос идёт через node:http: у fetch потолок 300 с на заголовки ответа.
// Если стенд перестал ждать, а агент продолжил ход, следующий запрос ждёт в его очереди, а не падает через RESET_TIMEOUT_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentClient, type AgentError } from '../src/agent/client.js';
import { loadRegistry } from '../src/config/loader.js';
import { CONFIG, startStand } from './helpers.js';

const failure = (p: Promise<unknown>) => p.then(() => assert.fail('ожидалась ошибка'), (e: AgentError) => e);

test('запрос к агенту: без fetch и его потолка 300 с; таймаут, остановка, отказ и HTTP-ошибка различаются', async () => {
  const reg = await loadRegistry(CONFIG);
  let mode: 'slow' | 'hang' | 'http500' = 'slow';
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === 'http500') return res.writeHead(500).end('{}');
      if (mode === 'hang') return;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { task: { status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'Готово' }] } } } } }));
      }, 1200);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const clientAt = (p: number) => new AgentClient(reg.agents.get('fake-agent')!, { FAKE_AGENT_URL: `http://127.0.0.1:${p}` }, ['127.0.0.1']);
  const client = clientAt(port);
  const send = (o: { timeoutMs?: number; waitMs?: number; signal?: AbortSignal } = {}) => client.send({ text: 'Привет', taskId: 't-1', senderId: 'lab-test', timeoutMs: 1000, ...o });
  const realFetch = globalThis.fetch;
  try {
    // fetch под запретом: ответ после паузы приходит, срок — свой таймаут плюс ожидание в очереди за прерванным запросом.
    globalThis.fetch = (() => {
      throw new Error('запрос к агенту не должен идти через fetch');
    }) as typeof fetch;
    const ok = await send({ waitMs: 1000 });
    assert.equal(ok.text, 'Готово');
    assert.ok(ok.durationMs >= 1100);
    globalThis.fetch = realFetch;

    const late = await failure(send());
    assert.deepEqual([late.kind, late.message, late.unfinished], ['timeout', 'Агент не ответил за 1 с', true], 'запрос дошёл, ответа нет: агент мог продолжить ход');

    mode = 'hang';
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const stopped = await failure(send({ signal: stop.signal }));
    assert.deepEqual([stopped.kind, stopped.unfinished], ['aborted', true]);

    mode = 'http500';
    const bad = await failure(send());
    assert.deepEqual([bad.kind, bad.httpStatus, bad.unfinished], ['http', 500, false], 'агент ответил — его сессия свободна');

    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const refused = await failure(clientAt(closedPort).send({ text: 'Привет', taskId: 't-2', senderId: 'lab-test', timeoutMs: 1000 }));
    assert.equal(refused.kind, 'network');
    assert.match(refused.message, /^Агент недоступен: ECONNREFUSED/);
    assert.equal(refused.unfinished, false, 'запрос не дошёл — ждать нечего');
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// Второй кейс корзины second-line-check: его тема встречается в корзине один раз.
const SLOW_ON = 'Оспаривание операции';

test('прерванный ход: агент его заканчивает, /reset следующего кейса ждёт в очереди агента, линия идёт дальше', async () => {
  const s = await startStand({ TURN_TIMEOUT_MS: '2000', RESET_TIMEOUT_MS: '1000', AGENT_BUSY_WAIT_MS: '6000', FAKE_AGENT_SLOW_ON: SLOW_ON, FAKE_AGENT_SLOW_MS: '4000' });
  try {
    const { data } = await s.api('POST', '/api/runs', { config: 'demo-check' });
    const run = await s.waitRun(data.id);
    const [first, slow, next, last] = run.lines[0].items.filter((i: any) => i.kind === 'case');
    assert.notEqual(first.outcome, 'technical');
    assert.equal(slow.status, 'agent_timeout');
    assert.equal(slow.reason, 'Агент не ответил за 2 с');
    assert.equal(next.steps.reset, 'ok', '/reset дождался конца прерванного хода');
    assert.notEqual(next.outcome, 'technical');
    assert.notEqual(last.outcome, 'technical');

    const ev = (await s.api('GET', `/api/runs/${run.id}/executions/${next.execName}`)).data.events;
    assert.ok(ev.some((e: any) => e.type === 'note' && /^Агент ещё выполняет прерванный запрос «Стартовое сообщение»/.test(e.text)), 'в журнале видно, чего ждёт /reset');
    const reset = ev.find((e: any) => e.type === 'command' && e.name === 'reset');
    assert.ok(reset.status === 'ok' && reset.durationMs >= 1000, `/reset ждал ${reset.durationMs} мс`);
    const http = (await s.api('GET', `/api/runs/${run.id}/executions/${next.execName}/http`)).data as any[];
    assert.ok(http.some((x) => x.label === '/reset · за прерванным запросом'));

    // Поздние вызовы прерванного хода сразу получают ошибку: вызов с подтверждением не держит агента до AGENT_MCP_TIMEOUT_MS.
    const lateCalls = (await s.api('GET', `/api/runs/${run.id}/executions/${slow.execName}`)).data.events.filter((e: any) => e.type === 'tool_call' && e.late);
    assert.ok(lateCalls.length > 0, 'агент продолжил ход после таймаута стенда');
    assert.ok(lateCalls.every((e: any) => e.outcome === 'stopped' && e.isError));
    assert.equal(s.app.unfinished.size, 0, 'агент ответил — оператор свободен');
  } finally {
    await s.close();
  }
});

test('прерванный ход: агент не освободил сессию за время ожидания — кейс «агент занят», линия остановлена', async () => {
  const slowMs = 5000;
  const s = await startStand({ TURN_TIMEOUT_MS: '1500', RESET_TIMEOUT_MS: '1000', AGENT_BUSY_WAIT_MS: '1000', FAKE_AGENT_SLOW_ON: SLOW_ON, FAKE_AGENT_SLOW_MS: String(slowMs) });
  try {
    const { data } = await s.api('POST', '/api/runs', { config: 'demo-check' });
    const run = await s.waitRun(data.id);
    const line = run.lines[0];
    const [, slow, busy, rest] = line.items.filter((i: any) => i.kind === 'case');
    assert.equal(slow.status, 'agent_timeout');
    assert.deepEqual([busy.status, busy.outcome], ['agent_busy', 'technical']);
    assert.equal(busy.reason, 'Агент не освободил сессию: прерванный запрос «Стартовое сообщение» не закончился за 1 с ожидания');
    assert.deepEqual([rest.status, rest.reason], ['not_started', 'линия остановлена: агент занят прерванным запросом']);
    assert.match(line.error, /^Линия остановлена: агент не освободил сессию/);
    assert.equal(run.status, 'completed');
    assert.equal(s.app.unfinished.get(line.senderId)?.stuck, true);
    // fake-agent доделывает долгий ход и после конца прогона: дождаться, иначе он допишет рабочую папку в удалённый каталог.
    const sent = s.agentRequests.find((r) => r.text.includes(SLOW_ON))!;
    const left = Date.parse(sent.ts) + slowMs + 500 - Date.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  } finally {
    await s.close();
  }
});
