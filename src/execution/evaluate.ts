// Оценка выполнения после завершения кейса (SOL-06, MET-05) и сводка исходных событий для метрик.
import type { Execution } from './execution.js';
import type { CheckItem, ChecksEvent, DecisionEvent, JudgeEvent, MessageEvent, ScoresEvent, ToolCallEvent } from './events.js';
import { LIMIT_STATUSES, TECH_STATUSES } from './events.js';
import { runActionChecks } from '../checks/actions.js';
import { frozenResult, type LlmJudge } from '../judge/judge.js';
import { StructuredError, sumUsage } from '../llm/structured.js';
import { DEFAULT_SCORING, caseScore, finalAction, toolsF1, type AnswerMatch, type CaseScores, type FinalAction, type Scoring } from '../metrics/scoring.js';
import type { LlmRequest } from '../llm/provider.js';
import { errorMessage } from '../util/core.js';

export type Outcome = 'passed' | 'failed' | 'not_evaluated' | 'technical';

export interface Evaluation {
  outcome: Outcome;
  reason: string;
  checks: CheckItem[] | null;
  judge: { status: 'ok' | 'failed' | 'skipped'; passed: number; total: number; failed: string[]; error?: string } | null;
  /** Метрики аналитика; технический сбой не оценивается. */
  scores: CaseScores | null;
}

export async function evaluate(exec: Execution, resultSeq: number, judge: LlmJudge | null, signal?: AbortSignal, scoring: Scoring = DEFAULT_SCORING): Promise<Evaluation> {
  if (TECH_STATUSES.has(exec.status)) {
    return { outcome: 'technical', reason: exec.reason || exec.status, checks: null, judge: null, scores: null };
  }
  const calls = exec.toolCalls().filter((c) => c.seq <= resultSeq);
  const checks = runActionChecks(exec.caseDef, calls);
  exec.add<ChecksEvent>({ type: 'checks', hidden: true, items: checks });

  const criteria = exec.caseDef.reference.criteria;
  let j: Evaluation['judge'];
  if (!criteria.length) {
    j = { status: 'skipped', passed: 0, total: 0, failed: [], error: 'у кейса нет критериев ответа' };
  } else if (!judge) {
    exec.add<JudgeEvent>({ type: 'judge', hidden: true, status: 'skipped', model: null, criteria: [], summary: '', durationMs: null, usage: null, error: 'модель оценки не выбрана' });
    j = { status: 'skipped', passed: 0, total: criteria.length, failed: [], error: 'модель оценки не выбрана' };
  } else {
    // HTTP-обмены судьи привязываются к событию оценки, когда оно появится.
    const log = exec.llmLog();
    try {
      const r = await judge.evaluate(exec, resultSeq, signal, log.onExchange);
      const byId = new Map(r.value.criteria.map((c) => [c.id, c]));
      const items = criteria.map((c) => ({ id: c.id, text: c.text, passed: !!byId.get(c.id)?.passed, reason: byId.get(c.id)?.reason ?? '' }));
      log.attach(exec.add<JudgeEvent>({ type: 'judge', hidden: true, status: 'ok', model: judge.model.id, criteria: items, summary: r.value.summary, durationMs: r.durationMs, usage: r.usage }));
      j = { status: 'ok', passed: items.filter((i) => i.passed).length, total: items.length, failed: items.filter((i) => !i.passed).map((i) => i.text) };
    } catch (e) {
      const msg = e instanceof StructuredError ? e.message : errorMessage(e);
      const dur = e instanceof StructuredError ? e.attempts.reduce((s, a) => s + a.durationMs, 0) : null;
      log.attach(exec.add<JudgeEvent>({ type: 'judge', hidden: true, status: 'failed', model: judge.model.id, criteria: [], summary: '', durationMs: dur, usage: null, error: msg }));
      // Сбой судьи — «не оценено», а не отрицательная оценка.
      j = { status: 'failed', passed: 0, total: criteria.length, failed: [], error: msg };
    }
  }

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
  if (LIMIT_STATUSES.has(exec.status) && outcome === 'passed') reason += ' (завершён по лимиту)';

  // Метрики аналитика не меняют итог кейса: это отдельные M1 и M2.
  const final = finalAction(exec.caseDef, exec.status, calls, frozenResult(exec, resultSeq).finalReply, scoring);
  const tools = toolsF1(exec.caseDef.reference.tools, calls, scoring.tools);
  const answerLog = exec.llmLog();
  const answer = await answerMatch(exec, final, judge, scoring, signal, answerLog.onExchange);
  const scores: CaseScores = { final, tools, answer, caseScore: caseScore(tools.f1, answer.score, scoring.weights), weights: scoring.weights };
  answerLog.attach(exec.add<ScoresEvent>({ type: 'scores', hidden: true, ...scores }));
  return { outcome, reason, checks, judge: j, scores };
}

