// Проверяющая корзина на экранах (web/js/pages): число напоминаний стенда в разборе кейса, лимит напоминаний
// в предпросмотре запуска и счётчик напоминаний без действий в блоке «Сейчас». У обучающей корзины лимита и счётчика нет.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Модули страниц без DOM на верхнем уровне — загружаются как есть, без сборки; ответы API подменяются через fetch.
const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Страница с ответами API по адресу; адрес без ответа получает 404, как у стенда. */
async function page(file: string, data: Record<string, unknown>, params: string[] = [], query = ''): Promise<string> {
  globalThis.fetch = (async (input: unknown) => {
    const p = String(input);
    return p in data ? new Response(JSON.stringify(data[p]), { status: 200 }) : new Response(JSON.stringify({ error: 'Не найдено' }), { status: 404 });
  }) as typeof fetch;
  return String(await (await web(`pages/${file}`)).render({ params, state: {}, query: new URLSearchParams(query) }));
}

const T = '2026-11-12T10:00:00.000Z';
const REMINDER = 'Обращение ведёте вы: действуйте так, как считаете верным. Подсказывать я не буду. Если не хватает данных — спросите. Если считаете работу законченной — так и скажите.';
type Kind = 'checking' | 'training';
const limits = { maxTurns: 20, maxDurationSec: 900, maxOperatorCalls: 30, maxReminders: 2 };

/** Строка сводки разбора по подписи: содержимое её блока .mt. */
const row = (markup: string, label: string) => new RegExp(`<div class="mt">(?:(?!<div class="mt">)[\\s\\S])*?${label}[\\s\\S]*?</div>`).exec(markup)?.[0] ?? '';

// ---------------------------------------------------------------- разбор кейса

const stats = (operator: Record<string, unknown>) => ({
  turns: 3,
  durationMs: 42_000,
  time: { agent: 30_000, operator: 9_000, judge: 2_000, commands: 1_000 },
  tokens: { agent: null, operator: null, judge: null },
  corrections: 0,
  lessons: [],
  repeated: [],
  unknownCorrections: 0,
  rejected: { operator: 0, human: 0, timeout: 0, auto: 0 },
  unexpected: [],
  operator: { calls: 3, failedAttempts: 0, errors: 0, modeViolations: 0, replies: 2, ...operator },
});

function caseApi(operator: Record<string, unknown> | null, type: Kind = 'checking') {
  const item = {
    index: 0,
    kind: 'case',
    pos: 1,
    execName: 'L1-P01',
    status: 'limit_reminders',
    outcome: 'failed',
    reason: 'Сменить канал уведомлений на SMS',
    case: { id: 'notifications-channel-change' },
    solution: { title: '«Только факты»' },
    steps: { reset: 'ok', dialog: 'limit_reminders', checks: { passed: 0, total: 2 }, judge: null, capture: null, curatorPass: null },
    checks: [],
    answerFailed: [],
    scores: null,
    stats: operator ? stats(operator) : null,
    repeated: [],
    limits,
  };
  const events = [
    { seq: 1, ts: T, type: 'start_message', text: 'Новое обращение второй линии.' },
    { seq: 2, ts: T, type: 'agent_message', text: 'Готов к дальнейшим вопросам по кейсу.', turn: 1 },
    { seq: 3, ts: T, type: 'operator_decision', hidden: true, event: 'turn_end', decision: { reaction: 'remind', reply: null, reason: 'агент ждёт вопросов' }, model: 'op-gigachat', durationMs: 900, usage: null, attempts: [] },
    { seq: 4, ts: T, type: 'operator_message', text: REMINDER, reminder: true, decisionSeq: 3 },
    { seq: 5, ts: T, type: 'status', status: 'limit_reminders', reason: 'Агент оставил без действий 2 напоминания подряд' },
  ];
  const ex = {
    id: 'run7-L1-P01',
    mode: 'auto',
    basketType: type,
    status: 'limit_reminders',
    case: { id: 'notifications-channel-change', title: 'Смена канала уведомлений', file: 'cases/notifications-channel-change.yaml', hash: 'a91c' },
    solution: { id: 'notifications-channel-change/facts-only', title: '«Только факты»', file: 'solutions/notifications-channel-change/facts-only.yaml', hash: 'b02d' },
    taskIds: ['cg-7-1-01-ab12'],
    events,
    item,
    live: false,
    waits: [],
    httpCount: 4,
  };
  return { '/api/runs/7/executions/L1-P01': ex, '/api/runs/7': { id: 7, title: 'Проверка · вторая линия', lines: [{ index: 1, items: [item] }] } };
}

