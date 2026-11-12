// Балл прогона от 0 до 100: одно число рядом с «N из M», по которому видно, какой из прогонов с равным числом успехов ближе
// к эталону (docs/CONTRACTS.md, правило 30). Балл кейса — премия за итог «пройден» и близость к эталону: среднее частей
// «действия» и «ответ». Формула одна на все прогоны: модуль не читает настройки прогона и метрики metrics/*.yaml.
// Балл считается по записи при каждом запросе и в var/ не хранится; итог кейса, M1 и M2 он не меняет.
import type { ItemRecord, RunRecord } from '../runner/types.js';
import { plural } from '../util/core.js';

// Решения владельца от 12–13 ноября 2026 года. Менять их — его решение с записью в docs/CONTRACTS.md: балл считается
// по записи, и другие числа изменят баллы всех прежних прогонов.
/** Премия за итог «пройден». Прогон «1 пройден и 14 с одним замечанием» лучше прогона «8 пройдено и 7 грубых промахов», пока она меньше 27. */
export const PASS_BONUS = 20;
/** Зелёная зона — балл не меньше 100 − премия: не пройденный кейс получает меньше, значит, часть кейсов пройдена целиком. */
export const ZONE_HIGH = 80;
/** Красная зона — балл меньше половины от 80: в среднем по кейсам выполнено меньше половины эталона. */
export const ZONE_LOW = 40;

/** Причина, по которой у набора кейсов нет балла. */
export const NO_EVALUATED = 'нет оценённых кейсов';

export type ScoreZone = 'high' | 'low';

/** Балл оценённого кейса, без округления. */
export interface CaseScore {
  /** От 0 до 100: у пройденного — 100, у не пройденного — меньше 80. */
  value: number;
  /** Части близости к эталону от 0 до 1; null — данных для части нет, нулём она не считается. */
  actions: number | null;
  answer: number | null;
  /** Критерии у кейса есть, но ответ не оценён: судья не выбран или дал сбой. Балл — по одним действиям. */
  noAnswer: boolean;
}

/** Балл набора кейсов — прогона, линии или общих кейсов сравнения — с разложением и полнотой. */
export interface Score {
  /** Целое от 0 до 100; null — оценённых кейсов нет. */
  value: number | null;
  /** Зона по округлённому баллу; null — между границами и при неполной оценке. */
  zone: ScoreZone | null;
  /** Кейсы с баллом и все кейсы набора. Оценка полная, если числа равны. */
  evaluated: number;
  total: number;
  /** Пройденные среди оценённых. */
  passed: number;
  /** Средние части в процентах — по кейсам, у которых часть есть; null — таких кейсов нет. */
  actions: number | null;
  answer: number | null;
  /** У скольких кейсов балл посчитан без части «ответ» из-за судьи. */
  noAnswer: number;
  /** Почему балла нет; пусто, когда он есть. */
  reason: string;
}

export interface LineScore {
  line: number;
  value: number | null;
  evaluated: number;
  total: number;
}

/** Балл и части кейса для таблицы результатов: целые числа, части — в процентах. */
export interface CaseScoreRow {
  line: number;
  index: number;
  value: number | null;
  actions: number | null;
  answer: number | null;
}

export interface RunScore extends Score {
  lines: LineScore[];
  items: CaseScoreRow[];
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const percent = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : Math.round(x * 100));
const present = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null);

// Запись читается терпимо: загрузка проверяет только поля, без которых не строится список (results/format.ts),
// поэтому у кейса может не быть checks, steps и stats. Такой части у кейса просто нет.

/**
 * Часть «действия» — TP / (TP + FN + FP): выполненные обязательные действия вместе с итоговым, делённые на все обязательные
 * и нарушенные запреты. Соблюдённый запрет в счёт не входит: иначе бездействие давало бы очки. Нарушенный — ещё одно
 * невыполненное действие; нарушение — любая попытка вызова, в том числе отклонённая (правило 2). Проверка без результата
 * не считается. Итоговое действие, указанное и в required, и в final, — две проверки. null — считать нечего.
 */
function actionsPart(item: ItemRecord): number | null {
  let done = 0;
  let missed = 0;
  let violated = 0;
  for (const c of item.checks ?? []) {
    if (c.kind === 'forbidden') violated += c.passed === false ? 1 : 0;
    else if (c.kind === 'required' || c.kind === 'final') {
      if (c.passed === true) done++;
      else if (c.passed === false) missed++;
    }
  }
  const all = done + missed + violated;
  return all ? done / all : null;
}

/** Часть «ответ» — доля критериев, которые судья признал выполненными в вердикте, определившем итог; null — вердикта нет. */
function answerPart(item: ItemRecord): number | null {
  const j = item.steps?.judge;
  return j && j.status === 'ok' && j.total > 0 ? j.passed / j.total : null;
}

