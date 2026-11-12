// Оценка выполнения после завершения кейса (SOL-06, MET-05) и сводка исходных событий для метрик.
import type { Execution } from './execution.js';
import type { CheckItem, ChecksEvent, CommandEvent, DecisionEvent, JudgeEvent, MessageEvent, ScoresEvent, ToolCallEvent } from './events.js';
import { LIMIT_STATUSES, TECH_STATUSES } from './events.js';
import { runActionChecks } from '../checks/actions.js';
import { ANSWER_LABEL, JUDGE_LABEL, frozenResult, type LlmJudge } from '../judge/judge.js';
import { StructuredError, sumUsage } from '../llm/structured.js';
import { DEFAULT_SCORING, caseScore, finalAction, toolsF1, type AnswerMatch, type CaseScores, type FinalAction, type Scoring } from '../metrics/scoring.js';
import type { LlmRequest } from '../llm/provider.js';
import { errorMessage } from '../util/core.js';

export type Outcome = 'passed' | 'failed' | 'not_evaluated' | 'technical';

export type JudgeVerdict = { status: 'ok' | 'failed' | 'skipped'; passed: number; total: number; failed: string[]; error?: string };

export interface Evaluation {
  outcome: Outcome;
  reason: string;
  checks: CheckItem[] | null;
  judge: JudgeVerdict | null;
  /** Метрики аналитика; технический сбой не оценивается. */
  scores: CaseScores | null;
  /** Итог опирается на повторный вызов судьи: сразу после сбоя или переоценку после прогона (решение владельца от 12.11.2026). */
  repeated: boolean;
}

/** Повторный вызов судьи: inline — сразу после сбоя, after — переоценка после прогона. */
type Repeat = 'inline' | 'after';

export async function evaluate(exec: Execution, resultSeq: number, judge: LlmJudge | null, signal?: AbortSignal, scoring: Scoring = DEFAULT_SCORING): Promise<Evaluation> {
  if (TECH_STATUSES.has(exec.status)) {
    return { outcome: 'technical', reason: exec.reason || exec.status, checks: null, judge: null, scores: null, repeated: false };
  }
  const calls = exec.toolCalls().filter((c) => c.seq <= resultSeq);
  const checks = runActionChecks(exec.caseDef, calls);
  exec.add<ChecksEvent>({ type: 'checks', hidden: true, items: checks });

  const verdict = await criteriaVerdict(exec, resultSeq, judge, signal, null);
  const { outcome, reason } = outcomeOf(exec.status, checks, verdict.j);

  // Метрики аналитика не меняют итог кейса: это отдельные M1 и M2.
  const final = finalAction(exec.caseDef, exec.status, calls, frozenResult(exec, resultSeq).finalReply, scoring);
  const tools = toolsF1(exec.caseDef.reference.tools, calls, scoring.tools);
  const answerLog = exec.llmLog({ label: ANSWER_LABEL, title: 'LLM-оценка: эталонный текст' });
  const answer = await answerMatch(exec, final, judge, scoring, signal, answerLog.onExchange);
  const scores: CaseScores = { final, tools, answer, caseScore: caseScore(tools.f1, answer.score, scoring.weights), weights: scoring.weights };
  answerLog.attach(exec.add<ScoresEvent>({ type: 'scores', hidden: true, ...scores }));
  return { outcome, reason, checks, judge: verdict.j, scores, repeated: verdict.repeated || answerRepeated(answer) };
}

/**
 * Переоценка после прогона (решение владельца от 12.11.2026): упавшая оценка итоговой попытки повторяется по сохранённому
 * журналу, без запросов агенту. Удачное не повторяется: вердикт судьи по критериям и удачные прогоны A_judge берутся прежние,
 * проверки действий — прежние. Новые события оценки помечены переоценкой, прежние остаются в журнале.
 */
