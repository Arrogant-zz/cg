// Проверяющая корзина: подсказка operator-check-v1 и её схема, текст напоминания стенда, контекст и вызов реакции на конец хода,
// лимит напоминаний и его статус, число напоминаний в сводке кейса. Сценарии диалога — в dialog.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AjvModule from 'ajv';
import { loadRegistry } from '../src/config/loader.js';
import { DEFAULT_LIMITS } from '../src/config/types.js';
import { loadEnv } from '../src/env.js';
import type { ExecutionInit } from '../src/execution/execution.js';
import type { MessageEvent } from '../src/execution/events.js';
import { startMessage } from '../src/execution/dialog.js';
import { evaluate, execStats } from '../src/execution/evaluate.js';
import { LIMIT_STATUSES, STATUS_TITLES, TECH_STATUSES } from '../src/execution/events.js';
import { CHECK_LABEL, LlmOperator, MODE_MARK, checkContext, checkUserPrompt, operatorContext } from '../src/operator/operator.js';
import { CHECK_REMINDER, OPERATOR_CHECK_PROMPT_VERSION, OPERATOR_CHECK_SCHEMA, OPERATOR_CHECK_SYSTEM, OPERATOR_SYSTEM } from '../src/operator/prompts.js';
import type { LlmProvider, LlmRequest } from '../src/llm/provider.js';
import { StructuredError } from '../src/llm/structured.js';
import { resolveRun } from '../src/runner/resolve.js';
import { fakeAnswer, fakeRole } from '../dev/fake-gigachat/brain.js';
import { CONFIG, REPO } from './helpers.js';
import { call, execution } from './dialog-helpers.js';

const Ajv: any = (AjvModule as any).default ?? AjvModule;
const limits = { maxTurns: 6, maxDurationSec: 60, maxOperatorCalls: 20, maxReminders: 2 };

test('подсказка operator-check-v1: версия в тексте; схема — три реакции, без лишних полей; в напоминании нет имён инструментов контракта', async () => {
  assert.equal(OPERATOR_CHECK_PROMPT_VERSION, 'operator-check-v1');
  assert.match(OPERATOR_CHECK_SYSTEM, /подсказка operator-check-v1/);

  const valid = new Ajv({ allErrors: true, strict: false }).compile(OPERATOR_CHECK_SCHEMA);
  for (const reaction of ['answer', 'done', 'remind']) assert.equal(valid({ reaction, reply: null, reason: 'обоснование' }), true, reaction);
  assert.equal(valid({ reaction: 'answer', reply: 'Покупка 12 октября.', reason: 'вопрос о дате' }), true);
  assert.equal(valid({ reaction: 'correct', reply: null, reason: 'обоснование' }), false, 'четвёртой реакции нет');
  // Поправку, урок, объяснение, одобрение и завершение выразить нечем.
  for (const extra of ['correction', 'lessonId', 'lessonNote', 'explanation', 'approval', 'finish', 'confirmation']) {
    assert.equal(valid({ reaction: 'remind', reply: null, reason: 'обоснование', [extra]: true }), false, extra);
  }
  for (const missing of ['reaction', 'reply', 'reason']) {
    const { [missing]: _, ...rest } = { reaction: 'remind', reply: null, reason: 'обоснование' } as Record<string, unknown>;
    assert.equal(valid(rest), false, `без ${missing}`);
  }

  // Напоминание возвращает инициативу агенту и не подсказывает: ни инструмента, ни итогового действия в нём нет.
  const reg = await loadRegistry(CONFIG);
  assert.deepEqual(reg.contract!.tools.map((t) => t.name).filter((name) => CHECK_REMINDER.includes(name)), []);
  assert.doesNotMatch(CHECK_REMINDER, /закр|эксперт|отлож/i);
  assert.match(CHECK_REMINDER, /^Обращение ведёте вы: действуйте так, как считаете верным\./);
  assert.match(CHECK_REMINDER, /Если считаете работу законченной — так и скажите\.$/);
});

