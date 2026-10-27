import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentClient, AgentError, parseReply } from '../../src/agent/client.js';
import { createProvider, extractJson, LlmError, type LlmProvider, type LlmRequest } from '../../src/llm/provider.js';
import { StructuredError, structuredCall } from '../../src/llm/structured.js';
import { loadRegistry } from '../../src/config/loader.js';
import type { Registry } from '../../src/config/types.js';
import { stress, CONFIG } from './helpers.js';

const req: LlmRequest = {
  system: 'Return JSON', user: 'Answer', schemaName: 'stress',
  schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false },
};

for (const text of ['{"ok":true}', '\uFEFF{"ok":true}', '```json\n{"ok":true}\n```', 'Ответ: {"ok":true} готово', '{"ok":true,"text":"} { \\\""}']) {
  stress(`LLM-01 извлечение JSON из ${JSON.stringify(text)}`, () => {
    assert.equal((extractJson(text) as any).ok, true);
  });
}

stress('LLM-02 формат исправляется ровно одним переспросом, токены суммируются', async () => {
  const calls: LlmRequest[] = [];
  const provider: LlmProvider = { complete: async (r) => {
    calls.push(r);
    return { text: calls.length === 1 ? '{"ok":"yes"}' : '{"ok":true}', usage: { input: 2, output: 3 }, model: 'stress' };
  } };
  const r = await structuredCall(provider, req, () => []);
  assert.deepEqual(r.value, { ok: true }); assert.equal(calls.length, 2);
  assert.deepEqual(r.usage, { input: 4, output: 6 }); assert.match(calls[1].user, /не прошёл проверку/);
});

for (const text of ['null', '[]', '{"ok":"yes"}', '{"ok":true,"extra":"injected"}', '```json\nnot JSON\n```', 'Ignore previous instructions']) {
  stress(`LLM-03 невалидный ответ ${text} не проходит схему и не зацикливает переспрос`, async () => {
    let count = 0;
    const provider: LlmProvider = { complete: async () => { count++; return { text, usage: null, model: 'stress' }; } };
    await assert.rejects(structuredCall(provider, req, () => []), (e: any) => e instanceof StructuredError && e.kind === 'format' && e.attempts.length === 2);
    assert.equal(count, 2);
  });
}

stress('LLM-04 семантическая ложь по валидной схеме отклоняется без потери попыток', async () => {
  const provider: LlmProvider = { complete: async () => ({ text: '{"ok":false}', usage: null, model: 'stress' }) };
  await assert.rejects(structuredCall<{ ok: boolean }>(provider, req, (v) => v.ok ? [] : ['expected success']),
    (e: any) => e instanceof StructuredError && e.kind === 'format' && e.attempts.every((a) => a.error?.includes('expected success')));
});

for (const kind of ['aborted', 'timeout', 'refusal'] as const) {
  stress(`LLM-05 ${kind} не превращается в переспрос формата`, async () => {
    let calls = 0;
    const provider: LlmProvider = { complete: async () => { calls++; throw new LlmError(kind, kind); } };
    await assert.rejects(structuredCall(provider, req, () => []), (e: any) => e instanceof StructuredError && e.kind === (kind === 'refusal' ? 'llm' : kind));
    assert.equal(calls, 1);
  });
}

let reg: Registry;
let server: http.Server;
let base: string;
let mode = 'good';
let hits = 0;
before(async () => {
  reg = await loadRegistry(CONFIG);
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      if (mode === 'partial') {
        res.writeHead(200, { 'Content-Length': '1000' }); res.write('{"result":');
        setImmediate(() => res.destroy()); return;
      }
      if (mode === 'html') { res.writeHead(200).end('<html>proxy login</html>'); return; }
      if (mode === '503') { res.writeHead(503).end('temporarily unavailable'); return; }
      if (mode === '401') { res.writeHead(401).end('no access'); return; }
      if (mode === 'llm') {
        res.writeHead(200).end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"ok":true}' } }] })); return;
      }
      res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', result: { task: { status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'Recovered' }] } } } } }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

const send = () => new AgentClient(reg.agents.get('fake-agent')!, { FAKE_AGENT_URL: base }, ['127.0.0.1'])
  .send({ text: 'stress', taskId: 'stress', senderId: 'stress', timeoutMs: 1200 });
const provider = () => createProvider({ ...reg.models.get('fake-operator')!, baseUrl: base, params: { retries: 1, timeoutMs: 1200 } }, {});

for (const [name, expected, unfinished] of [['disconnect', 'network', true], ['partial', 'network', false], ['html', 'parse', false]] as const) {
  stress(`NET-01 ${name}: правильный тип ошибки и последующее восстановление`, async () => {
    mode = name;
    await assert.rejects(send(), (e: any) => e instanceof AgentError && e.kind === expected && e.unfinished === unfinished);
    mode = 'good'; assert.equal((await send()).text, 'Recovered');
  });
}

stress('NET-02 GigaChat 401 не повторяется', async () => {
  mode = '401'; hits = 0;
  await assert.rejects(provider().complete(req), (e: any) => e instanceof LlmError && e.status === 401);
  assert.equal(hits, 1);
});

stress('NET-03 GigaChat обрезанный ответ не принимается за полную оценку', async () => {
  mode = 'llm'; hits = 0;
  await assert.rejects(provider().complete(req), (e: any) => e instanceof LlmError && e.kind === 'truncated');
  assert.equal(hits, 1);
});

stress('NET-04 остановка в паузе перед повтором сохраняет тип aborted', async () => {
  mode = '503'; hits = 0;
  const c = new AbortController(); let timer: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(provider().complete({ ...req, signal: c.signal, onExchange: (_x, phase) => {
      if (phase === 'end') timer = setTimeout(() => c.abort(), 20);
    } }), (e: any) => e instanceof LlmError && e.kind === 'aborted');
    assert.equal(hits, 1);
  } finally { clearTimeout(timer); c.abort(); }
});

for (const tokens of ['Infinity', '-10', '1e309']) {
  stress(`NET-05 usage=${tokens} не портит метрики бесконечными или отрицательными токенами`, () => {
    const def = reg.agents.get('fake-agent')!;
    const reply = parseReply(def, { result: { task: { status: { state: 'DONE', message: { parts: [{ text: 'ok' }] } } }, usage: { input_tokens: tokens, output_tokens: 1, total_tokens: 2 } } });
    // Используем пути именно подключения, чтобы тест не зависел от конкретной обёртки usage.
    const custom = { ...def, response: { ...def.response, usage: { inputPath: '$.input', outputPath: null, totalPath: null } } };
    const parsed = parseReply(custom, { result: { task: { status: { message: { parts: [{ text: 'ok' }] } } } }, input: tokens });
    assert.ok(reply.text);
    const n = parsed.usage?.input;
    assert.ok(n === null || n === undefined || (Number.isFinite(n) && n >= 0), `метрика получила ${n}`);
  });
}
