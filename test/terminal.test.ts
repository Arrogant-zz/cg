// Терминальные инструменты: пометка terminal в контракте, закрытие кейса выполненным вызовом, вызовы после закрытия.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry } from '../src/config/loader.js';
import { loadEnv } from '../src/env.js';
import { terminalMatches } from '../src/stubs/engine.js';
import type { Execution } from '../src/execution/execution.js';
import { runDialog } from '../src/execution/dialog.js';
import { execStats } from '../src/execution/evaluate.js';
import type { DecisionEvent, NoteEvent } from '../src/execution/events.js';
import { operatorContext } from '../src/operator/operator.js';
import { OPERATOR_PROMPT_VERSION, OPERATOR_SYSTEM } from '../src/operator/prompts.js';
import { StructuredError } from '../src/llm/structured.js';
import { CONFIG, REPO, startStand, until, type Stand } from './helpers.js';
import { agent, approveAll, call, deps, execution, held, operator, whenTrue } from './dialog-helpers.js';

const last = (exec: Execution, tool: string) => exec.toolCalls().filter((c) => c.tool === tool).at(-1)!;
const close = { request: { shortAnswer: 'Уведомления будут приходить в SMS', extendedAnswer: 'Канал уведомлений изменён на SMS.' } };

async function closed(exec: Execution): Promise<void> {
  const r = call(exec, 'get_close_with_answer', close);
  exec.resolvePending(await held(exec, 'get_close_with_answer', 'confirmation'), { action: 'approve', by: 'human' });
  assert.equal((await r).isError, undefined);
}

