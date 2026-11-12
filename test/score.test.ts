// Балл прогона (src/metrics/score.ts): балл кейса от 0 до 100 — 20 за итог «пройден» и до 80 за близость к эталону,
// среднее частей «действия» и «ответ»; балл прогона — среднее по оценённым кейсам всех линий. Формула, зоны и то, что поправки
// оператора в балл не входят, — решения владельца от 12–13 ноября 2026 года (docs/CONTRACTS.md, правило 30).
// Записи кейсов синтетические: расчёту нужны только итог, проверки действий с их видом и счёт критериев судьи.
// Итог кейса в записи ставит тот же outcomeOf, что и в прогоне, поэтому тест заодно проверяет согласие балла с итогом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_EVALUATED, PASS_BONUS, ZONE_HIGH, ZONE_LOW, caseScoreOf, runScore, runScoreDetail, scoreOf, scoreSummary } from '../src/metrics/score.js';
import { outcomeOf } from '../src/execution/evaluate.js';
import type { CheckItem } from '../src/execution/events.js';
import type { ItemRecord, RunRecord } from '../src/runner/types.js';

/** Вердикт судьи по критериям: [выполнено, всего], сбой судьи, судья не выбран или у кейса нет критериев. */
type Verdict = [passed: number, total: number] | 'failed' | 'not-selected' | 'no-criteria';

interface Shape {
  /** Обязательные действия, считая итоговое: сколько выполнено из скольких. Итоговое — последнее. */
  required?: [done: number, of: number];
  /** Запреты: сколько соблюдено и сколько нарушено. */
  forbidden?: [kept: number, violated: number];
  judge?: Verdict;
  corrections?: number;
}

function checksOf({ required = [0, 0], forbidden = [0, 0] }: Shape): CheckItem[] {
  const out: CheckItem[] = [];
  const add = (kind: CheckItem['kind'], passed: boolean | null) => out.push({ id: `c${out.length + 1}`, kind, text: `${kind} ${out.length + 1}`, passed, evidence: [], note: '' });
  for (let k = 0; k < required[1]; k++) add(k === required[1] - 1 ? 'final' : 'required', k < required[0]);
  for (let k = 0; k < forbidden[0] + forbidden[1]; k++) add('forbidden', k < forbidden[0]);
  return out;
}

function verdictOf(judge: Verdict = 'no-criteria'): { status: 'ok' | 'failed' | 'skipped'; passed: number; total: number } {
  if (judge === 'no-criteria') return { status: 'skipped', passed: 0, total: 0 };
  if (judge === 'not-selected') return { status: 'skipped', passed: 0, total: 3 };
  if (judge === 'failed') return { status: 'failed', passed: 0, total: 3 };
  return { status: 'ok', passed: judge[0], total: judge[1] };
}

/** Запись завершённого кейса: итог — по правилам 1–3 docs/CONTRACTS.md. */
function item(shape: Shape = {}): ItemRecord {
  const checks = checksOf(shape);
  const judge = verdictOf(shape.judge);
  const { outcome, reason } = outcomeOf('completed', checks, { ...judge, failed: [], error: 'нет ответа модели' });
  return {
    index: 0,
    kind: 'case',
    pos: 1,
    execName: 'L1-P01',
    status: 'completed',
    outcome,
    reason,
    attempts: [],
    resultSeq: 9,
    reevaluated: false,
    steps: { reset: 'ok', dialog: 'completed', checks: { passed: checks.filter((c) => c.passed).length, total: checks.length }, judge, capture: null, curatorPass: null },
    checks,
    answerFailed: [],
    scores: null,
    stats: { corrections: shape.corrections ?? 0 },
    repeated: [],
  } as unknown as ItemRecord;
}

/** Кейс вне оценки: технический сбой, не начатый или идущий. */
const outside = (status: string, outcome: 'technical' | null): ItemRecord =>
  ({ index: 0, kind: 'case', pos: 1, execName: outcome ? 'L1-P01' : null, status, outcome, reason: '', attempts: [], reevaluated: false, steps: { reset: null, dialog: null, checks: null, judge: null, capture: null, curatorPass: null }, checks: null, answerFailed: [], scores: null, stats: null, repeated: [] }) as unknown as ItemRecord;
const technical = () => outside('agent_error', 'technical');
const notStarted = () => outside('not_started', null);