/** Кейс card-hold-amount в проверяющей корзине: в situation — «экспертиза не нужна», в решении — обучающая инструкция. */
async function holdCase(over: Partial<ExecutionInit> = {}) {
  const reg = await loadRegistry(CONFIG);
  const caseDef = reg.cases.get('card-hold-amount')!;
  const solution = reg.solutions.get('card-hold-amount/explain-now')!;
  const exec = await execution({ mode: 'auto', basketType: 'checking', caseDef, solution, ...over });
  exec.add<MessageEvent>({ type: 'start_message', text: startMessage(exec) });
  await call(exec, 'get_card_history', { id: 'CARD-TEST-3307', fromDate: '2026-10-25T00:00:00', toDate: '2026-10-25T23:59:59' });
  exec.add<MessageEvent>({ type: 'agent_message', text: 'Нашёл операцию. Что делать дальше?', turn: 1 });
  const reminder = exec.add<MessageEvent>({ type: 'operator_message', text: CHECK_REMINDER, reminder: true, decisionSeq: 4 });
  exec.add<MessageEvent>({ type: 'agent_message', text: 'Какого числа была операция?', turn: 2 });
  const answer = exec.add<MessageEvent>({ type: 'operator_message', text: 'Операция 25 октября на 7 800 ₽.', decisionSeq: 7 });
  exec.add<MessageEvent>({ type: 'agent_message', text: 'Это спорная операция?', turn: 3 });
  return { reg, caseDef, solution, exec, reminder, answer };
}

/** Провайдер-сценарий: отдаёт ответы по очереди и запоминает запросы. */
function scripted(answers: unknown[]): { provider: LlmProvider; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    async complete(req) {
      requests.push(req);
      const next = answers[Math.min(requests.length, answers.length) - 1];
      return { text: typeof next === 'string' ? next : JSON.stringify(next), usage: { input: 10, output: 5 }, model: 'scripted' };
    },
  };
  return { provider, requests };
}

test('контекст конца хода в проверке: только режим, факты, журнал и событие — без ситуации, эталона, инструкции, стиля и уроков', async (t) => {
  const { reg, caseDef, solution, exec, reminder, answer } = await holdCase();
  t.after(() => exec.stop('cleanup'));
  const ctx = checkContext(exec, 'Это спорная операция?');
  assert.deepEqual(Object.keys(ctx), ['mode', 'facts', 'transcript', 'event'], 'названия и тематики кейса, эталона, инструкции, стиля, уроков и лимитов нет');
  assert.equal(ctx.mode, 'checking');
  assert.deepEqual(ctx.facts, caseDef.facts);
  assert.deepEqual(ctx.event, { type: 'turn_end', agentReply: 'Это спорная операция?', looksLikeQuestion: true });

  const tr = ctx.transcript as any[];
  assert.deepEqual(tr.map((x) => x.role), ['clawgym', 'tool', 'agent', 'operator', 'agent', 'operator', 'agent']);
  assert.equal(tr.find((x) => x.seq === reminder.seq).reminder, true, 'напоминание стенда помечено');
  assert.ok(!('reminder' in tr.find((x) => x.seq === answer.seq)), 'ответ на вопрос о факте — без пометки');
  assert.ok(tr[1].result, 'ответ инструмента оператору виден');

  // Запрос к модели: ни ситуации, ни эталона, ни урока, ни инструкции решения в нём нет.
  const { provider, requests } = scripted([{ reaction: 'remind', reply: null, reason: 'вопрос о том, как поступить' }]);
  await new LlmOperator(reg.models.get('fake-operator')!, provider).react(exec, 'Это спорная операция?');
  const sent = requests[0].system + requests[0].user;
  assert.match(caseDef.situation, /экспертиза не нужна/);
  assert.ok(!sent.includes('экспертиза не нужна'), 'ситуация кейса в запрос не попала');
  for (const hidden of [caseDef.reference.answer, caseDef.reference.lessons[0].rule, caseDef.reference.procedure[1], caseDef.reference.criteria[0].text, solution.operator.instruction.trim(), caseDef.title]) {
    assert.ok(hidden.length > 20 && !sent.includes(hidden), hidden);
  }
  assert.doesNotMatch(sent, /L-hold-001|explain-now|instruction|situation|procedure/);
  assert.ok(sent.includes(caseDef.facts[0]), 'факты кейса в запросе есть');
  assert.ok(sent.includes('Нашёл операцию. Что делать дальше?'), 'журнал диалога в запросе есть');
  assert.equal(requests[0].system, OPERATOR_CHECK_SYSTEM);
  assert.deepEqual(requests[0].schema, OPERATOR_CHECK_SCHEMA);

  // seesToolResults: false по-прежнему убирает ответы инструментов, сами вызовы остаются.
  const blind = await holdCase({ solution: { ...solution, operator: { ...solution.operator, seesToolResults: false } } });
  t.after(() => blind.exec.stop('cleanup'));
  const tool = (checkContext(blind.exec, 'Готово.').transcript as any[])[1];
  assert.deepEqual([tool.role, tool.tool, tool.executed, 'result' in tool], ['tool', 'get_card_history', true, false]);
  assert.deepEqual((checkContext(blind.exec, 'Готово.').event as any).looksLikeQuestion, false);
});

