// Автоматический диалог кейса с LLM-оператором (SOL-04, SOL-05, BASK-05).
import type { BasketType, CaseDef, ContractDef, Limits } from '../config/types.js';
import type { ConfirmDecision, Execution } from './execution.js';
import type { AgentChannel } from './channel.js';
import type { DecisionEvent, MessageEvent, NoteEvent, ToolCallEvent } from './events.js';
import { MODE_MARK, decisionLabel, type LlmOperator, type OperatorDecision, type OperatorEvent } from '../operator/operator.js';
import { StructuredError } from '../llm/structured.js';
import { renderLines } from '../util/template.js';
import { previewStub } from '../stubs/engine.js';
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

export interface StartExecution {
  caseNumber: string;
  requestRef: string;
  /** x-task-id, с которым уйдёт стартовое сообщение. */
  taskId: string;
}

/**
 * Стартовое сообщение по шаблону контракта: поля кейса ({{case.*}}, {{start.*}}), выполнения ({{execution.taskId}} и др.)
 * и ответы заглушек инструментов ({{tools.<инструмент>}}) — как оркестратор, который встраивает результаты вызовов в старт.
 * missing — подстановки без значения: их строки выпадают.
 */
export function renderStartMessage(contract: ContractDef, c: CaseDef, execution: StartExecution, state: Record<string, unknown>, missing?: Set<string>): string {
  const cache = new Map<string, unknown>();
  const preview = (tool: string | symbol): unknown => {
    if (typeof tool !== 'string') return undefined;
    if (!cache.has(tool)) cache.set(tool, previewStub(c, contract.defaults[tool], tool, state, { ...execution }));
    return cache.get(tool);
  };
  const tools = new Proxy(
    {},
    {
      get: (_t, tool) => preview(tool),
      // Подстановка читает только собственные поля (util/jsonpath.ts): ответ заглушки — собственное поле, вычисляемое по запросу.
      getOwnPropertyDescriptor: (_t, tool) => {
        const value = preview(tool);
        return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
      },
    },
  );
  return renderLines(contract.startMessage.text, { case: { id: c.id, title: c.title, topic: c.topic, tags: c.tags }, start: c.start, execution, tools }, missing);
}