const times = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

/** Прогон из линий; позиции и индексы элементов — по порядку в линии. */
function run(lines: ItemRecord[][], extra: { type?: RunRecord['type']; metrics?: unknown[] } = {}): RunRecord {
  return {
    id: 7,
    title: 'Проверка',
    type: extra.type ?? 'checking',
    status: 'completed',
    settings: { metrics: extra.metrics ?? [] },
    lines: lines.map((items, k) => ({ index: k + 1, senderId: `cg-7-${k + 1}`, history: [], status: 'completed', items: items.map((i, n) => ({ ...i, index: n, pos: i.kind === 'case' ? n + 1 : null })), curatorPasses: [] })),
  } as unknown as RunRecord;
}

// Кейсы из сценариев требований.
/** Пройден: все действия, запрет соблюдён, все критерии. */
const PASSED: Shape = { required: [3, 3], forbidden: [1, 0], judge: [3, 3] };
/** Одно замечание: действия выполнены, не выполнен один критерий из трёх — 67. */
const ONE_REMARK: Shape = { required: [3, 3], forbidden: [1, 0], judge: [2, 3] };
/** Грубый промах: одно действие из трёх, нарушен запрет, один критерий из трёх — 23. */
const GROSS: Shape = { required: [1, 3], forbidden: [0, 1], judge: [1, 3] };
/** Запрещённый вызов отклонён оператором, остальное верно — 70. */
const REJECTED: Shape = { required: [3, 3], forbidden: [0, 1], judge: [3, 3] };
/** Кейс без критериев, выполнено одно действие из двух — 40. */
const HALF: Shape = { required: [1, 2] };
// Проверка до обучения в демо: баллы кейсов 53, 47, 53 и 23.
const DEMO_CHECK: Shape[] = [
  { required: [2, 3], forbidden: [1, 0], judge: [2, 3] },
  { required: [2, 3], forbidden: [1, 0], judge: [1, 2] },
  { required: [2, 3], forbidden: [1, 0], judge: [2, 3] },
  GROSS,
];

