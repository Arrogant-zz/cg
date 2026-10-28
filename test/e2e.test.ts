// Сквозные сценарии из gap.md, раздел 17: обучение, проверка, сравнение версий, ручной запуск, сбои, изоляция.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Execution } from '../src/execution/execution.js';
import type { NoteEvent } from '../src/execution/events.js';
import { settleWrites } from '../src/util/fsx.js';
import { compareRuns } from '../src/results/compare.js';
import { stepLabel } from '../src/runner/operators.js';
import { startStand, until, CONFIG, REPO, type Stand } from './helpers.js';

let s: Stand;
before(async () => {
  s = await startStand();
});
after(async () => {
  await s?.close();
});

// Стартовые скиллы «сборки» fake-agent: новый тестовый оператор начинает с них, обучение меняет только его копию в агенте.
const buildFiles = () =>
  ['spasibo-bonus', 'card-dispute', 'card-hold', 'notifications-channel'].map((n) => fs.readFileSync(path.join(REPO, `dev/fake-agent/build/skills/learned/${n}/SKILL.md`), 'utf8'));
const workspace = (sender: string) => path.join(s.dataDir, 'fake-workspaces', sender.replace(/[^\w.-]/g, '_'));

test('обучение на новом операторе: reset перед каждым кейсом, capture после каждого, curator после 2, 4, 6 и финальный после 7; выученное — у оператора', async () => {
  const before = buildFiles();
  const created = await s.api('POST', '/api/runs', { config: 'demo-train' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const run = await s.waitRun(created.data.id);
  assert.equal(run.status, 'completed', run.error ?? '');
  const line = run.lines[0];
  assert.equal(line.prep.status, 'ok');
  const cases = line.items.filter((i: any) => i.kind === 'case');
  assert.equal(cases.length, 7);
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
      [7, 'ok'],
    ],
    'финальный проход неполной пачки после седьмого',
  );
  // Поправки в начале, затем агент применяет свежие уроки и скиллы после curator.
  assert.ok(cases[0].stats.corrections > 0, 'на первой позиции есть поправки');
  assert.equal(cases[2].stats.corrections, 0, 'после curator та же ошибка не повторяется');
  // Порядок сообщений агенту: /reset → стартовое → … → /case-capture; перед curator — /reset.
  const texts = s.agentRequests.filter((r) => r.sender === line.senderId).map((r) => r.text.split('\n')[0]);
  const firstStart = texts.findIndex((t) => t.startsWith('Новое обращение'));
  assert.equal(texts[firstStart - 1], '/reset');
  assert.equal(texts.filter((t) => t.startsWith('/case-capture')).length, 7);
  assert.equal(texts.filter((t) => t === '/skill-curator').length, 4);
  // Блокировка суммы: скилл V1 ведёт к экспертизе, оператор отклоняет и объясняет; агент закрывает кейс ответом.
  const hold = cases[6];
  assert.equal(hold.case.id, 'card-hold-amount');
  assert.deepEqual(hold.stats.lessons, ['L-hold-001']);
  assert.equal(hold.scores.final.predicted, 'close_answer');
  // Новый тестовый оператор; что сделал curator — по строке результата. Скиллы ClawGym не выгружает: урок — в workspace оператора в агенте.
  assert.equal(run.settings.testOperator.mode, 'new');
  assert.deepEqual(line.history, []);
  assert.ok(line.curatorPasses.every((p: any) => p.parsed?.kind === 'complete'), 'строка результата curator разобрана');
  assert.ok(line.curatorPasses.some((p: any) => p.parsed.updated + p.parsed.created > 0));
  const holdSkill = fs.readFileSync(path.join(workspace(line.senderId), 'skills/learned/card-hold/SKILL.md'), 'utf8');
  assert.match(holdSkill, /экспертизу не выставлять/, 'урок перенесён curator в скилл оператора');
  assert.deepEqual(buildFiles(), before, 'стартовые скиллы сборки не изменились');
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
  // Вызовы LLM-оператора и судьи — тоже в журнале HTTP, с подписью и привязкой к решению или оценке.
  const llmX = http.filter((x) => x.kind === 'llm');
  assert.ok(llmX.some((x) => /^LLM-оператор · (конец хода|подтверждение \w+)$/.test(x.label)));
  assert.equal(llmX.filter((x) => x.label === 'LLM-оценка · критерии ответа').length, 1);
  assert.equal(llmX.filter((x) => /^LLM-оценка · эталонный текст, прогон \d из 3$/.test(x.label)).length, 3);
  assert.ok(llmX.every((x) => x.response?.status === 200 && /\/v[12]\/chat\/completions$/.test(x.request.url) && JSON.parse(x.request.body).messages));
  const decision = ex.data.events.find((e: any) => e.type === 'operator_decision' && !e.forced);
  assert.ok(llmX.some((x) => x.id === decision.httpId && x.eventSeq === decision.seq), 'решение оператора ведёт к своему обмену');
  const judgeEv = ex.data.events.find((e: any) => e.type === 'judge');
  assert.ok(llmX.some((x) => x.id === judgeEv.httpId && x.eventSeq === judgeEv.seq), 'оценка ведёт к своему обмену');
  assert.equal(ex.data.httpCount, http.length);
});