export async function reevaluate(
  exec: Execution,
  resultSeq: number,
  judge: LlmJudge,
  prev: { checks: CheckItem[]; judge: JudgeVerdict; answer: AnswerMatch | null },
  signal?: AbortSignal,
  scoring: Scoring = DEFAULT_SCORING,
): Promise<Evaluation> {
  let j = prev.judge;
  let repeated = false;
  if (prev.judge.status === 'failed') {
    const failedBefore = exec.events.filter((e): e is JudgeEvent => e.type === 'judge' && e.status === 'failed' && !e.replacedBy);
    const v = await criteriaVerdict(exec, resultSeq, judge, signal, 'after');
    j = v.j;
    repeated = v.repeated;
    const ok = [...exec.events].reverse().find((e): e is JudgeEvent => e.type === 'judge' && e.status === 'ok');
    if (v.j.status === 'ok' && ok) {
      for (const e of failedBefore) {
        e.replacedBy = ok.seq;
        exec.update(e);
      }
    }
  }
  const { outcome, reason } = outcomeOf(exec.status, prev.checks, j);

  const calls = exec.toolCalls().filter((c) => c.seq <= resultSeq);
  const final = finalAction(exec.caseDef, exec.status, calls, frozenResult(exec, resultSeq).finalReply, scoring);
  const tools = toolsF1(exec.caseDef.reference.tools, calls, scoring.tools);
  let answer = prev.answer;
  if (answer && answer.status === 'failed') {
    const failed = answer.runs.find((r) => r.match === null);
    const log = exec.llmLog({ label: ANSWER_LABEL, title: 'LLM-оценка: эталонный текст, переоценка' });
    answer = await answerMatch(exec, final, judge, scoring, signal, log.onExchange, {
      keep: answer.runs.filter((r) => r.match !== null),
      retried: [...(answer.retried ?? []), ...(failed ? [{ n: failed.n, error: failed.error ?? '', durationMs: failed.durationMs }] : [])],
      repeatOf: failed?.n ?? null,
    });
    const scores: CaseScores = { final, tools, answer, caseScore: caseScore(tools.f1, answer.score, scoring.weights), weights: scoring.weights };
    log.attach(exec.add<ScoresEvent>({ type: 'scores', hidden: true, reevaluation: true, ...scores }));
    repeated ||= answer.status === 'ok';
  }
  const scores: CaseScores | null = answer ? { final, tools, answer, caseScore: caseScore(tools.f1, answer.score, scoring.weights), weights: scoring.weights } : null;
  return { outcome, reason, checks: prev.checks, judge: j, scores, repeated };
}

/** Итог по проверкам действий и вердикту судьи: правила 1–3 docs/CONTRACTS.md. */
export function outcomeOf(status: string, checks: CheckItem[], j: JudgeVerdict): { outcome: Outcome; reason: string } {
  const checksOk = checks.every((c) => c.passed !== false);
  let outcome: Outcome;
  let reason: string;
  if (!checksOk) {
    outcome = 'failed';
    reason = checks.filter((c) => c.passed === false).map((c) => c.text).join('; ');
  } else if (j.status === 'ok') {
    outcome = j.passed === j.total ? 'passed' : 'failed';
    reason = j.passed === j.total ? 'все проверки пройдены' : `ответ: ${j.failed.join('; ')}`;
  } else if (j.status === 'skipped' && j.total === 0) {
    outcome = 'passed';
    reason = 'проверки действий пройдены; критериев ответа нет';
  } else {
    outcome = 'not_evaluated';
    reason = j.status === 'failed' ? `сбой судьи: ${j.error}` : `ответ не оценён: ${j.error}`;
  }
  if (LIMIT_STATUSES.has(status) && outcome === 'passed') reason += ' (завершён по лимиту)';
  return { outcome, reason };
}

/**
 * Вердикт судьи по критериям. После сбоя вызов сразу повторяется один раз: сбой модели — не повод оставлять кейс
 * «не оценено». Повтор — отдельное событие оценки; сбой, который он заменил, помечен номером этого события.
 */