test('контекст подтверждения в проверке и контекст обучения не изменились: ситуация, эталон, инструкция и уроки на месте', async (t) => {
  const { caseDef, solution, exec } = await holdCase();
  t.after(() => exec.stop('cleanup'));
  const keys = ['mode', 'case', 'reference', 'instruction', 'style', 'lessons', 'limits', 'transcript', 'event'];
  const held = exec.toolCalls()[0];
  const confirmation = operatorContext(exec, { type: 'confirmation', call: held }, 'checking', limits, false) as any;
  assert.deepEqual(Object.keys(confirmation), keys);
  assert.equal(confirmation.mode, 'checking');
  assert.equal(confirmation.case.situation, caseDef.situation);
  assert.deepEqual(confirmation.reference.procedure, caseDef.reference.procedure);
  assert.equal(confirmation.instruction, solution.operator.instruction);
  assert.deepEqual(confirmation.lessons, caseDef.reference.lessons);
  assert.deepEqual(Object.keys(confirmation.event), ['type', 'seq', 'tool', 'args', 'description', 'terminal']);

  const training = operatorContext(exec, { type: 'turn_end', agentReply: 'Готово.' }, 'training', limits, false) as any;
  assert.deepEqual(Object.keys(training), keys);
  assert.deepEqual([training.case.title, training.style, training.reference.answer], [caseDef.title, 'explain-now', caseDef.reference.answer]);
  assert.deepEqual(training.event, { type: 'turn_end', agentReply: 'Готово.', looksLikeQuestion: false });
});