/** Копия справочников стенда с правкой контракта инструментов. */
async function withContract(edit: (contract: any) => void, fn: (dir: string, text: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-terminal-'));
  try {
    fs.cpSync(CONFIG, dir, { recursive: true });
    const file = path.join(dir, 'contracts/tools.json');
    const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(contract);
    const text = JSON.stringify(contract, null, 2) + '\n';
    fs.writeFileSync(file, text);
    await fn(dir, text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tool = (contract: any, name: string) => contract.tools.find((t: any) => t.name === name);
const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

test('пометка terminal: true, false и { when } загружаются; без errors.closed — текст по умолчанию; неверный тип — ошибка с полем и строкой', async () => {
  const reg = await loadRegistry(CONFIG);
  const byName = (n: string) => reg.contract!.tools.find((t) => t.name === n)!;
  assert.deepEqual(byName('get_close_with_answer').terminal, { when: null });
  assert.deepEqual(byName('change_stage').terminal, { when: { 'request.keepOnSelf': false } });
  assert.equal(byName('get_cases_history').terminal, null, 'без пометки — не терминальный');
  assert.ok(!('terminal' in byName('get_close_with_answer').listed), 'пометка не входит в определение для tools/list');
  assert.match(reg.contract!.errors.closed, /закрыто/);

  await withContract(
    (c) => {
      tool(c, 'cases_postpone').terminal = false;
      delete c.errors.closed;
    },
    async (dir) => {
      const r = await loadRegistry(dir);
      assert.equal(r.contract!.tools.find((t) => t.name === 'cases_postpone')!.terminal, null);
      assert.equal(r.contract!.errors.closed, 'Обращение уже закрыто: инструмент {{tool}} недоступен.', 'текст по умолчанию');
      assert.deepEqual(r.issues.filter((i) => i.file === 'contracts/tools.json'), []);
    },
  );

  await withContract(
    (c) => {
      tool(c, 'cases_postpone').terminal = 'yes';
    },
    async (dir, text) => {
      const r = await loadRegistry(dir);
      const index = JSON.parse(text).tools.findIndex((t: any) => t.name === 'cases_postpone');
      const bad = r.issues.find((i) => i.file === 'contracts/tools.json' && i.severity === 'error');
      assert.deepEqual([bad?.field, bad?.line], [`tools[${index}].terminal`, lineOf(text, '"terminal": "yes"')]);
      assert.equal(r.contract, null, 'контракт с ошибкой схемы не загружается');
    },
  );
});

test('условие terminal: регулярное выражение проверяется при загрузке с флагом u, ошибка — с полем и строкой контракта', async () => {
  await withContract(
    (c) => {
      tool(c, 'change_stage').terminal = { when: { 'request.stageId': { regex: '[\\w-.]+' } } };
    },
    async (dir, text) => {
      const r = await loadRegistry(dir);
      const index = JSON.parse(text).tools.findIndex((t: any) => t.name === 'change_stage');
      const found = r.issues.filter((i) => i.file === 'contracts/tools.json' && i.reason.startsWith('Регулярное выражение не компилируется'));
      assert.deepEqual(
        found.map((i) => [i.severity, i.field, i.line]),
        [['error', `tools[${index}].terminal.when.request.stageId.regex`, lineOf(text, '"regex": "[\\\\w-.]+"')]],
      );
    },
  );
});

test('вызов подходит под пометку terminal: условие when на аргументы, как у заглушек', () => {
  const stage = { terminal: { when: { 'request.keepOnSelf': false } } };
  assert.ok(terminalMatches(stage, { request: { keepOnSelf: false } }));
  assert.ok(terminalMatches(stage, { request: { keepOnSelf: 'false' } }), 'скаляры сравниваются как строки');
  assert.ok(!terminalMatches(stage, { request: { keepOnSelf: true } }));
  assert.ok(!terminalMatches(stage, { request: {} }), 'без аргумента — не терминальный');
  assert.ok(terminalMatches({ terminal: { when: null } }, {}), 'terminal: true — любой вызов');
  assert.ok(!terminalMatches({ terminal: null }, {}));
  assert.ok(!terminalMatches(undefined, {}), 'инструмента нет в контракте');
});

test('закрытие: выполненный терминальный вызов закрывает кейс; отклонение, ошибка заглушки и аргументы не по условию — нет', async (t) => {
  const exec = await execution();
  t.after(() => exec.stop('cleanup'));

  const rejected = call(exec, 'get_close_with_answer', close);
  assert.equal(last(exec, 'get_close_with_answer').terminal, true, 'вызов подходит под пометку уже при поступлении');
  exec.resolvePending(await held(exec, 'get_close_with_answer', 'confirmation'), { action: 'reject', by: 'human' });
  assert.equal((await rejected).isError, true);
  assert.equal(exec.closedBy, null, 'отклонённый вызов кейс не закрывает');

  const keep = call(exec, 'change_stage', { request: { comment: 'на себе', keepOnSelf: true, stageId: 'ST-2' } });
  assert.equal(last(exec, 'change_stage').terminal, undefined);
  exec.resolvePending(await held(exec, 'change_stage', 'confirmation'), { action: 'approve', by: 'human' });
  exec.resolvePending(await held(exec, 'change_stage', 'answer'), { action: 'answer', json: { status: 'MOVED' } });
  assert.equal((await keep).isError, undefined);
  assert.equal(exec.closedBy, null, 'аргументы не по условию — кейс не закрыт');

  exec.caseDef.tools.cases_postpone = [{ id: 'fail', tool: 'cases_postpone', origin: 'case', index: 0, error: 'POSTPONE_FAILED' }];
  const failed = call(exec, 'cases_postpone', { request: { comment: 'ждём', postponeDateTime: '2026-11-01T10:00:00Z' } });
  exec.resolvePending(await held(exec, 'cases_postpone', 'confirmation'), { action: 'approve', by: 'human' });
  assert.equal((await failed).isError, true);
  assert.equal(exec.closedBy, null, 'ответ заглушки с ошибкой кейс не закрывает');

  await closed(exec);
  const ev = last(exec, 'get_close_with_answer');
  assert.deepEqual(exec.closedBy, { seq: ev.seq, tool: 'get_close_with_answer' });
  assert.deepEqual([ev.executed, ev.closedCase, exec.stub.state.case], [true, true, 'closed'], 'агент получил ответ заглушки, эффект применён');
  assert.deepEqual(exec.toJSON().closedBy, exec.closedBy);
});

test('после закрытия: чтение — по заглушке, действие и второй финал — сразу errors.closed, чтение без заглушки не ждёт человека', async (t) => {
  const exec = await execution();
  t.after(() => exec.stop('cleanup'));
  await closed(exec);

  const read = await call(exec, 'get_channel_cases');
  assert.equal(read.isError, undefined);
  assert.deepEqual([last(exec, 'get_channel_cases').outcome, last(exec, 'get_channel_cases').afterClose], ['stub', true]);

  const action = await call(exec, 'change_notifications_channel_for_case', { request: { channelCode: 'SMS' } });
  assert.deepEqual([action.isError, action.content[0].text], [true, 'Обращение уже закрыто: инструмент change_notifications_channel_for_case недоступен.']);
  const a = last(exec, 'change_notifications_channel_for_case');
  assert.deepEqual([a.outcome, a.executed, a.afterClose, a.confirmation?.by], ['closed', false, true, 'closed']);
  assert.equal(exec.stub.state.channel, 'EMAIL', 'действие не выполнено');

  const second = await call(exec, 'cases_postpone', { request: { comment: 'ждём', postponeDateTime: '2026-11-01T10:00:00Z' } });
  assert.equal(second.isError, true);
  assert.deepEqual([last(exec, 'cases_postpone').outcome, exec.closedBy?.tool], ['closed', 'get_close_with_answer'], 'кейс закрыт первым действием');

  const unmatched = await call(exec, 'get_smsbank_notifications');
  assert.equal(unmatched.isError, true);
  assert.deepEqual([last(exec, 'get_smsbank_notifications').outcome, last(exec, 'get_smsbank_notifications').unexpected], ['no_stub', true]);
  assert.equal(exec.pending.size, 0, 'ничто не ждёт человека');
});

test('ждущие вызовы в момент закрытия сразу получают ответ: подтверждение — errors.closed, ручной ответ — «нет заглушки»', async (t) => {
  const exec = await execution();
  t.after(() => exec.stop('cleanup'));
  const action = call(exec, 'change_notifications_channel_for_case', { request: { channelCode: 'SMS' } });
  const read = call(exec, 'get_smsbank_notifications');
  await held(exec, 'change_notifications_channel_for_case', 'confirmation');
  await held(exec, 'get_smsbank_notifications', 'answer');
  const t0 = Date.now();
  await closed(exec);
  assert.equal((await action).isError, true);
  assert.equal((await read).isError, true);
  assert.ok(Date.now() - t0 < 5000, 'без ожидания таймаута');
  const a = last(exec, 'change_notifications_channel_for_case');
  const r = last(exec, 'get_smsbank_notifications');
  assert.deepEqual([a.outcome, a.afterClose, a.confirmation?.decision, a.confirmation?.by], ['closed', true, 'reject', 'closed']);
  assert.deepEqual([r.outcome, r.afterClose], ['no_stub', true]);
  assert.equal(exec.stub.state.channel, 'EMAIL');
});

test('ответ человека вместо терминального инструмента без заглушки: JSON закрывает кейс, ошибка — нет', async (t) => {
  const answered = await execution();
  t.after(() => answered.stop('cleanup'));
  const r = call(answered, 'cases_postpone', { request: { comment: 'ждём', postponeDateTime: '2026-11-01T10:00:00Z' } });
  answered.resolvePending(await held(answered, 'cases_postpone', 'confirmation'), { action: 'approve', by: 'human' });
  answered.resolvePending(await held(answered, 'cases_postpone', 'answer'), { action: 'answer', json: { status: 'POSTPONED' } });
  assert.equal((await r).isError, undefined);
  assert.deepEqual([answered.closedBy?.tool, last(answered, 'cases_postpone').outcome], ['cases_postpone', 'manual']);

  const failed = await execution();
  t.after(() => failed.stop('cleanup'));
  const f = call(failed, 'change_stage', { request: { comment: 'дальше', keepOnSelf: false, stageId: 'ST-3' } });
  assert.equal(last(failed, 'change_stage').terminal, true);
  failed.resolvePending(await held(failed, 'change_stage', 'confirmation'), { action: 'approve', by: 'human' });
  failed.resolvePending(await held(failed, 'change_stage', 'answer'), { action: 'error', message: 'STAGE_LOCKED' });
  assert.equal((await f).isError, true);
  assert.equal(failed.closedBy, null, 'ответ-ошибка человека кейс не закрывает');
});

// ---------------------------------------------------------------- автоматический диалог

test('диалог: после терминального вызова агент договаривает ход, оператор не вызывается; закрытие в последнем ходе — «Завершён», а не лимит', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(approveAll);
  const out = await runDialog(
    exec,
    deps(agent([async (x) => {
      await call(x, 'get_channel_cases');
      await call(x, 'get_close_with_answer', close);
      return 'Кейс закрыт, ответ отправлен клиенту.';
    }]), op, { limits: { maxTurns: 1, maxDurationSec: 60, maxOperatorCalls: 20 } }),
  );
  assert.deepEqual([out.status, out.reason, exec.endedBy], ['completed', 'Выполнен терминальный инструмент get_close_with_answer', 'terminal']);
  assert.deepEqual(seen, ['confirmation get_close_with_answer'], 'решения на конец хода после закрытия нет');
  assert.equal(exec.messages().at(-1)!.text, 'Кейс закрыт, ответ отправлен клиенту.', 'ответ агента сохранён');
  assert.deepEqual([out.resultSeq, exec.closedTurnEndSeq], [exec.events.at(-1)!.seq, exec.messages().at(-1)!.seq]);
});

test('диалог: технический сбой в ходе с закрытием важнее закрытия — таймаут агента после закрытия, таймаут оператора до него', async (t) => {
  const late = await execution({ mode: 'auto' });
  t.after(() => late.stop('cleanup'));
  const out = await runDialog(late, deps(agent([async (x) => {
    await call(x, 'get_close_with_answer', close);
    return { error: 'timeout' };
  }]), operator(approveAll).op));
  assert.deepEqual([out.status, late.closedBy?.tool, late.endedBy], ['agent_timeout', 'get_close_with_answer', null]);

  // Удержание MCP-вызова — 1 с: AGENT_MCP_TIMEOUT_MS − OPERATOR_DECISION_MARGIN_MS, но не меньше секунды.
  const slow = await execution({ mode: 'auto', env: loadEnv({ AGENT_MCP_TIMEOUT_MS: '2000', OPERATOR_DECISION_MARGIN_MS: '1000' }, REPO) });
  t.after(() => slow.stop('cleanup'));
  const { op } = operator((e) => (e.type === 'confirmation' && e.call.tool === 'change_notifications_channel_for_case' ? new Promise(() => {}) : approveAll(e)));
  const out2 = await runDialog(slow, deps(agent([async (x) => {
    await call(x, 'change_notifications_channel_for_case', { request: { channelCode: 'SMS' } });
    await call(x, 'get_close_with_answer', close);
    return 'Закрыл кейс.';
  }]), op, { confirmationTimeoutMs: 1000 }));
  assert.deepEqual([out2.status, slow.closedBy?.tool], ['operator_timeout', 'get_close_with_answer']);
});

test('диалог: реплика к отклонению не уходит, если в том же ходе кейс закрыт; решение помечено, в журнале скрытая заметка', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const { op } = operator(async (e, x) => {
    if (e.type !== 'confirmation') return { reply: 'Что дальше?' };
    const first = x.toolCalls().filter((c) => c.tool === 'get_close_with_answer').length === 1;
    return first ? { confirmation: 'reject', reply: 'Сначала проверьте каналы уведомлений', correction: true } : { confirmation: 'approve' };
  });
  const out = await runDialog(exec, deps(agent([async (x) => {
    assert.equal((await call(x, 'get_close_with_answer', close)).isError, true);
    await call(x, 'get_channel_cases');
    await call(x, 'get_close_with_answer', close);
    return 'Проверил каналы и закрыл кейс.';
  }]), op));
  assert.deepEqual([out.status, exec.endedBy], ['completed', 'terminal']);
  assert.equal(exec.events.filter((e) => e.type === 'operator_message').length, 0, 'реплика агенту не ушла');
  const decisions = exec.events.filter((e): e is DecisionEvent => e.type === 'operator_decision');
  assert.deepEqual(decisions.map((d) => [d.decision?.confirmation, d.replyDropped]), [['reject', true], ['approve', undefined]]);
  const note = exec.events.find((e): e is NoteEvent => e.type === 'note' && e.text.startsWith('Реплика оператора не отправлена'));
  assert.ok(note?.hidden, 'заметка скрыта от агента');
});

test('диалог: решение по вызову, который закрытие уже отклонило, ни на что не влияет — ни репликой, ни сбоем', async (t) => {
  for (const variant of ['реплика', 'сбой'] as const) {
    const exec = await execution({ mode: 'auto' });
    t.after(() => exec.stop('cleanup'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { op } = operator(async (e) => {
      if (e.type === 'confirmation' && e.call.tool === 'change_notifications_channel_for_case') {
        await gate;
        if (variant === 'сбой') throw new StructuredError('timeout', 'Модель не ответила вовремя', []);
        return { confirmation: 'reject', reply: 'Канал не меняйте', correction: true };
      }
      return approveAll(e);
    });
    const out = await runDialog(exec, deps(agent([async (x) => {
      const action = call(x, 'change_notifications_channel_for_case', { request: { channelCode: 'SMS' } });
      await held(x, 'change_notifications_channel_for_case', 'confirmation');
      await call(x, 'get_close_with_answer', close);
      assert.equal((await action).isError, true);
      release();
      await whenTrue(() => x.events.some((e) => e.type === 'operator_decision' && (e as DecisionEvent).moot), 'запоздалое решение записано');
      return 'Закрыл кейс.';
    }]), op));
    assert.deepEqual([variant, out.status, exec.endedBy], [variant, 'completed', 'terminal']);
    const late = exec.events.find((e): e is DecisionEvent => e.type === 'operator_decision' && e.event === 'confirmation' && !!e.moot)!;
    assert.equal(!!late.error, variant === 'сбой');
    assert.equal(exec.events.filter((e) => e.type === 'operator_message').length, 0);
    assert.ok(!exec.events.some((e) => e.type === 'note' && (e as NoteEvent).text.startsWith('Реплика оператора не отправлена')), 'реплика запоздалого решения в очередь не встаёт');
  }
});

test('диалог: проверяющая корзина с confirmations: approve — терминальный вызов разрешён правилом, кейс закрыт без модели оператора', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const { op, seen } = operator(async () => {
    throw new Error('оператор не должен вызываться');
  });
  const out = await runDialog(exec, deps(agent([async (x) => {
    await call(x, 'get_close_with_answer', close);
    return 'Закрыл кейс.';
  }]), op, { mode: 'checking' }));
  assert.deepEqual([out.status, exec.endedBy, seen], ['completed', 'terminal', []]);
  const d = exec.events.find((e): e is DecisionEvent => e.type === 'operator_decision')!;
  assert.match(d.forced ?? '', /Проверяющая корзина/);
});

test('поправки: учитывается то, что дошло до агента — отклонение с неотправленной репликой да, разрешение с репликой и запоздалое решение нет', async (t) => {
  const exec = await execution({ mode: 'auto' });
  t.after(() => exec.stop('cleanup'));
  const decision = (d: Record<string, unknown>, extra: Partial<DecisionEvent>) =>
    exec.add<DecisionEvent>({ type: 'operator_decision', hidden: true, event: 'confirmation', decision: { correction: true, lessonNote: null, ...d }, model: 'fake-operator', durationMs: 1, usage: null, attempts: [], ...extra });
  decision({ confirmation: 'reject', lessonId: 'L-dropped', reply: 'Сначала проверьте каналы' }, { replyDropped: true });
  decision({ confirmation: 'approve', lessonId: 'L-approve', reply: 'В следующий раз проверьте каналы' }, { replyDropped: true });
  decision({ confirmation: 'reject', lessonId: 'L-moot', reply: null }, { moot: true });
  const stats = execStats(exec);
  assert.deepEqual([stats.corrections, stats.lessons], [1, ['L-dropped']]);
});

test('LLM-оператор: в событии подтверждения видно, закроет ли вызов кейс; подсказка operator-v3 объясняет терминальное действие и неотправленные реплики', async (t) => {
  const exec = await execution();
  t.after(() => exec.stop('cleanup'));
  const limits = { maxTurns: 6, maxDurationSec: 60, maxOperatorCalls: 20 };
  const ctx = (tool: string, args: Record<string, unknown>) => {
    void call(exec, tool, args);
    const event = operatorContext(exec, { type: 'confirmation', call: last(exec, tool) }, 'training', limits, false).event as { terminal: boolean };
    return event.terminal;
  };
  assert.equal(ctx('get_close_with_answer', close), true);
  assert.equal(ctx('change_stage', { request: { comment: 'на себе', keepOnSelf: true, stageId: 'ST-2' } }), false);
  assert.equal(ctx('change_notifications_channel_for_case', { request: { channelCode: 'SMS' } }), false);
  assert.equal(OPERATOR_PROMPT_VERSION, 'operator-v3');
  assert.match(OPERATOR_SYSTEM, /подсказка operator-v3/);
  assert.match(OPERATOR_SYSTEM, /terminal=true/);
  assert.match(OPERATOR_SYSTEM, /unsentReplies/);
  assert.match(OPERATOR_SYSTEM, /sent=false/);
});

// ---------------------------------------------------------------- ручная сессия на fake-agent

/** Ручная сессия notifications-channel-change: ответ вместо инструмента, смена канала, «можно закрывать», разрешение закрытия. */
async function manual(s: Stand) {
  const created = await s.api('POST', '/api/manual', { case: 'notifications-channel-change', agent: 'fake-agent' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id as number;
  const get = async () => (await s.api('GET', `/api/manual/${id}`)).data;
  const pending = (kind: string, tool: string) => until(async () => (await get()).execution?.pending.find((p: any) => p.kind === kind && p.tool === tool) ?? null, 20000, `${tool}: ${kind}`);
  const idle = () => until(async () => ((await get()).busy === null ? true : null), 20000, 'конец хода');
  const decide = async (kind: string, tool: string, body: Record<string, unknown>) => {
    const p = await pending(kind, tool);
    assert.equal((await s.api('POST', `/api/manual/${id}/tool/${p.callId}`, body)).status, 200);
  };
  /** Начало кейса: агент ждёт ответа вместо get_smsbank_notifications и решения по смене канала. */
  const start = async () => {
    await decide('answer', 'get_smsbank_notifications', { action: 'answer', text: '{"notifications":[]}' });
    await decide('confirmation', 'change_notifications_channel_for_case', { action: 'approve' });
    await idle();
  };
  const close = async () => {
    assert.equal((await s.api('POST', `/api/manual/${id}/message`, { text: 'Хорошо, можно закрывать обращение.' })).status, 200);
    await decide('confirmation', 'get_close_with_answer', { action: 'approve' });
    await idle();
  };
  return { id, get, start, close, idle };
}

test('ручная сессия: после закрытия реплика — 409, команды доступны, оценка до конца терминального хода; /reset начинает кейс заново', async () => {
  const s = await startStand();
  try {
    const dir = (await s.api('GET', '/api/directory')).data;
    assert.deepEqual(dir.tools.filter((t: any) => t.terminal).map((t: any) => t.name).sort(), ['cases_postpone', 'change_stage', 'change_stage_case', 'get_close_with_answer', 'postpone_expertises']);
    assert.deepEqual(dir.tools.find((t: any) => t.name === 'change_stage').terminal, { when: { 'request.keepOnSelf': false } });

    const a = await manual(s);
    await a.start();
    await a.close();
    let m = await a.get();
    assert.equal(m.execution.closedBy.tool, 'get_close_with_answer');
    const refused = await s.api('POST', `/api/manual/${a.id}/message`, { text: 'И ещё один вопрос' });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Кейс закрыт терминальным инструментом get_close_with_answer/);
    assert.equal((await s.api('POST', `/api/manual/${a.id}/command`, { name: 'capture' })).status, 200, 'команды после закрытия доступны');
    await a.idle();
    m = await a.get();
    const capture = m.execution.events.find((e: any) => e.type === 'command' && e.name === 'capture');
    assert.ok(capture && capture.status !== 'running' && capture.reply, 'ответ /case-capture в истории');
    const fin = await s.api('POST', `/api/manual/${a.id}/finish`, {});
    assert.equal(fin.status, 200, JSON.stringify(fin.data));
    const ex = fin.data.execution;
    assert.deepEqual([ex.endedBy, ex.reason], ['terminal', 'Выполнен терминальный инструмент get_close_with_answer']);
    assert.ok(ex.closedTurnEndSeq < capture.seq, '/case-capture — после конца терминального хода');
    assert.ok(fin.data.evaluation.checks.every((c: any) => c.evidence.every((seq: number) => seq <= ex.closedTurnEndSeq)), 'проверки — по событиям до конца терминального хода');

    const b = await manual(s);
    await b.start();
    await b.close();
    assert.equal((await s.api('POST', `/api/manual/${b.id}/command`, { name: 'reset' })).status, 200);
    await until(async () => {
      const x = await b.get();
      return !x.execution.closedBy && x.execution.events.filter((e: any) => e.type === 'start_message').length === 2 ? true : null;
    }, 20000, 'кейс начат заново');
    await b.start();
    assert.equal((await s.api('POST', `/api/manual/${b.id}/message`, { text: 'Уточните, пожалуйста, ответ клиенту.' })).status, 200, 'после /reset реплики снова принимаются');
    await b.idle();
    const fin2 = await s.api('POST', `/api/manual/${b.id}/finish`, {});
    assert.equal(fin2.status, 200, JSON.stringify(fin2.data));
    assert.deepEqual([fin2.data.execution.endedBy, fin2.data.execution.closedBy], ['human', null]);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- прогон обучения на fake-agent

test('прогон обучения: кейс закрыт терминальным инструментом; после закрытия чтение — по заглушке, действие и второй финал — errors.closed; затем capture и curator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-terminal-run-'));
  fs.cpSync(CONFIG, dir, { recursive: true });
  // Тематика скилла сборки fake-agent after-close: после закрытия он читает историю, пишет заметку и откладывает кейс.
  const files: Record<string, string> = {
    'cases/after-close.yaml': [
      'id: after-close',
      'title: Действия после закрытия',
      'topic: Тест / Действия после закрытия',
      'situation: Синтетический кейс проверки терминальных инструментов.',
      'state: { case: open }',
      'tools:',
      '  get_cases_assigned:',
      '    - id: case',
      '      result: { json: { caseId: CASE-TEST-9001, taskId: "{{execution.taskId}}", status: IN_WORK, clientMessage: "Решите моё обращение." } }',
      '  get_static_attributes_assigned:',
      '    - id: static',
      '      result: { json: { classifier: { categoryName: Тест / Действия после закрытия }, channel: CHAT } }',
      '  get_close_with_answer:',
      '    - id: closed',
      '      result: { json: { caseId: CASE-TEST-9001, status: CLOSED } }',
      '      effect: { case: closed }',
      'reference:',
      '  answer: Ваше обращение решено.',
      '  finalClass: close_answer',
      '  tools: [get_close_with_answer]',
      '  criteria:',
      '    - id: solved',
      '      text: Сообщает, что обращение решено',
      '      hint: решено',
      '  actions:',
      '    required:',
      '      - tool: get_close_with_answer',
      '    final: get_close_with_answer',
    ].join('\n'),
    'solutions/after-close/plain.yaml': ['case: after-close', 'title: «Без подсказок»', 'goal: кейс закрывается терминальным инструментом.', 'operator:', '  style: minimal', '  instruction: Разрешай действия, которые соответствуют эталону.'].join('\n'),
    'baskets/after-close-train.yaml': ['id: after-close-train', 'title: Обучение · действия после закрытия', 'type: training', 'curator: { every: 1, final: false, resetBefore: true }', 'items:', '  - solution: after-close/plain'].join('\n'),
    'runs/after-close-train.yaml': [
      'id: after-close-train',
      'title: Обучение · действия после закрытия',
      'basket: after-close-train',
      'agent: fake-agent',
      'models: { operator: fake-operator, judge: fake-judge }',
      'metrics: all',
      'limits: { maxTurns: 10, maxDurationSec: 300, maxOperatorCalls: 20 }',
      'repetitions: 1',
    ].join('\n'),
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text + '\n');
  }
  const s = await startStand({ CLAWGYM_CONFIG: dir });
  try {
    const created = await s.api('POST', '/api/runs', { config: 'after-close-train' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const run = await s.waitRun(created.data.id);
    assert.equal(run.status, 'completed', run.error ?? '');
    const item = run.lines[0].items.find((i: any) => i.kind === 'case');
    assert.deepEqual([item.status, item.reason, item.outcome], ['completed', 'все проверки пройдены', 'passed']);
    assert.equal(item.steps.capture.status, 'ok', '/case-capture после оценки');
    assert.deepEqual(run.lines[0].curatorPasses.map((p: any) => [p.afterPos, p.status]), [[1, 'ok']], 'кейс вошёл в счётчик curator');

    const ex = (await s.api('GET', `/api/runs/${run.id}/executions/${item.execName}`)).data;
    assert.deepEqual([ex.status, ex.reason, ex.endedBy, ex.closedBy.tool], ['completed', 'Выполнен терминальный инструмент get_close_with_answer', 'terminal', 'get_close_with_answer']);
    const calls = ex.events.filter((e: any) => e.type === 'tool_call');
    const of = (tool: string) => calls.find((c: any) => c.tool === tool);
    assert.deepEqual([of('get_close_with_answer').closedCase, of('get_close_with_answer').executed], [true, true]);
    assert.deepEqual([of('get_cases_history').outcome, of('get_cases_history').afterClose], ['default', true], 'чтение — по заглушке по умолчанию');
    for (const tool of ['add_note_in_case', 'cases_postpone']) {
      assert.deepEqual([tool, of(tool).outcome, of(tool).executed, of(tool).afterClose], [tool, 'closed', false, true]);
      assert.match(of(tool).result, /Обращение уже закрыто/);
    }
    const decisions = ex.events.filter((e: any) => e.type === 'operator_decision');
    assert.ok(!decisions.some((d: any) => d.event === 'confirmation' && ['add_note_in_case', 'cases_postpone'].includes(calls.find((c: any) => c.callId === d.callId)?.tool)), 'по вызовам после закрытия оператора не спрашивали');
    const closeSeq = of('get_close_with_answer').seq;
    assert.ok(!decisions.some((d: any) => d.event === 'turn_end' && d.seq > closeSeq), 'после закрытия решений на конец хода нет');
    const lastAgent = ex.events.filter((e: any) => e.type === 'agent_message').at(-1);
    assert.match(lastAgent.text, /Обращение обработано/, 'агент договорил ход');
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
