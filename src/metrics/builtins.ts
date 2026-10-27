// Встроенные метрики (MET-01–04). Нет данных — не ноль: значение отсутствует, причина видна.
import type { ItemRecord, LineRecord, RunRecord } from '../runner/types.js';
import { plural } from '../util/core.js';
import { classReport, fmtShare, scoringOf } from './scoring.js';

export interface MetricValue {
  id: string;
  title: string;
  builtin: string;
  status: 'ok' | 'na';
  value: number | null;
  denominator: number | null;
  display: string;
  note: string;
  reason: string;
  series?: { pos: number; value: number | null; mark?: string }[];
  details?: unknown;
}

const caseItems = (lines: LineRecord[]) => lines.flatMap((l) => l.items.filter((i) => i.kind === 'case'));
const evaluated = (items: ItemRecord[]) => items.filter((i) => i.outcome === 'passed' || i.outcome === 'failed');
const done = (items: ItemRecord[]) => items.filter((i) => i.outcome && i.outcome !== 'technical');
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const cases = (n: number) => `${n} ${plural(n, 'кейс', 'кейса', 'кейсов')}`;

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${String(s % 60).padStart(2, '0')} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function formatDuration(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : fmtMs(ms);
}

function na(id: string, title: string, builtin: string, reason: string): MetricValue {
  return { id, title, builtin, status: 'na', value: null, denominator: null, display: 'нет данных', note: '', reason };
}

