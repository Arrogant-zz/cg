// Метрики аналитика: правило дубликатов F1_tools, macro-F1 с матрицей ошибок, класс финального действия, case_score, параметры.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_SCORING, caseScore, classReport, countTool, finalAction, scoringOf, toolsF1 } from '../src/metrics/scoring.js';
import { loadRegistry } from '../src/config/loader.js';
import type { CaseDef, FinalClass } from '../src/config/types.js';
import { fakeAnswerMatch } from '../dev/fake-gigachat/brain.js';
import { CONFIG } from './helpers.js';

const calls = (...tools: string[]) => tools.map((tool) => ({ tool }));
const tolerate = DEFAULT_SCORING.tools;

test('F1_tools: «≤3 допустимо, с 4-го — FP», лишние и пропущенные, порядок не важен', () => {
  // Один нужный вызов: 1–3 вызова — TP, четвёртый — FP, пятый — ещё FP.
  assert.deepEqual([1, 2, 3, 4, 5].map((p) => countTool(p, 1, 'tolerate', 3)), [
    { counted: 1, tp: 1, fp: 0, fn: 0 },
    { counted: 1, tp: 1, fp: 0, fn: 0 },
    { counted: 1, tp: 1, fp: 0, fn: 0 },
    { counted: 2, tp: 1, fp: 1, fn: 0 },
    { counted: 3, tp: 1, fp: 2, fn: 0 },
  ]);
  assert.deepEqual(countTool(2, 0, 'tolerate', 3), { counted: 1, tp: 0, fp: 1, fn: 0 }, 'лишний инструмент — один FP при повторах до трёх');
  assert.deepEqual(countTool(0, 1, 'tolerate', 3), { counted: 0, tp: 0, fp: 0, fn: 1 });
  assert.deepEqual(countTool(4, 2, 'tolerate', 3), { counted: 2, tp: 2, fp: 0, fn: 0 }, 'нужно два вызова: ещё два повтора допустимы');
  // Формула аналитика без схлопывания и альтернатива «весь инструмент в FP».
  assert.deepEqual(countTool(2, 1, 'strict', 3), { counted: 2, tp: 1, fp: 1, fn: 0 });
  assert.deepEqual(countTool(3, 1, 'whole', 3), { counted: 1, tp: 1, fp: 0, fn: 0 });
  assert.deepEqual(countTool(4, 1, 'whole', 3), { counted: 4, tp: 0, fp: 1, fn: 1 });

  const ref = [
    { tool: 'a', count: 1 },
    { tool: 'b', count: 1 },
    { tool: 'c', count: 1 },
  ];
  const r = toolsF1(ref, calls('c', 'x', 'a', 'a', 'a', 'a'), tolerate);
  assert.deepEqual([r.tp, r.fp, r.fn], [2, 2, 1], 'a — TP и FP за четвёртый вызов, x — FP, b — FN');
  assert.equal(r.f1, 4 / 7);
  assert.equal(toolsF1(ref, calls('c', 'b', 'a'), tolerate).f1, 1, 'порядок вызовов не важен');
  assert.equal(toolsF1(null, calls('a'), tolerate).f1, null, 'без эталона — нет данных, а не ноль');
  assert.equal(toolsF1([], [], tolerate).f1, 1);
  assert.equal(toolsF1(ref, calls('a', 'b', 'c', 'get_cases_assigned'), { ...tolerate, ignore: ['get_cases_assigned'] }).f1, 1, 'ignore не считается');
});

test('M1: macro-F1 по присутствующим классам, accuracy и матрица ошибок', () => {
  const r = classReport([
    { expected: 'close_answer', predicted: 'close_answer' },
    { expected: 'close_answer', predicted: 'close_answer' },
    { expected: 'close_answer', predicted: 'expertise' },
    { expected: 'expertise', predicted: 'expertise' },
  ]);
  assert.deepEqual(r.matrix[0], [2, 1, 0, 0]);
  assert.deepEqual(r.matrix[1], [0, 1, 0, 0]);
  const close = r.perClass.find((c) => c.cls === 'close_answer')!;
  const exp = r.perClass.find((c) => c.cls === 'expertise')!;
  assert.equal(close.f1, 0.8);
  assert.equal(exp.f1, 2 / 3);
  assert.equal(r.macroF1, (0.8 + 2 / 3) / 2, 'классы без эталона и ответов не входят');
  assert.equal(r.accuracy, 0.75);
  assert.equal(classReport([]).macroF1, null);
  // Один класс в датасете: одна ошибка в другую сторону роняет macro-F1 сильнее accuracy.
  const pairs: { expected: FinalClass; predicted: FinalClass }[] = [...Array(9)].map(() => ({ expected: 'close_answer', predicted: 'close_answer' }));
  const one = classReport([...pairs, { expected: 'close_answer', predicted: 'expertise' }]);
  assert.equal(one.accuracy, 0.9);
  assert.ok(one.macroF1! < 0.5);
});

