// Реплики LLM-оператора к подтверждениям: агенту сами не уходят, их пересматривает решение на конец хода.
// Проверяющая корзина: на конец хода оператор выбирает реакцию — ответ на вопрос о факте, напоминание стенда или завершение.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDialog } from '../src/execution/dialog.js';
import { execStats } from '../src/execution/evaluate.js';
import type { DecisionEvent, MessageEvent, NoteEvent } from '../src/execution/events.js';
import type { Execution } from '../src/execution/execution.js';
import { MODE_MARK, operatorContext } from '../src/operator/operator.js';
import { CHECK_REMINDER } from '../src/operator/prompts.js';
import { StructuredError } from '../src/llm/structured.js';
import { fakeOperator } from '../dev/fake-gigachat/brain.js';
import { agent, call, deps, execution, operator } from './dialog-helpers.js';

const limits = { maxTurns: 6, maxDurationSec: 60, maxOperatorCalls: 20, maxReminders: 2 };
const channel =['change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }] as const;
const note = ['add_note_in_case', { request: { comment: 'Клиент попросил SMS' } }] as const;

const confirmations = (exec: Execution) => exec.events.filter((e): e is DecisionEvent => e.type === 'operator_decision' && e.event === 'confirmation');
const turnEnds = (exec: Execution) => exec.events.filter((e): e is DecisionEvent => e.type === 'operator_decision' && e.event === 'turn_end');
const replies = (exec: Execution) => exec.events.filter((e): e is MessageEvent => e.type === 'operator_message');
const dropNote = (exec: Execution) => exec.events.find((e): e is NoteEvent => e.type === 'note' && e.text.startsWith('Реплика оператора не отправлена'));
const unsentIn = (ctx: Record<string, any>) => (ctx.transcript as any[]).filter((x) => x.sent === false);

test('контекст оператора: неотправленная реплика стоит после своего вызова с sent: false, номера — в событии конца хода', async (t) => {
  const exec = await execution();
  t.after(() => exec.stop('cleanup'));
  void call(exec, ...note);
  const tool = exec.toolCalls().at(-1)!;
  const decision = (reply: string) =>
    exec.add<DecisionEvent>({ type: 'operator_decision', hidden: true, event: 'confirmation', callId: tool.callId, decision: { confirmation: 'approve', reply, correction: true, lessonId: 'L-note' }, model: 'fake-operator', durationMs: 1, usage: null, attempts: [] });
  const pending = decision('Теперь закройте обращение');
  decision('Эта реплика уже пересмотрена');

  const ctx = operatorContext(exec, { type: 'turn_end', agentReply: 'Готово.', unsent: [pending.seq] }, 'training', limits, false);
  const tr = ctx.transcript as any[];
  assert.deepEqual(unsentIn(ctx), [{ seq: pending.seq, role: 'operator', text: 'Теперь закройте обращение', sent: false, call: tool.seq, correction: true, lessonId: 'L-note' }]);
  assert.equal(tr.findIndex((x) => x.sent === false), tr.findIndex((x) => x.seq === tool.seq) + 1, 'реплика стоит сразу после своего вызова');
  assert.ok(!tr.some((x) => x.text === 'Эта реплика уже пересмотрена'), 'реплики не из списка в журнале нет');
  assert.deepEqual((ctx.event as any).unsentReplies, [pending.seq]);

  const none = operatorContext(exec, { type: 'turn_end', agentReply: 'Готово.' }, 'training', limits, false);
  assert.ok(!('unsentReplies' in (none.event as any)), 'без неотправленных реплик поля нет');
  assert.deepEqual(unsentIn(none), []);
});

test('диалог: реплики к подтверждениям не уходят сами — после хода их пересматривает решение на конец хода (сценарий владельца)', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const final = 'Канал сменён, заметка есть. Закройте обращение с ответом клиенту.';
  const { op, seen, contexts } = operator(async (e, x) => {
    if (e.type === 'turn_end') return x.turns === 1 ? { reply: final } : { finish: true, approval: true };
    if (e.call.tool === channel[0]) return { confirmation: 'approve', reply: 'Канал сменили. Теперь добавьте заметку в обращение.' };
    return { confirmation: 'approve', reply: 'Заметку вижу, спасибо.' };
  });
  const received: string[] = [];
  const out = await runDialog(
    exec,
    deps(agent([
      async (x) => {
        await call(x, ...channel);
        await call(x, ...note);
        return 'Канал сменил на SMS и добавил заметку.';
      },
      async (_x, text) => {
        received.push(text);
        return 'Хорошо, закрываю.';
      },
    ]), op),
  );
  assert.deepEqual([out.status, out.reason], ['completed', 'Оператор завершил кейс']);
  assert.deepEqual(seen, [`confirmation ${channel[0]}`, `confirmation ${note[0]}`, 'turn_end', 'turn_end'], 'после хода с репликами оператор решает на конец хода');

  const [first, second] = confirmations(exec);
  const [turnEnd] = turnEnds(exec);
  const channelCall = exec.toolCalls().find((c) => c.tool === channel[0])!;
  assert.deepEqual(
    unsentIn(contexts[1]).map((x) => [x.seq, x.text, x.call]),
    [[first.seq, 'Канал сменили. Теперь добавьте заметку в обращение.', channelCall.seq]],
    'при следующем подтверждении в том же ходе оператор видит свою неотправленную реплику',
  );
  assert.deepEqual(contexts[2].event.unsentReplies, [first.seq, second.seq]);
  assert.deepEqual(unsentIn(contexts[2]).map((x) => x.seq), [first.seq, second.seq]);

  assert.deepEqual(replies(exec).map((m) => [m.text, m.decisionSeq, m.queued]), [[final, turnEnd.seq, undefined]], 'агенту ушла только реплика решения на конец хода');
  assert.deepEqual(received, [final]);
  assert.deepEqual([first.replyReviewed, second.replyReviewed], [turnEnd.seq, turnEnd.seq]);
  assert.deepEqual(unsentIn(contexts[3]), [], 'в следующем решении пересмотренных реплик нет');
  assert.equal(dropNote(exec), undefined);
});