export function computeRunMetrics(run: RunRecord): MetricValue[] {
  const lines = run.lines;
  const items = caseItems(lines);
  const checking = run.type === 'checking';
  const out: MetricValue[] = [];
  for (const m of run.settings.metrics) {
    const avail = run.metricsAvailability.find((a) => a.id === m.id);
    const base = { id: m.id, title: m.title, builtin: m.builtin };
    switch (m.builtin) {
      case 'action-checks': {
        const withChecks = items.filter((i) => i.checks);
        const ok = withChecks.filter((i) => i.checks!.every((c) => c.passed !== false)).length;
        const passedItems = withChecks.reduce((s, i) => s + i.checks!.filter((c) => c.passed).length, 0);
        const totalItems = withChecks.reduce((s, i) => s + i.checks!.length, 0);
        out.push(
          withChecks.length
            ? { ...base, status: 'ok', value: ok, denominator: withChecks.length, display: `${ok} из ${withChecks.length}`, note: `кейсов без нарушений · проверок ${passedItems}/${totalItems}`, reason: '' }
            : na(m.id, m.title, m.builtin, 'нет завершённых кейсов с проверками'),
        );
        break;
      }
      case 'answer-quality': {
        const judged = items.filter((i) => i.steps.judge?.status === 'ok');
        if (!judged.length) {
          out.push(na(m.id, m.title, m.builtin, avail?.available === false ? avail.reason : 'нет оценённых ответов'));
          break;
        }
        const p = judged.reduce((s, i) => s + (i.steps.judge?.passed ?? 0), 0);
        const t = judged.reduce((s, i) => s + (i.steps.judge?.total ?? 0), 0);
        const failedJudge = items.filter((i) => i.steps.judge?.status === 'failed').length;
        out.push({ ...base, status: 'ok', value: p, denominator: t, display: `${p} из ${t}`, note: `критериев · оценено ${judged.length} кейсов${failedJudge ? ` · сбой судьи: ${failedJudge}` : ''}`, reason: '' });
        break;
      }
      case 'success': {
        const ev = evaluated(items);
        const passed = ev.filter((i) => i.outcome === 'passed').length;
        const tech = items.filter((i) => i.outcome === 'technical').length;
        const notEval = items.filter((i) => i.outcome === 'not_evaluated').length;
        const notStarted = items.filter((i) => !i.outcome).length;
        const parts = [`${items.length} решений`];
        if (tech) parts.push(`${tech} техн. сбой`);
        if (notEval) parts.push(`${notEval} не оценено`);
        if (notStarted) parts.push(`${notStarted} не начато`);
        out.push(
          ev.length
            ? { ...base, status: 'ok', value: passed, denominator: ev.length, display: `${passed} из ${ev.length}`, note: `оценённых · ${parts.join(' · ')}`, reason: '', series: seriesOf(lines, (i) => (i.outcome === 'passed' ? 1 : i.outcome === 'failed' ? 0 : null)) }
            : na(m.id, m.title, m.builtin, notEval ? 'ни один кейс не оценён' : 'нет завершённых кейсов'),
        );
        break;
      }
      case 'corrections': {
        if (checking) {
          out.push(na(m.id, m.title, m.builtin, 'в проверке поправок нет'));
          break;
        }
        const d = done(items);
        const total = d.reduce((s, i) => s + (i.stats?.corrections ?? 0), 0);
        out.push(
          d.length
            ? { ...base, status: 'ok', value: total, denominator: d.length, display: String(total), note: `за прогон · кейсов ${d.length}`, reason: '', series: seriesOf(lines, (i) => (i.outcome && i.outcome !== 'technical' ? (i.stats?.corrections ?? 0) : null), (i) => (i.repeated.length ? 'repeat' : i.outcome === 'technical' ? 'tech' : undefined)) }
            : na(m.id, m.title, m.builtin, 'нет завершённых кейсов'),
        );
        break;
      }
      case 'repeated-corrections': {
        if (checking) {
          out.push(na(m.id, m.title, m.builtin, 'в проверке поправок нет'));
          break;
        }
        const d = done(items);
        const lessons = d.flatMap((i) => i.repeated);
        const totalCorr = d.reduce((s, i) => s + (i.stats?.corrections ?? 0), 0);
        out.push(
          d.length
            ? { ...base, status: 'ok', value: lessons.length, denominator: totalCorr, display: String(lessons.length), note: lessons.length ? `уроки: ${[...new Set(lessons)].join(', ')}` : `из ${totalCorr} поправок`, reason: '', details: lessons }
            : na(m.id, m.title, m.builtin, 'нет завершённых кейсов'),
        );
        break;
      }
      case 'rejected-actions': {
        const d = items.filter((i) => i.stats);
        const op = d.reduce((s, i) => s + (i.stats!.rejected.operator + i.stats!.rejected.human), 0);
        const to = d.reduce((s, i) => s + i.stats!.rejected.timeout, 0);
        out.push(d.length ? { ...base, status: 'ok', value: op, denominator: null, display: String(op), note: `решения оператора${to ? ` · ${to} по таймауту отдельно` : ''}`, reason: '' } : na(m.id, m.title, m.builtin, 'нет выполненных кейсов'));
        break;
      }
      case 'unexpected-tools': {
        const d = items.filter((i) => i.stats);
        const list = d.flatMap((i) => i.stats!.unexpected.map((u) => ({ ...u, pos: i.pos })));
        out.push(
          d.length
            ? { ...base, status: 'ok', value: list.length, denominator: null, display: String(list.length), note: list.length ? list.slice(0, 3).map((u) => `${u.tool} · позиция ${u.pos}`).join(', ') : 'все вызовы с заглушками', reason: '', details: list }
            : na(m.id, m.title, m.builtin, 'нет выполненных кейсов'),
        );
        break;
      }
      case 'turns-duration': {
        const d = items.filter((i) => i.stats);
        if (!d.length) {
          out.push(na(m.id, m.title, m.builtin, 'нет выполненных кейсов'));
          break;
        }
        const total = lines.reduce((s, l) => s + (l.startedAt ? (Date.parse(l.finishedAt ?? new Date().toISOString()) - Date.parse(l.startedAt)) : 0), 0);
        const t = { agent: 0, operator: 0, judge: 0, commands: 0 };
        for (const i of d) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += i.stats!.time[k];
        const cur = lines.reduce((s, l) => s + l.curatorPasses.reduce((x, p) => x + (p.durationMs ?? 0) + (p.reset?.durationMs ?? 0), 0), 0);
        const turns = d.reduce((s, i) => s + i.stats!.turns, 0);
        out.push({
          ...base,
          status: 'ok',
          value: total,
          denominator: null,
          display: fmtMs(total),
          note: `ходов на кейс ${(turns / d.length).toFixed(1).replace('.', ',')} · агент ${fmtMs(t.agent)} · оператор ${fmtMs(t.operator)} · судья ${fmtMs(t.judge)} · команды ${fmtMs(t.commands + cur)}`,
          reason: '',
          details: { turnsPerCase: turns / d.length, time: { ...t, commands: t.commands + cur } },
        });
        break;
      }
      case 'tokens': {
        const d = items.filter((i) => i.stats);
        const agentTok = d.map((i) => i.stats!.tokens.agent).filter(Boolean) as { input: number | null; output: number | null; total: number | null }[];
        const sum = (xs: ({ input: number | null; output: number | null } | null)[]) => xs.reduce((s, x) => s + (x ? (x.input ?? 0) + (x.output ?? 0) : 0), 0);
        const op = sum(d.map((i) => i.stats!.tokens.operator));
        const jd = sum(d.map((i) => i.stats!.tokens.judge));
        const extra = `оператор ${op ? fmtK(op) : 'нет данных'} · судья ${jd ? fmtK(jd) : 'нет данных'}`;
        if (!agentTok.length) {
          out.push({ ...na(m.id, m.title, m.builtin, avail?.reason || 'в ответе агента нет usage'), note: extra, title: 'Токены агента' });
          break;
        }
        const total = agentTok.reduce((s, x) => s + (x.total ?? (x.input ?? 0) + (x.output ?? 0)), 0);
        out.push({ ...base, title: 'Токены агента', status: 'ok', value: total, denominator: null, display: fmtK(total), note: extra, reason: '' });
        break;
      }
      case 'final-action': {
        // M1: macro-F1 по классам финального действия среди завершённых; незавершённые — отдельный счётчик.
        const finished = items.filter((i) => i.outcome);
        const tech = finished.filter((i) => i.outcome === 'technical').length;
        const incomplete = tech + finished.filter((i) => i.scores?.final.incomplete).length;
        const noRef = finished.filter((i) => i.scores && !i.scores.final.incomplete && !i.scores.final.expected).length;
        const pairs = finished.flatMap((i) => (i.scores?.final.expected && i.scores.final.predicted ? [{ expected: i.scores.final.expected, predicted: i.scores.final.predicted }] : []));
        const rep = classReport(pairs);
        const incNote = `незавершённых ${incomplete} из ${finished.length}${tech ? ` · техн. сбой ${tech}` : ''}`;
        if (rep.macroF1 === null) {
          out.push({ ...na(m.id, m.title, m.builtin, noRef ? 'у завершённых кейсов нет эталонного класса (reference.finalClass)' : 'нет завершённых кейсов'), note: finished.length ? incNote : '' });
          break;
        }
        out.push({
          ...base,
          status: 'ok',
          value: rep.macroF1,
          denominator: null,
          display: fmtShare(rep.macroF1),
          note: `accuracy ${fmtShare(rep.accuracy!)} · завершено ${rep.completed} · ${incNote}${noRef ? ` · без эталона класса ${noRef}` : ''}`,
          reason: '',
          details: { ...rep, incomplete, technical: tech, finished: finished.length, noReference: noRef },
        });
        break;
      }
      case 'tools-f1': {
        const scored = items.filter((i) => i.scores);
        const ok = scored.filter((i) => i.scores!.tools.f1 !== null);
        if (!ok.length) {
          out.push(na(m.id, m.title, m.builtin, scored.length ? 'у кейсов нет эталона инструментов (reference.tools)' : 'нет оценённых кейсов'));
          break;
        }
        const v = mean(ok.map((i) => i.scores!.tools.f1!));
        const sum = (k: 'tp' | 'fp' | 'fn') => ok.reduce((a, i) => a + i.scores!.tools[k], 0);
        const noRef = scored.length - ok.length;
        out.push({
          ...base,
          status: 'ok',
          value: v,
          denominator: null,
          display: fmtShare(v),
          note: `среднее · ${cases(ok.length)} · TP ${sum('tp')} · FP ${sum('fp')} · FN ${sum('fn')}${noRef ? ` · без эталона ${noRef}` : ''}`,
          reason: '',
          series: seriesOf(lines, (i) => i.scores?.tools.f1 ?? null),
        });
        break;
      }
      case 'answer-match': {
        const scored = items.filter((i) => i.scores);
        const ok = scored.filter((i) => i.scores!.answer.status === 'ok');
        const failed = scored.filter((i) => i.scores!.answer.status === 'failed').length;
        const skipped = scored.filter((i) => i.scores!.answer.status === 'skipped');
        if (!ok.length) {
          const why = avail?.available === false ? avail.reason : failed ? 'сбой судьи во всех кейсах' : skipped[0]?.scores!.answer.reason || 'нет оценённых кейсов';
          out.push(na(m.id, m.title, m.builtin, why));
          break;
        }
        const runs = scoringOf(run.settings.metrics).answer.runs;
        const v = mean(ok.map((i) => i.scores!.answer.score!));
        out.push({
          ...base,
          status: 'ok',
          value: v,
          denominator: null,
          display: fmtShare(v),
          note: `среднее · ${cases(ok.length)} · ${runs} ${plural(runs, 'прогон', 'прогона', 'прогонов')} судьи на кейс${failed ? ` · сбой судьи ${failed}` : ''}${skipped.length ? ` · без оценки ${skipped.length}` : ''}`,
          reason: '',
          series: seriesOf(lines, (i) => (i.scores?.answer.status === 'ok' ? i.scores.answer.score : null)),
        });
        break;
      }
      case 'case-score': {
        // M2: среднее case_score по кейсам, где есть обе части; F1 и A в подписи — по тем же кейсам, M2 из них складывается точно.
        const w = scoringOf(run.settings.metrics).weights;
        const scored = items.filter((i) => i.scores);
        const ok = scored.filter((i) => i.scores!.caseScore !== null);
        const tech = items.filter((i) => i.outcome === 'technical').length;
        if (!ok.length) {
          out.push(na(m.id, m.title, m.builtin, avail?.available === false ? avail.reason : 'нет кейсов с обеими оценками: F1 инструментов и A_judge'));
          break;
        }
        const v = mean(ok.map((i) => i.scores!.caseScore!));
        const f1 = mean(ok.map((i) => i.scores!.tools.f1!));
        const a = mean(ok.map((i) => i.scores!.answer.score!));
        const excluded = scored.length - ok.length;
        const wt = (x: number) => String(x).replace('.', ',');
        out.push({
          ...base,
          status: 'ok',
          value: v,
          denominator: null,
          display: fmtShare(v),
          note: `${wt(w.tools)} · F1 ${fmtShare(f1)} + ${wt(w.answer)} · A ${fmtShare(a)} · ${cases(ok.length)}${excluded ? ` · без оценки ${excluded}` : ''}${tech ? ` · техн. сбой ${tech}` : ''}`,
          reason: '',
          series: seriesOf(lines, (i) => i.scores?.caseScore ?? null),
          details: { weights: w, f1, answer: a, cases: ok.length, excluded, technical: tech },
        });
        break;
      }
      case 'operator-errors': {
        const d = items.filter((i) => i.stats);
        if (!d.length) {
          out.push(na(m.id, m.title, m.builtin, 'нет выполненных кейсов'));
          break;
        }
        const failed = d.reduce((s, i) => s + i.stats!.operator.failedAttempts, 0);
        const errors = items.filter((i) => ['operator_error', 'operator_format_error', 'operator_timeout', 'operator_mode_violation'].includes(i.status)).length;
        const calls = d.reduce((s, i) => s + i.stats!.operator.calls, 0);
        out.push({ ...base, status: 'ok', value: errors, denominator: null, display: String(errors), note: `сбоев кейсов · неудачных попыток ${failed} из ${calls} вызовов`, reason: '' });
        break;
      }
    }
  }
  return out;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} тыс.` : String(n);
}

function seriesOf(lines: LineRecord[], val: (i: ItemRecord) => number | null, mark?: (i: ItemRecord) => string | undefined) {
  // Кривая по позициям; при нескольких повторениях — среднее, разброс в details.
  const byPos = new Map<number, { vals: number[]; marks: string[] }>();
  for (const l of lines) {
    for (const i of l.items) {
      if (i.kind !== 'case' || i.pos === null) continue;
      const e = byPos.get(i.pos) ?? { vals: [], marks: [] };
      const v = val(i);
      if (v !== null) e.vals.push(v);
      const mk = mark?.(i);
      if (mk) e.marks.push(mk);
      byPos.set(i.pos, e);
    }
  }
  return [...byPos.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pos, e]) => ({
      pos,
      value: e.vals.length ? e.vals.reduce((s, x) => s + x, 0) / e.vals.length : null,
      min: e.vals.length ? Math.min(...e.vals) : null,
      max: e.vals.length ? Math.max(...e.vals) : null,
      mark: e.marks[0],
    }));
}