test('разбор кейса: строка «Напоминания стенда» — число из сводки; у записи без числа — пунктир с причиной, а не ноль', async () => {
  const counted = await page('exec.js', caseApi({ reminders: 2 }), ['7', 'L1-P01']);
  assert.match(row(counted, 'Напоминания стенда'), />Напоминания стенда<\/span><span class="num t2">2<\/span><\/div>$/);
  // Лента того же экрана: метка под напоминанием, реакция у решения, статус лимита — строкой «кейс завершён», без фиолетовой пилюли.
  assert.match(counted, /<span>напоминание стенда<\/span>/);
  assert.match(counted, /<span>реакция: напоминание<\/span>/);
  assert.match(counted, /кейс завершён<\/span><span>Агент оставил без действий 2 напоминания подряд/);
  assert.match(counted, /<span class="pill fail">/);
  assert.doesNotMatch(counted, /pill tech|Статус выполнения:/, 'лимит напоминаний — не технический сбой');

  const zero = await page('exec.js', caseApi({ reminders: 0 }, 'training'), ['7', 'L1-P01']);
  assert.match(row(zero, 'Напоминания стенда'), /<span class="num t2">0<\/span><\/div>$/, 'ноль — когда он записан');

  // Запись до 12.11.2026: числа напоминаний в сводке нет.
  const before = row(await page('exec.js', caseApi({}), ['7', 'L1-P01']), 'Напоминания стенда');
  assert.match(before, /<span class="pill na">нет данных<\/span><span class="cap" style="grid-column: 1 \/ -1">Запись сделана до 12 ноября 2026 года: напоминаний стенда тогда не было\.<\/span><\/div>$/);
  assert.doesNotMatch(before, /class="num t2"/, 'нуля нет');

  // Кейс ещё идёт — сводки нет: прочерк, как у соседних строк.
  const running = row(await page('exec.js', caseApi(null), ['7', 'L1-P01']), 'Напоминания стенда');
  assert.match(running, /<span class="num t2">—<\/span><\/div>$/);
});

// ---------------------------------------------------------------- запуск прогона

function previewApi(type: Kind, runLimits: Record<string, number> = limits) {
  const config = { id: 'demo', title: 'Прогон', file: 'runs/demo.yaml', basket: { id: 'basket', title: 'Корзина', type, items: 4 }, agent: 'fake-agent', continueFrom: null, testOperator: 'новый тестовый оператор', ok: true, errors: 0, warnings: 0, lastRun: null };
  const preview = {
    ok: true,
    issues: [],
    plan: [],
    planText: [],
    metrics: [],
    files: 12,
    queueAhead: [],
    sessions: { used: 0, capacity: 2 },
    overrides: {},
    continueFrom: null,
    continueOptions: [],
    resolved: {
      title: 'Прогон',
      file: 'runs/demo.yaml',
      basket: { id: 'basket', title: 'Корзина', type, file: 'baskets/basket.yaml', items: 4, cases: 3 },
      agent: { id: 'fake-agent', title: 'fake-agent', file: 'agents/fake-agent.yaml', commands: { reset: '/reset', capture: '/case-capture request_ref={{taskId}}', curator: '/skill-curator' }, build: null, model: null },
      testOperator: { mode: 'new' },
      operator: { id: 'fake-operator', title: 'fake-operator', provider: 'gigachat-v1' },
      judge: { id: 'fake-judge', title: 'fake-judge', provider: 'gigachat-v1' },
      items: [],
      limits: runLimits,
      repetitions: 1,
      startAt: null,
    },
  };
  return { '/api/run-configs': [config], '/api/run-configs/demo/preview': preview };
}

test('запуск прогона: лимит напоминаний в строке лимитов — только у проверяющей корзины', async () => {
  const cfg = (markup: string) => /<div class="cfg"><span class="t3">Лимиты<\/span>[\s\S]*?<\/div>/.exec(markup)![0];
  const checking = cfg(await page('setup.js', previewApi('checking')));
  assert.match(checking, /20 ходов · 15 мин на кейс · 30 запросов оператора · <span class="tip" title="[^"]*">2 напоминания без действий<\/span><\/span>/);
  const training = cfg(await page('setup.js', previewApi('training')));
  assert.match(training, /<span>20 ходов · 15 мин на кейс · 30 запросов оператора<\/span>/);
  assert.doesNotMatch(training, /напоминани/, 'в обучении лимит напоминаний не действует');
  // Склонение и запись без лимита.
  assert.match(cfg(await page('setup.js', previewApi('checking', { ...limits, maxReminders: 5 }))), />5 напоминаний без действий</);
  assert.match(cfg(await page('setup.js', previewApi('checking', { ...limits, maxReminders: 1 }))), />1 напоминание без действий</);
});

