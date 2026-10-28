// Отдельная LLM-оценка ответа после завершения кейса (MET-05): свой контекст, оценка скрыта от агента.
import type { ModelDef } from '../config/types.js';
import type { Execution } from '../execution/execution.js';
import type { MessageEvent, ToolCallEvent } from '../execution/events.js';
import type { LlmProvider, LlmRequest } from '../llm/provider.js';
import { structuredCall, type StructuredResult } from '../llm/structured.js';
import { ANSWER_JUDGE_SCHEMA, ANSWER_JUDGE_SYSTEM, JUDGE_SCHEMA, JUDGE_SYSTEM } from '../operator/prompts.js';
import { FINAL_TEXT_KINDS, type FinalAction } from '../metrics/scoring.js';

export interface JudgeVerdict {
  criteria: { id: string; passed: boolean; reason: string }[];
  summary: string;
}

export interface TextVerdict {
  match: boolean;
  reason: string;
}

/** Результат решения фиксируется до служебных команд: судья оценивает его, а не отчёт capture. */
export function frozenResult(exec: Execution, uptoSeq: number) {
  const evs = exec.events.filter((e) => e.seq <= uptoSeq);
  const agentMessages = evs.filter((e): e is MessageEvent => e.type === 'agent_message').map((e) => ({ seq: e.seq, text: e.text }));
  const actions = evs
    .filter((e): e is ToolCallEvent => e.type === 'tool_call')
    .map((e) => ({ seq: e.seq, tool: e.tool, args: e.args, outcome: e.outcome, executed: e.executed, confirmation: e.confirmation?.decision ?? null }));
  return { agentMessages, finalReply: agentMessages.length ? agentMessages[agentMessages.length - 1].text : '', actions };
}

export function judgeContext(exec: Execution, uptoSeq: number, devHints: boolean) {
  const c = exec.caseDef;
  return {
    case: { id: c.id, title: c.title, topic: c.topic, situation: c.situation, start: c.start, facts: c.facts },
    reference: {
      answer: c.reference.answer,
      procedure: c.reference.procedure,
      criteria: c.reference.criteria.map((x) => ({ id: x.id, text: x.text, ...(devHints && x.hint ? { hint: x.hint } : {}) })),
    },
    result: frozenResult(exec, uptoSeq),
  };
}

/** Подписи вызовов оценки в журнале HTTP; у сверки с эталоном к подписи добавляется номер прогона. */
export const JUDGE_LABEL = 'LLM-оценка · критерии ответа';
export const ANSWER_LABEL = 'LLM-оценка · эталонный текст';

export class LlmJudge {
  constructor(
    public model: ModelDef,
    private provider: LlmProvider,
  ) {}

  async evaluate(exec: Execution, uptoSeq: number, signal?: AbortSignal, onExchange?: LlmRequest['onExchange']): Promise<StructuredResult<JudgeVerdict>> {
    const ctx = judgeContext(exec, uptoSeq, !!this.model.params.devHints);
    const ids = new Set(exec.caseDef.reference.criteria.map((c) => c.id));
    const user = `Оцени результат агента по критериям.\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\``;
    return structuredCall<JudgeVerdict>(
      this.provider,
      { system: JUDGE_SYSTEM, user, schema: JUDGE_SCHEMA, schemaName: 'judge_verdict', signal, label: JUDGE_LABEL, onExchange },
      (v) => {
        const got = new Set(v.criteria.map((c) => c.id));
        const errs: string[] = [];
        const missing = [...ids].filter((i) => !got.has(i));
        const extra = [...got].filter((i) => !ids.has(i));
        if (missing.length) errs.push(`нет оценки критериев: ${missing.join(', ')}`);
        if (extra.length) errs.push(`лишние критерии: ${extra.join(', ')}`);
        return errs;
      },
      1,
    );
  }

  /** A_judge: соответствует ли итоговый текст агента эталонному. Один прогон из runs; судья видит только тексты и тематику. */
  async matchText(exec: Execution, final: FinalAction, reference: string, n: number, runs: number, signal?: AbortSignal, onExchange?: LlmRequest['onExchange']): Promise<StructuredResult<TextVerdict>> {
    const c = exec.caseDef;
    const ctx = {
      case: { id: c.id, title: c.title, topic: c.topic },
      referenceKind: final.expected ? FINAL_TEXT_KINDS[final.expected] : null,
      reference,
      kind: final.predicted ? FINAL_TEXT_KINDS[final.predicted] : null,
      text: final.text,
      run: n,
      runs,
    };
    const user = `Сравни итоговый текст агента с эталонным.\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\``;
    return structuredCall<TextVerdict>(this.provider, { system: ANSWER_JUDGE_SYSTEM, user, schema: ANSWER_JUDGE_SCHEMA, schemaName: 'answer_match', signal, label: `${ANSWER_LABEL}, прогон ${n} из ${runs}`, onExchange }, () => [], 1);
  }
}