test('диалог: кейс завершён по решению оператора раньше решения на конец хода — реплика к отклонению не уходит, у решения пометка', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(async (e) =>
    e.type === 'turn_end' ? { finish: true, reply: 'Спасибо, обращение можно закрывать.' } : { confirmation: 'reject', reply: 'Заметку не добавляйте.', correction: true, lessonNote: 'без заметок' },
  );
  const out = await runDialog(
    exec,
    deps(agent([
      async () => 'Канал сменил.',
      async (x) => {
        await call(x, ...note);
        return 'Заметку добавить не дали.';
      },
    ]), op),
  );
  assert.deepEqual([out.status, out.reason, exec.endedBy], ['completed', 'Оператор завершил кейс', 'operator']);
  assert.deepEqual(seen, ['turn_end', `confirmation ${note[0]}`], 'после последнего хода оператор не вызывается');
  const [dec] = confirmations(exec);
  assert.deepEqual([dec.replyDropped, dec.replyReviewed], [true, undefined]);
  assert.deepEqual(replies(exec).map((m) => m.text), ['Спасибо, обращение можно закрывать.'], 'реплика к отклонению агенту не ушла');
  const n = dropNote(exec);
  assert.equal(n?.text, 'Реплика оператора не отправлена: кейс завершён до решения на конец хода (Оператор завершил кейс)');
  assert.ok(n?.hidden, 'заметка скрыта от агента');
});

test('диалог: к концу хода исчерпан лимит запросов оператора — неотправленная реплика не уходит, кейс завершён по лимиту', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(async (e) => (e.type === 'turn_end' ? { reply: 'Продолжайте' } : { confirmation: 'reject', reply: 'Канал не меняйте.' }));
  const out = await runDialog(
    exec,
    deps(agent([
      async (x) => {
        await call(x, ...channel);
        return 'Канал менять не стал.';
      },
    ]), op, { limits: { ...limits, maxOperatorCalls: 1 } }),
  );
  assert.deepEqual([out.status, out.reason], ['limit_operator_calls', 'Исчерпан лимит 1 запросов оператора']);
  assert.deepEqual(seen, [`confirmation ${channel[0]}`]);
  assert.deepEqual(replies(exec), []);
  assert.equal(confirmations(exec)[0].replyDropped, true);
  assert.ok(dropNote(exec)?.hidden);
});