// ---------------------------------------------------------------- ход прогона

function liveApi(type: Kind, ignoredReminders: number | undefined, itemLimits: Record<string, number> = limits) {
  const item = { index: 0, kind: 'case', pos: 1, execName: 'L1-P01', status: 'running', outcome: null, reason: '', startedAt: T, finishedAt: null, case: { id: 'notifications-channel-change' }, solution: { title: '«Только факты»' }, steps: { reset: 'ok', dialog: null, checks: null, judge: null, capture: null, curatorPass: null }, checks: null, answerFailed: [], scores: null, stats: null, repeated: [], limits: itemLimits };
  const run = {
    id: 7,
    title: 'Проверка · вторая линия',
    type,
    status: 'running',
    error: null,
    configFile: 'runs/demo.yaml',
    configId: 'demo',
    startedAt: T,
    finishedAt: null,
    testOperatorLabel: 'новый · стартовые скиллы сборки',
    settings: { agent: { id: 'fake-agent', title: 'fake-agent', model: null }, operator: { id: 'op' }, judge: { id: 'judge' }, basket: { id: 'basket', items: 1, hash: 'abc', curator: { enabled: false, every: 0, final: false, resetBefore: true } }, prompts: { operator: 'operator-v4', operatorCheck: 'operator-check-v1', judge: 'judge-v1' }, metrics: [], limits, contract: { version: '1', hash: 'abc' } },
    snapshot: { createdAt: T, files: [], settings: [] },
    plan: [{ kind: 'case', pos: 1, capture: type === 'training' }],
    planText: [],
    summary: [],
    lines: [{ index: 1, status: 'running', senderId: 'cg-7-1', error: null, prep: { status: 'ok', items: [], durationMs: 0 }, items: [item], curatorPasses: [], current: { index: 0, execName: 'L1-P01', phase: 'диалог' } }],
  };
  const ex = {
    events: [
      { seq: 3, ts: T, type: 'operator_decision', hidden: true, event: 'turn_end', decision: { reaction: 'remind', reply: null, reason: 'агент ждёт вопросов' }, model: 'op', durationMs: 900, usage: null, attempts: [] },
      { seq: 4, ts: T, type: 'operator_message', text: REMINDER, reminder: true, decisionSeq: 3 },
    ],
    turns: 2,
    operatorCalls: 2,
    ...(ignoredReminders === undefined ? {} : { ignoredReminders }),
    startedAt: T,
    waits: [],
  };
  return { '/api/runs/7': run, '/api/runs/7/executions/L1-P01': ex };
}

test('ход прогона: «Напоминания без действий: N из M» в блоке «Сейчас» — только у проверяющей корзины', async () => {
  const counters = (markup: string) => /<div class="row cap" style="gap: 20px; padding-top: 4px">[\s\S]*?<\/div>/.exec(markup)![0];
  const checking = counters(await page('run.js', liveApi('checking', 1), ['7']));
  assert.match(checking, /Ходы: <span class="num t2">2 из 20<\/span>/);
  assert.match(checking, /Запросы оператора: <span class="num t2">2 из 30<\/span>/);
  assert.match(checking, /<span><span class="tip" title="[^"]*">Напоминания без действий<\/span>: <span class="num t2">1 из 2<\/span><\/span>/);
  // Лимит элемента корзины сильнее лимита прогона.
  assert.match(counters(await page('run.js', liveApi('checking', 0, { ...limits, maxReminders: 1 }), ['7'])), /Напоминания без действий<\/span>: <span class="num t2">0 из 1</);

  const training = counters(await page('run.js', liveApi('training', 0), ['7']));
  assert.match(training, /Запросы оператора: <span class="num t2">2 из 30<\/span>/);
  assert.doesNotMatch(training, /Напоминания/, 'в обучении счётчика нет');

  // Лента блока «Сейчас»: метка под напоминанием и реакция у решения.
  const now = await page('run.js', liveApi('checking', 1), ['7']);
  assert.match(now, /<span>напоминание стенда<\/span>/);
  assert.match(now, /<span>реакция: напоминание<\/span>/);
});

test('результат прогона: в снимке настроек названа и подсказка проверки', async () => {
  const data = liveApi('checking', 0);
  const run: Record<string, any> = { ...data['/api/runs/7'], status: 'completed', finishedAt: T };
  run.lines = [{ ...run.lines[0], status: 'completed', current: null, items: [] }];
  const done = await page('run.js', { '/api/runs/7': run, '/api/run-configs': [] }, ['7']);
  assert.match(done, /подсказки \(operator-v4, operator-check-v1, judge-v1\)/);
});