/** A_judge: runs независимых прогонов судьи, среднее вердиктов. Сбой любого прогона — оценки нет: градация держится на полном числе прогонов. */
async function answerMatch(exec: Execution, final: FinalAction, judge: LlmJudge | null, s: Scoring, signal?: AbortSignal, onExchange?: LlmRequest['onExchange']): Promise<AnswerMatch> {
  const reference = (exec.caseDef.reference.finalText || exec.caseDef.reference.answer).trim();
  const base: AnswerMatch = { status: 'skipped', score: null, runs: [], model: judge?.model.id ?? null, reference, durationMs: null, usage: null, reason: '' };
  if (!s.answer.enabled) return { ...base, reason: 'в прогоне не выбраны метрики answer-match и case-score' };
  if (final.incomplete) return { ...base, reason: 'агент не завершил кейс' };
  if (!reference) return { ...base, reason: 'у кейса нет эталонного текста (reference.finalText или answer)' };
  if (!final.text) return { ...base, status: 'ok', score: 0, reason: `итоговый текст пуст (${final.textFrom}): 0 без вызова судьи` };
  if (!judge) return { ...base, reason: 'модель оценки не выбрана' };
  const runs: AnswerMatch['runs'] = [];
  let usage: AnswerMatch['usage'] = null;
  let durationMs = 0;
  for (let n = 1; n <= s.answer.runs; n++) {
    try {
      const r = await judge.matchText(exec, final, reference, n, s.answer.runs, signal, onExchange);
      runs.push({ n, match: r.value.match, reason: r.value.reason, durationMs: r.durationMs });
      usage = sumUsage([usage, r.usage]);
      durationMs += r.durationMs;
    } catch (e) {
      const msg = e instanceof StructuredError ? e.message : errorMessage(e);
      const dur = e instanceof StructuredError ? e.attempts.reduce((a, x) => a + x.durationMs, 0) : null;
      runs.push({ n, match: null, reason: '', durationMs: dur, error: msg });
      return { ...base, status: 'failed', runs, durationMs: durationMs + (dur ?? 0), usage, reason: `сбой судьи в прогоне ${n} из ${s.answer.runs}: ${msg}` };
    }
  }
  return { ...base, status: 'ok', score: runs.filter((r) => r.match).length / runs.length, runs, durationMs, usage };
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
  operator: { calls: number; failedAttempts: number; errors: number; modeViolations: number; replies: number };
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
  const lessonSet = new Set<string>();
  const repeated = new Set<string>();
  let unknown = 0;
  const corrected = [
    ...msgs.filter((m) => m.marks?.correction).map((m) => ({ lessonId: m.marks!.lessonId, repeated: !!m.marks!.repeated })),
    ...decisions
      .filter((d) => d.event === 'confirmation' && (d.decision as any)?.correction && !(d.decision as any)?.reply)
      .map((d) => ({ lessonId: ((d.decision as any).lessonId as string) ?? null, repeated: false })),
  ];
  for (const c of corrected) {
    if (c.lessonId) {
      lessonSet.add(c.lessonId);
      if (c.repeated) repeated.add(c.lessonId);
    } else unknown++;
  }

  const confWait = calls.reduce((s, c) => s + (c.confirmation?.waitedMs ?? 0), 0);
  const agentTime = agentMsgs.reduce((s, m) => s + (m.durationMs ?? 0), 0);
  const commands = ev.filter((e) => e.type === 'command').reduce((s, e: any) => s + (e.durationMs ?? 0), 0);
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
    },
  };
}
