import assert from 'node:assert/strict';
import { toolsF1, classReport, caseScore, type DuplicatesRule } from '../../src/metrics/scoring.js';
import { FINAL_CLASSES } from '../../src/config/types.js';
import { stress, random } from './helpers.js';

stress('FUZZ-01 1000 журналов: F1 ограничен [0,1] и не зависит от порядка, seed=0xF100', () => {
  const rng = random(0xF100);
  const names = ['a', 'b', '__proto__', 'constructor', 'Карта 💳', 'ignored'];
  const rules: DuplicatesRule[] = ['strict', 'tolerate', 'whole'];
  for (let i = 0; i < 1000; i++) {
    const ref = names.filter(() => rng() > 0.5).map((tool) => ({ tool, count: 1 + Math.floor(rng() * 4) }));
    const calls = Array.from({ length: Math.floor(rng() * 25) }, () => ({ tool: names[Math.floor(rng() * names.length)] }));
    const cfg = { duplicates: rules[i % rules.length], maxRepeats: 1 + Math.floor(rng() * 5), ignore: ['ignored'] };
    const result = toolsF1(ref, calls, cfg);
    assert.ok(Number.isFinite(result.f1) && result.f1! >= 0 && result.f1! <= 1, `итерация ${i}`);
    assert.equal(result.f1, toolsF1(ref, [...calls].reverse(), cfg).f1, `итерация ${i}`);
    assert.equal(result.f1, toolsF1(ref, [...calls, { tool: 'ignored' }], cfg).f1);
    assert.ok([result.tp, result.fp, result.fn].every((n) => Number.isInteger(n) && n >= 0));
  }
});

stress('FUZZ-02 500 матриц классификации: число записей и диагональ согласованы, seed=0xACCA', () => {
  const rng = random(0xACCA);
  for (let i = 0; i < 500; i++) {
    const pairs = Array.from({ length: 1 + Math.floor(rng() * 30) }, () => ({
      expected: FINAL_CLASSES[Math.floor(rng() * FINAL_CLASSES.length)],
      predicted: FINAL_CLASSES[Math.floor(rng() * FINAL_CLASSES.length)],
    }));
    const result = classReport(pairs);
    assert.equal(result.matrix.flat().reduce((a, b) => a + b, 0), pairs.length);
    assert.equal(result.accuracy, pairs.filter((p) => p.expected === p.predicted).length / pairs.length);
    assert.ok(result.macroF1! >= 0 && result.macroF1! <= 1);
  }
});

stress('FUZZ-03 500 смесей оценок: пропуски не становятся нулями, результат лежит между компонентами', () => {
  const rng = random(0xCA5E);
  for (let i = 0; i < 500; i++) {
    const tools = rng(); const answer = rng(); const w = rng();
    const weights = { tools: w, answer: 1 - w };
    const score = caseScore(tools, answer, weights)!;
    assert.ok(score >= Math.min(tools, answer) - Number.EPSILON && score <= Math.max(tools, answer) + Number.EPSILON);
    assert.equal(caseScore(tools, null, weights), null);
    assert.equal(caseScore(null, answer, weights), null);
  }
});