test('диалог: сбой решения на конец хода после хода с неотправленной репликой — технический статус, как после любого хода', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const { op } = operator(async (e) => {
    if (e.type === 'turn_end') throw new StructuredError('format', 'Ответ модели не по схеме', []);
    return { confirmation: 'reject', reply: 'Канал не меняйте.' };
  });
  const out = await runDialog(
    exec,
    deps(agent([
      async (x) => {
        await call(x, ...channel);
        return 'Канал менять не стал.';
      },
    ]), op),
  );
  assert.equal(out.status, 'operator_format_error');
  assert.deepEqual(replies(exec), []);
  assert.equal(confirmations(exec)[0].replyDropped, true);
});

test('поправки: отклонение с пересмотренной репликой — по решению, разрешение с репликой — нет, итоговая реплика — по разметке; прежние записи — как раньше', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const marks = (lessonId: string | null, lessonNote: string | null = null) => ({ correction: true, lessonId, lessonNote, explanation: false, approval: false, finish: false });
  const decision = (d: Record<string, unknown>, extra: Partial<DecisionEvent> = {}) =>
    exec.add<DecisionEvent>({ type: 'operator_decision', hidden: true, event: 'confirmation', decision: { correction: true, lessonNote: null, ...d }, model: 'fake-operator', durationMs: 1, usage: null, attempts: [], ...extra });
  decision({ confirmation: 'reject', lessonId: 'L-reject', reply: 'Сначала проверьте каналы' }, { replyReviewed: 10 });
  decision({ confirmation: 'approve', lessonId: 'L-approve', reply: 'В следующий раз проверьте каналы' }, { replyReviewed: 10 });
  decision({ confirmation: 'reject', lessonId: 'L-second', reply: 'Канал не меняйте' }, { replyReviewed: 10 });
  exec.add<MessageEvent>({ type: 'operator_message', text: 'Проверьте каналы и не меняйте канал без просьбы клиента.', marks: marks('L-final') });
  const stats = execStats(exec);
  assert.deepEqual([stats.corrections, [...stats.lessons].sort()], [3, ['L-final', 'L-reject', 'L-second']], 'два отклонения по разным урокам и итоговая реплика; разрешение — нет');

  // Прежняя запись: реплика к отклонению ушла склеенным сообщением, поправка — по его разметке, а не по решению.
  const old = await execution({ mode: 'auto' });
  t.after(() => old.stop('cleanup'));
  old.add<DecisionEvent>({ type: 'operator_decision', hidden: true, event: 'confirmation', decision: { confirmation: 'reject', correction: true, lessonId: null, lessonNote: 'старое правило', reply: 'Сначала проверьте каналы' }, model: 'fake-operator', durationMs: 1, usage: null, attempts: [] });
  old.add<MessageEvent>({ type: 'operator_message', text: 'Сначала проверьте каналы', marks: marks(null, 'старое правило'), queued: true });
  const before = execStats(old);
  assert.deepEqual([before.corrections, before.unknownCorrections], [1, 1]);
});

test('fake-gigachat: в конце хода актуальная неотправленная реплика уходит с разметкой, устаревшая отбрасывается', () => {
  const rule = 'Перед сменой канала проверьте каналы уведомлений по кейсу.';
  const ctx = (agentReply: string, extra: any[] = []) => ({
    mode: 'training' as const,
    case: { facts: [] },
    style: 'explain-now',
    reference: { criteria: [], required: [{ tool: 'get_channel_cases', before: channel[0], lesson: 'L-channels' }], forbidden: [], final: null },
    lessons: [{ id: 'L-channels', rule }],
    transcript: [
      { seq: 3, role: 'tool', tool: channel[0], confirmation: 'reject', executed: false },
      { seq: 4, role: 'operator', text: rule, sent: false, call: 3, correction: true, lessonId: 'L-channels' },
      ...extra,
      { seq: 9, role: 'agent', text: agentReply },
    ],
    event: { type: 'turn_end' as const, agentReply, looksLikeQuestion: agentReply.trim().endsWith('?'), unsentReplies: [4] },
  });

  const fresh = fakeOperator(ctx('Понял, не выполняю смену канала. Что нужно сделать иначе?'));
  assert.deepEqual([fresh.reply, fresh.correction, fresh.lessonId, fresh.explanation], [rule, true, 'L-channels', true]);

  // Агент сам проверил каналы в том же ходе: просьба устарела, «модель» отвечает по обычным правилам.
  const stale = fakeOperator(ctx('Проверил каналы и сменил канал на SMS.', [{ seq: 6, role: 'tool', tool: 'get_channel_cases', confirmation: null, executed: true }]));
  assert.deepEqual([stale.reply, stale.correction], ['Продолжайте.', false]);
});