test('проверка до и после обучения: новый оператор и продолжение на обученном, без capture и curator, сравнение', async () => {
  const train = (await s.api('GET', '/api/runs')).data.runs.find((r: any) => r.type === 'training' && r.status === 'completed');
  const trainSender = (await s.api('GET', `/api/runs/${train.id}`)).data.lines[0].senderId;
  // Нет такого прогона — продолжать не на ком: ошибка до запуска.
  const missing = (await s.api('GET', '/api/run-configs/demo-check/preview?continueFrom=9999')).data;
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((i: any) => /Прогон #9999 для продолжения не найден/.test(i.reason)));
  const a = await s.waitRun((await s.api('POST', '/api/runs', { config: 'demo-check' })).data.id);
  const b = await s.waitRun((await s.api('POST', '/api/runs', { config: 'demo-check-trained' })).data.id);
  // demo-check — новый оператор со стартовыми скиллами сборки; demo-check-trained — оператор обучающего прогона.
  assert.equal(a.settings.testOperator.mode, 'new');
  assert.notEqual(a.lines[0].senderId, trainSender);
  assert.deepEqual(b.settings.testOperator, { mode: 'continue', run: train.id, title: train.title, type: 'training', configId: 'demo-train' });
  assert.equal(b.lines[0].senderId, trainSender, 'тот же x-a2a-sender-id, что в обучении');
  assert.deepEqual(b.lines[0].history.map((h: any) => [h.run, h.type]), [[train.id, 'training']]);
  for (const r of [a, b]) {
    assert.equal(r.status, 'completed', r.error ?? '');
    const l = r.lines[0];
    const sent = s.agentRequests.filter((x) => x.sender === l.senderId && Date.parse(x.ts) >= Date.parse(r.startedAt)).map((x) => x.text);
    assert.ok(!sent.some((t) => t.startsWith('/case-capture') || t.startsWith('/skill-curator')), 'в проверке нет команд обучения');
    assert.equal(l.curatorPasses.length, 0);
    for (const i of l.items) assert.ok(!i.stats || i.stats.corrections === 0, 'в проверке нет поправок');
  }
  const aPassed = a.lines[0].items.filter((i: any) => i.outcome === 'passed').length;
  const bPassed = b.lines[0].items.filter((i: any) => i.outcome === 'passed').length;
  assert.ok(bPassed > aPassed, `обученный оператор лучше нового: ${aPassed} → ${bPassed}`);
  const cmp = await s.api('GET', `/api/compare?a=${a.id}&b=${b.id}`);
  assert.equal(cmp.status, 200);
  assert.ok(cmp.data.counts.better > 0);
  assert.equal(cmp.data.rows.filter((r: any) => !r.same).map((r: any) => r.key).join(','), 'operator');
  assert.match(cmp.data.rows.find((r: any) => r.key === 'operator').b, new RegExp(`^после #${train.id} обучение$`));

  // Метрики аналитика. M1: со стартовыми скиллами блокировка суммы идёт как спорная операция — экспертиза вместо ответа; после обучения — ответ и закрытие.
  const metric = (r: any, id: string) => r.summary.find((m: any) => m.id === id);
  const [m1a, m1b] = [a, b].map((r) => metric(r, 'final-action'));
  assert.equal(m1a.display, '0,73');
  assert.match(m1a.note, /^accuracy 0,75/);
  assert.deepEqual(m1a.details.matrix.slice(0, 2), [
    [2, 1, 0, 0],
    [0, 1, 0, 0],
  ]);
  assert.equal(m1b.value, 1);
  assert.deepEqual(m1b.details.matrix.slice(0, 2), [
    [3, 0, 0, 0],
    [0, 1, 0, 0],
  ]);
  assert.deepEqual([a, b].map((r) => r.lines[0].items[3].scores.final.predicted), ['expertise', 'close_answer']);
  for (const r of [a, b]) assert.ok(r.lines[0].items.every((i: any) => i.scores.answer.runs === 3), 'три прогона судьи на кейс');
  // M2 = 0,5 · F1 + 0,5 · A_judge. V1: нет истории операций и ответ не по эталону; описание экспертизы — ⅔ прогонов.
  const [sp, card] = a.lines[0].items.map((i: any) => i.scores);
  assert.deepEqual([sp.tools.f1, sp.answer.score, sp.caseScore], [0.8, 0, 0.4]);
  assert.deepEqual([card.tools.fn, card.answer.matched], [1, 2]);
  assert.equal(metric(a, 'case-score').display, '0,44');
  assert.equal(metric(b, 'case-score').display, '0,96');
  assert.match(metric(b, 'case-score').note, /^0,5 · F1 1,00 \+ 0,5 · A 0,92/);
  // Журнал кейса: класс, F1 по инструментам и вердикты судьи с обоснованием.
  const ex = await s.api('GET', `/api/runs/${b.id}/executions/${b.lines[0].items[0].execName}`);
  const sc = ex.data.events.find((e: any) => e.type === 'scores');
  assert.equal(sc.final.tool, 'get_close_with_answer');
  assert.equal(sc.final.textFrom, 'request.extendedAnswer');
  assert.deepEqual(sc.tools.rows.map((x: any) => x.tool).sort(), ['get_close_with_answer', 'get_spasibo_general_info', 'get_spasibo_history_info']);
  assert.ok(sc.answer.runs.every((x: any) => x.match === true && x.reason));
  // Сравнение: ΔM1 и ΔM2 положительны; параметры метрик входят в определение.
  const pair = (id: string) => cmp.data.metrics.find((p: any) => p.a.id === id);
  assert.ok(pair('final-action').b.value - pair('final-action').a.value > 0.25);
  assert.ok(pair('case-score').b.value - pair('case-score').a.value > 0.5);
  assert.ok(cmp.data.rows.find((r: any) => r.key === 'prompts').a.includes('answer-judge-v1'));
});

test('ручной режим: кейс без решений, ответ вместо инструмента, подтверждение, команда, разметка', async () => {
  // Существующий оператор задаётся явно: без id — ошибка, а не тихая подмена новым.
  const noId = await s.api('POST', '/api/manual', { case: 'notifications-channel-change', agent: 'fake-agent', sender: { mode: 'existing', id: ' ' } });
  assert.equal(noId.status, 400);
  const created = await s.api('POST', '/api/manual', { case: 'notifications-channel-change', agent: 'fake-agent' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  // Один диалог на оператора: занятый активной сессией оператор второй сессии не достаётся.
  const sender = (await s.api('GET', `/api/manual/${id}`)).data.senderId;
  const twice = await s.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent', sender: { mode: 'existing', id: sender } });
  assert.equal(twice.status, 409);
  assert.match(twice.data.error ?? JSON.stringify(twice.data), /занят ручной сессией/);
  const get = async () => (await s.api('GET', `/api/manual/${id}`)).data;
  // Нет заглушки для get_smsbank_notifications: вызов ждёт ответа человека.
  const waiting = await until(async () => {
    const m = await get();
    return m.execution.pending.find((p: any) => p.kind === 'answer') ?? null;
  }, 20000, 'ручной ответ инструмента');
  assert.equal(waiting.tool, 'get_smsbank_notifications');
  assert.equal((await s.api('POST', `/api/manual/${id}/tool/${waiting.callId}`, { action: 'answer', text: '{"notifications":[{"date":"2026-10-20","channel":"EMAIL","status":"DELIVERED"}]}' })).status, 200);
  const conf = await until(async () => {
    const m = await get();
    return m.execution.pending.find((p: any) => p.kind === 'confirmation') ?? null;
  }, 20000, 'подтверждение change_notifications_channel_for_case');
  assert.equal(conf.tool, 'change_notifications_channel_for_case');
  // Удерживаемый MCP-вызов уже виден в HTTP-обменах сессии — без ответа.
  const held = ((await s.api('GET', `/api/manual/${id}/http`)).data as any[]).find((x) => x.label === 'tools/call change_notifications_channel_for_case');
  assert.ok(held && held.response === null && held.request.headers['x-task-id']);
  // Пока агент ждёт, реплика не принимается: один ход за раз.
  assert.equal((await s.api('POST', `/api/manual/${id}/message`, { text: 'Проверка занятости' })).status, 409);
  await s.api('POST', `/api/manual/${id}/tool/${conf.callId}`, { action: 'approve' });
  await until(async () => ((await get()).busy === null ? true : null), 20000, 'конец хода');
  assert.equal((await s.api('POST', `/api/manual/${id}/message`, { text: 'Хорошо, можно закрывать обращение.', correction: false })).status, 200);
  const close = await until(async () => (await get()).execution.pending.find((p: any) => p.tool === 'get_close_with_answer') ?? null, 20000, 'get_close_with_answer');
  await s.api('POST', `/api/manual/${id}/tool/${close.callId}`, { action: 'approve' });
  await until(async () => ((await get()).busy === null ? true : null), 20000, 'закрытие');
  const m = await get();
  const manualCall = m.execution.events.find((e: any) => e.type === 'tool_call' && e.tool === 'get_smsbank_notifications');
  assert.equal(manualCall.outcome, 'manual');
  assert.match(manualCall.yaml, /get_smsbank_notifications/);
  // Ответ клиенту ушёл в request.shortAnswer инструмента закрытия.
  const closeCall = m.execution.events.find((e: any) => e.type === 'tool_call' && e.tool === 'get_close_with_answer');
  assert.match(closeCall.args.request.shortAnswer, /SMS/);
  // Разметка реплики как поправки и завершение с автоматическими проверками.
  const human = m.execution.events.find((e: any) => e.type === 'human_message');
  assert.equal((await s.api('POST', `/api/manual/${id}/mark`, { seq: human.seq, correction: true, lessonId: 'L-test-1' })).status, 200);
  assert.equal((await s.api('DELETE', `/api/manual/${id}`)).status, 409, 'активную сессию удалить нельзя');
  const fin = await s.api('POST', `/api/manual/${id}/finish`, { judge: 'fake-judge' });
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  assert.equal(fin.data.status, 'closed');
  assert.ok(fin.data.evaluation.checks.length > 0);
  assert.equal(fin.data.evaluation.stats.corrections, 1);
  const after = ((await s.api('GET', `/api/manual/${id}/http`)).data as any[]).find((x) => x.label === 'tools/call change_notifications_channel_for_case');
  assert.equal(after.response.status, 200, 'после решения ответ записан, обмены сохранены после закрытия сессии');
});

test('вызов MCP с неизвестным x-task-id получает ошибку и попадает в журнал стенда', async () => {
  const res = await fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-task-id': 'unknown-task' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_client_cards', arguments: {} } }),
  });
  const j: any = await res.json();
  assert.equal(j.result.isError, true);
  const log = await s.api('GET', '/api/stand-log');
  const entry = log.data.find((e: any) => e.kind === 'mcp.unbound' && e.message.includes('unknown-task'));
  assert.ok(entry);
  const unbound = (await s.api('GET', '/api/mcp/traffic?unbound=1')).data as any[];
  assert.ok(unbound.some((x) => x.id === entry.data.httpId && x.execId === null), 'вызов без привязки — в общем журнале MCP');
});

