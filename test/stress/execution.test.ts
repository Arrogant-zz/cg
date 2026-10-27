import assert from 'node:assert/strict';
import type { CommandEvent } from '../../src/execution/events.js';
import { execution, stress } from './helpers.js';

stress('EXEC-01 подтверждение нельзя подменить ответом инструмента, повторное решение игнорируется', async (t) => {
  const exec = await execution(); t.after(() => exec.stop('cleanup'));
  const pending = exec.handleToolCall('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }, exec.currentTaskId);
  const callId = exec.pendingList()[0].callId;
  assert.equal(exec.resolvePending(callId, { action: 'answer', text: 'injected' }), false);
  assert.equal(exec.pending.size, 1);
  assert.equal(exec.resolvePending(callId, { action: 'reject', by: 'human' }), true);
  assert.equal(exec.resolvePending(callId, { action: 'approve', by: 'human' }), false);
  assert.equal((await pending).isError, true);
  assert.equal(exec.stub.state.channel, 'EMAIL'); assert.equal(exec.pending.size, 0);
});

stress('EXEC-02 остановка сразу разрешает и подтверждение, и ручной ответ', async (t) => {
  const exec = await execution(); t.after(() => exec.stop('cleanup'));
  const confirm = exec.handleToolCall('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }, exec.currentTaskId);
  const answer = exec.handleToolCall('get_smsbank_notifications', {}, exec.currentTaskId);
  assert.equal(exec.pending.size, 2);
  exec.stop('stress-stop');
  assert.ok((await confirm).isError); assert.ok((await answer).isError);
  assert.equal(exec.pending.size, 0); assert.equal(exec.stub.state.channel, 'EMAIL');
  assert.ok(exec.toolCalls().every((c) => c.outcome === 'stopped' && !c.executed));
});

stress('EXEC-03 поздний вызов после closeTools не меняет состояние и не ждёт человека', async () => {
  const exec = await execution(); exec.closeTools();
  const r = await exec.handleToolCall('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }, exec.currentTaskId);
  assert.ok(r.isError); assert.equal(exec.pending.size, 0); assert.equal(exec.stub.state.channel, 'EMAIL');
});

stress('EXEC-04 таймаут подтверждения завершает вызов без эффекта', async () => {
  const exec = await execution();
  const r = await exec.handleToolCall('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }, exec.currentTaskId);
  assert.ok(r.isError); assert.equal(exec.toolCalls()[0].outcome, 'timeout');
  assert.equal(exec.pending.size, 0); assert.equal(exec.stub.state.channel, 'EMAIL');
});

stress('EXEC-05 отмена во время delayMs не оставляет эффект невыполненного вызова', async (t) => {
  const exec = await execution(); t.after(() => exec.stop('cleanup'));
  exec.caseDef.tools.get_channel_cases = [{
    id: 'delayed', tool: 'get_channel_cases', origin: 'case', index: 0,
    delayMs: 200, result: { json: { status: 'done' } }, effect: { channel: 'SMS' },
  }];
  const call = exec.handleToolCall('get_channel_cases', {}, exec.currentTaskId);
  exec.stop('cancel-during-delay');
  assert.ok((await call).isError);
  assert.equal(exec.toolCalls()[0].executed, false);
  assert.equal(exec.stub.state.channel, 'EMAIL', 'вызов прерван и не выполнен, но effect уже применён');
});

stress('EXEC-06 ошибка слушателя событий не ломает выполнение', async () => {
  const exec = await execution();
  exec.onChange(() => { throw new Error('broken UI observer'); });
  const r = await exec.handleToolCall('get_cases_assigned', {}, exec.currentTaskId);
  assert.ok(!r.isError); assert.equal(exec.toolCalls().length, 1);
});

stress('EXEC-07 две сессии одного кейса не разделяют состояние, решения и очередь', async (t) => {
  const a = await execution(); const b = await execution({ id: 'stress-other' });
  t.after(() => { a.stop('cleanup'); b.stop('cleanup'); });
  const call = a.handleToolCall('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }, a.currentTaskId);
  a.resolvePending(a.pendingList()[0].callId, { action: 'approve', by: 'human' });
  assert.ok(!(await call).isError); assert.equal(a.stub.state.channel, 'SMS');
  assert.equal(b.stub.state.channel, 'EMAIL'); assert.equal(b.toolCalls().length, 0);
});

stress('EXEC-08 резерв taskId возвращается следующему запросу ровно один раз', async () => {
  const exec = await execution();
  exec.add<CommandEvent>({ type: 'command', name: 'reset', text: '/reset', status: 'ok', by: 'runner',
    reply: 'ok', parsed: null, durationMs: 0 });
  const reserved = exec.reserveTaskId();
  assert.equal(exec.reserveTaskId(), reserved);
  assert.equal(exec.taskIdForRequest(), reserved);
  assert.notEqual(exec.taskIdForRequest(), reserved);
});