// ---------------------------------------------------------------- проверяющая корзина: реакции и напоминание стенда

const idle = 'Готов к дальнейшим вопросам по кейсу.';
const close = { request: { shortAnswer: 'Уведомления будут приходить в SMS', extendedAnswer: 'Канал уведомлений изменён на SMS.' } };
/** В проверке на конец хода оператора спрашивают о реакции, а не о реплике: общий метод — только для подтверждений. */
const noDecide = async (): Promise<never> => {
  throw new Error('общий метод оператора на конец хода в проверке не вызывается');
};
const waiting = async () => idle;

test('проверка: агент трижды ждёт вопросов — два одинаковых напоминания стенда, третье не уходит, кейс завершён по лимиту напоминаний (сценарий владельца)', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen, contexts } = operator(noDecide, async () => ({ reaction: 'remind', reason: 'агент ждёт вопросов' }));
  const received: string[] = [];
  const turn = async (_x: Execution, text: string) => {
    received.push(text);
    return idle;
  };
  const out = await runDialog(exec, deps(agent([turn, turn, turn, turn]), op, { mode: 'checking' }));
  assert.deepEqual([out.status, out.reason, exec.endedBy], ['limit_reminders', 'Агент оставил без действий 2 напоминания подряд', null]);
  assert.deepEqual(seen, ['check', 'check', 'check'], 'оператор вызван три раза');
  assert.deepEqual(received.slice(1), [CHECK_REMINDER, CHECK_REMINDER], 'агенту ушло два напоминания с одним текстом, третье не ушло');
  assert.deepEqual([exec.turns, exec.operatorCalls, exec.ignoredReminders], [3, 3, 2]);

  // Журнал: скрытое решение с реакцией и обоснованием, за ним — напоминание со ссылкой на это решение, без разметки поправок.
  const decisions = turnEnds(exec);
  assert.deepEqual(decisions.map((d) => d.decision), Array(3).fill({ reaction: 'remind', reply: null, reason: 'агент ждёт вопросов' }));
  assert.ok(decisions.every((d) => d.hidden));
  assert.deepEqual(replies(exec).map((m) => [m.text, m.reminder, m.decisionSeq, m.marks]), decisions.slice(0, 2).map((d) => [CHECK_REMINDER, true, d.seq, undefined]));
  // Оператор видит прежние напоминания в журнале с пометкой; эталона и ситуации кейса в его контексте нет.
  assert.deepEqual((contexts[2].transcript as any[]).filter((x) => x.reminder).map((x) => x.text), [CHECK_REMINDER, CHECK_REMINDER]);
  assert.deepEqual(contexts.map((c) => Object.keys(c)), Array(3).fill(['mode', 'facts', 'transcript', 'event']));
  const stats = execStats(exec);
  assert.deepEqual([stats.operator.reminders, stats.operator.replies, stats.operator.calls, stats.corrections], [2, 2, 3, 0]);
});

test('проверка: ответ на вопрос о факте уходит агенту без разметки и пометки напоминания; слова агента о завершении — «Завершён», новых сообщений нет', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(noDecide, async (reply) =>
    reply.endsWith('?') ? { reaction: 'answer', reply: 'Клиент просит SMS вместо e-mail.', reason: 'вопрос о канале' } : { reaction: 'done', reason: 'агент сообщил о завершении' },
  );
  const received: string[] = [];
  const out = await runDialog(
    exec,
    deps(agent([
      async () => 'В какой канал клиент просит присылать уведомления?',
      async (_x, text) => {
        received.push(text);
        return 'Работа по обращению закончена.';
      },
    ]), op, { mode: 'checking' }),
  );
  assert.deepEqual([out.status, out.reason, exec.endedBy], ['completed', 'Агент сообщил, что закончил работу', 'operator']);
  assert.deepEqual(seen, ['check', 'check']);
  assert.deepEqual(received, ['Клиент просит SMS вместо e-mail.'], 'агенту ушёл текст модели');
  const [first, last] = turnEnds(exec);
  const [answer, ...rest] = replies(exec);
  assert.deepEqual([answer.text, answer.decisionSeq, 'marks' in answer, 'reminder' in answer], ['Клиент просит SMS вместо e-mail.', first.seq, false, false]);
  assert.deepEqual(rest, [], 'после решения о завершении сообщений агенту нет');
  assert.deepEqual(last.decision, { reaction: 'done', reply: null, reason: 'агент сообщил о завершении' });
  assert.equal(exec.events.at(-1), last, 'решение о завершении — последнее событие диалога');
  assert.deepEqual([out.resultSeq, exec.ignoredReminders, execStats(exec).operator.reminders], [last.seq, 0, 0]);
});

