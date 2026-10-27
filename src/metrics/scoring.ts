// Метрики аналитика (документ от 22.10.2026, сообщение владельца 27.10.2026): класс финального действия — M1,
// F1 по инструментам и соответствие эталонному тексту — M2. Всё, кроме A_judge, считается по журналу без LLM.
import { FINAL_CLASSES, type CaseDef, type FinalClass, type RefTool } from '../config/types.js';
import { LIMIT_STATUSES, STATUS_TITLES } from '../execution/events.js';
import { whenMatches } from '../stubs/engine.js';
import { getDotted } from '../util/jsonpath.js';

export const FINAL_CLASS_TITLES: Record<FinalClass, string> = {
  close_answer: 'Ответ клиенту и закрытие',
  expertise: 'Экспертиза',
  request_info: 'Запрос информации у клиента',
  operator_instruction: 'Инструкция оператору',
};

/** Вид итогового текста по классу — для судьи и интерфейса. */
export const FINAL_TEXT_KINDS: Record<FinalClass, string> = {
  close_answer: 'ответ клиенту',
  expertise: 'описание экспертизы',
  request_info: 'запрос информации у клиента',
  operator_instruction: 'инструкция оператору',
};

export interface ClassTool {
  tool: string;
  args?: Record<string, unknown>;
}

export type DuplicatesRule = 'tolerate' | 'strict' | 'whole';

export interface Scoring {
  /** Выполненный вызов какого инструмента означает класс; без таких вызовов — инструкция оператору. */
  classes: Record<FinalClass, ClassTool[]>;
  tools: { duplicates: DuplicatesRule; maxRepeats: number; ignore: string[] };
  /** enabled — в прогоне выбрана метрика answer-match или case-score: только тогда вызывается судья. */
  answer: { enabled: boolean; runs: number; text: Partial<Record<FinalClass, string[]>> };
  weights: { tools: number; answer: number };
}

export const DEFAULT_SCORING: Scoring = {
  classes: {
    close_answer: [{ tool: 'get_close_with_answer' }],
    expertise: [{ tool: 'create_expertise' }],
    request_info: [],
    operator_instruction: [],
  },
  tools: { duplicates: 'tolerate', maxRepeats: 3, ignore: [] },
  answer: { enabled: false, runs: 3, text: { close_answer: ['request.extendedAnswer', 'request.shortAnswer'], expertise: ['request.expertiseDescription'] } },
  weights: { tools: 0.5, answer: 0.5 },
};

/** Настройки расчёта из метрик прогона; параметры проверены при загрузке, незаданные берутся по умолчанию. */
export function scoringOf(metrics: { builtin: string; params?: Record<string, unknown> }[]): Scoring {
  const s: Scoring = structuredClone(DEFAULT_SCORING);
  for (const m of metrics) {
    const p: any = m.params ?? {};
    if (m.builtin === 'final-action' && p.classes) {
      for (const k of FINAL_CLASSES) if (p.classes[k]) s.classes[k] = p.classes[k].map((x: string | ClassTool) => (typeof x === 'string' ? { tool: x } : x));
    }
    if (m.builtin === 'tools-f1') s.tools = { duplicates: p.duplicates ?? s.tools.duplicates, maxRepeats: p.maxRepeats ?? s.tools.maxRepeats, ignore: p.ignore ?? s.tools.ignore };
    if (m.builtin === 'answer-match' || m.builtin === 'case-score') s.answer.enabled = true;
    if (m.builtin === 'answer-match') {
      if (p.runs) s.answer.runs = p.runs;
      if (p.text) s.answer.text = { ...s.answer.text, ...p.text };
    }
    if (m.builtin === 'case-score' && p.weights) s.weights = { tools: p.weights.tools, answer: p.weights.answer };
  }
  return s;
}

// ---------------------------------------------------------------- M1: класс финального действия

export function classOfCall(s: Scoring, call: { tool: string; args: Record<string, unknown> }): FinalClass | null {
  for (const k of FINAL_CLASSES) if (s.classes[k].some((c) => c.tool === call.tool && whenMatches(c.args, call.args))) return k;
  return null;
}

/** Эталонный класс: reference.finalClass, иначе — класс инструмента из reference.actions.final. */
export function expectedClass(c: CaseDef, s: Scoring): { cls: FinalClass | null; from: 'finalClass' | 'actions.final' | null } {
  if (c.reference.finalClass) return { cls: c.reference.finalClass, from: 'finalClass' };
  const k = c.reference.final ? classOfCall(s, { tool: c.reference.final, args: {} }) : null;
  return k ? { cls: k, from: 'actions.final' } : { cls: null, from: null };
}

export interface FinalAction {
  expected: FinalClass | null;
  expectedFrom: 'finalClass' | 'actions.final' | null;
  predicted: FinalClass | null;
  /** Агент не завершил кейс: лимит без итогового действия или ни одной реплики. В M1 не входит, считается отдельно. */
  incomplete: boolean;
  correct: boolean | null;
  tool: string | null;
  seq: number | null;
  /** Итоговый текст агента для A_judge и откуда он взят. */
  text: string;
  textFrom: string;
  note: string;
}

