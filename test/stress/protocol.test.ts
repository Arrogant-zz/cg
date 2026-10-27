import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Stand } from '../helpers.js';
import { stress, request, execution, startLocalStand as startStand } from './helpers.js';

let s: Stand;
before(async () => { s = await startStand(); }, { timeout: 10000 });
after(async () => { await s?.close(); });

const rpc = (body: unknown, headers: Record<string, string> = {}) => request(s.base, '/mcp', JSON.stringify(body), headers);

for (const value of [null, [], [null], [null, { jsonrpc: '2.0', id: 'valid', method: 'ping' }]]) {
  stress(`RPC-01 невалидный пакет ${JSON.stringify(value)} возвращает JSON-RPC ошибку`, async () => {
    const r = await rpc(value);
    assert.equal((await request(s.base, '/health', undefined, {}, 'GET')).status, 200);
    assert.equal(r.status, 200, `обработчик выбросил исключение: HTTP ${r.status}`);
    const responses = Array.isArray(r.data) ? r.data : [r.data];
    assert.ok(responses.some((x: any) => x?.error?.code === -32600), r.text || 'пустой ответ');
    if (Array.isArray(value) && value.length === 2) assert.ok(responses.some((x: any) => x?.id === 'valid' && x.result));
  });
}

stress('RPC-02 сломанный JSON получает Parse error, следующий ping проходит', async () => {
  const r = await request(s.base, '/mcp', '{"jsonrpc":');
  assert.equal(r.data?.error?.code, -32700);
  const next = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(next.data, { jsonrpc: '2.0', id: 1, result: {} });
});

for (const value of [0, false, 'text', {}, { method: 'ping' }, { jsonrpc: '2.0', method: 42, id: 1 }]) {
  stress(`RPC-03 невалидный envelope ${JSON.stringify(value)} отклоняется`, async () => {
    const r = await rpc(value);
    assert.equal(r.status, 200);
    assert.equal(r.data?.error?.code, -32600, r.text);
  });
}

for (const id of [true, { arbitrary: 'id' }, [1, 2]]) {
  stress(`RPC-04 недопустимый id ${JSON.stringify(id)} отклоняется`, async () => {
    const r = await rpc({ jsonrpc: '2.0', id, method: 'ping' });
    assert.equal(r.data?.error?.code, -32600, r.text);
  });
}

stress('RPC-05 id=null остаётся запросом, уведомление определяется отсутствием id', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.deepEqual(r.data, { jsonrpc: '2.0', id: null, result: {} });
});

stress('RPC-06 пакет уведомлений не порождает ответы, id=0 не теряется', async () => {
  const notification = await rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(notification.status, 202); assert.equal(notification.text, '');
  const mixed = await rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 0, method: 'ping' }]);
  assert.deepEqual(mixed.data, [{ jsonrpc: '2.0', id: 0, result: {} }]);
});

for (const args of ['not-an-object', [1, 2], 42, false, null]) {
  stress(`RPC-07 arguments=${JSON.stringify(args)} отклоняется до вызова инструмента`, async (t) => {
    const exec = await execution();
    s.app.bindings.bindAll(exec); t.after(() => { exec.stop('cleanup'); s.app.bindings.unbindAll(exec); });
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cases_assigned', arguments: args } }, { 'x-task-id': exec.currentTaskId });
    assert.equal(r.data?.error?.code, -32602, `невалидные аргументы дошли до заглушки: ${r.text}`);
    assert.equal(exec.toolCalls().length, 0);
  });
}

stress('RPC-08 неизвестный метод и отсутствующее имя инструмента дают разные ошибки', async () => {
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'unknown' })).data?.error?.code, -32601);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })).data?.error?.code, -32602);
});

stress('RPC-09 заголовок x-task-id имеет приоритет над _meta и аргументом', async (t) => {
  const exec = await execution(); s.app.bindings.bindAll(exec);
  t.after(() => { exec.stop('cleanup'); s.app.bindings.unbindAll(exec); });
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'get_cases_assigned', _meta: { 'x-task-id': 'other-meta' }, arguments: { 'x-task-id': 'other-arg' },
  } }, { 'x-task-id': exec.currentTaskId });
  assert.equal(r.data.result.isError, undefined);
  assert.equal(exec.toolCalls()[0].taskId, exec.currentTaskId);
  assert.equal(Object.hasOwn(exec.toolCalls()[0].args, 'x-task-id'), false);
});

stress('RPC-10 initialize → DELETE удаляет ровно созданную MCP-сессию', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'unknown-version', clientInfo: { name: 'stress' } } });
  assert.ok(r.data.result.protocolVersion);
  const session = [...s.app.mcp.sessions.keys()].at(-1)!;
  assert.ok(session);
  const deleted = await request(s.base, '/mcp', undefined, { 'mcp-session-id': session }, 'DELETE');
  assert.equal(deleted.status, 204); assert.equal(s.app.mcp.sessions.has(session), false);
});

for (const url of ['/api/cases/%', '/api/runs/%C0%AF', '/api/cases/%E0%A4%A']) {
  stress(`HTTP-01 битый URL ${url} даёт 400, сервер остаётся доступен`, async () => {
    const r = await request(s.base, url, undefined, {}, 'GET');
    assert.equal((await request(s.base, '/health', undefined, {}, 'GET')).status, 200);
    assert.equal(r.status, 400, `некорректный URL классифицирован как HTTP ${r.status}`);
  });
}

for (const url of ['/api/runs', '/api/manual', '/api/manual/999/command', '/api/manual/999/mark']) {
  stress(`HTTP-02 JSON null в ${url} даёт клиентскую ошибку`, async () => {
    const r = await request(s.base, url, 'null');
    assert.ok(r.status >= 400 && r.status < 500, `null вызвал HTTP ${r.status}: ${r.text}`);
  });
}

stress('HTTP-03 синтаксически битый JSON API даёт 400', async () => {
  assert.equal((await request(s.base, '/api/runs', '{bad')).status, 400);
});

stress('HTTP-04 Content-Type с charset принимается, text/plain отклоняется', async () => {
  assert.equal((await request(s.base, '/api/runs', '{}', { 'Content-Type': 'application/json; charset=utf-8' })).status, 400);
  assert.equal((await request(s.base, '/api/runs', '{}', { 'Content-Type': 'text/plain' })).status, 415);
});

stress('HTTP-05 дробный и слишком большой номер прогона не округляются', async () => {
  assert.equal((await request(s.base, '/api/runs/1.5', undefined, {}, 'GET')).status, 400);
  assert.equal((await request(s.base, '/api/runs/9007199254740993', undefined, {}, 'GET')).status, 400);
});

stress('HTTP-06 continueFrom=true не превращается в номер прогона 1', async () => {
  const r = await request(s.base, '/api/runs', JSON.stringify({ config: 'demo-check', overrides: { continueFrom: true } }));
  assert.equal(r.status, 400, `булево значение принято как номер: ${r.status} ${r.text}`);
});

stress('HTTP-07 один запрос сверх лимита 20 MiB получает 413, следующий проходит', async () => {
  const r = await request(s.base, '/api/runs', JSON.stringify({ config: 'x'.repeat(20 * 1024 * 1024) }));
  assert.equal(r.status, 413);
  assert.equal((await request(s.base, '/health', undefined, {}, 'GET')).status, 200);
});