test('проверка: текст модели при напоминании агенту не уходит — он получает текст стенда; терминальный инструмент после напоминания закрывает кейс без оператора', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  const hint = 'Проверьте каналы уведомлений и закройте обращение с ответом.';
  const { op, seen } = operator(noDecide, async () => ({ reaction: 'remind', reply: hint, reason: 'агент просит разрешения' }));
  const received: string[] = [];
  const out = await runDialog(
    exec,
    deps(agent([
      async () => '**Ответ клиенту:** «Уведомления будут приходить в SMS.»\n\nМожно закрывать обращение?',
      async (x, text) => {
        received.push(text);
        await call(x, 'get_close_with_answer', close);
        return 'Обращение закрыто.';
      },
    ]), op, { mode: 'checking' }),
  );
  assert.deepEqual([out.status, out.reason, exec.endedBy], ['completed', 'Выполнен терминальный инструмент get_close_with_answer', 'terminal']);
  assert.deepEqual(seen, ['check'], 'после закрытия оператор не вызывается');
  assert.deepEqual(received, [CHECK_REMINDER], 'агент получил текст стенда, а не модели');
  assert.equal(turnEnds(exec)[0].decision?.reply, hint, 'текст модели остался только в решении');
  assert.ok(!exec.messages().some((m) => m.text.includes('Проверьте каналы')), 'ни в одном сообщении диалога текста модели нет');
  assert.deepEqual(replies(exec).map((m) => [m.text, m.reminder]), [[CHECK_REMINDER, true]]);
});

test('проверка: счёт напоминаний без действий — вызов инструмента, даже отклонённый, и ответ на вопрос о факте начинают его заново', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(
    async (e) => (e.type === 'confirmation' ? { confirmation: 'reject' } : noDecide()),
    async (reply) => (reply.endsWith('?') ? { reaction: 'answer', reply: 'Таких данных нет.', reason: 'вопрос о факте' } : { reaction: 'remind', reason: 'агент ждёт' }),
  );
  // Счёт и JSON идущего выполнения в начале каждого хода: так его видит экран «Ход прогона».
  const counted: number[] = [];
  const turn = (act: (x: Execution) => Promise<string>) => async (x: Execution) => {
    counted.push(x.ignoredReminders);
    assert.equal(x.toJSON().ignoredReminders, x.ignoredReminders);
    return act(x);
  };
  const out = await runDialog(
    exec,
    deps(agent([
      turn(waiting), // стартовое сообщение → напоминание 1
      turn(waiting), // напоминание 1 без действий: счёт 1
      turn(async (x) => {
        await call(x, 'get_channel_cases');
        return 'Каналы посмотрел. Жду указаний.';
      }), // вызов инструмента: счёт 0
      turn(waiting), // счёт 1
      turn(async (x) => {
        assert.equal((await call(x, ...note)).isError, true);
        return 'Заметку добавить не дали. Жду указаний.';
      }), // отклонённый вызов — тоже вызов: счёт 0
      turn(waiting), // счёт 1
      turn(async () => 'Какой номер телефона у клиента?'), // вопрос о факте: счёт 0, агенту уходит ответ
      turn(waiting), // ход начался с ответа, а не с напоминания: счёт 0
      turn(waiting), // счёт 1
      turn(waiting), // счёт 2 — лимит
    ]), op, { mode: 'checking', checkingConfirmations: 'operator', limits: { ...limits, maxTurns: 12 } }),
  );
  assert.deepEqual(counted, [0, 0, 1, 0, 1, 0, 1, 0, 0, 1]);
  assert.deepEqual([out.status, out.reason, exec.ignoredReminders, exec.turns], ['limit_reminders', 'Агент оставил без действий 2 напоминания подряд', 2, 10]);
  assert.equal(seen.filter((s) => s === 'check').length, 10);
  assert.deepEqual(replies(exec).map((m) => (m.reminder ? 'напоминание' : m.text)), ['напоминание', 'напоминание', 'напоминание', 'напоминание', 'напоминание', 'напоминание', 'Таких данных нет.', 'напоминание', 'напоминание']);
  assert.equal(execStats(exec).operator.reminders, 8);
});

