// Реплики LLM-оператора к подтверждениям: агенту сами не уходят, их пересматривает решение на конец хода.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDialog } from '../src/execution/dialog.js';
import { execStats } from '../src/execution/evaluate.js';
import type { DecisionEvent, MessageEvent, NoteEvent } from '../src/execution/events.js';
import type { Execution } from '../src/execution/execution.js';
import { operatorContext } from '../src/operator/operator.js';
import { StructuredError } from '../src/llm/structured.js';
import { fakeOperator } from '../dev/fake-gigachat/brain.js';
import { agent, call, deps, execution, operator } from './dialog-helpers.js';

const limits = { maxTurns: 6, maxDurationSec: 60, maxOperatorCalls: 20 };
const channel = ['change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }] as const;
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
