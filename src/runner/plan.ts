// План служебных команд корзины (BASK-02, BASK-03): /reset перед каждым кейсом, capture после
// каждого завершённого обучающего кейса, curator по частоте корзины и финальный проход неполной пачки.
import type { BasketDef } from '../config/types.js';

export type PlanStep =
  | { kind: 'case'; pos: number; itemIndex: number; solution: string; reset: true; capture: boolean }
  | { kind: 'curator'; pass: number; afterPos: number; itemIndex: number | null; reason: 'every' | 'final' | 'explicit' };

export function buildPlan(basket: BasketDef): PlanStep[] {
  const training = basket.type === 'training';
  const cur = basket.curator;
  const steps: PlanStep[] = [];
  let counter = 0;
  let pass = 0;
  let pos = 0;
  for (const item of basket.items) {
    if (item.kind === 'solution') {
      pos++;
      steps.push({ kind: 'case', pos, itemIndex: item.index, solution: item.solution, reset: true, capture: training });
      if (training && cur.enabled) {
        counter++;
        if (cur.every > 0 && counter >= cur.every) {
          steps.push({ kind: 'curator', pass: ++pass, afterPos: pos, itemIndex: null, reason: 'every' });
          counter = 0;
        }
      }
    } else if (training) {
      steps.push({ kind: 'curator', pass: ++pass, afterPos: pos, itemIndex: item.index, reason: 'explicit' });
      counter = 0;
    }
  }
  if (training && cur.enabled && cur.final && counter > 0) steps.push({ kind: 'curator', pass: ++pass, afterPos: pos, itemIndex: null, reason: 'final' });
  return steps;
}

/** Текстовое описание правил для экрана запуска и результата. */
export function describePlan(basket: BasketDef, steps: PlanStep[]): string[] {
  const passes = steps.filter((s): s is Extract<PlanStep, { kind: 'curator' }> => s.kind === 'curator');
  if (basket.type === 'checking') {
    return [
      '/reset перед каждым кейсом: проверка не опирается на переписку прошлого кейса.',
      '/case-capture и /skill-curator не отправляются — запрет держат и настройки, и раннер.',
      basket.checking.confirmations === 'approve'
        ? 'Подтверждения инструментов разрешаются без вмешательства оператора; оператор только уточняет факты кейса.'
        : 'Решения по подтверждениям принимает LLM-оператор без обучающих поправок.',
    ];
  }
  const out = ['/reset перед каждым кейсом, следующий шаг — только после успешного ответа.', '/case-capture после каждого завершённого кейса, в том числе решённого неверно.'];
  if (!basket.curator.enabled || !passes.length) out.push('/skill-curator в этой корзине не запускается.');
  else {
    const where = passes.map((p) => (p.reason === 'final' ? `финальный после ${p.afterPos}-го` : `после ${p.afterPos}-го`)).join(', ');
    const freq = basket.curator.every > 0 ? `каждые ${basket.curator.every} завершённых решения` : 'на явных шагах корзины';
    out.push(`/skill-curator ${freq}: ${where}.`);
    if (basket.curator.resetBefore) out.push('Перед /skill-curator отправляется /reset, как в INTEGRATION.md.');
  }
  out.push('Если кейс прерван технически, capture не отправляется и кейс не входит в счётчик curator.');
  return out;
}