test('удаление: завершённый прогон и закрытая сессия удаляются с файлами, идущий прогон — нет, история оператора у продолжений остаётся', async () => {
  const runDir = (id: number) => path.join(s.dataDir, 'results', `run-${String(id).padStart(4, '0')}`);
  // Прогон в очереди или в работе удалить нельзя.
  const created = await s.api('POST', '/api/runs', { config: 'demo-check' });
  const busy = await s.api('DELETE', `/api/runs/${created.data.id}`);
  assert.equal(busy.status, 409);
  const run = await s.waitRun(created.data.id);
  assert.ok(fs.existsSync(path.join(runDir(run.id), 'run.json')));
  assert.equal((await s.api('DELETE', `/api/runs/${run.id}`)).status, 200);
  assert.ok(!fs.existsSync(runDir(run.id)), 'каталог прогона удалён целиком');
  assert.equal((await s.api('GET', `/api/runs/${run.id}`)).status, 404);
  assert.ok(!(await s.api('GET', '/api/runs')).data.runs.some((r: any) => r.id === run.id));
  // Обучающий прогон удаляется; проверка, продолжившая его оператора, хранит историю у себя.
  const list = (await s.api('GET', '/api/runs')).data.runs;
  const train = list.find((r: any) => r.type === 'training');
  const cont = list.find((r: any) => r.configId === 'demo-check-trained');
  assert.ok(train && cont, 'обучение и продолжение из прошлых тестов');
  assert.equal((await s.api('DELETE', `/api/runs/${train.id}`)).status, 200);
  assert.equal((await s.api('GET', `/api/runs/${cont.id}`)).data.testOperatorLabel, `после #${train.id} обучение`);
  const orphan = (await s.api('GET', '/api/run-configs/demo-check-trained/preview')).data;
  assert.ok(orphan.issues.some((i: any) => /Нет завершённого прогона «demo-train»/.test(i.reason)), 'продолжать больше не на ком');
  // Закрытая ручная сессия удаляется вместе с журналом и HTTP-обменами.
  const closed = (await s.api('GET', '/api/manual')).data.find((x: any) => x.status === 'closed');
  assert.ok(closed, 'закрытая сессия из теста ручного режима');
  const files = ['json', 'http.json'].map((ext) => path.join(s.dataDir, 'sessions', `${closed.key}.${ext}`));
  assert.ok(files.every((f) => fs.existsSync(f)));
  assert.equal((await s.api('DELETE', `/api/manual/${closed.id}`)).status, 200);
  assert.ok(files.every((f) => !fs.existsSync(f)), 'файлы сессии удалены');
  assert.equal((await s.api('GET', `/api/manual/${closed.id}`)).status, 404);
  // Номер удалённого прогона не занимается повторно.
  const next = await s.api('POST', '/api/runs', { config: 'demo-check' });
  assert.ok(next.data.id > run.id);
  await s.waitRun(next.data.id);
});

