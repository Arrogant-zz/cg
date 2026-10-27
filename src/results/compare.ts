// Сравнение двух прогонов (RES-02): сопоставимость условий, метрики A → B, различия по кейсам.
import type { ItemRecord, RunRecord } from '../runner/types.js';
import { computeRunMetrics } from '../metrics/builtins.js';
import { plural, stableStringify } from '../util/core.js';

export interface CompareRow {
  key: string;
  title: string;
  a: string;
  b: string;
  same: boolean;
  focus?: boolean;
}

/** С какими скиллами тестовый оператор начал прогон: стартовые скиллы сборки или результат его прошлых прогонов. */
export function operatorLabel(r: RunRecord): string {
  // Записи до 27.10.2026: прогон шёл на установленной версии набора.
  const legacy = (r.settings as any).skillset;
  if (!r.settings.testOperator && legacy) return legacy === 'build' ? 'стартовые скиллы сборки' : `набор ${legacy.title} ${legacy.version}`;
  const h = r.lines[0]?.history ?? [];
  if (!h.length) return 'новый · стартовые скиллы сборки';
  return `после ${h.map((x) => `#${x.run} ${x.type === 'training' ? 'обучение' : 'проверка'}`).join(' → ')}`;
}

function agentLabel(r: RunRecord): string {
  const a = r.settings.agent;
  return [a.title, a.build, a.model].filter(Boolean).join(' · ');
}

function casesHash(r: RunRecord): string {
  return r.lines[0]?.items
    .filter((i) => i.kind === 'case')
    .map((i) => `${i.case?.id}@${i.case?.hash}/${i.solution?.id}@${i.solution?.hash}`)
    .join('|') ?? '';
}

