// LLM-оператор (SOL-02–05): контекст из кейса, решения, режима корзины и журнала; структурированное решение.
import type { BasketType, LessonDef, ModelDef } from '../config/types.js';
import type { Execution } from '../execution/execution.js';
import type { ToolCallEvent } from '../execution/events.js';
import type { LlmProvider, LlmRequest } from '../llm/provider.js';
import { structuredCall, type StructuredResult } from '../llm/structured.js';
import { OPERATOR_SCHEMA, OPERATOR_SYSTEM } from './prompts.js';

/** Метка ошибки режима: по ней сбой формата отличается от нарушения режима проверки. */
export const MODE_MARK = 'в проверяющей корзине поправки запрещены';

export interface OperatorDecision {
  reply: string | null;
  confirmation: 'approve' | 'reject' | null;
  correction: boolean;
  lessonId: string | null;
  lessonNote: string | null;
  explanation: boolean;
  approval: boolean;
  finish: boolean;
  reason: string;
}

/** unsent — номера решений, чьи реплики к подтверждениям этого хода ещё не пересмотрены: агент их не видел. */
export type OperatorEvent =
  | { type: 'turn_end'; agentReply: string; unsent?: number[] }
  | { type: 'confirmation'; call: ToolCallEvent; unsent?: number[] };

export interface OperatorLimits {
  maxTurns: number;
  maxDurationSec: number;
  maxOperatorCalls: number;
}

export function lessonCatalog(exec: Execution): LessonDef[] {
  const map = new Map<string, LessonDef>();
  for (const l of exec.caseDef.reference.lessons) map.set(l.id, l);
  for (const l of exec.solution?.operator.lessons ?? []) map.set(l.id, l);
  return [...map.values()];
}

/**
 * Что известно оператору: журнал без скрытых событий ClawGym; результаты инструментов — по настройке решения.
 * unsent — решения, чьи реплики к подтверждениям этого хода ещё не пересмотрены: они стоят после своих вызовов с sent: false.
 */
export function transcript(exec: Execution, unsent: readonly number[] = []): unknown[] {
  const sees = exec.solution?.operator.seesToolResults !== false;
  const pending = new Set(unsent);
  const calls = new Map<string, number>();
  const out: unknown[] = [];
  for (const e of exec.events) {
    if (e.type === 'start_message') out.push({ seq: e.seq, role: 'clawgym', kind: 'start', text: e.text });
    else if (e.type === 'agent_message') out.push({ seq: e.seq, role: 'agent', text: e.text });
    else if (e.type === 'operator_message' || e.type === 'human_message') out.push({ seq: e.seq, role: 'operator', text: e.text, correction: e.marks?.correction ?? false, lessonId: e.marks?.lessonId ?? null });
    else if (e.type === 'operator_decision' && pending.has(e.seq)) {
      const d = e.decision ?? {};
      out.push({ seq: e.seq, role: 'operator', text: d.reply, sent: false, call: e.callId ? (calls.get(e.callId) ?? null) : null, correction: d.correction === true, lessonId: d.lessonId ?? null });
    } else if (e.type === 'tool_call') {
      calls.set(e.callId, e.seq);
      out.push({
        seq: e.seq,
        role: 'tool',
        tool: e.tool,
        args: e.args,
        confirmation: e.confirmation?.decision ?? null,
        outcome: e.outcome,
        executed: e.executed,
        ...(sees ? { result: e.result } : {}),
      });
    } else if (e.type === 'command' && e.name === 'reset') out.push({ seq: e.seq, role: 'clawgym', kind: 'command', text: e.text });
  }
  return out;
}