test('иконка вкладки: ICO и PNG для Safari, SVG для остальных браузеров', async () => {
  const page = await (await fetch(s.base + '/')).text();
  for (const href of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']) assert.ok(page.includes(`href="${href}"`), href);
  const ico = await fetch(s.base + '/favicon.ico');
  assert.equal(ico.headers.get('content-type'), 'image/x-icon');
  assert.deepEqual([...new Uint8Array(await ico.arrayBuffer()).slice(0, 4)], [0, 0, 1, 0], 'настоящий ICO, а не SVG');
  const png = await fetch(s.base + '/apple-touch-icon.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer()).slice(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal((await fetch(s.base + '/favicon.svg')).headers.get('content-type'), 'image/svg+xml');
});

test('перечитывание с битым контрактом во время прогона: прогон доходит до конца на контракте запуска, журнал стенда предупреждает', async () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-contract-'));
  fs.cpSync(CONFIG, config, { recursive: true });
  // Агент медленно отвечает на стартовое сообщение: перечитывание приходится на первый кейс.
  const t = await startStand({ CLAWGYM_CONFIG: config, FAKE_AGENT_SLOW_ON: 'Тематика', FAKE_AGENT_SLOW_MS: '500' });
  try {
    const created = await t.api('POST', '/api/runs', { config: 'demo-check' });
    const id = created.data.id;
    await until(async () => (await t.api('GET', `/api/runs/${id}`)).data.lines[0].items[0].status === 'running', 10000, 'первый кейс');
    fs.writeFileSync(path.join(config, 'contracts/tools.json'), '{ сломан');
    const reload = await t.api('POST', '/api/config/reload');
    assert.ok(reload.data.issues.some((i: any) => i.severity === 'error' && i.file === 'contracts/tools.json'), 'контракт в настройках сломан');
    const run = await t.waitRun(id);
    assert.equal(run.status, 'completed', run.error ?? '');
    const cases = run.lines[0].items.filter((i: any) => i.kind === 'case');
    assert.equal(cases.length, 4);
    assert.ok(
      cases.every((i: any) => i.outcome && i.outcome !== 'technical'),
      JSON.stringify(cases.map((i: any) => [i.pos, i.status, i.outcome, i.reason])),
    );
    const log = (await t.api('GET', '/api/stand-log')).data as any[];
    assert.ok(log.some((e) => e.kind === 'config.contract' && e.message.includes(`#${id}`)), 'журнал стенда предупреждает: tools/list — из новых настроек');
  } finally {
    await t.close();
    fs.rmSync(config, { recursive: true, force: true });
  }
});

test('сбой стенда посреди линии: начатый кейс закрывается как технический сбой, остальные не начаты', async () => {
  // Сбой подстраивается в стартовом сообщении второго кейса: /reset уже отправлен, кейс идёт.
  const reserve = Execution.prototype.reserveTaskId;
  Execution.prototype.reserveTaskId = function (this: Execution) {
    if (this.id.endsWith('-L1-P02')) throw new Error('сбой для теста');
    return reserve.call(this);
  };
  try {
    const created = await s.api('POST', '/api/runs', { config: 'demo-check' });
    const run = await s.waitRun(created.data.id);
    assert.equal(run.status, 'failed');
    const line = run.lines[0];
    assert.equal(line.status, 'failed');
    assert.match(line.error, /сбой для теста/);
    const [first, second, ...rest] = line.items.filter((i: any) => i.kind === 'case');
    assert.ok(first.outcome && first.outcome !== 'technical', 'первый кейс пройден до сбоя');
    assert.deepEqual([second.status, second.outcome], ['internal_error', 'technical']);
    assert.match(second.reason, /^сбой стенда: сбой для теста/);
    assert.ok(rest.every((i: any) => i.status === 'not_started'), 'следующие кейсы не начаты');
    // Журнал кейса сохраняется со статусом сбоя, а не «выполняется».
    const exec = await until(async () => {
      const e = (await s.api('GET', `/api/runs/${run.id}/executions/${second.execName}`)).data;
      return e.status === 'internal_error' ? e : null;
    }, 5000, 'журнал кейса со сбоем');
    assert.ok(exec.events.some((e: any) => e.type === 'status' && e.status === 'internal_error'));
  } finally {
    Execution.prototype.reserveTaskId = reserve;
  }
});

test('API: POST только с Content-Type: application/json — форма или text/plain с чужой страницы ничего не запускают', async () => {
  const count = async () => (await s.api('GET', '/api/runs')).data.runs.length;
  const before = await count();
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const res = await fetch(`${s.base}/api/runs`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify({ config: 'demo-check' }) });
    assert.equal(res.status, 415, type);
  }
  assert.equal((await fetch(`${s.base}/api/runs/1/stop`, { method: 'POST' })).status, 415, 'без заголовка');
  assert.equal(await count(), before, 'прогон не создан');
  const ok = await fetch(`${s.base}/api/config/reload`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(ok.status, 200, 'charset допускается');
});