async function criteriaVerdict(exec: Execution, resultSeq: number, judge: LlmJudge | null, signal: AbortSignal | undefined, repeat: Repeat | null): Promise<{ j: JudgeVerdict; repeated: boolean }> {
  const criteria = exec.caseDef.reference.criteria;
  if (!criteria.length) return { j: { status: 'skipped', passed: 0, total: 0, failed: [], error: 'у кейса нет критериев ответа' }, repeated: false };
  if (!judge) {
    exec.add<JudgeEvent>({ type: 'judge', hidden: true, status: 'skipped', model: null, criteria: [], summary: '', durationMs: null, usage: null, error: 'модель оценки не выбрана' });
    return { j: { status: 'skipped', passed: 0, total: criteria.length, failed: [], error: 'модель оценки не выбрана' }, repeated: false };
  }
  const first = await judgeCall(exec, resultSeq, judge, signal, repeat);
  if (first.j.status === 'ok' || signal?.aborted) return { j: first.j, repeated: first.j.status === 'ok' && repeat !== null };
  const second = await judgeCall(exec, resultSeq, judge, signal, repeat ?? 'inline');
  if (second.j.status === 'ok') {
    first.ev.replacedBy = second.ev.seq;
    exec.update(first.ev);
  }
  return { j: second.j, repeated: second.j.status === 'ok' };
}

async function judgeCall(exec: Execution, resultSeq: number, judge: LlmJudge, signal: AbortSignal | undefined, repeat: Repeat | null): Promise<{ j: JudgeVerdict; ev: JudgeEvent }> {
  const criteria = exec.caseDef.reference.criteria;
  const mark = repeat ? { repeat } : {};
  // HTTP-обмены судьи привязываются к событию оценки, когда оно появится.
  const log = exec.llmLog({ label: JUDGE_LABEL, title: repeat ? 'LLM-оценка: критерии ответа, повтор' : 'LLM-оценка: критерии ответа' });
  try {
    const r = await judge.evaluate(exec, resultSeq, signal, log.onExchange);
    const byId = new Map(r.value.criteria.map((c) => [c.id, c]));
    const items = criteria.map((c) => ({ id: c.id, text: c.text, passed: !!byId.get(c.id)?.passed, reason: byId.get(c.id)?.reason ?? '' }));
    const ev = exec.add<JudgeEvent>({ type: 'judge', hidden: true, status: 'ok', model: judge.model.id, criteria: items, summary: r.value.summary, durationMs: r.durationMs, usage: r.usage, ...mark });
    log.attach(ev);
    return { j: { status: 'ok', passed: items.filter((i) => i.passed).length, total: items.length, failed: items.filter((i) => !i.passed).map((i) => i.text) }, ev };
  } catch (e) {
    const msg = e instanceof StructuredError ? e.message : errorMessage(e);
    const dur = e instanceof StructuredError ? e.attempts.reduce((s, a) => s + a.durationMs, 0) : null;
    const ev = exec.add<JudgeEvent>({ type: 'judge', hidden: true, status: 'failed', model: judge.model.id, criteria: [], summary: '', durationMs: dur, usage: null, error: msg, ...mark });
    log.attach(ev);
    // Сбой судьи — «не оценено», а не отрицательная оценка.
    return { j: { status: 'failed', passed: 0, total: criteria.length, failed: [], error: msg }, ev };
  }
}

/** A_judge получен с повтором: какой-то прогон судьи упал, и его заменил повторный вызов. */
const answerRepeated = (a: AnswerMatch): boolean => a.status === 'ok' && !!a.retried?.length;

/**
 * A_judge: runs независимых прогонов судьи, среднее вердиктов. Упавший прогон сразу повторяется один раз; если упал и
 * повтор — оценки нет: градация держится на полном числе прогонов. keep — удачные прогоны прежней оценки (переоценка),
 * repeatOf — номер прогона, который упал в прежней оценке.
 */