test('проверка: maxReminders: 1 — кейс завершается после первого же хода без вызовов вслед за напоминанием', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(noDecide);
  const out = await runDialog(exec, deps(agent([waiting, async () => 'Сейчас проверю.', waiting]), op, { mode: 'checking', limits: { ...limits, maxReminders: 1 } }));
  assert.deepEqual([out.status, out.reason], ['limit_reminders', 'Агент оставил без действий 1 напоминание подряд']);
  assert.deepEqual([seen, replies(exec).map((m) => m.text)], [['check', 'check'], [CHECK_REMINDER]]);
});

test('проверка: сбой реакции — технический статус, агенту ничего не уходит; лимит запросов оператора проверяется до вызова', async (t) => {
  const failures: [StructuredError, string][] = [
    [new StructuredError('format', 'Ответ модели не прошёл проверку формата', []), 'operator_format_error'],
    [new StructuredError('timeout', 'Модель не ответила вовремя', []), 'operator_timeout'],
    [new StructuredError('llm', 'HTTP 503 после всех повторов', []), 'operator_error'],
  ];
  for (const [error, status] of failures) {
    const exec = await execution({ mode: 'auto', basketType: 'checking' });
    t.after(() => exec.stop('cleanup'));
    const { op } = operator(noDecide, async () => {
      throw error;
    });
    const out = await runDialog(exec, deps(agent([waiting]), op, { mode: 'checking' }));
    assert.deepEqual([out.status, out.reason], [status, error.message]);
    assert.deepEqual(replies(exec), [], 'агенту ничего не ушло');
    const [dec] = turnEnds(exec);
    assert.deepEqual([dec.decision, dec.error], [null, error.message], 'сбой записан у решения');
  }

  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(noDecide);
  const out = await runDialog(exec, deps(agent([waiting, waiting]), op, { mode: 'checking', limits: { ...limits, maxOperatorCalls: 1 } }));
  assert.deepEqual([out.status, out.reason], ['limit_operator_calls', 'Исчерпан лимит 1 запросов оператора']);
  assert.deepEqual(seen, ['check'], 'второй раз оператора не спрашивали');
});

test('обучение: напоминаний стенда нет — на ход без вопроса агенту уходит реплика оператора, лимит напоминаний ни на что не влияет', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'training' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(
    async (_e, x) => (x.turns < 4 ? { reply: 'Проверьте каналы уведомлений по кейсу.', correction: true, lessonNote: 'сначала каналы' } : { finish: true }),
    async () => {
      throw new Error('реакция — только в проверяющей корзине');
    },
  );
  const received: string[] = [];
  const turn = async (_x: Execution, text: string) => {
    received.push(text);
    return idle;
  };
  const out = await runDialog(exec, deps(agent([turn, turn, turn, turn]), op, { limits: { ...limits, maxReminders: 1 } }));
  assert.deepEqual([out.status, out.reason], ['completed', 'Оператор завершил кейс']);
  assert.deepEqual(seen, ['turn_end', 'turn_end', 'turn_end', 'turn_end'], 'оператор вызывается прежним методом');
  assert.deepEqual(received.slice(1), Array(3).fill('Проверьте каналы уведомлений по кейсу.'));
  assert.ok(replies(exec).every((m) => !m.reminder && m.marks?.correction), 'реплики оператора — с разметкой, без пометки напоминания');
  assert.deepEqual([exec.ignoredReminders, execStats(exec).operator.reminders], [0, 0]);
});

