// Сценарные тесты диалога: выполнение кейса, агент-сценарий и LLM-оператор по сценарию вместо настоящих агента и модели.
import assert from 'node:assert/strict';
import { loadRegistry } from '../src/config/loader.js';
import { loadEnv } from '../src/env.js';
import type { BasketType } from '../src/config/types.js';
import { Execution, type ExecutionInit } from '../src/execution/execution.js';
import type { DialogDeps } from '../src/execution/dialog.js';
import type { AgentChannel } from '../src/execution/channel.js';
import type { CommandEvent, MessageEvent, NoteEvent } from '../src/execution/events.js';
import { operatorContext, type LlmOperator, type OperatorDecision, type OperatorEvent, type OperatorLimits } from '../src/operator/operator.js';
import { CONFIG, REPO } from './helpers.js';

/** Выполнение кейса notifications-channel-change: заглушка закрытия есть, у get_smsbank_notifications и cases_postpone заглушек нет. */
export async function execution(overrides: Partial<ExecutionInit> = {}): Promise<Execution> {
  const reg = await loadRegistry(CONFIG);
  return new Execution({
    id: 'dialog', mode: 'manual', caseDef: reg.cases.get('notifications-channel-change')!,
    contract: reg.contract!, solution: null, basketType: null, senderId: 'dialog-local',
    caseNumber: 'CG-DIALOG', requestRef: 'dialog-ref', taskIdScope: 'execution',
    env: loadEnv({ AGENT_MCP_TIMEOUT_MS: '20000', OPERATOR_DECISION_MARGIN_MS: '1000' }, REPO), run: null,
    ...overrides,
  });
}

/** Удерживаемый вызов инструмента: ждёт, пока он появится, — после решения по подтверждению вызов может ждать ответа человека. */
export async function held(exec: Execution, tool: string, kind: 'confirmation' | 'answer'): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const p = exec.pendingList().find((x) => x.tool === tool && x.kind === kind);
    if (p) return p.callId;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`${tool} не ждёт ${kind}`);
}

export const call = (exec: Execution, tool: string, args: Record<string, unknown> = {}) => exec.handleToolCall(tool, args, exec.currentTaskId);

/** Ход агента-сценария: получает текст сообщения, вызывает инструменты и возвращает текст ответа или сбой хода. */
export type Turn = (exec: Execution, text: string) => Promise<string | { error: 'timeout' | 'agent' }>;

/** Канал к агенту-сценарию: события журнала — как у настоящего канала, ход заканчивается endTurn(). */
export function agent(turns: Turn[]): AgentChannel {
  let n = 0;
  return {
    async command(exec: Execution, name: 'reset' | 'capture' | 'curator') {
      return exec.add<CommandEvent>({ type: 'command', name, text: `/${name}`, status: 'ok', reply: 'ok', parsed: null, durationMs: 0, by: 'runner' });
    },
    async sendMessage(exec: Execution, text: string, kind: 'start' | 'operator' | 'human', extra: Partial<MessageEvent> = {}) {
      exec.add<MessageEvent>({ type: kind === 'start' ? 'start_message' : kind === 'operator' ? 'operator_message' : 'human_message', text, ...extra });
      const out = n < turns.length ? await turns[n++](exec, text) : 'Жду указаний.';
      if (typeof out !== 'string') {
        exec.add<NoteEvent>({ type: 'note', text: `Агент: ${out.error}` });
        exec.endTurn();
        return { ok: false, error: { kind: out.error, message: `Агент: ${out.error}` } };
      }
      const reply = exec.add<MessageEvent>({ type: 'agent_message', text: out, turn: exec.turns + 1 });
      exec.endTurn();
      return { ok: true, reply, raw: {} };
    },
  } as unknown as AgentChannel;
}

/** LLM-оператор по сценарию; seen — какие решения у него спрашивали, contexts — что он при этом видел. */
export function operator(decide: (event: OperatorEvent, exec: Execution) => Promise<Partial<OperatorDecision>>): { op: LlmOperator; seen: string[]; contexts: Record<string, any>[] } {
  const seen: string[] = [];
  const contexts: Record<string, any>[] = [];
  const op = {
    model: { id: 'fake-operator' },
    async decide(exec: Execution, event: OperatorEvent, mode: BasketType, limits: OperatorLimits) {
      seen.push(event.type === 'confirmation' ? `confirmation ${event.call.tool}` : 'turn_end');
      contexts.push(operatorContext(exec, event, mode, limits, false));
      const value = { reply: null, confirmation: null, correction: false, lessonId: null, lessonNote: null, explanation: false, approval: false, finish: false, reason: 'сценарий теста', ...(await decide(event, exec)) };
      return { value, attempts: [{ n: 1, ok: true, durationMs: 1 }], usage: null, durationMs: 1, model: 'fake-operator' };
    },
  };
  return { op: op as unknown as LlmOperator, seen, contexts };
}

export const deps = (channel: AgentChannel, op: LlmOperator, over: Partial<DialogDeps> = {}): DialogDeps => ({
  channel,
  operator: op,
  mode: 'training',
  checkingConfirmations: 'approve',
  limits: { maxTurns: 6, maxDurationSec: 60, maxOperatorCalls: 20 },
  confirmationTimeoutMs: 5000,
  priorLessons: new Set(),
  signal: new AbortController().signal,
  ...over,
});

export const approveAll = async (e: OperatorEvent): Promise<Partial<OperatorDecision>> => (e.type === 'confirmation' ? { confirmation: 'approve' } : { reply: 'Продолжайте' });

export async function whenTrue(fn: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !fn(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(fn(), what);
}
