// Автоматический диалог кейса с LLM-оператором (SOL-04, SOL-05, BASK-05).
import type { BasketType, Limits } from '../config/types.js';
import type { Execution } from './execution.js';
import type { AgentChannel } from './channel.js';
import type { DecisionEvent, MessageEvent, ToolCallEvent } from './events.js';
import { MODE_MARK, type LlmOperator, type OperatorDecision, type OperatorEvent } from '../operator/operator.js';
import { StructuredError } from '../llm/structured.js';
import { renderLines } from '../util/template.js';
import { errorMessage } from '../util/core.js';

export interface DialogDeps {
  channel: AgentChannel;
  operator: LlmOperator;
  mode: BasketType;
  checkingConfirmations: 'approve' | 'operator';
  limits: Limits;
  /** Время на решение по удерживаемому вызову: таймаут MCP агента минус запас. */
  confirmationTimeoutMs: number;
  /** Уроки, по которым поправка уже была на этой линии обучения (повторные поправки). */
  priorLessons: Set<string>;
  signal: AbortSignal;
}

export interface DialogOutcome {
  status: string;
  reason: string;
  /** Последнее событие, относящееся к решению: оценка смотрит только до него. */
  resultSeq: number;
}

export function startMessage(exec: Execution): string {
  return renderLines(exec.contract.startMessage.text, {
    case: { id: exec.caseDef.id, title: exec.caseDef.title, topic: exec.caseDef.topic },
    start: exec.caseDef.start,
    execution: { caseNumber: exec.caseNumber, requestRef: exec.requestRef },
  });
}

function marksOf(d: OperatorDecision, prior: Set<string>): NonNullable<MessageEvent['marks']> {
  return {
    correction: d.correction,
    lessonId: d.lessonId,
    lessonNote: d.lessonNote,
    explanation: d.explanation,
    approval: d.approval,
    finish: d.finish,
    repeated: !!(d.correction && d.lessonId && prior.has(d.lessonId)),
  };
}