test('проверка с confirmations: operator — реплика к подтверждению агенту не уходит и на конец хода не пересматривается; у решения текст и причина', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  const reply = 'Сначала проверьте каналы уведомлений по кейсу.';
  const { op, seen, contexts } = operator(
    async (e) => (e.type !== 'confirmation' ? noDecide() : e.call.tool === channel[0] ? { confirmation: 'reject', reply } : { confirmation: 'approve' }),
    async () => ({ reaction: 'done', reason: 'агент сообщил о завершении' }),
  );
  const out = await runDialog(
    exec,
    deps(agent([
      async (x) => {
        assert.equal((await call(x, ...channel)).isError, true, 'агент получил ошибку отклонения');
        await call(x, ...note);
        return 'Канал сменить не дали, заметку добавил. Работа закончена.';
      },
    ]), op, { mode: 'checking', checkingConfirmations: 'operator' }),
  );
  assert.deepEqual([out.status, exec.endedBy], ['completed', 'operator']);
  assert.deepEqual(seen, [`confirmation ${channel[0]}`, `confirmation ${note[0]}`, 'check']);
  assert.deepEqual(replies(exec), [], 'агент реплику не получил');

  const [rejected, approved] = confirmations(exec);
  assert.deepEqual([rejected.decision?.reply, rejected.replyDropped, rejected.replyDropReason, rejected.replyReviewed], [reply, true, 'checking', undefined]);
  assert.deepEqual([approved.replyDropped, approved.replyDropReason], [undefined, undefined], 'решение без реплики — без пометок');
  const n = dropNote(exec);
  assert.equal(n?.text, 'Реплика оператора не отправлена: в проверяющей корзине реплики к подтверждениям агенту не уходят');
  assert.ok(n?.hidden, 'заметка скрыта от агента');
  assert.deepEqual(n?.data, { decisions: [rejected.seq], text: [reply] });
  assert.equal(exec.events.filter((e) => e.type === 'note' && (e as NoteEvent).text.startsWith('Реплика оператора не отправлена')).length, 1, 'при завершении кейса второй заметки нет');

  // Подтверждение в проверке решается с эталоном, как в обучении; неотправленных реплик оператор не видит ни при следующем подтверждении, ни на конец хода.
  assert.ok('reference' in contexts[0] && 'instruction' in contexts[0]);
  assert.deepEqual(unsentIn(contexts[1]), [], 'следующее подтверждение того же хода');
  assert.deepEqual(Object.keys(contexts[2]), ['mode', 'facts', 'transcript', 'event']);
  assert.deepEqual(unsentIn(contexts[2]), []);
  assert.ok(!JSON.stringify(contexts[2]).includes('Сначала проверьте каналы'), 'в запросе на конец хода реплики нет');
  assert.ok(!('unsentReplies' in contexts[2].event), 'событие конца хода не перечисляет неотправленных реплик');
});

test('проверка с confirmations: operator — поправка в решении по подтверждению: «Нарушение режима проверки», вызов отклонён, агенту ничего не уходит', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  // Так LLM-оператор сообщает о повторной поправке: ошибка формата с меткой режима после одного переспроса.
  const attempt = (n: number) => ({ n, ok: false, kind: 'format' as const, error: `${MODE_MARK}: correction должно быть false, reply оставь null`, durationMs: 1, usage: null });
  const { op, seen } = operator(async (e) => {
    if (e.type !== 'confirmation') return noDecide();
    throw new StructuredError('format', `Ответ модели не прошёл проверку формата: ${attempt(2).error}`, [attempt(1), attempt(2)]);
  });
  const out = await runDialog(
    exec,
    deps(agent([
      async (x) => {
        assert.equal((await call(x, ...channel)).isError, true, 'вызов отклонён автоматически');
        return 'Канал сменить не дали.';
      },
    ]), op, { mode: 'checking', checkingConfirmations: 'operator' }),
  );
  assert.deepEqual([out.status, out.reason], ['operator_mode_violation', 'Оператор нарушил режим проверки']);
  assert.deepEqual(seen, [`confirmation ${channel[0]}`], 'на конец хода оператора уже не спрашивали');
  assert.deepEqual(replies(exec), [], 'реплика агенту не ушла');
  const violation = exec.events.find((e) => e.type === 'mode_violation');
  assert.ok(violation?.hidden, 'событие нарушения режима скрыто от агента');
  const tool = exec.toolCalls()[0];
  assert.deepEqual([tool.outcome, tool.confirmation?.by, exec.stub.state.channel], ['rejected', 'auto', 'EMAIL']);
  assert.deepEqual([confirmations(exec)[0].decision, execStats(exec).operator.modeViolations], [null, 1]);
});