test('остановка: отложенные сохранения журнала идущего кейса и записи прогона уходят на диск сразу', async () => {
  // Агент долго отвечает на стартовое сообщение: кейс идёт, пока проверяется сброс.
  const t = await startStand({ FAKE_AGENT_SLOW_ON: 'Тематика', FAKE_AGENT_SLOW_MS: '5000' });
  try {
    const id = (await t.api('POST', '/api/runs', { config: 'demo-check' })).data.id;
    const runDir = path.join(t.dataDir, 'results', `run-${String(id).padStart(4, '0')}`);
    await until(async () => (await t.api('GET', `/api/runs/${id}/executions/L1-P01`)).data?.events?.some((e: any) => e.type === 'start_message'), 10000, 'стартовое сообщение');
    // Изменения прямо перед остановкой: их сохранение отложено на 300–400 мс.
    t.app.runs.liveExecution(id, 'L1-P01')!.add<NoteEvent>({ type: 'note', text: 'событие перед остановкой' });
    const run = t.app.runs.get(id);
    run.title = 'изменено перед остановкой';
    t.app.runs.scheduleSave(run);
    t.app.runs.flush();
    await settleWrites(t.dataDir);
    const exec = JSON.parse(fs.readFileSync(path.join(runDir, 'executions/L1-P01.json'), 'utf8'));
    assert.ok(exec.events.some((e: any) => e.text === 'событие перед остановкой'), 'журнал кейса сохранён без ожидания');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).title, 'изменено перед остановкой');
    await t.api('POST', `/api/runs/${id}/stop`);
  } finally {
    await t.close();
  }
});

