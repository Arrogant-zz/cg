// Сравнение двух прогонов (RES-02): сопоставимость условий, метрики A → B, различия по кейсам.
// Условия сверяются по снимку входных данных — полный SHA-256 каждого файла и значимые настройки окружения
// (замечание ревью, решение владельца от 28.10.2026). Короткие метки @a91c — только подписи.
import type { InputGroup } from '../runner/inputs.js';
import type { ItemRecord, RunRecord } from '../runner/types.js';
import { stepLabel } from '../runner/operators.js';
import { computeRunMetrics } from '../metrics/builtins.js';
import { plural, stableStringify } from '../util/core.js';

export interface CompareRow {
  key: string;
  title: string;
  a: string;
  b: string;
  same: boolean;
  focus?: boolean;
  /** Что именно различается: файлы снимка и настройки «значение A → значение B». */
  details?: string[];
}

/** С какими скиллами тестовый оператор начал прогон: стартовые скиллы сборки или после всего, через что он прошёл. */
export function operatorLabel(r: RunRecord): string {
  if (r.settings.legacySkillset) return r.settings.legacySkillset;
  const h = r.lines[0]?.history ?? [];
  if (!h.length) return 'новый · стартовые скиллы сборки';
  return `после ${h.map(stepLabel).join(' → ')}`;
}

function agentLabel(r: RunRecord): string {
  const a = r.settings.agent;
  return [a.title, a.build, a.model].filter(Boolean).join(' · ');
}

/** Запись до 28.10.2026: в снимке нет полных хешей и настроек окружения. */
const hasInputs = (r: RunRecord): boolean => r.snapshot.settings !== null;

const setting = (r: RunRecord, key: string): string | undefined => r.snapshot.settings?.find((s) => s.key === key)?.value;

/** Файлы и настройки группы из снимка: путь → SHA-256, ключ → значение. */
function inputsOf(r: RunRecord, group: InputGroup): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of r.snapshot.files) if (f.group === group) m.set(f.file, f.sha256 ?? '');
  for (const s of r.snapshot.settings ?? []) if (s.group === group) m.set(s.key, s.value);
  return m;
}

/** Различия группы: путь файла или «настройка: A → B»; файл только в одном прогоне — с его номером. */
function differences(a: RunRecord, b: RunRecord, group: InputGroup): string[] {
  const x = inputsOf(a, group);
  const y = inputsOf(b, group);
  const keys = new Set((a.snapshot.settings ?? []).concat(b.snapshot.settings ?? []).map((s) => s.key));
  return [...new Set([...x.keys(), ...y.keys()])]
    .filter((k) => x.get(k) !== y.get(k))
    .map((k) => (keys.has(k) ? `${k}: ${x.get(k) || '—'} → ${y.get(k) || '—'}` : !x.has(k) ? `${k} — только в #${b.id}` : !y.has(k) ? `${k} — только в #${a.id}` : k));
}

function modelsLabel(r: RunRecord): string {
  const one = (m: RunRecord['settings']['operator'], role: string) => {
    if (!m) return '—';
    const name = setting(r, `${role}.model`);
    return name && name !== m.id ? `${m.id} (${name})` : m.id;
  };
  return [one(r.settings.operator, 'operator'), one(r.settings.judge, 'judge')].join(' · ');
}

function standLabel(r: RunRecord): string {
  const sec = (key: string) => `${Math.round(Number(setting(r, key) ?? 0) / 1000)} с`;
  return `ход ${sec('TURN_TIMEOUT_MS')} · вызов MCP ${sec('AGENT_MCP_TIMEOUT_MS')}`;
}

/**
 * Строки по снимку входных данных. Файл прогона в сравнение не входит: до и после обучения он разный по замыслу,
 * его параметры — лимиты, метрики, модели и оператор — сверяются отдельными строками. Метрики — по определению
 * (встроенный расчёт, версия, параметры): подпись или описание в файле метрик на расчёт не влияют.
 */