/** Класс — по последнему выполненному вызову из соответствия; без такого вызова при обычном завершении — инструкция оператору. */
export function finalAction(c: CaseDef, status: string, calls: { tool: string; args: Record<string, unknown>; executed: boolean; seq: number }[], lastReply: string, s: Scoring): FinalAction {
  const exp = expectedClass(c, s);
  const judge = (predicted: FinalClass) => (exp.cls ? exp.cls === predicted : null);
  const done = calls.filter((e) => e.executed && classOfCall(s, e));
  const last = done[done.length - 1];
  if (last) {
    const predicted = classOfCall(s, last)!;
    const paths = s.answer.text[predicted] ?? [];
    let text = '';
    let textFrom = 'последняя реплика агента';
    if (!paths.length) text = lastReply.trim();
    else {
      textFrom = paths.join(' | ');
      for (const p of paths) {
        const v = getDotted(last.args, p);
        if (typeof v === 'string' && v.trim()) {
          text = v.trim();
          textFrom = p;
          break;
        }
      }
    }
    return { expected: exp.cls, expectedFrom: exp.from, predicted, incomplete: false, correct: judge(predicted), tool: last.tool, seq: last.seq, text, textFrom, note: `выполнен ${last.tool}, событие #${last.seq}` };
  }
  if (LIMIT_STATUSES.has(status) || !lastReply.trim()) {
    const note = LIMIT_STATUSES.has(status) ? `${STATUS_TITLES[status]}, итогового действия нет` : 'агент не ответил';
    return { expected: exp.cls, expectedFrom: exp.from, predicted: null, incomplete: true, correct: null, tool: null, seq: null, text: '', textFrom: '', note };
  }
  return {
    expected: exp.cls,
    expectedFrom: exp.from,
    predicted: 'operator_instruction',
    incomplete: false,
    correct: judge('operator_instruction'),
    tool: null,
    seq: null,
    text: lastReply.trim(),
    textFrom: 'последняя реплика агента',
    note: 'итоговый инструмент не выполнен: последняя реплика агента',
  };
}

export interface ClassReport {
  classes: FinalClass[];
  /** matrix[ожидаемый][фактический] в порядке classes. */
  matrix: number[][];
  perClass: { cls: FinalClass; support: number; predicted: number; tp: number; fp: number; fn: number; f1: number | null }[];
  macroF1: number | null;
  accuracy: number | null;
  completed: number;
}

/** Macro-F1 — среднее F1 по классам, которые есть в эталоне или в ответах агента (как в sklearn). */
export function classReport(pairs: { expected: FinalClass; predicted: FinalClass }[]): ClassReport {
  const n = FINAL_CLASSES.length;
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const p of pairs) matrix[FINAL_CLASSES.indexOf(p.expected)][FINAL_CLASSES.indexOf(p.predicted)]++;
  const perClass = FINAL_CLASSES.map((cls, i) => {
    const tp = matrix[i][i];
    const support = matrix[i].reduce((a, b) => a + b, 0);
    const predicted = matrix.reduce((a, row) => a + row[i], 0);
    const fp = predicted - tp;
    const fn = support - tp;
    const d = 2 * tp + fp + fn;
    return { cls, support, predicted, tp, fp, fn, f1: d ? (2 * tp) / d : null };
  });
  const present = perClass.filter((c) => c.f1 !== null);
  const correct = perClass.reduce((a, c) => a + c.tp, 0);
  return {
    classes: [...FINAL_CLASSES],
    matrix,
    perClass,
    macroF1: present.length ? present.reduce((a, c) => a + c.f1!, 0) / present.length : null,
    accuracy: pairs.length ? correct / pairs.length : null,
    completed: pairs.length,
  };
}

// ---------------------------------------------------------------- M2: F1 по инструментам