export function operatorContext(exec: Execution, event: OperatorEvent, mode: BasketType, limits: OperatorLimits, devHints: boolean): Record<string, unknown> {
  const c = exec.caseDef;
  const r = c.reference;
  return {
    mode,
    case: { id: c.id, title: c.title, topic: c.topic, situation: c.situation, start: c.start, facts: c.facts },
    reference: {
      procedure: r.procedure,
      answer: r.answer,
      criteria: r.criteria.map((x) => ({ id: x.id, text: x.text, lesson: x.lesson ?? null, ...(devHints && x.hint ? { hint: x.hint } : {}) })),
      required: r.required.map((a) => ({ tool: a.tool, before: a.before ?? null, lesson: a.lesson ?? null, text: a.text ?? null })),
      forbidden: r.forbidden.map((a) => ({ tool: a.tool, lesson: a.lesson ?? null, text: a.text ?? null })),
      final: r.final,
    },
    instruction: exec.solution?.operator.instruction ?? '',
    style: exec.solution?.operator.style ?? null,
    lessons: lessonCatalog(exec),
    limits: { turnsUsed: exec.turns, maxTurns: limits.maxTurns, operatorCallsUsed: exec.operatorCalls, maxOperatorCalls: limits.maxOperatorCalls },
    transcript: transcript(exec, event.unsent),
    event:
      event.type === 'turn_end'
        ? {
            type: 'turn_end',
            agentReply: event.agentReply,
            looksLikeQuestion: /\?\s*$/.test(event.agentReply.trim()),
            // Реплики к подтверждениям этого хода, которых агент не видел: что из них ещё нужно, оператор пишет в reply.
            ...(event.unsent?.length ? { unsentReplies: event.unsent } : {}),
          }
        : {
            type: 'confirmation',
            seq: event.call.seq,
            tool: event.call.tool,
            args: event.call.args,
            description: exec.contract.tools.find((t) => t.name === event.call.tool)?.description ?? '',
            // Терминальное действие: выполненный вызов закрывает кейс, поправить агента после него нельзя.
            terminal: !!event.call.terminal,
          },
  };
}

export function operatorUserPrompt(ctx: Record<string, unknown>): string {
  const ev = ctx.event as { type: string };
  return `Событие: ${ev.type}. Контекст кейса и диалога:\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\`\nВерни решение оператора по схеме.`;
}

/** Подпись вызова оператора в журнале HTTP: роль и повод. */
export const decisionLabel = (event: OperatorEvent): string => (event.type === 'confirmation' ? `LLM-оператор · подтверждение ${event.call.tool}` : 'LLM-оператор · конец хода');

export class LlmOperator {
  constructor(
    public model: ModelDef,
    private provider: LlmProvider,
  ) {}

  async decide(exec: Execution, event: OperatorEvent, mode: BasketType, limits: OperatorLimits, signal?: AbortSignal, onExchange?: LlmRequest['onExchange']): Promise<StructuredResult<OperatorDecision>> {
    const ctx = operatorContext(exec, event, mode, limits, !!this.model.params.devHints);
    const known = new Set(lessonCatalog(exec).map((l) => l.id));
    const label = decisionLabel(event);
    return structuredCall<OperatorDecision>(
      this.provider,
      { system: OPERATOR_SYSTEM, user: operatorUserPrompt(ctx), schema: OPERATOR_SCHEMA, schemaName: 'operator_decision', signal, label, onExchange },
      (d) => {
        const errs: string[] = [];
        if (event.type === 'confirmation' && !d.confirmation) errs.push('для события confirmation поле confirmation должно быть approve или reject');
        if (event.type === 'turn_end' && d.confirmation) errs.push('для события turn_end поле confirmation должно быть null');
        if (event.type === 'turn_end' && !d.finish && !(d.reply ?? '').trim()) errs.push('нужна реплика reply или finish=true');
        if (mode === 'checking' && d.correction) errs.push(`${MODE_MARK}: correction должно быть false, реплика — только факты кейса`);
        if (d.lessonId && !known.has(d.lessonId)) {
          // Неизвестный урок не выдумываем: переносим в lessonNote (MET-04).
          d.lessonNote = d.lessonNote ?? d.lessonId;
          d.lessonId = null;
        }
        if (d.reply !== null) d.reply = d.reply.trim() || null;
        return errs;
      },
      1,
    );
  }
}