export async function runDialog(exec: Execution, deps: DialogDeps): Promise<DialogOutcome> {
  const { channel, operator, mode, limits } = deps;
  const lastSeq = () => exec.events[exec.events.length - 1]?.seq ?? 0;
  const end = (status: string, reason: string): DialogOutcome => {
    exec.confirmationHandler = null;
    return { status, reason, resultSeq: lastSeq() };
  };
  const failure: { status: string; reason: string } = { status: '', reason: '' };
  const queued: { text: string; marks: MessageEvent['marks']; decisionSeq: number }[] = [];

  const recordDecision = (event: OperatorEvent, res: Awaited<ReturnType<LlmOperator['decide']>> | null, err: StructuredError | null, callId?: string): DecisionEvent =>
    exec.add<DecisionEvent>({
      type: 'operator_decision',
      hidden: true,
      event: event.type,
      callId,
      decision: res ? (res.value as unknown as Record<string, unknown>) : null,
      model: operator.model.id,
      durationMs: res ? res.durationMs : err ? err.attempts.reduce((s, a) => s + a.durationMs, 0) : 0,
      usage: res ? res.usage : null,
      attempts: (res?.attempts ?? err?.attempts ?? []).map((a) => ({ n: a.n, ok: a.ok, kind: a.kind, error: a.error, durationMs: a.durationMs })),
      error: err?.message,
    });

  const classify = (e: unknown): { status: string; reason: string } => {
    if (e instanceof StructuredError) {
      if (e.kind === 'format' && e.message.includes(MODE_MARK)) {
        exec.add({ type: 'mode_violation', hidden: true, text: 'LLM-оператор дважды предложил поправку в проверяющей корзине; реплика не отправлена', data: { attempts: e.attempts.map((a) => a.error) } } as any);
        return { status: 'operator_mode_violation', reason: 'Оператор нарушил режим проверки' };
      }
      if (e.kind === 'format') return { status: 'operator_format_error', reason: e.message };
      if (e.kind === 'timeout') return { status: 'operator_timeout', reason: e.message };
      if (e.kind === 'aborted') return { status: 'stopped', reason: 'Прогон остановлен' };
      return { status: 'operator_error', reason: e.message };
    }
    return { status: 'operator_error', reason: errorMessage(e) };
  };

  const decide = async (event: OperatorEvent, timeoutMs: number) => {
    exec.operatorCalls++;
    const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(timeoutMs)]);
    return operator.decide(exec, event, mode, limits, signal);
  };

  exec.confirmationHandler = async (call: ToolCallEvent) => {
    if (mode === 'checking' && deps.checkingConfirmations === 'approve') {
      const d = exec.add<DecisionEvent>({
        type: 'operator_decision',
        hidden: true,
        event: 'confirmation',
        callId: call.callId,
        decision: { confirmation: 'approve' },
        model: '—',
        durationMs: 0,
        usage: null,
        attempts: [],
        forced: 'Проверяющая корзина: подтверждения разрешаются без вмешательства оператора',
      });
      return { action: 'approve', by: 'auto', decisionSeq: d.seq };
    }
    if (exec.operatorCalls >= limits.maxOperatorCalls) {
      failure.status = failure.status || 'limit_operator_calls';
      failure.reason = failure.reason || 'Исчерпан лимит запросов оператора';
      return { action: 'reject', by: 'auto' };
    }
    const event: OperatorEvent = { type: 'confirmation', call };
    try {
      const res = await decide(event, deps.confirmationTimeoutMs);
      const d = res.value;
      const dec = recordDecision(event, res, null, call.callId);
      if (d.reply) queued.push({ text: d.reply, marks: marksOf(d, deps.priorLessons), decisionSeq: dec.seq });
      return { action: d.confirmation ?? 'reject', by: 'operator', decisionSeq: dec.seq };
    } catch (e) {
      const err = e instanceof StructuredError ? e : null;
      recordDecision(event, null, err, call.callId);
      const f = classify(e);
      failure.status = failure.status || f.status;
      failure.reason = failure.reason || f.reason;
      return { action: 'reject', by: 'auto' };
    }
  };

  exec.setStatus('running');
  const reset = await channel.command(exec, 'reset', 'runner', deps.signal);
  if (reset.status !== 'ok') return end(deps.signal.aborted ? 'stopped' : 'reset_failed', reset.error ?? 'Агент не подтвердил /reset');

  const started = Date.now();
  let next: { text: string; kind: 'start' | 'operator'; extra: Partial<MessageEvent> } = { text: startMessage(exec), kind: 'start', extra: {} };
  let finishAfterTurn = false;

  for (;;) {
    if (deps.signal.aborted || exec.flags.stopped) return end('stopped', 'Прогон остановлен');
    if (exec.turns >= limits.maxTurns) return end('limit_turns', `Достигнут лимит ${limits.maxTurns} ходов`);
    if (Date.now() - started > limits.maxDurationSec * 1000) return end('limit_duration', `Кейс длится дольше ${limits.maxDurationSec} с`);

    const r = await channel.sendMessage(exec, next.text, next.kind, next.extra, deps.signal);
    if (!r.ok) {
      if (r.error.kind === 'aborted' || deps.signal.aborted) return end('stopped', 'Прогон остановлен');
      if (r.error.kind === 'timeout') return end('agent_timeout', r.error.message);
      return end('agent_error', r.error.message);
    }
    exec.turns++;
    if (failure.status) return end(failure.status, failure.reason);
    if (exec.flags.operatorTimeout) return end('operator_timeout', 'Оператор не решил по подтверждению до таймаута MCP-вызова; вызов отклонён автоматически');
    if (finishAfterTurn) return end('completed', 'Оператор завершил кейс');

    if (queued.length) {
      // Реплика, решённая при отклонении вызова, уходит после конца хода агента.
      const q = queued.splice(0, queued.length);
      next = {
        text: q.map((x) => x.text).join('\n\n'),
        kind: 'operator',
        extra: { marks: q.find((x) => x.marks?.correction)?.marks ?? q[0].marks, decisionSeq: q[0].decisionSeq, queued: true },
      };
      continue;
    }

    if (exec.operatorCalls >= limits.maxOperatorCalls) return end('limit_operator_calls', `Исчерпан лимит ${limits.maxOperatorCalls} запросов оператора`);
    const event: OperatorEvent = { type: 'turn_end', agentReply: r.reply.text };
    let res;
    try {
      res = await decideTurn(event);
    } catch (e) {
      recordDecision(event, null, e instanceof StructuredError ? e : null);
      const f = classify(e);
      return end(f.status, f.reason);
    }
    const dec = recordDecision(event, res, null);
    const d = res.value;
    if (d.finish && !d.reply) return end('completed', 'Оператор завершил кейс');
    if (d.finish) finishAfterTurn = true;
    next = { text: d.reply!, kind: 'operator', extra: { marks: marksOf(d, deps.priorLessons), decisionSeq: dec.seq } };
  }

  async function decideTurn(event: OperatorEvent) {
    return decide(event, Math.max(30_000, deps.confirmationTimeoutMs));
  }
}