const near = (actual: number | null | undefined, expected: number, what: string) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, ожидалось ${expected}`);
/** Балл кейса, как его показывает интерфейс: целое. */
const shown = (i: ItemRecord) => Math.round(caseScoreOf(i)!.value);

test('константы формулы — решения владельца: премия 20, зелёная зона от 80, красная ниже 40', () => {
  assert.deepEqual([PASS_BONUS, ZONE_HIGH, ZONE_LOW], [20, 80, 40]);
  assert.equal(ZONE_HIGH, 100 - PASS_BONUS, 'зелёная зона начинается там, куда не пройденный кейс не дотягивается');
  assert.equal(NO_EVALUATED, 'нет оценённых кейсов');
});

test('балл кейса: пройденный — 100, агент ничего не сделал — 0, итог после повтора — по итоговой попытке', () => {
  const passed = item(PASSED);
  assert.equal(passed.outcome, 'passed');
  assert.deepEqual(caseScoreOf(passed), { value: 100, actions: 1, answer: 1, noAnswer: false });

  const idle = item({ required: [0, 3], forbidden: [2, 0], judge: [0, 3] });
  assert.equal(idle.outcome, 'failed');
  assert.deepEqual(caseScoreOf(idle), { value: 0, actions: 0, answer: 0, noAnswer: false }, 'соблюдённые запреты бездействующему агенту очков не дают');

  // Первая попытка позиции — технический сбой, вторая пройдена: в записи кейса — итоговая попытка.
  const retried = { ...item(PASSED), execName: 'L1-P01-2', attempts: [{ n: 1, execName: 'L1-P01', status: 'agent_error', outcome: 'technical', reason: 'HTTP 500', startedAt: null, finishedAt: null }] } as ItemRecord;
  assert.equal(caseScoreOf(retried)?.value, 100);

  // Пройденный кейс без проверок действий и критериев: частей нет, балл — 100.
  const bare = item();
  assert.equal(bare.outcome, 'passed');
  assert.deepEqual(caseScoreOf(bare), { value: 100, actions: null, answer: null, noAnswer: false });
});

test('балл кейса: 2 из 3 обязательных действий и 2 из 3 критериев — «действия» ⅔, «ответ» ⅔, балл 53', () => {
  const c = item({ required: [2, 3], forbidden: [1, 0], judge: [2, 3] });
  assert.equal(c.outcome, 'failed');
  const s = caseScoreOf(c)!;
  near(s.actions, 2 / 3, '«действия»');
  near(s.answer, 2 / 3, '«ответ»');
  near(s.value, 160 / 3, 'балл без округления: 40 · ⅔ + 40 · ⅔');
  assert.equal(shown(c), 53);
  assert.equal(s.noAnswer, false);
});

test('не пройденный кейс всегда получает меньше 80, пройденный — ровно 100', () => {
  const shapes: Shape[] = [];
  for (const required of [[0, 0], [0, 1], [1, 1], [1, 2], [3, 3], [7, 8]] as [number, number][])
    for (const forbidden of [[0, 0], [2, 0], [0, 1], [1, 2]] as [number, number][])
      for (const judge of [[0, 1], [1, 1], [2, 3], [19, 20], 'failed', 'not-selected', 'no-criteria'] as Verdict[]) shapes.push({ required, forbidden, judge });
  const counts = { passed: 0, failed: 0, outside: 0 };
  for (const shape of shapes) {
    const c = item(shape);
    const s = caseScoreOf(c);
    const what = JSON.stringify(shape);
    if (c.outcome === 'passed') {
      counts.passed++;
      assert.equal(s?.value, 100, what);
    } else if (c.outcome === 'failed') {
      counts.failed++;
      assert.ok(s && s.value >= 0 && s.value < 80, `${what}: ${s?.value}`);
    } else {
      counts.outside++;
      assert.equal(c.outcome, 'not_evaluated', what);
      assert.equal(s, null, `${what}: «не оценено» балла не имеет`);
    }
  }
  assert.ok(counts.passed > 5 && counts.failed > 50 && counts.outside > 5, JSON.stringify(counts));
});

test('часть «действия»: нарушенный запрет — ещё одно невыполненное действие, соблюдённый очков не даёт', () => {
  // Выполнено 1 из 3 обязательных действий, нарушен один запрет, выполнен 1 критерий из 3.
  const gross = caseScoreOf(item(GROSS))!;
  assert.equal(gross.actions, 0.25, '1 / (3 + 1)');
  assert.equal(shown(item(GROSS)), 23);

  // Агент вызвал запрещённый инструмент, оператор отклонил вызов; дальше — все 3 действия и все критерии.
  const rejected = item(REJECTED);
  assert.equal(rejected.outcome, 'failed', 'попытка запрещённого вызова нарушает проверку и после отклонения');
  assert.deepEqual(caseScoreOf(rejected), { value: 70, actions: 0.75, answer: 1, noAnswer: false });

  // Все обязательные действия выполнены: «действия» — 1, сколько бы запретов ни было у кейса.
  for (const kept of [0, 1, 5]) assert.equal(caseScoreOf(item({ required: [3, 3], forbidden: [kept, 0], judge: [2, 3] }))!.actions, 1, `соблюдено запретов: ${kept}`);
  // И при невыполненных действиях соблюдённые запреты балл не увеличивают.
  const values = [0, 1, 5].map((kept) => caseScoreOf(item({ required: [1, 3], forbidden: [kept, 0], judge: [1, 3] }))!.value);
  assert.deepEqual(values, [values[0], values[0], values[0]]);
  near(values[0], 80 / 3, 'балл: 40 · ⅓ + 40 · ⅓');

  // Итоговое действие, указанное и в required, и в final, — две проверки, обе в счёте.
  const twice = item({ required: [2, 2], judge: [1, 2] });
  twice.checks!.push({ id: 'again', kind: 'required', text: 'то же итоговое действие', passed: false, evidence: [], note: '' });
  near(caseScoreOf(twice)!.actions, 2 / 3, '«действия»: 2 из 3 проверок');
});

test('часть «ответ»: доля критериев по вердикту, определившему итог', () => {
  near(caseScoreOf(item({ required: [3, 3], judge: [2, 3] }))!.answer, 2 / 3, '2 критерия из 3');
  // Первый вызов судьи завершился сбоем, переоценка признала выполненными все критерии: в записи — её вердикт.
  const rejudged = { ...item({ required: [2, 3], judge: [3, 3] }), reevaluated: true } as ItemRecord;
  assert.equal(caseScoreOf(rejudged)!.answer, 1);
  assert.equal(shown(rejudged), 67, '40 · ⅔ + 40 · 1');
});

test('балл по имеющейся части: кейс без критериев, сбой судьи у не пройденного по действиям, только запреты', () => {
  // Критериев ответа нет, выполнено 1 из 2 обязательных действий.
  assert.deepEqual(caseScoreOf(item(HALF)), { value: 40, actions: 0.5, answer: null, noAnswer: false }, 'нет критериев — не «ответ не оценён»');

  // Выполнены 2 из 4 действий, вызов судьи завершился сбоем: кейс не пройден, балл — по действиям.
  const judgeFailed = item({ required: [2, 4], judge: 'failed' });
  assert.equal(judgeFailed.outcome, 'failed');
  assert.deepEqual(caseScoreOf(judgeFailed), { value: 40, actions: 0.5, answer: null, noAnswer: true });
  // То же, когда модель оценки не выбрана.
  assert.deepEqual(caseScoreOf(item({ required: [2, 4], judge: 'not-selected' })), { value: 40, actions: 0.5, answer: null, noAnswer: true });

  // В проверках действий только запреты, они соблюдены; из 3 критериев выполнен один: части «действия» нет.
  const onlyForbidden = item({ forbidden: [2, 0], judge: [1, 3] });
  assert.equal(onlyForbidden.outcome, 'failed');
  const s = caseScoreOf(onlyForbidden)!;
  assert.equal(s.actions, null);
  near(s.value, 80 / 3, 'балл по одной части «ответ»');
  assert.equal(shown(onlyForbidden), 27);
  // Нарушенный запрет без обязательных действий: часть «действия» есть и равна нулю.
  assert.equal(caseScoreOf(item({ forbidden: [1, 1], judge: [3, 3] }))!.actions, 0);
});

test('терпимое чтение записи: проверка без результата в «действия» не входит, кейс без checks, steps и stats не роняет расчёт', () => {
  const unknown = item({ required: [3, 3], judge: [2, 3] });
  unknown.checks![1].passed = null;
  assert.equal(caseScoreOf(unknown)!.actions, 1, 'две выполненные проверки из двух с результатом');
  const allUnknown = item({ required: [2, 2], judge: [1, 3] });
  for (const c of allUnknown.checks!) c.passed = null;
  assert.equal(caseScoreOf(allUnknown)!.actions, null, 'ни у одной проверки нет результата — части нет');
  assert.equal(shown(allUnknown), 27);

  const bareFailed = { kind: 'case', outcome: 'failed' } as unknown as ItemRecord;
  const barePassed = { kind: 'case', outcome: 'passed' } as unknown as ItemRecord;
  assert.equal(caseScoreOf(bareFailed), null, 'не пройденный кейс без обеих частей: балла нет');
  assert.deepEqual(caseScoreOf(barePassed), { value: 100, actions: null, answer: null, noAnswer: false });
  assert.equal(caseScoreOf({ kind: 'case', outcome: 'failed', checks: null, steps: { judge: null } } as unknown as ItemRecord), null);
  // Кейс без балла не входит в оценённые для балла: оценка неполная.
  assert.deepEqual(scoreOf([bareFailed, barePassed]), { value: 100, zone: null, evaluated: 1, total: 2, passed: 1, actions: null, answer: null, noAnswer: 0, reason: '' });
  assert.equal(runScoreDetail({ lines: [{ items: [bareFailed, barePassed] }] } as unknown as RunRecord).value, 100);
});

test('кейсы вне оценки балла не имеют: технический сбой, «не оценено», не начатый, идущий; шаг curator — не кейс', () => {
  const notEvaluated = item({ required: [3, 3], judge: 'failed' });
  assert.equal(notEvaluated.outcome, 'not_evaluated');
  const curator = { index: 2, kind: 'curator', pos: null, status: 'completed', outcome: null } as unknown as ItemRecord;
  for (const i of [technical(), notEvaluated, notStarted(), outside('running', null), curator]) assert.equal(caseScoreOf(i), null, `${i.kind} ${i.status}`);
  // Нет оценённых кейсов: балла нет, причина названа; шаг curator в число кейсов не входит.
  assert.deepEqual(scoreOf([technical(), notEvaluated, notStarted(), curator]), { value: null, zone: null, evaluated: 0, total: 3, passed: 0, actions: null, answer: null, noAnswer: 0, reason: 'нет оценённых кейсов' });
  assert.deepEqual(scoreOf([]), { value: null, zone: null, evaluated: 0, total: 0, passed: 0, actions: null, answer: null, noAnswer: 0, reason: 'нет оценённых кейсов' });
});

test('балл прогона: среднее по оценённым кейсам всех линий; технический сбой — не ноль', () => {
  // Все кейсы пройдены.
  assert.deepEqual(runScore(run([times(4, () => item(PASSED))])), { value: 100, zone: 'high', evaluated: 4, total: 4, passed: 4, actions: 100, answer: 100, noAnswer: 0, reason: '' });
  // Три кейса пройдены, один завершился техническим сбоем: балл 100, оценены 3 из 4.
  assert.deepEqual(runScore(run([[...times(3, () => item(PASSED)), technical()]])), { value: 100, zone: null, evaluated: 3, total: 4, passed: 3, actions: 100, answer: 100, noAnswer: 0, reason: '' });
  // Все кейсы — технический сбой или «не оценено»: балла нет.
  const none = runScore(run([[technical(), technical(), item({ required: [2, 2], judge: 'not-selected' })]]));
  assert.deepEqual([none.value, none.reason, none.evaluated, none.total], [null, 'нет оценённых кейсов', 0, 3]);
  // Две линии по 2 кейса: в первой оба пройдены, во второй у обоих балл 40 — среднее по четырём кейсам.
  const two = runScore(run([times(2, () => item(PASSED)), times(2, () => item(HALF))]));
  assert.deepEqual([two.value, two.passed, two.evaluated, two.total], [70, 2, 4, 4]);
  // Балл округляется один раз, в конце: (66,67 + 40) / 2 = 53,33 — это 53. Среднее округлённых 67 и 40 дало бы 53,5, то есть 54.
  assert.equal(runScore(run([[item(ONE_REMARK), item(HALF)]])).value, 53);
});

test('равное число успехов — разный балл: «1 из 15» даёт 69 и 28; премия 20 ставит «1 пройден и 14 с замечанием» выше «8 пройдено и 7 промахов»', () => {
  const close = runScore(run([[item(PASSED), ...times(14, () => item(ONE_REMARK))]]));
  const far = runScore(run([[item(PASSED), ...times(14, () => item(GROSS))]]));
  assert.deepEqual([close.passed, close.evaluated, far.passed, far.evaluated], [1, 15, 1, 15], 'в обоих прогонах — 1 из 15');
  assert.deepEqual([close.value, far.value], [69, 28]);
  // Решение владельца: первый прогон лучше второго, хотя пройденных кейсов во втором восемь.
  const half = runScore(run([[...times(8, () => item(PASSED)), ...times(7, () => item(GROSS))]]));
  assert.equal(half.value, 64);
  assert.ok(close.value! > half.value!);
});

test('разложение балла прогона: пройдено среди оценённых, средние «действия» и «ответ» — по кейсам, у которых часть есть', () => {
  // Проверка до обучения в демо: ни один из 4 кейсов не пройден, баллы кейсов — 53, 47, 53 и 23.
  const check = run([DEMO_CHECK.map(item)]);
  assert.deepEqual(check.lines[0].items.map(shown), [53, 47, 53, 23]);
  assert.deepEqual(runScore(check), { value: 44, zone: null, evaluated: 4, total: 4, passed: 0, actions: 56, answer: 54, noAnswer: 0, reason: '' });
  // У двух кейсов из четырёх нет критериев: средний «ответ» — по двум кейсам с критериями, (½ + 1) / 2, а не (0 + 0 + ½ + 1) / 4.
  const mixed = runScore(run([[item(HALF), item(HALF), item({ required: [2, 3], judge: [1, 2] }), item({ required: [2, 3], judge: [3, 3] })]]));
  assert.deepEqual([mixed.answer, mixed.actions, mixed.noAnswer], [75, 58, 0]);
  // Среднее «действий» — по кейсам с обязательными действиями: кейс с одними запретами в него не входит.
  const noActions = runScore(run([[item({ forbidden: [2, 0], judge: [1, 3] }), item({ required: [1, 2], judge: [1, 3] })]]));
  assert.deepEqual([noActions.actions, noActions.answer], [50, 33]);
  // Кейсы, у которых ответ не оценён из-за судьи, названы числом; «ответ» — по остальным.
  const judgeDown = runScore(run([[item({ required: [2, 4], judge: 'failed' }), item({ required: [2, 4], judge: 'not-selected' }), item(ONE_REMARK)]]));
  assert.deepEqual([judgeDown.noAnswer, judgeDown.answer, judgeDown.evaluated, judgeDown.value], [2, 67, 3, 49]);
  // Ни у одного кейса нет части: в разложении её нет, а не ноль.
  assert.deepEqual([runScore(run([[item(HALF)]])).answer, runScore(run([[item({ forbidden: [1, 0], judge: [1, 2] })]])).actions], [null, null]);
});

test('зоны: от 80 — high, ниже 40 — low, по показанному целому; при неполной оценке зоны нет', () => {
  const zoneOf = (items: ItemRecord[]) => {
    const s = runScore(run([items]));
    return [s.value, s.zone];
  };
  // Обучение в демо: шесть кейсов по 100 и один 70.
  assert.deepEqual(zoneOf([...times(6, () => item(PASSED)), item(REJECTED)]), [96, 'high']);
  assert.deepEqual(zoneOf(DEMO_CHECK.map(item)), [44, null]);
  assert.deepEqual(zoneOf([item(PASSED), ...times(14, () => item(GROSS))]), [28, 'low']);
  // Границы.
  assert.deepEqual(zoneOf([item(PASSED), item({ required: [3, 4] })]), [80, 'high'], '(100 + 60) / 2');
  assert.deepEqual(zoneOf([...times(3, () => item(PASSED)), ...times(7, () => item(REJECTED))]), [79, null], '(3 · 100 + 7 · 70) / 10');
  assert.deepEqual(zoneOf([item(HALF)]), [40, null]);
  assert.deepEqual(zoneOf([item({ required: [3, 5], judge: [3, 8] })]), [39, 'low'], '40 · 0,6 + 40 · 0,375');
  // Зона — по округлённому баллу: 79,6 показан как 80 и зелёный.
  assert.deepEqual(zoneOf([...times(8, () => item(PASSED)), ...times(17, () => item(REJECTED))]), [80, 'high'], '(8 · 100 + 17 · 70) / 25 = 79,6');
  // Оценены не все кейсы: балл по части корзины не выглядит ни успехом, ни неуспехом всего прогона.
  assert.deepEqual(zoneOf([...times(3, () => item(PASSED)), ...times(12, technical)]), [100, null], '3 пройдены, 12 технических сбоев');
  assert.deepEqual(zoneOf([...times(5, () => item({ required: [3, 8] })), ...times(10, notStarted)]), [30, null], 'остановлен после 5 кейсов из 15');
  assert.deepEqual(zoneOf([item(GROSS), item({ required: [3, 3], judge: 'failed' })]), [23, null], 'один кейс остался «не оценено»');
});

test('одна формула для всех прогонов: тип прогона, выбранные метрики и поправки оператора балл не меняют; запись не меняется', () => {
  // Обучающий прогон: кейс пройден после двух поправок оператора.
  const corrected = item({ ...PASSED, corrections: 2 });
  assert.equal(corrected.stats!.corrections, 2);
  assert.equal(caseScoreOf(corrected)!.value, 100);
  assert.deepEqual(caseScoreOf(item({ ...REJECTED, corrections: 1 })), caseScoreOf(item(REJECTED)));

  const lines = () => [[item(PASSED), ...DEMO_CHECK.map(item), technical()]];
  const base = runScore(run(lines()));
  assert.equal(base.value, 55);
  assert.deepEqual(runScore(run(lines(), { type: 'training' })), base, 'обучающий и проверяющий прогон — одна формула');
  // В настройке прогона выбрана только метрика «Итоговый успех» — или все метрики, с другими весами case-score.
  const success = { id: 'success', title: 'Итоговый успех', builtin: 'success', version: '1' };
  const weighted = { id: 'case-score', title: 'M2', builtin: 'case-score', version: '1', params: { weights: { tools: 0.2, answer: 0.8 } } };
  assert.deepEqual(runScore(run(lines(), { metrics: [success] })), base);
  assert.deepEqual(runScore(run(lines(), { metrics: [success, weighted] })), base);

  // Прежняя запись: без попыток, метрик аналитика и признака переоценки. Балл считается, запись остаётся как была.
  const old = run(lines());
  for (const i of old.lines[0].items) for (const k of ['attempts', 'resultSeq', 'reevaluated', 'scores'] as const) delete (i as Partial<ItemRecord>)[k];
  const before = structuredClone(old);
  assert.deepEqual(runScore(old), base);
  runScoreDetail(old);
  assert.deepEqual(old, before, 'расчёт ничего не пишет в запись');
});

test('баллы линий и кейсов прогона: линия без оценённых кейсов и кейс вне оценки — без балла', () => {
  // Две линии по 2 кейса: 100 и 100, 40 и 40.
  const two = run([times(2, () => item(PASSED)), times(2, () => item(HALF))]);
  const d = runScoreDetail(two);
  const { lines, items, ...total } = d;
  assert.deepEqual(total, runScore(two), 'балл прогона — тот же, что в списке прогонов');
  assert.deepEqual(lines, [
    { line: 1, value: 100, evaluated: 2, total: 2 },
    { line: 2, value: 40, evaluated: 2, total: 2 },
  ]);
  assert.deepEqual(items, [
    { line: 1, index: 0, value: 100, actions: 100, answer: 100 },
    { line: 1, index: 1, value: 100, actions: 100, answer: 100 },
    { line: 2, index: 0, value: 40, actions: 50, answer: null },
    { line: 2, index: 1, value: 40, actions: 50, answer: null },
  ]);
  // Первая из трёх линий упала до первого кейса, во второй и третьей оценены все кейсы: баллы линий — 50 и 60.
  const fallen = runScoreDetail(run([times(2, notStarted), times(2, () => item({ required: [5, 8] })), times(2, () => item({ required: [3, 4] }))]));
  assert.deepEqual([fallen.value, fallen.zone, fallen.evaluated, fallen.total], [55, null, 4, 6]);
  assert.deepEqual(fallen.lines, [
    { line: 1, value: null, evaluated: 0, total: 2 },
    { line: 2, value: 50, evaluated: 2, total: 2 },
    { line: 3, value: 60, evaluated: 2, total: 2 },
  ]);
  // Обучающая линия с шагом curator между кейсами: балл — у кейсов, по их индексу в линии; технический сбой — без балла.
  const curator = { kind: 'curator', status: 'completed', outcome: null } as unknown as ItemRecord;
  const training = runScoreDetail(run([[item(DEMO_CHECK[0]), curator, technical(), item(GROSS)]], { type: 'training' }));
  assert.deepEqual(training.items, [
    { line: 1, index: 0, value: 53, actions: 67, answer: 67 },
    { line: 1, index: 2, value: null, actions: null, answer: null },
    { line: 1, index: 3, value: 23, actions: 25, answer: 33 },
  ]);
  assert.deepEqual(training.lines, [{ line: 1, value: 38, evaluated: 2, total: 3 }]);
});

test('строка балла в итогах clawgym run: разложение, неполная оценка, нет оценённых кейсов', () => {
  const line = (items: ItemRecord[]) => scoreSummary(runScore(run([items])));
  // Проверка до обучения: не пройден ни один из 4 кейсов, балл — 44.
  assert.equal(line(DEMO_CHECK.map(item)), 'Балл прогона: 44 из 100 · пройдено 0 из 4 · действия 56 % · ответ 54 %');
  // Из 4 кейсов 3 пройдены, один завершился техническим сбоем: строка называет, сколько кейсов оценено из всех.
  assert.equal(line([...times(3, () => item(PASSED)), technical()]), 'Балл прогона: 100 из 100 · пройдено 3 из 3 · действия 100 % · ответ 100 % · оценено 3 из 4 кейсов');
  // Все кейсы завершились техническим сбоем: балла нет, причина названа — не ноль.
  assert.equal(line(times(4, technical)), 'Балл прогона: нет данных — нет оценённых кейсов');
  // Части, которой нет ни у одного кейса, в строке нет; число кейсов — со склонением.
  assert.equal(line([item(HALF)]), 'Балл прогона: 40 из 100 · пройдено 0 из 1 · действия 50 %');
  assert.equal(line([...times(20, () => item(PASSED)), notStarted()]), 'Балл прогона: 100 из 100 · пройдено 20 из 20 · действия 100 % · ответ 100 % · оценено 20 из 21 кейса');
});