export interface ToolRow {
  tool: string;
  ref: number;
  calls: number;
  /** Вызовы после правила дубликатов. */
  counted: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface ToolsF1 {
  f1: number | null;
  tp: number;
  fp: number;
  fn: number;
  rows: ToolRow[];
  rule: string;
  reason: string;
}

export function duplicatesRule(cfg: Scoring['tools']): string {
  const n = cfg.maxRepeats;
  if (cfg.duplicates === 'strict') return 'без схлопывания: каждый вызов сверх эталона — лишний (FP)';
  if (cfg.duplicates === 'whole') return `до ${n} вызовов инструмента считаются одним; с ${n + 1}-го весь инструмент — лишний (FP)`;
  return `до ${n} вызовов инструмента считаются одним; каждый вызов с ${n + 1}-го — лишний (FP)`;
}

/**
 * Правило дубликатов для одного инструмента: p — вызовов, r — нужно по эталону (0 — инструмента в эталоне нет).
 * tolerate: повторы схлопываются, сверх r допускается ещё maxRepeats − 1 вызов, каждый следующий — FP
 * (при r = 1 это «≤3 допустимо, с 4-го — FP»); затем TP = min(p', r), FP = max(0, p' − r), FN = max(0, r − p').
 * strict: формула без схлопывания, p' = p. whole: сверх допустимого весь инструмент — FP, а нужные вызовы — FN.
 */
export function countTool(p: number, r: number, rule: DuplicatesRule, maxRepeats: number): Pick<ToolRow, 'counted' | 'tp' | 'fp' | 'fn'> {
  const base = Math.max(r, 1);
  const tolerance = Math.max(0, maxRepeats - 1);
  let counted: number;
  if (p === 0) counted = 0;
  else if (rule === 'strict') counted = p;
  else if (p <= base + tolerance) counted = Math.min(p, base);
  else if (rule === 'whole') return { counted: p, tp: 0, fp: 1, fn: r };
  else counted = p - tolerance;
  return { counted, tp: Math.min(counted, r), fp: Math.max(0, counted - r), fn: Math.max(0, r - counted) };
}

/** F1 = 2TP / (2TP + FP + FN) по множеству инструментов, порядок вызовов не важен. Пустой эталон без вызовов — 1. */
export function toolsF1(ref: RefTool[] | null, calls: { tool: string }[], cfg: Scoring['tools']): ToolsF1 {
  const rule = duplicatesRule(cfg);
  if (!ref) return { f1: null, tp: 0, fp: 0, fn: 0, rows: [], rule, reason: 'у кейса нет эталона инструментов (reference.tools)' };
  const ignore = new Set(cfg.ignore);
  const need = new Map(ref.filter((r) => !ignore.has(r.tool)).map((r) => [r.tool, r.count]));
  const got = new Map<string, number>();
  for (const c of calls) if (!ignore.has(c.tool)) got.set(c.tool, (got.get(c.tool) ?? 0) + 1);
  const rows: ToolRow[] = [...new Set([...need.keys(), ...got.keys()])].map((tool) => {
    const r = need.get(tool) ?? 0;
    const p = got.get(tool) ?? 0;
    return { tool, ref: r, calls: p, ...countTool(p, r, cfg.duplicates, cfg.maxRepeats) };
  });
  const tp = rows.reduce((a, x) => a + x.tp, 0);
  const fp = rows.reduce((a, x) => a + x.fp, 0);
  const fn = rows.reduce((a, x) => a + x.fn, 0);
  const d = 2 * tp + fp + fn;
  return { f1: d ? (2 * tp) / d : 1, tp, fp, fn, rows, rule, reason: d ? '' : 'эталон пуст и вызовов нет' };
}

// ---------------------------------------------------------------- M2: сводная оценка кейса

export interface AnswerMatch {
  status: 'ok' | 'failed' | 'skipped';
  /** A_judge — доля прогонов судьи с вердиктом «соответствует»: при трёх прогонах 0, ⅓, ⅔ или 1. */
  score: number | null;
  runs: { n: number; match: boolean | null; reason: string; durationMs: number | null; error?: string }[];
  model: string | null;
  reference: string;
  durationMs: number | null;
  usage: { input: number | null; output: number | null } | null;
  reason: string;
}

export interface CaseScores {
  final: FinalAction;
  tools: ToolsF1;
  answer: AnswerMatch;
  /** case_score = w_tools · F1_tools + w_answer · A_judge; нет одной из частей — нет оценки. */
  caseScore: number | null;
  weights: Scoring['weights'];
}

/** Короткая запись в элементе прогона; подробности — в событии scores журнала кейса. */
export interface ItemScores {
  final: { expected: FinalClass | null; predicted: FinalClass | null; incomplete: boolean; correct: boolean | null };
  tools: { f1: number | null; tp: number; fp: number; fn: number; reason: string };
  answer: { status: AnswerMatch['status']; score: number | null; matched: number; runs: number; reason: string };
  caseScore: number | null;
}

export function caseScore(f1: number | null, a: number | null, w: Scoring['weights']): number | null {
  return f1 === null || a === null ? null : w.tools * f1 + w.answer * a;
}

export function itemScores(s: CaseScores): ItemScores {
  return {
    final: { expected: s.final.expected, predicted: s.final.predicted, incomplete: s.final.incomplete, correct: s.final.correct },
    tools: { f1: s.tools.f1, tp: s.tools.tp, fp: s.tools.fp, fn: s.tools.fn, reason: s.tools.reason },
    answer: { status: s.answer.status, score: s.answer.score, matched: s.answer.runs.filter((r) => r.match).length, runs: s.answer.runs.length, reason: s.answer.reason },
    caseScore: s.caseScore,
  };
}

/** Доля с двумя знаками и запятой: 0,83. */
export const fmtShare = (x: number): string => x.toFixed(2).replace('.', ',');