/** Балл кейса по итоговой попытке; null — кейс не оценён: технический сбой, «не оценено», не начат или идёт. */
export function caseScoreOf(item: ItemRecord): CaseScore | null {
  if (item.kind !== 'case' || (item.outcome !== 'passed' && item.outcome !== 'failed')) return null;
  const actions = actionsPart(item);
  const answer = answerPart(item);
  // Критерии есть, а вердикта нет: судья не выбран или дал сбой. У кейса без критериев total равен нулю.
  const noAnswer = answer === null && (item.steps?.judge?.total ?? 0) > 0;
  // У пройденного кейса все имеющиеся части равны 1: премия и вся близость. Частей может не быть вовсе — балл тот же.
  if (item.outcome === 'passed') return { value: 100, actions, answer, noAnswer };
  const closeness = mean(present([actions, answer]));
  // Не пройденный кейс без обеих частей по правилам итога невозможен; если запись такая, балла у кейса нет.
  if (closeness === null) return null;
  return { value: (100 - PASS_BONUS) * closeness, actions, answer, noAnswer };
}

/** Балл кейса целым числом, как его показывают таблицы; null — кейса нет или он не оценён. */
export function caseScoreValue(item: ItemRecord | null | undefined): number | null {
  const s = item ? caseScoreOf(item) : null;
  return s ? Math.round(s.value) : null;
}

/** Балл набора кейсов: среднее баллов оценённых. Элементы curator в набор не входят. */
export function scoreOf(items: readonly ItemRecord[]): Score {
  const cases = items.filter((i) => i.kind === 'case');
  const scored = cases.flatMap((i) => {
    const s = caseScoreOf(i);
    return s ? [{ ...s, passed: i.outcome === 'passed' }] : [];
  });
  // Среднее неокруглённых баллов кейсов; до целого — один раз, здесь.
  const exact = mean(scored.map((s) => s.value));
  const value = exact === null ? null : Math.round(exact);
  // Зона — по показанному числу и только когда оценены все кейсы: балл по части корзины не выглядит ни успехом, ни неуспехом прогона.
  const complete = scored.length === cases.length;
  return {
    value,
    zone: value === null || !complete ? null : value >= ZONE_HIGH ? 'high' : value < ZONE_LOW ? 'low' : null,
    evaluated: scored.length,
    total: cases.length,
    passed: scored.filter((s) => s.passed).length,
    actions: percent(mean(present(scored.map((s) => s.actions)))),
    answer: percent(mean(present(scored.map((s) => s.answer)))),
    noAnswer: scored.filter((s) => s.noAnswer).length,
    reason: value === null ? NO_EVALUATED : '',
  };
}

/** Балл прогона — по кейсам всех линий. */
export function runScore(run: RunRecord): Score {
  return scoreOf(run.lines.flatMap((l) => l.items));
}

/** Балл прогона с баллами линий и кейсов — для страницы прогона. */
export function runScoreDetail(run: RunRecord): RunScore {
  const lines = run.lines.map((l): LineScore => {
    const s = scoreOf(l.items);
    return { line: l.index, value: s.value, evaluated: s.evaluated, total: s.total };
  });
  const items = run.lines.flatMap((l) =>
    l.items
      .filter((i) => i.kind === 'case')
      .map((i): CaseScoreRow => {
        const s = caseScoreOf(i);
        return { line: l.index, index: i.index, value: caseScoreValue(i), actions: percent(s?.actions), answer: percent(s?.answer) };
      }),
  );
  return { ...runScore(run), lines, items };
}

/**
 * Строка балла в итогах `clawgym run`: балл и разложение — сколько кейсов пройдено из оценённых, средние «действия» и «ответ».
 * Разложение — пояснение, а не сумма: тождество 20 · доля пройденных + 40 · действия + 40 · ответ точно, только когда
 * у всех кейсов есть обе части. Оценены не все кейсы — строка называет, сколько оценено из всех.
 */
export function scoreSummary(score: Score): string {
  if (score.value === null) return `Балл прогона: нет данных — ${score.reason}`;
  const parts = [`${score.value} из 100`, `пройдено ${score.passed} из ${score.evaluated}`];
  if (score.actions !== null) parts.push(`действия ${score.actions} %`);
  if (score.answer !== null) parts.push(`ответ ${score.answer} %`);
  if (score.evaluated < score.total) parts.push(`оценено ${score.evaluated} из ${score.total} ${plural(score.total, 'кейса', 'кейсов', 'кейсов')}`);
  return `Балл прогона: ${parts.join(' · ')}`;
}