test('класс финального действия: последний выполненный итоговый вызов, иначе инструкция оператору; лимит — незавершённый', async () => {
  const reg = await loadRegistry(CONFIG);
  const s = scoringOf([...reg.metrics.values()]);
  const card = reg.cases.get('card-operation-dispute')!;
  const call = (seq: number, tool: string, args: Record<string, unknown> = {}, executed = true) => ({ seq, tool, args, executed });
  const desc = 'Клиент не узнаёт операцию по карте и оспаривает её';
  const f = finalAction(card, 'completed', [call(3, 'create_expertise', { request: { expertiseDescription: desc } }), call(5, 'postpone_expertises')], 'Обращение обработано.', s);
  assert.equal(f.expected, 'expertise');
  assert.equal(f.predicted, 'expertise', 'postpone_expertises не входит в соответствие: класс по create_expertise');
  assert.equal(f.correct, true);
  assert.equal(f.text, desc);
  assert.equal(f.textFrom, 'request.expertiseDescription');
  const closed = finalAction(card, 'completed', [call(3, 'get_close_with_answer', { request: { shortAnswer: 'Кратко', extendedAnswer: '' } })], 'Готово', s);
  assert.equal(closed.predicted, 'close_answer');
  assert.equal(closed.correct, false);
  assert.equal(closed.text, 'Кратко', 'пустой extendedAnswer — берётся shortAnswer');
  const rejected = finalAction(card, 'completed', [call(3, 'create_expertise', {}, false)], 'Передайте клиенту, что операцию проверят.', s);
  assert.equal(rejected.predicted, 'operator_instruction', 'отклонённый вызов не завершает кейс');
  assert.equal(rejected.text, 'Передайте клиенту, что операцию проверят.');
  const limit = finalAction(card, 'limit_turns', [call(3, 'get_client_cards')], 'Уточните, пожалуйста: cardId.', s);
  assert.equal(limit.incomplete, true);
  assert.equal(limit.predicted, null);
  // Класс из actions.final, если finalClass не задан.
  const spasibo = reg.cases.get('spasibo-bonus-missing')!;
  const derived: CaseDef = { ...spasibo, reference: { ...spasibo.reference, finalClass: null } };
  assert.equal(finalAction(derived, 'completed', [], 'x', s).expectedFrom, 'actions.final');
});

test('case_score: веса из параметров; нет части — нет оценки; fake-судья даёт градацию по прогонам', () => {
  assert.equal(caseScore(0.8, 1 / 3, { tools: 0.5, answer: 0.5 }), 0.5 * 0.8 + 0.5 / 3);
  assert.equal(caseScore(0.8, null, { tools: 0.5, answer: 0.5 }), null);
  const s = scoringOf([
    { builtin: 'case-score', params: { weights: { tools: 0.4, answer: 0.6 } } },
    { builtin: 'tools-f1', params: { duplicates: 'strict' } },
  ]);
  assert.deepEqual(s.weights, { tools: 0.4, answer: 0.6 });
  assert.equal(s.tools.duplicates, 'strict');
  assert.equal(s.tools.maxRepeats, 3);
  assert.equal(s.answer.enabled, true, 'M2 без A_judge не считается: судья включается');
  assert.equal(scoringOf([]).answer.enabled, false);
  const ref = 'Клиент не узнаёт операцию по карте 20 октября на 3 200 ₽ и оспаривает её; просим проверить операцию.';
  const text = 'Клиент не узнаёт операцию по карте и оспаривает её';
  assert.deepEqual([1, 2, 3].map((run) => fakeAnswerMatch({ reference: ref, text, run }).match), [true, true, false], '5 из 8 слов эталона — ⅔');
});

test('параметры метрик проверяются при загрузке: тип, допустимые значения, сумма весов', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-params-'));
  try {
    fs.mkdirSync(path.join(home, 'metrics'));
    fs.writeFileSync(
      path.join(home, 'metrics/m.yaml'),
      YAML.stringify({
        metrics: [
          { id: 'm2', builtin: 'case-score', params: { weights: { tools: 0.7, answer: 0.6 } } },
          { id: 'f1', builtin: 'tools-f1', params: { duplicates: 'collapse' } },
          { id: 'ok', builtin: 'tools-f1', params: { maxRepeats: 2 } },
        ],
      }),
    );
    const reg = await loadRegistry(home);
    const errors = reg.issues.filter((i) => i.severity === 'error' && i.file === 'metrics/m.yaml');
    assert.ok(errors.some((e) => e.field === 'metrics[0].params.weights' && /Сумма весов должна быть 1/.test(e.reason)), JSON.stringify(errors));
    assert.ok(errors.some((e) => e.field === 'metrics[1].params.duplicates' && /tolerate, strict, whole/.test(e.reason)), JSON.stringify(errors));
    assert.deepEqual([...reg.metrics.keys()], ['ok']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
