// Ожидания выполнения: кто держит ход диалога, на чём он стоит и срок — по обменам без ответа, открытым вызовам LLM и удерживаемым вызовам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.js';
import type { Execution } from '../src/execution/execution.js';
import type { CommandEvent, MessageEvent, NoteEvent } from '../src/execution/events.js';
import { ANSWER_LABEL, JUDGE_LABEL } from '../src/judge/judge.js';
import { finishExchange, startExchange } from '../src/util/httplog.js';
import { execution } from './stress/helpers.js';
import { REPO } from './helpers.js';

const env = loadEnv({ AGENT_MCP_TIMEOUT_MS: '60000', OPERATOR_DECISION_MARGIN_MS: '5000' }, REPO);
const req = { method: 'POST', url: '/a2a', headers: {}, body: '{}' };
const span = (w: { startedAt: string; deadline: string | null }) => (w.deadline ? Date.parse(w.deadline) - Date.parse(w.startedAt) : null);

/** Запрос к агенту без ответа, как у канала: исходящее событие и его обмен. */
function send(exec: Execution, ev: Omit<MessageEvent, 'seq' | 'ts'> | Omit<CommandEvent, 'seq' | 'ts'>, timeoutMs: number, behind: string | null = null) {
  const out = exec.add(ev as MessageEvent);
  const x = startExchange('agent', 'запрос', req, {}, timeoutMs);
  x.eventSeq = out.seq;
  exec.addHttp(x, behind);
  return x;
}
const message = (type: MessageEvent['type']) => ({ type, text: 'Реплика' }) as Omit<MessageEvent, 'seq' | 'ts'>;

test('ожидания: ход агента и служебная команда — со сроком запроса; ответ получен — ожидания нет', async () => {
  const exec = await execution({ env });
  const reset = send(exec, { type: 'command', name: 'reset', text: '/reset', status: 'running', reply: null, parsed: null, durationMs: null, by: 'runner' }, 120_000);
  const [cmd] = exec.waits();
  assert.deepEqual([cmd.scope, cmd.who, cmd.text, cmd.detail], ['turn', 'command', '/reset', null]);
  assert.equal(span(cmd), 120_000);
  finishExchange(reset, { status: 200, headers: {}, body: '{}' });
  const x = send(exec, message('start_message'), 900_000);
  const [w] = exec.waits();
  assert.deepEqual([w.scope, w.who, w.text, w.detail, w.blocked, w.hidden, w.remaining], ['turn', 'agent', 'Ход агента', 'Pagurus отвечает на стартовое сообщение', null, false, false]);
  assert.deepEqual([span(w), w.httpId], [900_000, x.id]);
  finishExchange(x, { status: 200, headers: {}, body: '{}' });
  assert.deepEqual(exec.waits(), []);
});

test('ожидания: в ручной сессии ход стоит на вызове без заглушки — ждёт вашего ответа, у вызова остаток до его срока', async (t) => {
  const exec = await execution({ env });
  t.after(() => exec.stop('cleanup'));
  send(exec, message('human_message'), 900_000);
  void exec.handleToolCall('get_smsbank_notifications', {}, exec.currentTaskId);
  const [turn, human] = exec.waits();
  assert.deepEqual([turn.text, turn.detail, turn.blocked], ['Ход агента', 'стоит: get_smsbank_notifications ждёт вашего ответа', 'human']);
  const p = exec.pendingList()[0];
  assert.deepEqual([human.scope, human.who, human.text, human.detail, human.remaining, human.callId, human.deadline], ['call', 'human', 'Ждёт вашего ответа', 'get_smsbank_notifications', true, p.callId, p.deadline]);
});