function rowsByInputs(a: RunRecord, b: RunRecord): CompareRow[] {
  const row = (key: string, title: string, group: InputGroup, label: (r: RunRecord) => string): CompareRow => {
    const details = differences(a, b, group);
    return { key, title, a: label(a), b: label(b), same: !details.length, ...(details.length ? { details } : {}) };
  };
  const solutions = (r: RunRecord) => `${r.settings.basket.items} ${plural(r.settings.basket.items, 'решение', 'решения', 'решений')}`;
  return [
    row('basket', 'Корзина', 'basket', (r) => `${r.settings.basket.id} @${r.settings.basket.hash}`),
    row('cases', 'Кейсы и решения', 'cases', solutions),
    row('agent', 'Агент · сборка и модель', 'agent', agentLabel),
    row('models', 'Модели оператора и оценки', 'models', modelsLabel),
    row('prompts', 'Подсказки оператора и судьи', 'prompts', promptsLabel),
    { key: 'metrics', title: 'Определения метрик', a: metricsLabel(a), b: metricsLabel(b), same: metricsKey(a) === metricsKey(b) },
    row('contract', 'Контракт инструментов', 'contract', (r) => `${r.settings.contract.version} @${r.settings.contract.hash}`),
    { key: 'limits', title: 'Лимиты', a: limits(a), b: limits(b), same: limits(a) === limits(b) },
    row('stand', 'Настройки стенда', 'stand', standLabel),
    { key: 'operator', title: 'Тестовый оператор', a: operatorLabel(a), b: operatorLabel(b), same: operatorLabel(a) === operatorLabel(b), focus: true },
  ];
}

function casesHash(r: RunRecord): string {
  return r.lines[0]?.items
    .filter((i) => i.kind === 'case')
    .map((i) => `${i.case?.id}@${i.case?.hash}/${i.solution?.id}@${i.solution?.hash}`)
    .join('|') ?? '';
}

/** Записи до 28.10.2026: короткие метки основных файлов. Стартовое сообщение, умолчания, файлы ответов, шаблон запроса и окружение не видны. */
function legacyRows(a: RunRecord, b: RunRecord): CompareRow[] {
  return [
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
    { key: 'prompts', title: 'Подсказки оператора и судьи', a: promptsLabel(a), b: promptsLabel(b), same: promptsLabel(a) === promptsLabel(b) },
    { key: 'metrics', title: 'Определения метрик', a: metricsLabel(a), b: metricsLabel(b), same: metricsKey(a) === metricsKey(b) },
    { key: 'contract', title: 'Контракт инструментов', a: `${a.settings.contract.version} @${a.settings.contract.hash}`, b: `${b.settings.contract.version} @${b.settings.contract.hash}`, same: a.settings.contract.hash === b.settings.contract.hash },
    { key: 'limits', title: 'Лимиты', a: limits(a), b: limits(b), same: limits(a) === limits(b) },
    { key: 'operator', title: 'Тестовый оператор', a: operatorLabel(a), b: operatorLabel(b), same: operatorLabel(a) === operatorLabel(b), focus: true },
  ];
}

export function compareRuns(a: RunRecord, b: RunRecord) {
  const full = hasInputs(a) && hasInputs(b);
  const rows = full ? rowsByInputs(a, b) : legacyRows(a, b);
  const differ = rows.filter((r) => !r.same);
  const named = differ.length === 1 ? `Отличается только: ${differ[0].title.toLowerCase()}` : `Отличаются: ${differ.map((d) => d.title.toLowerCase()).join(', ')}`;
  // Без перечня входных данных совпадение коротких меток ничего не доказывает: сопоставимость не подтверждается.
  const conclusion = full ? (differ.length ? named : 'Условия совпадают') : differ.some((d) => !d.focus) ? named : 'Сопоставимость не подтверждена';

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
  if (!full) {
    const old = [a, b].filter((r) => !hasInputs(r)).map((r) => `#${r.id}`);
    limitations.push(
      `В ${old.join(' и ')} нет полного перечня входных данных: запись сделана до 28.10.2026. Сверены короткие метки основных файлов; стартовое сообщение, заглушки по умолчанию, файлы ответов, шаблон запроса и подстановки окружения не сравнивались.`,
    );
  }
  const notCompared = cases.filter((c) => c.change === 'na');
  if (notCompared.length) limitations.push(`Не сравниваются ${notCompared.length} позиций: ${notCompared.map((c) => `${c.pos} — ${c.note}`).join('; ')}. Долю успеха сравниваем на ${common.length} кейсах, оценённых в обоих прогонах.`);
  if (a.lines.length > 1 || b.lines.length > 1) limitations.push('Сравнивается первая линия каждого прогона; разброс повторений — на странице результата.');
  if (a.lines.length < 3 && b.lines.length < 3) limitations.push('Малое число повторений: разницу нельзя считать статистически значимой.');
  return {
    a: brief(a),
    b: brief(b),
    rows,
    conclusion,
    comparable: full && differ.every((d) => d.focus),
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
