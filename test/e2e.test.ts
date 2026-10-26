// Сквозные сценарии из gap.md, раздел 17: обучение, проверка, сравнение версий, ручной запуск, сбои, изоляция.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStand, until, HOME, type Stand } from './helpers.js';

let s: Stand;
before(async () => {
  s = await startStand();
});
after(async () => {
  await s?.close();
});

const v1Files = () =>
  ['cards-pin-blocking', 'cards-reissue', 'cards-disputes'].map((n) => fs.readFileSync(path.join(HOME, `skillsets/cards/V1/skills/learned/${n}/SKILL.md`), 'utf8'));

test('обучение V1: reset перед каждым кейсом, capture после каждого, curator после 2, 4, 6; новая версия V2', async () => {
  const before = v1Files();
  const created = await s.api('POST', '/api/runs', { config: 'demo-cards-train' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const run = await s.waitRun(created.data.id);
  assert.equal(run.status, 'completed', run.error ?? '');
  const line = run.lines[0];
  assert.equal(line.prep.status, 'ok');
  const cases = line.items.filter((i: any) => i.kind === 'case');
  assert.equal(cases.length, 6);
  for (const i of cases) {
    assert.equal(i.steps.reset, 'ok', `reset перед позицией ${i.pos}`);
    assert.equal(i.steps.capture.status, 'ok', `capture после позиции ${i.pos}`);
    assert.notEqual(i.outcome, 'technical', `позиция ${i.pos}: ${i.reason}`);
  }
  assert.deepEqual(
    line.curatorPasses.map((p: any) => [p.afterPos, p.status]),
    [
      [2, 'ok'],
      [4, 'ok'],
      [6, 'ok'],
    ],
  );
  // Поправки в начале, затем агент применяет свежие уроки и скиллы после curator.
  assert.ok(cases[0].stats.corrections > 0, 'на первой позиции есть поправки');
  assert.equal(cases[2].stats.corrections, 0, 'после curator та же ошибка не повторяется');
  // Порядок сообщений агенту: /reset → стартовое → … → /case-capture; перед curator — /reset.
  const texts = s.agentRequests.filter((r) => r.sender === line.senderId).map((r) => r.text.split('\n')[0]);
  const firstStart = texts.findIndex((t) => t.startsWith('Новое обращение'));
  assert.equal(texts[firstStart - 1], '/reset');
  assert.equal(texts.filter((t) => t.startsWith('/case-capture')).length, 6);
  assert.equal(texts.filter((t) => t === '/skill-curator').length, 3);
  // Новая версия со ссылками на V1 и прогон; V1 не изменён.
  assert.equal(line.skills.newVersion?.status, 'ready', line.skills.versionNote);
  const ver = line.skills.newVersion.id;
  const ss = await s.api('GET', '/api/skillsets/cards');
  const v = ss.data.versions.find((x: any) => x.id === ver);
  assert.equal(v.origin.from, 'V1');
  assert.equal(v.origin.run, run.id);
  assert.deepEqual(v1Files(), before, 'V1 не перезаписан');
  assert.ok(line.skills.changes.length > 0);
  // Метрики: успех среди оценённых, токены агента из usage.
  const success = run.summary.find((m: any) => m.id === 'success');
  assert.equal(success.status, 'ok');
  const tokens = run.summary.find((m: any) => m.id === 'tokens');
  assert.equal(tokens.status, 'ok');
  // Журнал кейса: скрытые события и проверки с событиями-доказательствами.
  const ex = await s.api('GET', `/api/runs/${run.id}/executions/${cases[0].execName}`);
  assert.ok(ex.data.events.some((e: any) => e.type === 'operator_decision' && e.hidden));
  assert.ok(ex.data.events.some((e: any) => e.type === 'judge' && e.status === 'ok'));
  const checks = ex.data.events.find((e: any) => e.type === 'checks');
  assert.ok(checks.items.every((c: any) => Array.isArray(c.evidence)));
  // Скрытая инструкция оператора не уходит агенту.
  const instr = 'Отклоняй действия, которые расходятся с эталоном';
  assert.ok(!s.agentRequests.some((r) => r.text.includes(instr)));
  // HTTP-обмены кейса: запросы к агенту и запросы агента к MCP, привязанные к событиям журнала.
  const http = (await s.api('GET', `/api/runs/${run.id}/executions/${cases[0].execName}/http`)).data as any[];
  const agentX = http.filter((x) => x.kind === 'agent');
  const mcpX = http.filter((x) => x.kind === 'mcp');
  assert.ok(agentX.length >= 3, 'reset, стартовое сообщение и реплики');
  assert.ok(agentX.every((x) => x.request.headers['x-task-id'] && x.request.headers['x-a2a-sender-id'] === line.senderId && x.response?.status === 200));
  assert.ok(agentX.some((x) => x.label === '/reset') && agentX.some((x) => x.label === 'Стартовое сообщение'));
  assert.ok(mcpX.length > 0 && mcpX.every((x) => x.label.startsWith('tools/call') && x.request.headers['x-task-id'] === x.taskId && x.response?.status === 200));
  const seqs = new Set(ex.data.events.map((e: any) => e.seq));
  assert.ok(http.every((x) => x.eventSeq && seqs.has(x.eventSeq)), 'каждый обмен ведёт к событию журнала');
  const toolEv = ex.data.events.find((e: any) => e.type === 'tool_call');
  assert.ok(mcpX.some((x) => x.id === toolEv.httpId), 'вызов инструмента ведёт к своему обмену');
  assert.equal(ex.data.httpCount, http.length);
});

test('проверка V1 и полученной версии: без capture и curator, неизменность набора, сравнение', async () => {
  const a = await s.waitRun((await s.api('POST', '/api/runs', { config: 'demo-cards-check-v1' })).data.id);
  const b = await s.waitRun((await s.api('POST', '/api/runs', { config: 'demo-cards-check-latest' })).data.id);
  for (const r of [a, b]) {
    assert.equal(r.status, 'completed', r.error ?? '');
    const l = r.lines[0];
    const sent = s.agentRequests.filter((x) => x.sender === l.senderId).map((x) => x.text);
    assert.ok(!sent.some((t) => t.startsWith('/case-capture') || t.startsWith('/skill-curator')), 'в проверке нет команд обучения');
    assert.equal(l.skills.immutability.status, 'unchanged');
    assert.equal(l.curatorPasses.length, 0);
    for (const i of l.items) assert.ok(!i.stats || i.stats.corrections === 0, 'в проверке нет поправок');
  }
  const aPassed = a.lines[0].items.filter((i: any) => i.outcome === 'passed').length;
  const bPassed = b.lines[0].items.filter((i: any) => i.outcome === 'passed').length;
  assert.ok(bPassed > aPassed, `полученная версия лучше исходной: ${aPassed} → ${bPassed}`);
  const cmp = await s.api('GET', `/api/compare?a=${a.id}&b=${b.id}`);
  assert.equal(cmp.status, 200);
  assert.ok(cmp.data.counts.better > 0);
  assert.equal(cmp.data.rows.filter((r: any) => !r.same).map((r: any) => r.key).join(','), 'skillset');
});

test('ручной режим: кейс без решений, ответ вместо инструмента, подтверждение, команда, разметка', async () => {
  const created = await s.api('POST', '/api/manual', { case: 'card-double-charge', agent: 'fake-agent', model: 'fake-agent-a', skillset: 'build' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  const get = async () => (await s.api('GET', `/api/manual/${id}`)).data;
  // Нет заглушки для get_merchant_info: вызов ждёт ответа человека.
  const waiting = await until(async () => {
    const m = await get();
    return m.execution.pending.find((p: any) => p.kind === 'answer') ?? null;
  }, 20000, 'ручной ответ инструмента');
  assert.equal(waiting.tool, 'get_merchant_info');
  assert.equal((await s.api('POST', `/api/manual/${id}/tool/${waiting.callId}`, { action: 'answer', text: '{"name":"ТехноМаркет","status":"active"}' })).status, 200);
  const conf = await until(async () => {
    const m = await get();
    return m.execution.pending.find((p: any) => p.kind === 'confirmation') ?? null;
  }, 20000, 'подтверждение refund_operation');
  assert.equal(conf.tool, 'refund_operation');
  // Удерживаемый MCP-вызов уже виден в HTTP-обменах сессии — без ответа.
  const held = ((await s.api('GET', `/api/manual/${id}/http`)).data as any[]).find((x) => x.label === 'tools/call refund_operation');
  assert.ok(held && held.response === null && held.request.headers['x-task-id']);
  // Пока агент ждёт, реплика не принимается: один ход за раз.
  assert.equal((await s.api('POST', `/api/manual/${id}/message`, { text: 'Проверка занятости' })).status, 409);
  await s.api('POST', `/api/manual/${id}/tool/${conf.callId}`, { action: 'approve' });
  await until(async () => ((await get()).busy === null ? true : null), 20000, 'конец хода');
  assert.equal((await s.api('POST', `/api/manual/${id}/message`, { text: 'Хорошо, можно закрывать обращение.', correction: false })).status, 200);
  const close = await until(async () => (await get()).execution.pending.find((p: any) => p.tool === 'close_case') ?? null, 20000, 'close_case');
  await s.api('POST', `/api/manual/${id}/tool/${close.callId}`, { action: 'approve' });
  await until(async () => ((await get()).busy === null ? true : null), 20000, 'закрытие');
  const m = await get();
  const manualCall = m.execution.events.find((e: any) => e.type === 'tool_call' && e.tool === 'get_merchant_info');
  assert.equal(manualCall.outcome, 'manual');
  assert.match(manualCall.yaml, /get_merchant_info/);
  // Разметка реплики как поправки и завершение с автоматическими проверками.
  const human = m.execution.events.find((e: any) => e.type === 'human_message');
  assert.equal((await s.api('POST', `/api/manual/${id}/mark`, { seq: human.seq, correction: true, lessonId: 'L-test-1' })).status, 200);
  assert.equal((await s.api('DELETE', `/api/manual/${id}`)).status, 409, 'активную сессию удалить нельзя');
  const fin = await s.api('POST', `/api/manual/${id}/finish`, { judge: 'fake-judge' });
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  assert.equal(fin.data.status, 'closed');
  assert.ok(fin.data.evaluation.checks.length > 0);
  assert.equal(fin.data.evaluation.stats.corrections, 1);
  const after = ((await s.api('GET', `/api/manual/${id}/http`)).data as any[]).find((x) => x.label === 'tools/call refund_operation');
  assert.equal(after.response.status, 200, 'после решения ответ записан, обмены сохранены после закрытия сессии');
});

test('вызов MCP с неизвестным x-task-id получает ошибку и попадает в журнал стенда', async () => {
  const res = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-task-id': 'unknown-task' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_card_status', arguments: { card: '1' } } }),
  });
  const j: any = await res.json();
  assert.equal(j.result.isError, true);
  const log = await s.api('GET', '/api/stand-log');
  const entry = log.data.find((e: any) => e.kind === 'mcp.unbound' && e.message.includes('unknown-task'));
  assert.ok(entry);
  const unbound = (await s.api('GET', '/api/mcp/traffic?unbound=1')).data as any[];
  assert.ok(unbound.some((x) => x.id === entry.data.httpId && x.execId === null), 'вызов без привязки — в общем журнале MCP');
});

