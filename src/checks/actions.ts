// Автоматические проверки действий по журналу инструментов (SOL-06).
// Разрешение вызова оператором ещё не успех: засчитывается фактически выполненный вызов.
import type { CaseDef } from '../config/types.js';
import type { CheckItem, ToolCallEvent } from '../execution/events.js';
import { whenMatches } from '../stubs/engine.js';

function describe(args?: Record<string, unknown>): string {
  return args && Object.keys(args).length ? ` (${Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')})` : '';
}

export function runActionChecks(c: CaseDef, calls: ToolCallEvent[]): CheckItem[] {
  const ref = c.reference;
  const done = (tool: string, args?: Record<string, unknown>) => calls.filter((e) => e.tool === tool && e.executed && whenMatches(args, e.args));
  const out: CheckItem[] = [];

  for (const r of ref.required) {
    const hits = done(r.tool, r.args);
    const text = r.text ?? `Обязательно: ${r.tool}${describe(r.args)}${r.before ? ` до ${r.before}` : ''}`;
    if (!hits.length) {
      const tried = calls.filter((e) => e.tool === r.tool);
      out.push({
        id: r.id,
        kind: 'required',
        text,
        passed: false,
        evidence: tried.map((e) => e.seq),
        note: tried.length ? `вызов был, но не выполнен: ${tried.map((e) => e.outcome).join(', ')}` : 'не вызывался',
      });
      continue;
    }
    if (r.before) {
      const target = calls.filter((e) => e.tool === r.before && e.executed);
      if (target.length && target[0].seq < hits[0].seq) {
        out.push({ id: r.id, kind: 'required', text, passed: false, evidence: [hits[0].seq, target[0].seq], note: `${r.before} выполнен раньше (#${target[0].seq})` });
        continue;
      }
      out.push({ id: r.id, kind: 'required', text, passed: true, evidence: [hits[0].seq, ...(target[0] ? [target[0].seq] : [])], note: target.length ? `событие #${hits[0].seq} раньше #${target[0].seq}` : `событие #${hits[0].seq}` });
      continue;
    }
    out.push({ id: r.id, kind: 'required', text, passed: true, evidence: [hits[0].seq], note: `событие #${hits[0].seq}` });
  }

  for (const f of ref.forbidden) {
    const text = f.text ?? `Запрещено: ${f.tool}${describe(f.args)}`;
    const tried = calls.filter((e) => e.tool === f.tool && whenMatches(f.args, e.args));
    if (!tried.length) out.push({ id: f.id, kind: 'forbidden', text, passed: true, evidence: [], note: 'не вызывался' });
    else {
      const executed = tried.filter((e) => e.executed);
      out.push({
        id: f.id,
        kind: 'forbidden',
        text,
        passed: false,
        evidence: tried.map((e) => e.seq),
        note: executed.length ? `выполнен (#${executed[0].seq})` : `вызывался, отклонён (#${tried[0].seq})`,
      });
    }
  }

  if (ref.final) {
    const hits = done(ref.final);
    out.push({
      id: 'final',
      kind: 'final',
      text: `Итоговое действие: ${ref.final}`,
      passed: hits.length > 0,
      evidence: hits.length ? [hits[hits.length - 1].seq] : calls.filter((e) => e.tool === ref.final).map((e) => e.seq),
      note: hits.length ? `событие #${hits[hits.length - 1].seq}` : 'не выполнено',
    });
  }
  return out;
}