test('остановка: отложенная разметка ручной сессии сохраняется при закрытии ClawGym', async () => {
  const t = await startStand();
  try {
    const { id, key } = (await t.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent' })).data;
    const get = async () => (await t.api('GET', `/api/manual/${id}`)).data;
    await until(async () => ((await get()).busy === null ? true : null), 20000, 'стартовое сообщение');
    await t.api('POST', `/api/manual/${id}/message`, { text: 'Проверьте историю начислений СберСпасибо' });
    await until(async () => ((await get()).busy === null ? true : null), 20000, 'ответ агента');
    const seq = (await get()).execution.events.find((e: any) => e.type === 'human_message').seq;
    // Разметка сохраняется с задержкой 250 мс, а ClawGym закрывается сразу.
    assert.equal((await t.api('POST', `/api/manual/${id}/mark`, { seq, correction: true, lessonNote: 'сначала история начислений' })).status, 200);
    await t.app.close();
    const saved = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'sessions', `${key}.json`), 'utf8'));
    const ev = saved.execution.events.find((e: any) => e.seq === seq);
    assert.deepEqual([ev.marks.correction, ev.marks.lessonNote], [true, 'сначала история начислений']);
  } finally {
    await t.close();
  }
});

test('сбой итоговой записи прогона: привязки x-task-id сняты, прогон можно удалить, поздний вызов агента — без привязки', async () => {
  const t = await startStand();
  const save = t.app.store.saveRun.bind(t.app.store);
  // Итоговая запись прогона падает, промежуточные проходят.
  t.app.store.saveRun = async (run) => {
    if (run.status === 'completed') throw new Error('диск недоступен');
    return save(run);
  };
  try {
    const id = (await t.api('POST', '/api/runs', { config: 'demo-check' })).data.id;
    const run = await until(async () => {
      const r = (await t.api('GET', `/api/runs/${id}`)).data;
      return r.status === 'failed' ? r : null;
    }, 60000, 'прогон упал на итоговой записи');
    assert.match(run.error, /диск недоступен/);
    const taskId = (await t.api('GET', `/api/runs/${id}/executions/L1-P01`)).data.taskIds[0];
    assert.equal(t.app.bindings.get(taskId), undefined, 'привязка снята');
    const late = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-task-id': taskId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_client_cards', arguments: {} } }),
    });
    assert.equal(((await late.json()) as any).result.isError, true);
    const log = (await t.api('GET', '/api/stand-log')).data as any[];
    assert.ok(log.some((e) => e.kind === 'mcp.unbound' && e.message.includes(taskId)), 'поздний вызов не попал в законченный кейс');
    assert.equal((await t.api('DELETE', `/api/runs/${id}`)).status, 200, 'прогон удаляется');
  } finally {
    t.app.store.saveRun = save;
    await t.close();
  }
});