test('вызов реакции: answer без текста — ошибка формата с одним переспросом; при done и remind текст модели обнуляется без ошибки; своя подпись обмена', async (t) => {
  const { reg, exec } = await holdCase();
  t.after(() => exec.stop('cleanup'));
  const model = reg.models.get('fake-operator')!;
  const react = (answers: unknown[]) => {
    const s = scripted(answers);
    return { ...s, result: new LlmOperator(model, s.provider).react(exec, 'Какого числа была операция?') };
  };

  // Ответ на вопрос о факте: текст обрезается по краям и уходит как есть.
  const ok = react([{ reaction: 'answer', reply: '  Операция 25 октября на 7 800 ₽.  ', reason: 'вопрос о дате' }]);
  assert.deepEqual((await ok.result).value, { reaction: 'answer', reply: 'Операция 25 октября на 7 800 ₽.', reason: 'вопрос о дате' });
  assert.deepEqual(ok.requests.map((r) => r.label), [CHECK_LABEL]);
  assert.equal(CHECK_LABEL, 'LLM-оператор · конец хода в проверке');
  assert.match(ok.requests[0].user, /^Событие: turn_end\. Факты обращения и журнал диалога:\n```json\n/);

  // answer без текста: один переспрос с описанием ошибки, второй ответ принят.
  const retried = react([{ reaction: 'answer', reply: '  ', reason: 'вопрос о дате' }, { reaction: 'answer', reply: 'Таких данных нет.', reason: 'факта нет' }]);
  const second = await retried.result;
  assert.equal(second.value.reply, 'Таких данных нет.');
  assert.deepEqual(second.attempts.map((a) => [a.ok, a.kind]), [[false, 'format'], [true, undefined]]);
  assert.equal(retried.requests.length, 2);
  assert.match(retried.requests[1].user, /Предыдущий ответ не прошёл проверку: для реакции answer нужен текст ответа в reply/);

  // Повторная ошибка — ошибка формата оператора.
  const failed = react([{ reaction: 'answer', reply: null, reason: 'вопрос о дате' }]);
  await assert.rejects(failed.result, (e: unknown) => e instanceof StructuredError && e.kind === 'format' && e.attempts.length === 2);
  assert.equal(failed.requests.length, 2, 'переспрос один');

  // Четвёртая реакция и лишнее поле — тоже ошибка формата, по схеме.
  await assert.rejects(react([{ reaction: 'correct', reply: 'Проверьте историю операций', reason: 'агент ошибся' }]).result, (e: unknown) => e instanceof StructuredError && e.kind === 'format');
  await assert.rejects(react([{ reaction: 'remind', reply: null, reason: 'ждёт указаний', correction: true }]).result, (e: unknown) => e instanceof StructuredError && e.kind === 'format');

  // Текст при напоминании и завершении — не ошибка: он обнуляется и агенту не уйдёт.
  for (const reaction of ['remind', 'done'] as const) {
    const quiet = react([{ reaction, reply: 'Проверьте историю операций по карте.', reason: 'обоснование' }]);
    const res = await quiet.result;
    assert.deepEqual([res.value.reaction, res.value.reply, res.attempts.length, quiet.requests.length], [reaction, null, 1, 1]);
  }
});

test('подтверждение в проверке: решение по общей подсказке и с эталоном; поправка — переспрос, при повторе — ошибка режима', async (t) => {
  const { reg, caseDef, exec } = await holdCase();
  t.after(() => exec.stop('cleanup'));
  const model = reg.models.get('fake-operator')!;
  const event = { type: 'confirmation' as const, call: exec.toolCalls()[0] };
  const corrected = { reply: 'Экспертизу здесь не выставляйте.', confirmation: 'reject', correction: true, lessonId: null, lessonNote: null, explanation: false, approval: false, finish: false, reason: 'расходится с эталоном' };
  const clean = { ...corrected, reply: null, correction: false };

  // Оператор дважды пометил решение поправкой: ошибка формата с меткой режима — по ней кейс получает «Нарушение режима проверки».
  const twice = scripted([corrected]);
  await assert.rejects(new LlmOperator(model, twice.provider).decide(exec, event, 'checking', limits), (e: unknown) => e instanceof StructuredError && e.kind === 'format' && e.message.includes(MODE_MARK));
  assert.equal(twice.requests.length, 2, 'переспрос один');
  assert.ok(twice.requests[1].user.includes(`${MODE_MARK}: correction должно быть false, reply оставь null`));
  // Запрос — прежний: общая подсказка и контекст с ситуацией кейса и эталоном.
  assert.equal(twice.requests[0].system, OPERATOR_SYSTEM);
  assert.ok(twice.requests[0].user.includes('экспертиза не нужна') && twice.requests[0].user.includes(caseDef.reference.answer));

  // После переспроса решение без поправки принято.
  const once = scripted([corrected, clean]);
  const res = await new LlmOperator(model, once.provider).decide(exec, event, 'checking', limits);
  assert.deepEqual([res.value.confirmation, res.value.correction, res.attempts.length], ['reject', false, 2]);
  // В обучении та же поправка — обычное решение.
  const training = await new LlmOperator(model, scripted([corrected]).provider).decide(exec, event, 'training', limits);
  assert.deepEqual([training.value.correction, training.value.reply, training.attempts.length], [true, 'Экспертизу здесь не выставляйте.', 1]);
});

// ---------------------------------------------------------------- лимит напоминаний

test('лимит maxReminders: по умолчанию 2, целое 1–20; элемент корзины сильнее решения, решение — прогона; демонстрационный набор проходит без правок', async () => {
  // Файлы демонстрационного набора лимит не задают: проверка проходит, действует умолчание.
  const demo = await loadRegistry(CONFIG);
  assert.deepEqual(demo.issues.filter((i) => i.severity === 'error'), []);
  assert.ok(!demo.issues.some((i) => /maxReminders/.test(`${i.field} ${i.reason}`)));
  assert.equal(DEFAULT_LIMITS.maxReminders, 2);
  const check = resolveRun(demo, loadEnv({ CLAWGYM_CONFIG: CONFIG }, REPO), 'demo-check');
  assert.equal(check.ok, true, JSON.stringify(check.issues.filter((i) => i.severity === 'error')));
  assert.deepEqual(check.resolved!.items.map((i) => i.limits.maxReminders), [2, 2, 2, 2]);
  assert.equal(check.resolved!.limits.maxReminders, 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-reminders-'));
  try {
    fs.cpSync(CONFIG, dir, { recursive: true });
    const write = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
    const run = (id: string, limit: string) => `id: ${id}\nbasket: reminders\nagent: fake-agent\nmodels: { operator: fake-operator, judge: fake-judge }\nlimits: { maxReminders: ${limit} }\n`;
    // Прогон — 5, решение card-hold-amount/facts-only — 3, третий элемент корзины — 1.
    fs.appendFileSync(path.join(dir, 'solutions/card-hold-amount/facts-only.yaml'), 'limits: { maxReminders: 3 }\n');
    write('baskets/reminders.yaml', ['id: reminders', 'title: Проверка · лимит напоминаний', 'type: checking', 'items:', '  - solution: spasibo-bonus-missing/facts-only', '  - solution: card-hold-amount/facts-only', '  - solution: card-hold-amount/facts-only', '    limits: { maxReminders: 1 }', ''].join('\n'));
    write('runs/reminders.yaml', run('reminders', '5'));
    write('runs/zero.yaml', run('zero', '0'));
    write('runs/many.yaml', run('many', '21'));
    write('runs/half.yaml', run('half', '1.5'));
    const reg = await loadRegistry(dir);
    const p = resolveRun(reg, loadEnv({ CLAWGYM_CONFIG: dir }, REPO), 'reminders');
    assert.equal(p.ok, true, JSON.stringify(p.issues.filter((i) => i.severity === 'error')));
    assert.deepEqual(p.resolved!.items.map((i) => i.limits.maxReminders), [5, 3, 1], 'прогон → решение → элемент корзины');
    assert.deepEqual(p.resolved!.items.map((i) => i.limits.maxTurns), [20, 20, 20], 'остальные лимиты — с уровня выше');
    assert.equal(p.resolved!.limits.maxReminders, 5);
    assert.ok(!reg.issues.some((i) => ['runs/reminders.yaml', 'baskets/reminders.yaml', 'solutions/card-hold-amount/facts-only.yaml'].includes(i.file)), 'поле известно схеме: ни ошибок, ни предупреждений');

    const error = (file: string) => reg.issues.find((i) => i.file === file && i.severity === 'error');
    assert.deepEqual([error('runs/zero.yaml')?.field, error('runs/zero.yaml')?.reason], ['limits.maxReminders', 'Значение должно быть не меньше 1']);
    assert.deepEqual([error('runs/many.yaml')?.field, error('runs/many.yaml')?.reason], ['limits.maxReminders', 'Значение должно быть не больше 20']);
    assert.equal(error('runs/half.yaml')?.field, 'limits.maxReminders', 'только целое');
    assert.ok(!reg.runs.has('zero') && !reg.runs.has('many') && !reg.runs.has('half'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('статус limit_reminders — завершение по лимиту, а не технический сбой: кейс оценивается, причина итога отмечает лимит', async (t) => {
  assert.ok(LIMIT_STATUSES.has('limit_reminders') && !TECH_STATUSES.has('limit_reminders'));
  assert.equal(STATUS_TITLES.limit_reminders, 'Исчерпан лимит напоминаний');
  const stalled = async (over: Partial<ExecutionInit> = {}) => {
    const exec = await execution({ mode: 'auto', basketType: 'checking', ...over });
    t.after(() => exec.stop('cleanup'));
    exec.add<MessageEvent>({ type: 'start_message', text: 'Новое обращение второй линии.' });
    exec.add<MessageEvent>({ type: 'agent_message', text: 'Готов отвечать на вопросы по фактам кейса.', turn: 1 });
    exec.setStatus('limit_reminders', 'Агент оставил без действий 2 напоминания подряд');
    return exec;
  };

  // Обычный кейс: обязательные действия не выполнены — «не пройден», а не «технический сбой»; в M1 кейс незавершён.
  const exec = await stalled();
  const ev = await evaluate(exec, exec.events.at(-1)!.seq, null);
  assert.equal(ev.outcome, 'failed');
  assert.ok(ev.checks!.length > 0 && ev.checks!.some((c) => c.passed === false), 'проверки действий выполнены');
  assert.deepEqual([ev.scores!.final.incomplete, ev.scores!.final.predicted, ev.scores!.final.note], [true, null, 'Исчерпан лимит напоминаний, итогового действия нет']);

  // Кейс без обязательных действий и критериев: итог «пройден» с отметкой о лимите.
  const c = exec.caseDef;
  const free = await stalled({ caseDef: { ...c, reference: { ...c.reference, criteria: [], required: [], forbidden: [], final: null } } });
  const passed = await evaluate(free, free.events.at(-1)!.seq, null);
  assert.deepEqual([passed.outcome, passed.reason], ['passed', 'проверки действий пройдены; критериев ответа нет (завершён по лимиту)']);
});

test('сводка кейса: reminders — напоминания стенда, replies — все сообщения оператора; счётчик напоминаний без действий — в JSON выполнения', async (t) => {
  const exec = await execution({ mode: 'auto', basketType: 'checking' });
  t.after(() => exec.stop('cleanup'));
  exec.add<MessageEvent>({ type: 'start_message', text: 'Новое обращение второй линии.' });
  exec.add<MessageEvent>({ type: 'agent_message', text: 'Готов к дальнейшим вопросам по кейсу.', turn: 1 });
  exec.add<MessageEvent>({ type: 'operator_message', text: CHECK_REMINDER, reminder: true, decisionSeq: 3 });
  exec.add<MessageEvent>({ type: 'agent_message', text: 'В какой канал клиент просит уведомления?', turn: 2 });
  exec.add<MessageEvent>({ type: 'operator_message', text: 'Клиент просит SMS.', decisionSeq: 6 });
  exec.add<MessageEvent>({ type: 'agent_message', text: 'Понял. Что дальше?', turn: 3 });
  exec.add<MessageEvent>({ type: 'operator_message', text: CHECK_REMINDER, reminder: true, decisionSeq: 9 });
  const stats = execStats(exec);
  assert.deepEqual([stats.operator.reminders, stats.operator.replies, stats.corrections], [2, 3, 0]);

  // Состояние идущего выполнения: счётчик рядом с turns и operatorCalls.
  assert.equal(exec.toJSON().ignoredReminders, 0);
  exec.ignoredReminders = 1;
  const json = JSON.parse(JSON.stringify(exec));
  assert.deepEqual([json.turns, json.operatorCalls, json.ignoredReminders], [0, 0, 1]);

  // Обучение и ручная сессия: напоминаний нет — ноль, а не отсутствие поля.
  const manual = await execution();
  t.after(() => manual.stop('cleanup'));
  manual.add<MessageEvent>({ type: 'human_message', text: 'Продолжайте.' });
  assert.equal(execStats(manual).operator.reminders, 0);
});

// ---------------------------------------------------------------- офлайн-модель

test('fake-gigachat: на подсказку operator-check-v отвечает реакцией по её схеме — завершение, ответ фактом, «таких данных нет», напоминание', () => {
  const facts = ['Покупка 12 октября у партнёра «Тестовый партнёр» на 4 990 ₽.', 'Партнёр подтверждает покупки в течение 30 дней.'];
  const valid = new Ajv({ allErrors: true, strict: false }).compile(OPERATOR_CHECK_SCHEMA);
  // Запрос — как у стенда: в контексте только режим, факты, журнал и событие; эталона, стиля и уроков нет.
  const react = (agentReply: string) => {
    const ctx = { mode: 'checking', facts, transcript: [{ seq: 1, role: 'clawgym', kind: 'start', text: 'Новое обращение второй линии.' }], event: { type: 'turn_end', agentReply, looksLikeQuestion: /\?\s*$/.test(agentReply.trim()) } };
    const answer = JSON.parse(fakeAnswer(OPERATOR_CHECK_SYSTEM, checkUserPrompt(ctx)));
    assert.ok(valid(answer), `${agentReply}: ${JSON.stringify(answer)}`);
    return [answer.reaction, answer.reply];
  };
  assert.deepEqual(react('`get_close_with_answer` выполнен. Обращение обработано.'), ['done', null]);
  assert.deepEqual(react('Работа по обращению закончена.'), ['done', null]);
  assert.deepEqual(react('Какого числа была покупка?'), ['answer', facts[0]], 'вопрос с подходящим фактом');
  assert.deepEqual(react('Какой номер телефона у клиента?'), ['answer', 'Таких данных в обращении нет.'], 'вопрос о данных без факта');
  for (const stuck of ['**Ответ клиенту:** «Бонусы начислят после подтверждения покупки.»\n\nМожно закрывать обращение?', 'По тематике «Карты» у меня нет процедуры. Подскажите, что сделать?', 'Понял, не выполняю `create_expertise`. Что нужно сделать иначе?', 'Готов к дальнейшим вопросам по кейсу.', 'Уточните, пожалуйста: cardId.']) {
    assert.deepEqual(react(stuck), ['remind', null], stuck);
  }
  // Сбой оператора в демо (X-Fake-Fail: operator) задевает и подсказку проверки; судьи — нет.
  assert.equal(fakeRole(OPERATOR_CHECK_SYSTEM), 'operator');
});