test('ожидания: в автоматическом прогоне ход стоит на подтверждении — решает LLM-оператор, у вызова время решения и общий срок', async (t) => {
  const exec = await execution({ env, mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  send(exec, message('operator_message'), 900_000);
  void exec.handleToolCall('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }, exec.currentTaskId);
  const callId = exec.pendingList()[0].callId;
  const label = 'LLM-оператор · подтверждение change_notifications_channel_for_case';
  exec.llmLog({ label, title: 'решает LLM-оператор', timeoutMs: 55_000, callId }).onExchange(startExchange('llm', label, req, {}, 120_000), 'start');
  const [turn, call, ...rest] = exec.waits();
  assert.deepEqual([turn.detail, turn.blocked], ['стоит: change_notifications_channel_for_case ждёт решения LLM-оператора', 'llm']);
  assert.deepEqual([call.scope, call.who, call.text, call.detail, call.hidden, call.callId], ['call', 'llm', 'решает LLM-оператор', null, true, callId]);
  assert.equal(span(call), 55_000);
  assert.deepEqual(rest, [], 'в автоматическом режиме человека не ждут');
});

test('ожидания: запрос за прерванным — в очереди, пока не пришли вызовы этого хода', async () => {
  const exec = await execution({ env });
  send(exec, message('human_message'), 1_800_000, 'Стартовое сообщение');
  let [w] = exec.waits();
  assert.deepEqual([w.detail, w.blocked, span(w)], ['в очереди за прерванным «Стартовое сообщение»', 'queue', 1_800_000]);
  await exec.handleToolCall('get_cases_assigned', {}, exec.currentTaskId);
  [w] = exec.waits();
  assert.deepEqual([w.detail, w.blocked], ['Pagurus отвечает на вашу реплику', null], 'вызов пришёл — агент уже работает над запросом');
});

test('ожидания: вызов LLM держит ход от начала до attach — пауза перед повтором и повтор подписаны, срок общий; у оценки срока нет', async () => {
  const exec = await execution({ env, mode: 'auto' });
  const log = exec.llmLog({ label: 'LLM-оператор · конец хода', title: 'LLM-оператор решает, что ответить', timeoutMs: 55_000 });
  const first = startExchange('llm', 'LLM-оператор · конец хода', req, {}, 120_000);
  log.onExchange(first, 'start');
  const [w] = exec.waits();
  assert.deepEqual([w.scope, w.who, w.text, w.detail, w.hidden, span(w)], ['turn', 'llm', 'LLM-оператор решает, что ответить', null, true, 55_000]);
  finishExchange(first, { status: 503, headers: {}, body: '' });
  log.onExchange(first, 'end');
  assert.equal(exec.waits()[0].detail, 'пауза перед повтором', 'между попытками строка не пропадает');
  const second = startExchange('llm', 'LLM-оператор · конец хода · повтор 1', req, {}, 120_000);
  log.onExchange(second, 'start');
  const [r] = exec.waits();
  assert.deepEqual([r.detail, r.startedAt, r.deadline, r.httpId], ['повтор 1', w.startedAt, w.deadline, second.id], 'время и срок — у всего вызова');
  log.attach(exec.add<NoteEvent>({ type: 'note', text: 'решение' }));
  assert.deepEqual(exec.waits(), []);
  // Оценка: общего срока нет; попытка подписана номером прогона. Сбой до первой попытки тоже снимает ожидание.
  const answer = exec.llmLog({ label: ANSWER_LABEL, title: 'LLM-оценка: эталонный текст' });
  answer.onExchange(startExchange('llm', `${ANSWER_LABEL}, прогон 2 из 3`, req, {}, 120_000), 'start');
  const [a] = exec.waits();
  assert.deepEqual([a.text, a.detail, a.deadline], ['LLM-оценка: эталонный текст', 'прогон 2 из 3', null]);
  answer.attach(exec.add<NoteEvent>({ type: 'note', text: 'оценка' }));
  const failed = exec.llmLog({ label: JUDGE_LABEL, title: 'LLM-оценка: критерии ответа' });
  assert.equal(exec.waits()[0].text, 'LLM-оценка: критерии ответа');
  failed.attach(exec.add<NoteEvent>({ type: 'note', text: 'сбой оценки' }));
  assert.deepEqual(exec.waits(), []);
});

test('ожидания: два вызова ждут решения — ход стоит на обоих, у каждого вызова своё ожидание', async (t) => {
  const exec = await execution({ env });
  t.after(() => exec.stop('cleanup'));
  send(exec, message('human_message'), 900_000);
  void exec.handleToolCall('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }, exec.currentTaskId);
  void exec.handleToolCall('get_smsbank_notifications', {}, exec.currentTaskId);
  const waits = exec.waits();
  assert.deepEqual([waits[0].detail, waits[0].blocked], ['стоит: 2 вызова ждут вашего решения', 'human']);
  assert.deepEqual(
    waits.filter((w) => w.scope === 'call').map((w) => [w.text, w.detail]),
    [
      ['Ждёт вашего решения', 'change_notifications_channel_for_case'],
      ['Ждёт вашего ответа', 'get_smsbank_notifications'],
    ],
  );
});