test('тестовый оператор: занят на весь прогон и ручную сессию; история продолжения — по журналу оператора, а не по выбранному прогону', async () => {
  const t = await startStand({ UNMATCHED_MODE: 'error' });
  const run = async (config: string, continueFrom?: number) => {
    const r = await t.api('POST', '/api/runs', { config, ...(continueFrom ? { overrides: { continueFrom } } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return t.waitRun(r.data.id);
  };
  try {
    const a0 = await run('demo-check');
    const sender = a0.lines[0].senderId;
    // Два одновременных продолжения на одном операторе: второй запуск отклонён, а не идёт параллельно (ревью 28.10.2026).
    const both = await Promise.all([1, 2].map(() => t.api('POST', '/api/runs', { config: 'demo-check', overrides: { continueFrom: a0.id } })));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 422], JSON.stringify(both.map((r) => r.data)));
    const refused = both.find((r) => r.status === 422)!.data;
    assert.ok(refused.details.some((i: any) => new RegExp(`Оператор прогона #${a0.id} занят (запускаемым прогоном|прогоном #\\d+)`).test(i.reason)), JSON.stringify(refused));
    const a1 = both.find((r) => r.status === 200)!.data;
    assert.equal((await t.api('GET', '/api/runs')).data.runs.filter((r: any) => r.senders.includes(sender) && r.id !== a0.id).length, 1, 'на операторе один прогон');
    // Пока прогон идёт, ручная сессия на его операторе тоже не открывается.
    const manualBusy = await t.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent', sender: { mode: 'existing', id: sender } });
    assert.equal(manualBusy.status, 409);
    assert.match(manualBusy.data.error, new RegExp(`Тестовый оператор занят прогоном #${a1.id}: дождитесь его завершения`));
    await t.waitRun(a1.id);

    // Ручная сессия на существующем операторе — шаг его истории: в ней можно отправить /case-capture и /skill-curator.
    const m = (await t.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent', sender: { mode: 'existing', id: sender } })).data;
    const idle = await until(async () => {
      const x = (await t.api('GET', `/api/manual/${m.id}`)).data;
      for (const p of x.execution?.pending ?? []) await t.api('POST', `/api/manual/${m.id}/tool/${p.callId}`, p.kind === 'confirmation' ? { action: 'reject' } : { action: 'error', message: 'нет данных' });
      return x.busy === null ? x : null;
    }, 30000, 'ход агента в ручной сессии');
    assert.deepEqual(idle.history.map(stepLabel), [`#${a0.id} проверка`, `#${a1.id} проверка`]);
    assert.match(idle.prep[0].text, new RegExp(`скиллы после #${a0.id} проверка → #${a1.id} проверка`));
    assert.equal((await t.api('POST', `/api/manual/${m.id}/finish`, {})).status, 200);

    // Обучение и снова проверка от старого прогона #a0: агент продолжает текущие скиллы оператора — история это показывает.
    const tr = await run('demo-train', a0.id);
    const preview = (await t.api('GET', `/api/run-configs/demo-check/preview?continueFrom=${a0.id}`)).data;
    assert.ok(preview.issues.some((i: any) => i.severity === 'warning' && new RegExp(`После прогона #${a0.id} его оператор прошёл #${a1.id} проверка, ${m.key} ручная, #${tr.id} обучение`).test(i.reason)), JSON.stringify(preview.issues));
    assert.deepEqual(preview.resolved.testOperator.later, [`#${a1.id} проверка`, `${m.key} ручная`, `#${tr.id} обучение`]);
    assert.deepEqual(preview.continueOptions.find((o: any) => o.id === a0.id).later, [`#${a1.id} проверка`, `${m.key} ручная`, `#${tr.id} обучение`]);
    const x = await run('demo-check', a0.id);
    assert.equal(x.lines[0].senderId, sender);
    assert.deepEqual(x.lines[0].history.map(stepLabel), [`#${a0.id} проверка`, `#${a1.id} проверка`, `${m.key} ручная`, `#${tr.id} обучение`]);
    assert.match(x.lines[0].prep.items[0].text, new RegExp(`скиллы — текущие, после #${a1.id} проверка → ${m.key} ручная → #${tr.id} обучение`));
    // До и после обучения: различие — в тестовом операторе, а не «условия совпадают».
    const cmp = (await t.api('GET', `/api/compare?a=${a1.id}&b=${x.id}`)).data;
    const op = cmp.rows.find((r: any) => r.key === 'operator');
    assert.equal(op.a, `после #${a0.id} проверка`);
    assert.equal(op.b, `после #${a0.id} проверка → #${a1.id} проверка → ${m.key} ручная → #${tr.id} обучение`);
    assert.equal(cmp.conclusion, 'Отличается только: тестовый оператор');
    assert.equal(cmp.comparable, true);
  } finally {
    await t.close();
  }
});

test('сравнение по снимку входных данных: другое стартовое сообщение или настройка стенда — условия различаются; запись без перечня сопоставимость не подтверждает', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-cmp-'));
  fs.cpSync(CONFIG, cfg, { recursive: true });
  const t = await startStand({ CLAWGYM_CONFIG: cfg });
  const run = async () => t.waitRun((await t.api('POST', '/api/runs', { config: 'demo-check' })).data.id);
  try {
    const a = await run();
    fs.appendFileSync(path.join(cfg, 'contracts/start-message.txt'), '\nПриоритет обращения: высокий.');
    await t.api('POST', '/api/config/reload');
    const b = await run();
    const file = (r: any, f: string) => r.snapshot.files.find((x: any) => x.file === f);
    for (const f of ['contracts/start-message.txt', 'contracts/tool-defaults.yaml', 'templates/aefclaw-a2a-message.json', 'prompts/operator-v2.txt']) {
      assert.match(file(a, f)?.sha256 ?? '', /^[0-9a-f]{64}$/, f);
      assert.equal(file(a, f).hash, file(a, f).sha256.slice(0, 4), 'короткая метка — начало полного хеша');
    }
    assert.notEqual(file(a, 'contracts/start-message.txt').sha256, file(b, 'contracts/start-message.txt').sha256);
    const ab = (await t.api('GET', `/api/compare?a=${a.id}&b=${b.id}`)).data;
    assert.equal(ab.comparable, false);
    assert.equal(ab.conclusion, 'Отличается только: контракт инструментов');
    assert.deepEqual(ab.rows.find((r: any) => r.key === 'contract').details, ['contracts/start-message.txt']);

    // Настройка стенда из окружения — тоже условие эксперимента.
    const turn = t.app.env.turnTimeoutMs;
    t.app.env.turnTimeoutMs = 600_000;
    const c = await run().finally(() => (t.app.env.turnTimeoutMs = turn));
    const bc = (await t.api('GET', `/api/compare?a=${b.id}&b=${c.id}`)).data;
    assert.equal(bc.conclusion, 'Отличается только: настройки стенда');
    assert.deepEqual(bc.rows.find((r: any) => r.key === 'stand').details, ['TURN_TIMEOUT_MS: 900000 → 600000']);
    assert.equal((await t.api('GET', `/api/compare?a=${b.id}&b=${b.id}`)).data.conclusion, 'Условия совпадают');

    // Прогон на прежней подсказке оператора operator-v1: сравнение показывает, что подсказки различаются.
    const v1 = structuredClone(t.app.runs.get(b.id));
    v1.settings.prompts.operator = 'operator-v1';
    Object.assign(v1.snapshot.files.find((f: any) => f.file === 'prompts/operator-v2.txt')!, { file: 'prompts/operator-v1.txt', sha256: '0'.repeat(64), hash: '0000' });
    const prompts = compareRuns(v1, t.app.runs.get(b.id)).rows.find((r) => r.key === 'prompts')!;
    assert.deepEqual([prompts.same, prompts.a.split(' · ')[0], prompts.b.split(' · ')[0]], [false, 'operator-v1', 'operator-v2']);

    // Запись до 28.10.2026 — без перечня входных данных: совпадение коротких меток сопоставимость не подтверждает.
    const legacy = structuredClone(t.app.runs.get(b.id));
    legacy.snapshot.settings = null;
    const old = compareRuns(legacy, t.app.runs.get(b.id));
    assert.equal(old.comparable, false);
    assert.equal(old.conclusion, 'Сопоставимость не подтверждена');
    assert.match(old.limitations[0], new RegExp(`В #${b.id} нет полного перечня входных данных`));
  } finally {
    await t.close();
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});