async function answerMatch(
  exec: Execution,
  final: FinalAction,
  judge: LlmJudge | null,
  s: Scoring,
  signal?: AbortSignal,
  onExchange?: LlmRequest['onExchange'],
  resume: { keep: AnswerMatch['runs']; retried: NonNullable<AnswerMatch['retried']>; repeatOf: number | null } | null = null,
): Promise<AnswerMatch> {
  const reference = (exec.caseDef.reference.finalText || exec.caseDef.reference.answer).trim();
  const base: AnswerMatch = { status: 'skipped', score: null, runs: [], model: judge?.model.id ?? null, reference, durationMs: null, usage: null, reason: '' };
  if (!s.answer.enabled) return { ...base, reason: 'в прогоне не выбраны метрики answer-match и case-score' };
  if (final.incomplete) return { ...base, reason: 'агент не завершил кейс' };
  if (!reference) return { ...base, reason: 'у кейса нет эталонного текста (reference.finalText или answer)' };
  if (!final.text) return { ...base, status: 'ok', score: 0, reason: `итоговый текст пуст (${final.textFrom}): 0 без вызова судьи` };
  if (!judge) return { ...base, reason: 'модель оценки не выбрана' };
  const runs: AnswerMatch['runs'] = [...(resume?.keep ?? [])];
  const retried: NonNullable<AnswerMatch['retried']> = [...(resume?.retried ?? [])];
  let usage: AnswerMatch['usage'] = null;
  let durationMs = runs.reduce((a, r) => a + (r.durationMs ?? 0), 0);
  const once = async (n: number) => {
    try {
      const r = await judge.matchText(exec, final, reference, n, s.answer.runs, signal, onExchange);
      usage = sumUsage([usage, r.usage]);
      durationMs += r.durationMs;
      return { ok: true as const, match: r.value.match, reason: r.value.reason, durationMs: r.durationMs };
    } catch (e) {
      const dur = e instanceof StructuredError ? e.attempts.reduce((a, x) => a + x.durationMs, 0) : null;
      durationMs += dur ?? 0;
      return { ok: false as const, error: e instanceof StructuredError ? e.message : errorMessage(e), durationMs: dur };
    }
  };
  for (let n = runs.length + 1; n <= s.answer.runs; n++) {
    let repeat: Repeat | undefined = resume && n === resume.repeatOf ? 'after' : undefined;
    let r = await once(n);
    if (!r.ok && !signal?.aborted) {
      retried.push({ n, error: r.error, durationMs: r.durationMs });
      repeat = resume ? 'after' : 'inline';
      r = await once(n);
    }
    if (!r.ok) {
      runs.push({ n, match: null, reason: '', durationMs: r.durationMs, error: r.error });
      return { ...base, status: 'failed', runs, retried, durationMs, usage, reason: `сбой судьи в прогоне ${n} из ${s.answer.runs}: ${r.error}` };
    }
    runs.push({ n, match: r.match, reason: r.reason, durationMs: r.durationMs, ...(repeat ? { repeat } : {}) });
  }
  return { ...base, status: 'ok', score: runs.filter((r) => r.match).length / runs.length, runs, ...(retried.length ? { retried } : {}), durationMs, usage };
}

export interface ExecStats {
  turns: number;
  durationMs: number;
  time: { agent: number; operator: number; judge: number; commands: number };
  tokens: {
    agent: { input: number | null; output: number | null; total: number | null } | null;
    operator: { input: number | null; output: number | null } | null;
    judge: { input: number | null; output: number | null } | null;
  };
  corrections: number;
  lessons: string[];
  repeated: string[];
  unknownCorrections: number;
  rejected: { operator: number; human: number; timeout: number; auto: number };
  unexpected: { tool: string; seq: number; outcome: string }[];
  /** replies — все сообщения LLM-оператора агенту вместе с напоминаниями стенда; reminders — напоминания стенда в проверяющей корзине, в записях до 12.11.2026 поля нет. */
  operator: { calls: number; failedAttempts: number; errors: number; modeViolations: number; replies: number; reminders?: number };
}

const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