test('удаление: завершённый прогон и закрытая сессия удаляются с файлами, идущий прогон — нет, версия скиллов остаётся', async () => {
  const runDir = (id: number) => path.join(s.dataDir, 'results', `run-${String(id).padStart(4, '0')}`);
  // Прогон в очереди или в работе удалить нельзя.
  const created = await s.api('POST', '/api/runs', { config: 'demo-cards-check-v1' });
  const busy = await s.api('DELETE', `/api/runs/${created.data.id}`);
  assert.equal(busy.status, 409);
  const run = await s.waitRun(created.data.id);
  assert.ok(fs.existsSync(path.join(runDir(run.id), 'run.json')));
  assert.equal((await s.api('DELETE', `/api/runs/${run.id}`)).status, 200);
  assert.ok(!fs.existsSync(runDir(run.id)), 'каталог прогона удалён целиком');
  assert.equal((await s.api('GET', `/api/runs/${run.id}`)).status, 404);
  assert.ok(!(await s.api('GET', '/api/runs')).data.runs.some((r: any) => r.id === run.id));
  // Обучающий прогон удаляется, а полученная им версия остаётся с пометкой «прогон удалён».
  const train = (await s.api('GET', '/api/runs')).data.runs.find((r: any) => r.type === 'training' && r.newVersions.length);
  assert.ok(train, 'обучающий прогон из первого теста');
  const vid = train.newVersions[0].id;
  assert.equal((await s.api('DELETE', `/api/runs/${train.id}`)).status, 200);
  const v = (await s.api('GET', '/api/skillsets')).data.find((x: any) => x.id === 'cards').versions.find((x: any) => x.id === vid);
  assert.ok(v, 'версия скиллов осталась');
  assert.equal(v.origin.run, train.id);
  assert.equal(v.runDeleted, true);
  assert.equal((await s.api('GET', `/api/skillsets/cards`)).status, 200);
  // Закрытая ручная сессия удаляется вместе с журналом и HTTP-обменами.
  const closed = (await s.api('GET', '/api/manual')).data.find((x: any) => x.status === 'closed');
  assert.ok(closed, 'закрытая сессия из теста ручного режима');
  const files = ['json', 'http.json'].map((ext) => path.join(s.dataDir, 'sessions', `${closed.key}.${ext}`));
  assert.ok(files.every((f) => fs.existsSync(f)));
  assert.equal((await s.api('DELETE', `/api/manual/${closed.id}`)).status, 200);
  assert.ok(files.every((f) => !fs.existsSync(f)), 'файлы сессии удалены');
  assert.equal((await s.api('GET', `/api/manual/${closed.id}`)).status, 404);
  // Номер удалённого прогона не занимается повторно.
  const next = await s.api('POST', '/api/runs', { config: 'demo-cards-check-v1' });
  assert.ok(next.data.id > run.id);
  await s.waitRun(next.data.id);
});