export function startMessage(exec: Execution): string {
  const taskId = exec.reserveTaskId();
  exec.startTaskId = taskId;
  return renderStartMessage(exec.contract, exec.caseDef, { caseNumber: exec.caseNumber, requestRef: exec.requestRef, taskId }, exec.stub.state);
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
  // Реплики к подтверждениям текущего хода: агенту сами не уходят, их пересматривает решение на конец хода.
  const unsent: { text: string; decisionSeq: number }[] = [];
  const decisionAt = (seq: number) => exec.events.find((e): e is DecisionEvent => e.seq === seq && e.type === 'operator_decision');

  // Кейс завершился раньше, чем оператор пересмотрел реплики хода: агенту они не уходят.
  const dropUnsent = (reason: string): void => {
    const q = unsent.splice(0, unsent.length);
    if (!q.length) return;
    for (const x of q) {
      const dec = decisionAt(x.decisionSeq);
      if (!dec) continue;
      dec.replyDropped = true;
      exec.update(dec);
    }
    exec.add<NoteEvent>({ type: 'note', hidden: true, text: `Реплика оператора не отправлена: ${reason}`, data: { decisions: q.map((x) => x.decisionSeq), text: q.map((x) => x.text) } });
  };

  // Решение на конец хода пересмотрело реплики хода: агенту уходит только его реплика.
  const reviewed = (seq: number): void => {
    for (const x of unsent.splice(0, unsent.length)) {
      const dec = decisionAt(x.decisionSeq);
      if (!dec) continue;
      dec.replyReviewed = seq;
      exec.update(dec);
    }
  };

  const end = (status: string, reason: string, by: Execution['endedBy'] = null): DialogOutcome => {
    exec.confirmationHandler = null;
    exec.endedBy = by;
    dropUnsent(`кейс завершён до решения на конец хода (${reason})`);
    return { status, reason, resultSeq: lastSeq() };
  };
  const failure: { status: string; reason: string } = { status: '', reason: '' };

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
        exec.add<NoteEvent>({ type: 'mode_violation', hidden: true, text: 'LLM-оператор дважды предложил поправку в проверяющей корзине; реплика не отправлена', data: { attempts: e.attempts.map((a) => a.error) } });
        return { status: 'operator_mode_violation', reason: 'Оператор нарушил режим проверки' };
      }
      if (e.kind === 'format') return { status: 'operator_format_error', reason: e.message };
      if (e.kind === 'timeout') return { status: 'operator_timeout', reason: e.message };
      if (e.kind === 'aborted') return { status: 'stopped', reason: 'Прогон остановлен' };
      return { status: 'operator_error', reason: e.message };
    }
    return { status: 'operator_error', reason: errorMessage(e) };
  };

  // Решение после хода — не меньше 30 с, даже если срок решения по подтверждению короче.
  const turnDecisionMs = Math.max(30_000, deps.confirmationTimeoutMs);

  // HTTP-обмены вызова оператора привязываются к его решению после ответа: решение появляется в журнале только тогда.
  const decide = async (event: OperatorEvent, timeoutMs: number, log: ReturnType<Execution['llmLog']>) => {
    exec.operatorCalls++;
    const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(timeoutMs)]);
    return operator.decide(exec, event, mode, limits, signal, log.onExchange);
  };

  // Кейс закрыли, пока оператор решал: вызов уже получил ошибку закрытого кейса, решение ни на что не влияет — ни репликой, ни сбоем.
  const moot = (dec: DecisionEvent): ConfirmDecision => {
    dec.moot = true;
    exec.update(dec);
    return { action: 'reject', by: 'auto', decisionSeq: dec.seq };
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
    const event: OperatorEvent = { type: 'confirmation', call, unsent: unsent.map((x) => x.decisionSeq) };
    const log = exec.llmLog({ label: decisionLabel(event), title: 'решает LLM-оператор', timeoutMs: deps.confirmationTimeoutMs, callId: call.callId });
    try {
      const res = await decide(event, deps.confirmationTimeoutMs, log);
      const d = res.value;
      const dec = recordDecision(event, res, null, call.callId);
      log.attach(dec);
      if (call.afterClose) return moot(dec);
      if (d.reply) unsent.push({ text: d.reply, decisionSeq: dec.seq });
      return { action: d.confirmation ?? 'reject', by: 'operator', decisionSeq: dec.seq };
    } catch (e) {
      const err = e instanceof StructuredError ? e : null;
      const dec = recordDecision(event, null, err, call.callId);
      log.attach(dec);
      if (call.afterClose) return moot(dec);
      const f = classify(e);
      failure.status = failure.status || f.status;
      failure.reason = failure.reason || f.reason;
      return { action: 'reject', by: 'auto' };
    }
  };

  exec.setStatus('running');
  const reset = await channel.command(exec, 'reset', 'runner', deps.signal);
  if (reset.status !== 'ok') return end(deps.signal.aborted ? 'stopped' : reset.busy ? 'agent_busy' : 'reset_failed', reset.error ?? 'Агент не подтвердил /reset');

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
    // Терминальный инструмент выполнен: агент договорил ход, оператор больше не вызывается и не пишет. Лимиты — после: закрытие в последнем ходе — «Завершён».
    if (exec.closedBy) {
      dropUnsent(`кейс закрыт терминальным инструментом ${exec.closedBy.tool}`);
      return end('completed', `Выполнен терминальный инструмент ${exec.closedBy.tool}`, 'terminal');
    }
    if (finishAfterTurn) return end('completed', 'Оператор завершил кейс', 'operator');

    // Реплики к подтверждениям этого хода оператор видит в решении на конец хода и сам решает, что из них написать агенту.
    if (exec.operatorCalls >= limits.maxOperatorCalls) return end('limit_operator_calls', `Исчерпан лимит ${limits.maxOperatorCalls} запросов оператора`);
    const event: OperatorEvent = { type: 'turn_end', agentReply: r.reply.text, unsent: unsent.map((x) => x.decisionSeq) };
    const log = exec.llmLog({ label: decisionLabel(event), title: 'LLM-оператор решает, что ответить', timeoutMs: turnDecisionMs });
    let res;
    try {
      res = await decideTurn(event, log);
    } catch (e) {
      log.attach(recordDecision(event, null, e instanceof StructuredError ? e : null));
      const f = classify(e);
      return end(f.status, f.reason);
    }
    const dec = recordDecision(event, res, null);
    log.attach(dec);
    reviewed(dec.seq);
    const d = res.value;
    if (d.finish && !d.reply) return end('completed', 'Оператор завершил кейс', 'operator');
    if (d.finish) finishAfterTurn = true;
    next = { text: d.reply!, kind: 'operator', extra: { marks: marksOf(d, deps.priorLessons), decisionSeq: dec.seq } };
  }

  async function decideTurn(event: OperatorEvent, log: ReturnType<Execution['llmLog']>) {
    return decide(event, turnDecisionMs, log);
  }
}