export function execStats(exec: Execution): ExecStats {
  const ev = exec.events;
  const msgs = ev.filter((e): e is MessageEvent => e.type === 'operator_message' || e.type === 'human_message');
  const decisions = ev.filter((e): e is DecisionEvent => e.type === 'operator_decision');
  const calls = ev.filter((e): e is ToolCallEvent => e.type === 'tool_call');
  const judge = ev.filter((e): e is JudgeEvent => e.type === 'judge');
  const answerJudge = ev.filter((e): e is ScoresEvent => e.type === 'scores').map((e) => e.answer);
  const agentMsgs = ev.filter((e): e is MessageEvent => e.type === 'agent_message');

  // Поправки — по разметке реплик и отклонений; один урок в кейсе считается один раз (MET-03).
  // Считается то, что дошло до агента. Реплика к подтверждению сама не уходит: отклонение с поправкой — поправка по решению,
  // и когда реплику пересмотрело решение на конец хода, и когда кейс завершился раньше; реплика к разрешению и запоздалое решение — нет.
  const lessonSet = new Set<string>();
  const repeated = new Set<string>();
  let unknown = 0;
  const corrected = [
    ...msgs.filter((m) => m.marks?.correction).map((m) => ({ lessonId: m.marks!.lessonId, repeated: !!m.marks!.repeated })),
    ...decisions
      .filter((d) => d.event === 'confirmation' && d.decision?.correction && !d.moot && (!d.decision?.reply || ((d.replyDropped || d.replyReviewed) && d.decision?.confirmation === 'reject')))
      .map((d) => ({ lessonId: typeof d.decision?.lessonId === 'string' ? d.decision.lessonId : null, repeated: false })),
  ];
  for (const c of corrected) {
    if (c.lessonId) {
      lessonSet.add(c.lessonId);
      if (c.repeated) repeated.add(c.lessonId);
    } else unknown++;
  }

  const confWait = calls.reduce((s, c) => s + (c.confirmation?.waitedMs ?? 0), 0);
  const agentTime = agentMsgs.reduce((s, m) => s + (m.durationMs ?? 0), 0);
  const commands = ev.filter((e): e is CommandEvent => e.type === 'command').reduce((s, e) => s + (e.durationMs ?? 0), 0);
  const opTime = decisions.reduce((s, d) => s + (d.durationMs ?? 0), 0);
  const judgeTime = [...judge, ...answerJudge].reduce((s, j) => s + (j.durationMs ?? 0), 0);

  let agentTok = null as ExecStats['tokens']['agent'];
  for (const m of agentMsgs) {
    if (!m.usage) continue;
    agentTok = { input: add(agentTok?.input ?? null, m.usage.input), output: add(agentTok?.output ?? null, m.usage.output), total: add(agentTok?.total ?? null, m.usage.total) };
  }
  const sumLlm = (list: { usage: { input: number | null; output: number | null } | null }[]) => {
    let t = null as { input: number | null; output: number | null } | null;
    for (const x of list) if (x.usage) t = { input: add(t?.input ?? null, x.usage.input), output: add(t?.output ?? null, x.usage.output) };
    return t;
  };

  const start = Date.parse(exec.startedAt);
  const end = exec.finishedAt ? Date.parse(exec.finishedAt) : Date.now();
  return {
    turns: exec.turns,
    durationMs: Math.max(0, end - start),
    time: { agent: Math.max(0, agentTime - confWait), operator: opTime, judge: judgeTime, commands },
    tokens: { agent: agentTok, operator: sumLlm(decisions), judge: sumLlm([...judge, ...answerJudge]) },
    corrections: lessonSet.size + unknown,
    lessons: [...lessonSet],
    repeated: [...repeated],
    unknownCorrections: unknown,
    rejected: {
      operator: calls.filter((c) => c.confirmation?.decision === 'reject' && c.confirmation.by === 'operator').length,
      human: calls.filter((c) => c.confirmation?.decision === 'reject' && c.confirmation.by === 'human').length,
      timeout: calls.filter((c) => c.confirmation?.by === 'timeout').length,
      auto: calls.filter((c) => c.confirmation?.decision === 'reject' && (c.confirmation.by === 'auto' || c.confirmation.by === 'stopped')).length,
    },
    unexpected: calls.filter((c) => c.unexpected).map((c) => ({ tool: c.tool, seq: c.seq, outcome: c.outcome })),
    operator: {
      calls: decisions.filter((d) => !d.forced).length,
      failedAttempts: decisions.reduce((s, d) => s + d.attempts.filter((a) => !a.ok).length, 0),
      errors: decisions.filter((d) => d.error).length,
      modeViolations: ev.filter((e) => e.type === 'mode_violation').length,
      replies: msgs.filter((m) => m.type === 'operator_message').length,
      reminders: msgs.filter((m) => m.type === 'operator_message' && m.reminder).length,
    },
  };
}