export function compareRuns(a: RunRecord, b: RunRecord) {
  const rows: CompareRow[] = [
    { key: 'basket', title: 'Корзина', a: `${a.settings.basket.id} @${a.settings.basket.hash}`, b: `${b.settings.basket.id} @${b.settings.basket.hash}`, same: a.settings.basket.id === b.settings.basket.id && a.settings.basket.hash === b.settings.basket.hash },
    { key: 'cases', title: 'Кейсы и решения', a: `${a.settings.basket.items} · по снимку`, b: `${b.settings.basket.items} · ${casesHash(a) === casesHash(b) ? 'снимки совпадают' : 'снимки различаются'}`, same: casesHash(a) === casesHash(b) },
    { key: 'agent', title: 'Агент · сборка и модель', a: agentLabel(a), b: agentLabel(b), same: a.settings.agent.id === b.settings.agent.id && a.settings.agent.hash === b.settings.agent.hash && agentLabel(a) === agentLabel(b) },
    {
      key: 'models',
      title: 'Модели оператора и оценки',
      a: [a.settings.operator?.id ?? '—', a.settings.judge?.id ?? '—'].join(' · '),
      b: [b.settings.operator?.id ?? '—', b.settings.judge?.id ?? '—'].join(' · '),
      same: a.settings.operator?.id === b.settings.operator?.id && a.settings.operator?.hash === b.settings.operator?.hash && a.settings.judge?.id === b.settings.judge?.id && a.settings.judge?.hash === b.settings.judge?.hash,
    },
    {
      key: 'prompts',
      title: 'Подсказки оператора и судьи',
      a: promptsLabel(a),
      b: promptsLabel(b),
      same: promptsLabel(a) === promptsLabel(b),
    },
    { key: 'metrics', title: 'Определения метрик', a: metricsLabel(a), b: metricsLabel(b), same: metricsKey(a) === metricsKey(b) },
    { key: 'contract', title: 'Контракт инструментов', a: `${a.settings.contract.version} @${a.settings.contract.hash}`, b: `${b.settings.contract.version} @${b.settings.contract.hash}`, same: a.settings.contract.hash === b.settings.contract.hash },
    { key: 'limits', title: 'Лимиты', a: limits(a), b: limits(b), same: limits(a) === limits(b) },
    { key: 'operator', title: 'Тестовый оператор', a: operatorLabel(a), b: operatorLabel(b), same: operatorLabel(a) === operatorLabel(b), focus: true },
  ];
  const differ = rows.filter((r) => !r.same);
  const conclusion = !differ.length
    ? 'Условия совпадают'
    : differ.length === 1
      ? `Отличается только: ${differ[0].title.toLowerCase()}`
      : `Отличаются: ${differ.map((d) => d.title.toLowerCase()).join(', ')}`;

  // По кейсам: позиция и решение должны совпасть, иначе кейс не сравнивается.
  const itemsA = a.lines[0]?.items.filter((i) => i.kind === 'case') ?? [];
  const itemsB = b.lines[0]?.items.filter((i) => i.kind === 'case') ?? [];
  const n = Math.max(itemsA.length, itemsB.length);
  const cases: { pos: number; case: string; solution: string; a: ItemRecord | null; b: ItemRecord | null; change: 'better' | 'worse' | 'same' | 'na'; note: string }[] = [];
  for (let k = 0; k < n; k++) {
    const x = itemsA[k] ?? null;
    const y = itemsB[k] ?? null;
    const sameItem = x && y && x.solution?.id === y.solution?.id;
    let change: 'better' | 'worse' | 'same' | 'na' = 'na';
    let note = '';
    if (!sameItem) note = 'разные решения на позиции';
    else if (!isEval(x!) || !isEval(y!)) note = !isEval(x!) ? `в #${a.id}: ${label(x!)}` : `в #${b.id}: ${label(y!)}`;
    else if (x!.outcome === y!.outcome) change = 'same';
    else change = y!.outcome === 'passed' ? 'better' : 'worse';
    if (sameItem && change !== 'na') {
      const fa = failures(x!);
      const fb = failures(y!);
      if (change === 'better') note = `В #${b.id} пройдено: ${fa.join('; ') || 'все проверки'}`;
      else if (change === 'worse') note = `В #${b.id} не пройдено: ${fb.join('; ')}`;
      else if (y!.outcome === 'failed') note = `В обоих: ${fb.join('; ')}`;
    }
    cases.push({ pos: k + 1, case: (x ?? y)!.case?.id ?? '', solution: (x ?? y)!.solution?.title ?? '', a: x, b: y, change, note });
  }
  const common = cases.filter((c) => c.change !== 'na');
  const passA = common.filter((c) => c.a?.outcome === 'passed').length;
  const passB = common.filter((c) => c.b?.outcome === 'passed').length;

  const ma = computeRunMetrics(a);
  const mb = computeRunMetrics(b);
  const metrics = ma.map((m) => ({ a: m, b: mb.find((x) => x.id === m.id) ?? null }));
  const limitations: string[] = [];
  const notCompared = cases.filter((c) => c.change === 'na');
  if (notCompared.length) limitations.push(`Не сравниваются ${notCompared.length} позиций: ${notCompared.map((c) => `${c.pos} — ${c.note}`).join('; ')}. Долю успеха сравниваем на ${common.length} кейсах, оценённых в обоих прогонах.`);
  if (a.lines.length > 1 || b.lines.length > 1) limitations.push('Сравнивается первая линия каждого прогона; разброс повторений — на странице результата.');
  if (a.lines.length < 3 && b.lines.length < 3) limitations.push('Малое число повторений: разницу нельзя считать статистически значимой.');
  return {
    a: brief(a),
    b: brief(b),
    rows,
    conclusion,
    comparable: differ.every((d) => d.focus),
    cases,
    counts: {
      better: cases.filter((c) => c.change === 'better').length,
      worse: cases.filter((c) => c.change === 'worse').length,
      same: cases.filter((c) => c.change === 'same').length,
      na: notCompared.length,
    },
    common: { n: common.length, passA, passB },
    metrics,
    limitations,
  };
}

// Параметры входят в определение: другие веса M2 или правило дубликатов F1 — другая метрика.
function metricsKey(r: RunRecord): string {
  return r.settings.metrics.map((m) => `${m.id}:${m.builtin}:${m.version}:${stableStringify(m.params ?? {})}`).join(',');
}
function promptsLabel(r: RunRecord): string {
  const p = r.settings.prompts;
  return [p.operator, p.judge, p.answerJudge].filter(Boolean).join(' · ');
}
function metricsLabel(r: RunRecord): string {
  const n = r.settings.metrics.length;
  const versions = [...new Set(r.settings.metrics.map((m) => m.version))].join(', ');
  return `${n} ${plural(n, 'метрика', 'метрики', 'метрик')} · ${versions}`;
}

function limits(r: RunRecord): string {
  const l = r.settings.limits;
  return `${l.maxTurns} ходов · ${l.maxDurationSec} с · ${l.maxOperatorCalls} запросов`;
}
const isEval = (i: ItemRecord) => i.outcome === 'passed' || i.outcome === 'failed';
const label = (i: ItemRecord) => (i.outcome === 'technical' ? 'технический сбой' : i.outcome === 'not_evaluated' ? 'не оценено' : 'не выполнялся');
const failures = (i: ItemRecord) => [...(i.checks ?? []).filter((c) => c.passed === false).map((c) => c.text), ...i.answerFailed];

function brief(r: RunRecord) {
  return { id: r.id, title: r.title, type: r.type, status: r.status, finishedAt: r.finishedAt, testOperator: operatorLabel(r) };
}
