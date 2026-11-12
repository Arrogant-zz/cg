// Экран «Прогоны» (web/js/pages/runs.js): полоса результатов корзины — отметка на каждый кейс в порядке позиций, цвет — исход.
// Отметки стоят в сетке web/app.css: не уже 5,5 px, что не помещается — переходит на следующий ряд. В одной строке с постоянным
// зазором у корзины на 36 кейсов полоса становилась бледными штрихами, а с 44 кейсов пропадала. Раскладку тест не видит — её
// показывает только браузер, — но возврат к одной строке и расхождение ширины полосы, зазора и наименьшей ширины отметки ловит.
// У прогона с повторениями полоса строилась по одной линии, а число успехов рядом с ней — по всем, и они расходились. Теперь
// у каждой линии свой блок с номером слева, и число пересчитывается по отметкам (решение владельца от 12 ноября 2026 года).
// Колонка «Балл» таблицы «Завершённые» — балл прогона от 0 до 100 перед «N из M»: два прогона «1 из 15» по числу успехов
// неразличимы. Зелёный — от 80, красный — ниже 40, и только когда оценены все кейсы; иначе — пунктир с подсказкой. У обучающего
// прогона под баллом — число поправок оператора (решения владельца от 12–13 ноября 2026 года, docs/CONTRACTS.md, правило 30).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runListItem } from '../src/api/views.js';
import type { RunRecord } from '../src/runner/types.js';

// Модули интерфейса без DOM на верхнем уровне — загружаются как есть, без сборки; ответы API подменяются через fetch.
const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);
const appCss = fs.readFileSync(path.resolve('web/app.css'), 'utf8');
const baseCss = fs.readFileSync(path.resolve('web/clawgym.css'), 'utf8');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Объявления правила с этим селектором: селектор стоит в начале строки или сразу после предыдущего правила. */
function rule(css: string, file: string, selector: string): Record<string, string> {
  const m = new RegExp(`(?:^|\\})${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(m, `в ${file} нет правила ${selector}`);
  return Object.fromEntries(
    m[1]
      .split(';')
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
  );
}

/** Число из значения в пикселях: «3px» → 3. */
function px(value: string | undefined, what: string): number {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value ?? '');
  assert.ok(m, `${what}: ожидалось значение в px, а не «${value}»`);
  return Number(m[1]);
}

/** Экран «Прогоны» с этими прогонами; журнал стенда пуст. Адрес без ответа получает 404, как у стенда. */
async function runsPage(runs: unknown[]): Promise<string> {
  const data: Record<string, unknown> = { '/api/runs': { runs, manual: [] }, '/api/status': { stand: [] }, '/api/mcp/traffic?unbound=1': [] };
  globalThis.fetch = (async (input: unknown) => {
    const p = String(input);
    return p in data ? new Response(JSON.stringify(data[p]), { status: 200 }) : new Response(JSON.stringify({ error: 'Не найдено' }), { status: 404 });
  }) as typeof fetch;
  return String(await (await web('pages/runs.js')).render({ params: [], state: {}, query: new URLSearchParams() }));
}

/** Полосы результатов в разметке: ширина, если она задана в разметке, и классы отметок по порядку. */
function bars(markup: string): { width: number | null; cells: string[] }[] {
  return [...markup.matchAll(/<div class="bar"(?: style="width: (\d+)px")? aria-hidden="true">((?:<i class="[^"]*"><\/i>)*)<\/div>/g)].map((m) => ({
    width: m[1] ? Number(m[1]) : null,
    cells: [...m[2].matchAll(/<i class="([^"]*)"><\/i>/g)].map((c) => c[1]),
  }));
}

/** Номера линий слева от блоков полосы, по порядку. */
function lineNumbers(markup: string): number[] {
  return [...markup.matchAll(/<span>(\d+)<\/span><div class="bar"/g)].map((m) => Number(m[1]));
}

/** Заголовки колонок таблицы «Завершённые». */
const headers = (markup: string) => [...(/<thead>([\s\S]*?)<\/thead>/.exec(markup)?.[1] ?? '').matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);

/** Строки таблицы «Завершённые»: разметка ячеек по порядку колонок. */
function rows(markup: string): string[][] {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(markup)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
}

// Колонки таблицы «Завершённые»: балл — четвёртая, успех среди оценённых — пятая, вне оценки — шестая.
const SCORE = 3;
const SUCCESS = 4;
const OUTSIDE = 5;

/** Балл в колонке «Балл» по строкам: число, вариант оформления и подсказка; null — балла в ячейке нет. */
function scores(markup: string): ({ value: number; variant: string; title: string | null } | null)[] {
  return rows(markup).map((cells) => {
    const m = /<span class="score((?: [a-z]+)*)"(?: title="([^"]*)")?>(\d+)<\/span>/.exec(cells[SCORE] ?? '');
    return m ? { value: Number(m[3]), variant: m[1].trim(), title: m[2] ?? null } : null;
  });
}

/** Подпись о поправках под баллом по строкам; null — подписи нет. */
const captions = (markup: string) => rows(markup).map((cells) => /<span class="cap nw">([^<]*)<\/span>/.exec(cells[SCORE] ?? '')?.[1] ?? null);

const T = '2026-11-11T17:33:00.000Z';
// Отметки по позициям: o — пройден, x — не пройден, t — технический сбой, * — идёт, - — не начат.
const CELL: Record<string, string> = { o: 'ok', x: 'no', t: 'tech', '*': 'live', '-': '' };
const cellsOf = (pattern: string) => [...pattern].map((c) => CELL[c]);

// Обучающий прогон как в отчёте владельца от 11 ноября 2026 года: 36 кейсов, 23 успеха, 9 неуспехов, 4 технических сбоя.
const finished = cellsOf(['xoxxto', 'xoooxo', 'txoooo', 'oxotoo', 'ooxooo', 'otooxo'].join(''));
const finishedRun = {
  id: 4,
  title: 'Обучение · 36 обращений',
  configId: 'train-36',
  configFile: 'runs/train-36.yaml',
  type: 'training',
  status: 'completed',
  error: null,
  testOperator: 'новый · cg-4-1',
  finishedAt: T,
  bars: [finished],
  success: { passed: 23, evaluated: 32 },
  score: { value: 84, zone: null, evaluated: 32, total: 36, passed: 23, actions: 88, answer: 81, noAnswer: 0, reason: '' },
  corrections: 14,
  tech: 4,
  notEvaluated: 0,
  notStarted: 0,
  repetitions: 1,
};

// Идущий прогон на 100 кейсов: 40 завершены, сорок первый идёт, остальные не начаты.
const live = Array.from({ length: 100 }, (_, i) => (i < 40 ? (i % 3 ? 'ok' : 'no') : i === 40 ? 'live' : ''));
const runningRun = {
  id: 6,
  title: 'Обучение · 100 обращений',
  configId: 'train-100',
  configFile: 'runs/train-100.yaml',
  type: 'training',
  status: 'running',
  error: null,
  testOperator: 'новый · cg-6-1',
  startedAt: T,
  bars: [live],
  progress: { done: 40, total: 100, phase: null, pos: 41, turns: null },
  models: { operator: 'fake-operator', judge: 'fake-judge' },
  success: { passed: 26, evaluated: 40 },
  score: { value: 77, zone: null, evaluated: 40, total: 100, passed: 26, actions: 80, answer: 74, noAnswer: 0, reason: '' },
  corrections: 31,
  tech: 0,
  notEvaluated: 0,
  notStarted: 59,
  repetitions: 1,
};

// Прогоны с повторениями — синтетические записи для runListItem: тест проверяет вместе подсчёт на сервере и разметку.
const check = (kind: string, passed: boolean) => ({ id: kind, kind, text: kind, passed, evidence: [], note: '' });
/** Проверки действий кейса: обязательные вместе с итоговым — выполнено из всех — и один запрет, соблюдённый или нарушенный. */
const acts = (done: number, of: number, violated = false) => [...Array.from({ length: of }, (_, k) => check(k === of - 1 ? 'final' : 'required', k < done)), check('forbidden', !violated)];
/** Не пройденный кейс с проверками действий и счётом критериев судьи; без критериев судья не вызывался. */
const failed = (checks: ReturnType<typeof acts>, judge: [passed: number, total: number] | null = null) => ({
  status: 'completed',
  outcome: 'failed',
  checks,
  steps: { judge: judge ? { status: 'ok', passed: judge[0], total: judge[1] } : { status: 'skipped', passed: 0, total: 0 } },
});
const CASE: Record<string, { status: string; outcome: string | null; checks?: unknown; steps?: unknown }> = {
  o: { status: 'completed', outcome: 'passed' },
  x: { status: 'completed', outcome: 'failed' },
  t: { status: 'failed', outcome: 'technical' },
  '*': { status: 'running', outcome: null },
  '-': { status: 'not_started', outcome: null },
  // Не пройденные кейсы для колонки «Балл»: ключ — балл кейса. У кейса «x» проверок и критериев в записи нет, балла у него нет.
  70: failed(acts(3, 3, true), [3, 3]), // запрещённый вызов отклонён оператором, остальное верно
  67: failed(acts(3, 3), [2, 3]), // одно замечание: не выполнен один критерий из трёх
  60: failed(acts(3, 4)),
  53: failed(acts(2, 3), [2, 3]),
  47: failed(acts(2, 3), [1, 2]),
  40: failed(acts(1, 2)),
  39: failed(acts(3, 5), [3, 8]),
  30: failed(acts(3, 8)),
  23: failed(acts(1, 3, true), [1, 3]), // грубый промах: одно действие из трёх, нарушен запрет, один критерий из трёх
};
/** Кейсы подряд: fill(14, 67) — четырнадцать кейсов с баллом 67. */
const fill = (n: number, token: string | number): (string | number)[] => Array.from({ length: n }, () => token);

/** Линия по строке исходов или списку кейсов. У идущей и ждущей сессию линии будущие кейсы ещё «ожидают», у законченной — «не начат». */
function line(index: number, pattern: string | (string | number)[], status = 'completed') {
  const open = status === 'running' || status === 'queued';
  const cur = [...pattern].indexOf('*');
  return {
    index,
    senderId: status === 'queued' ? '' : `cg-9-${index}`,
    history: [],
    status,
    startedAt: status === 'queued' ? null : T,
    finishedAt: open ? null : T,
    error: status === 'failed' ? 'Внутренняя ошибка стенда' : null,
    prep: { status: status === 'queued' ? 'pending' : 'ok', items: [], durationMs: 0 },
    curatorPasses: [],
    counter: 0,
    current: cur >= 0 ? { index: cur, execName: null, phase: 'диалог' } : null,
    items: [...pattern].map((c, k) => ({ index: k, kind: 'case', pos: k + 1, ...(c === '-' && open ? { status: 'pending', outcome: null } : CASE[c]) })),
  };
}

function record(status: string, lines: ReturnType<typeof line>[], extra: { id?: number; type?: 'training' | 'checking' } = {}): RunRecord {
  return {
    id: extra.id ?? 9,
    title: `Проверка · 15 обращений × ${lines.length}`,
    type: extra.type ?? 'checking',
    status,
    error: null,
    configId: 'check-15',
    configFile: 'runs/check-15.yaml',
    createdAt: T,
    startAt: null,
    startedAt: T,
    finishedAt: status === 'running' ? null : T,
    settings: { agent: { id: 'demo', title: 'Демо-агент' }, operator: { id: 'fake-operator' }, judge: { id: 'fake-judge' } },
    lines,
  } as unknown as RunRecord;
}

// Три повторения корзины из 15 кейсов: 28 успехов, 13 неуспехов и 4 технических сбоя, все сбои — в третьей линии.
const reps15 = ['oooooxoooooooxo', 'xoxxoxooxoxxoox', 'ottoxooxtoooxot'];

test('правило стилей: полоса — сетка, отметка не уже 5,5 px, при короткой корзине отметки делят ширину поровну', () => {
  const grid = rule(appCss, 'web/app.css', '.bar');
  assert.equal(grid.display, 'grid', 'отметки стоят в сетке и переносятся в ряды, а не сжимаются в одну строку');
  assert.equal(grid['grid-template-columns'], 'repeat(auto-fit,minmax(5.5px,1fr))', 'колонок столько, сколько помещается; пустые схлопываются');
});

test('правило стилей: блоки линий — сетка «номер и полоса» через 6 px, строка номера не выше отметки', () => {
  const grid = rule(appCss, 'web/app.css', '.bar-lines');
  assert.equal(grid.display, 'grid');
  assert.equal(
    grid['grid-template-columns'],
    'max-content 1fr',
    'номер — по содержимому, полоса — остаток ширины, но колонка не уже блока: у minmax(0,1fr) таблица сжимает её, и блок вылезает из ячейки',
  );
  assert.equal(grid.gap, '6px', 'между блоками линий вдвое больше, чем между рядами внутри блока');
  const mark = px(rule(baseCss, 'web/clawgym.css', '.bar i').height, 'высота отметки');
  const label = px(rule(appCss, 'web/app.css', '.bar-lines>span')['line-height'], 'высота строки номера линии');
  assert.ok(label <= mark, `строка номера ${label} px выше отметки ${mark} px: номер раздвинет ряды блоков`);
});

test('«Прогоны», таблица «Завершённые»: полоса шириной 128 px, отметка на каждый кейс в порядке позиций', async () => {
  const counts = finished.reduce<Record<string, number>>((n, c) => ({ ...n, [c]: (n[c] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { no: 9, ok: 23, tech: 4 }, 'данные теста: 23 успеха, 9 неуспехов, 4 сбоя');
  const page = await runsPage([finishedRun]);
  assert.match(page, /<span class="num m5">23 из 32<\/span><div class="bar"/, 'полоса стоит под числом успехов среди оценённых');
  const found = bars(page);
  assert.equal(found.length, 1, 'одна полоса — в строке завершённого прогона');
  assert.equal(found[0].width, 128);
  assert.deepEqual(found[0].cells, finished, 'отметка на каждый из 36 кейсов, классы исходов по позициям');
  assert.ok(!page.includes('bar-lines'), 'у прогона без повторений нет блоков линий');
  assert.deepEqual(lineNumbers(page), [], 'и нет номера линии');
});

test('«Прогоны», карточка идущего прогона: отметка на каждый кейс корзины, в том числе на текущий и не начатые', async () => {
  const page = await runsPage([runningRun]);
  const found = bars(page);
  assert.equal(found.length, 1, 'одна полоса — в карточке идущего прогона');
  assert.equal(found[0].width, null, 'ширину полосы в карточке задаёт карточка');
  assert.equal(found[0].cells.length, 100);
  assert.deepEqual(found[0].cells, live);
  assert.ok(!page.includes('bar-lines'), 'у прогона без повторений нет блоков линий');
  assert.match(page, /<span class="sm t2">Решение 41 из 100<\/span>/, 'подпись без повторений прежняя: текущее решение');
});

test('в ряду полосы таблицы «Завершённые» ровно 15 отметок: ширина полосы, зазор и наименьшая ширина отметки согласованы', async () => {
  const [table] = bars(await runsPage([finishedRun]));
  assert.ok(table?.width, 'ширина полосы задана в разметке таблицы');
  const grid = rule(appCss, 'web/app.css', '.bar');
  const gap = px(grid.gap ?? rule(baseCss, 'web/clawgym.css', '.bar').gap, 'зазор .bar');
  const min = px(/^repeat\(auto-fit,minmax\(([^,]+),1fr\)\)$/.exec(grid['grid-template-columns'] ?? '')?.[1], 'наименьшая ширина отметки');
  // Сетка ставит в ряд столько колонок наименьшей ширины с зазорами, сколько помещается в ширину полосы.
  const perRow = Math.floor((table.width + gap) / (min + gap));
  assert.equal(perRow, 15, `полоса ${table.width} px, зазор ${gap} px, отметка от ${min} px: в ряду ${perRow} отметок`);
  assert.ok((table.width - gap * (perRow - 1)) / perRow >= min, 'в полном ряду отметка не уже наименьшей ширины');
});

test('«Прогоны», таблица «Завершённые», три повторения: блок на линию с номером, число «N из M» сходится с отметками', async () => {
  const page = await runsPage([runListItem(record('completed', reps15.map((p, k) => line(k + 1, p))))]);
  assert.match(page, /<span class="num m5">28 из 41<\/span><div class="bar-lines" aria-hidden="true">/, 'блоки линий стоят под числом успехов');
  const found = bars(page);
  assert.equal(found.length, 3, 'блок на каждую из трёх линий');
  assert.deepEqual(
    found.map((b) => b.width),
    [128, 128, 128],
    'у каждого блока ширина полосы таблицы: в ряду 15 отметок, и отметки одной позиции стоят друг под другом',
  );
  assert.deepEqual(
    found.map((b) => b.cells),
    reps15.map(cellsOf),
    'блоки в порядке линий, отметки в порядке позиций',
  );
  assert.deepEqual(lineNumbers(page), [1, 2, 3], 'слева от блока — номер линии, как на вкладке «Повторение N»');
  const all = found.flatMap((b) => b.cells);
  const count = (c: string) => all.filter((x) => x === c).length;
  assert.deepEqual([count('ok'), count('ok') + count('no')], [28, 41], 'зелёных — 28, зелёных и красных — 41, как в числе');
  assert.match(page, /4 технических сбоя/);
  assert.equal(count('tech'), 4, 'фиолетовых отметок столько же, сколько технических сбоев в «Вне оценки»');
  assert.deepEqual(
    found.map((b) => b.cells.filter((c) => c === 'tech').length),
    [0, 0, 4],
    'все сбои — в третьей линии, и фиолетовые отметки — только в третьем блоке',
  );
});

test('«Прогоны», линия упала до первого кейса: её блок стоит первым из неначатых отметок, число — по отметкам других линий', async () => {
  const lines = [line(1, '-'.repeat(15), 'failed'), line(2, 'ooxoooxooooxooo'), line(3, 'oooxooooxoooooo')];
  const page = await runsPage([runListItem(record('completed', lines))]);
  assert.match(page, /<span class="num m5">25 из 30<\/span>/);
  const found = bars(page);
  assert.equal(found.length, 3);
  assert.deepEqual(found[0].cells, cellsOf('-'.repeat(15)), 'блок упавшей линии виден: 15 отметок «не начат»');
  const all = found.flatMap((b) => b.cells);
  assert.deepEqual([all.filter((c) => c === 'ok').length, all.filter((c) => c === 'ok' || c === 'no').length], [25, 30]);
});

test('«Прогоны», карточка прогона с повторениями: блок каждой линии с её текущей позицией, подпись — по всем линиям', async () => {
  const lines = [line(1, 'oooxooooooooooo'), line(2, 'oxoo*----------', 'running'), line(3, 'ooxxoo*--------', 'running')];
  const page = await runsPage([runListItem(record('running', lines))]);
  const found = bars(page);
  assert.equal(found.length, 3, 'блоки всех трёх линий');
  assert.deepEqual(
    found.map((b) => b.width),
    [null, null, null],
    'ширину блоков в карточке задаёт карточка',
  );
  assert.deepEqual(
    found.map((b) => b.cells.indexOf('live')),
    [-1, 4, 6],
    'текущие позиции: пятая во второй линии, седьмая в третьей',
  );
  assert.deepEqual(lineNumbers(page), [1, 2, 3]);
  assert.match(page, /<span class="sm t2">Готово 25 из 45 · повторений 3<\/span>/, 'готово 15 + 4 + 6 кейсов из 3 × 15');
});

test('«Прогоны», карточка прогона с повторениями: линия, которая ждёт сессию, видна блоком из неначатых отметок', async () => {
  const lines = [line(1, 'oo*------------', 'running'), line(2, 'o*-------------', 'running'), line(3, '-'.repeat(15), 'queued')];
  const page = await runsPage([runListItem(record('running', lines))]);
  const found = bars(page);
  assert.equal(found.length, 3);
  assert.deepEqual(found[2].cells, cellsOf('-'.repeat(15)), 'третья линия ждёт свободную сессию: все отметки «не начат»');
  assert.match(page, /<span class="sm t2">Готово 3 из 45 · повторений 3<\/span>/);
});

// ------------------------------------------------------------------ колонка «Балл»

/** Строка списка прогонов по записи с одной линией: балл по записи считает сервер, как у любого завершённого прогона. */
const listed = (id: number, tokens: string | (string | number)[], extra: { status?: string; type?: 'training' | 'checking' } = {}) =>
  runListItem(record(extra.status ?? 'completed', [line(1, tokens, extra.status ?? 'completed')], { id, type: extra.type }));

/** Обучающий прогон: число поправок оператора у кейсов первой линии по порядку, у остальных — ноль. */
function training(rec: RunRecord, corrections: number[]): RunRecord {
  rec.type = 'training';
  rec.lines[0].items.forEach((i, k) => Object.assign(i, { stats: { corrections: corrections[k] ?? 0 } }));
  return rec;
}

test('данные теста: балл кейса с проверками действий и критериями совпадает с его ключом', () => {
  for (const key of Object.keys(CASE).filter((k) => /^\d+$/.test(k))) assert.equal(listed(1, [Number(key)]).score.value, Number(key), `кейс ${key}`);
  assert.equal(listed(1, 'o').score.value, 100);
  assert.equal(listed(1, 'x').score.value, null, 'у кейса без проверок и критериев в записи балла нет');
});

test('правило стилей: балл прогона — пары «Пройдено» и «Неуспех агента» из стайлгайда, неполная оценка — пунктир; размер у всех вариантов один', () => {
  const base = rule(appCss, 'web/app.css', '.score');
  assert.equal(base['font-variant-numeric'], 'tabular-nums', 'цифры табличные: числа в колонке стоят на одной вертикали');
  px(base['min-width'], 'наименьшая ширина балла: «100» и «7» занимают одно место');
  px(base.height, 'высота балла');
  assert.equal(base.border, '1px solid transparent', 'рамка есть у каждого варианта, поэтому пунктир неполной оценки не меняет размер');
  assert.ok(!('background' in base) && !('color' in base), 'без зоны — графитовый текст страницы без фона');
  // Варианты меняют только цвет и вид рамки: размер у всех один.
  assert.deepEqual(rule(appCss, 'web/app.css', '.score.high'), { background: '#E6F2EA', color: '#17603F' }, 'зелёная зона — пара «Пройдено»');
  assert.deepEqual(rule(appCss, 'web/app.css', '.score.low'), { background: '#FCEAE8', color: '#A51C14' }, 'красная зона — пара «Неуспех агента»');
  assert.deepEqual(rule(appCss, 'web/app.css', '.score.partial'), { 'border-style': 'dashed', 'border-color': '#A6ADA7' }, 'неполная оценка — пунктир «нет данных» без заливки');
  // Те же пары — у плашек «Пройден» и «Не пройден» в clawgym.css.
  assert.deepEqual(
    [rule(baseCss, 'web/clawgym.css', '.pill.pass'), rule(baseCss, 'web/clawgym.css', '.pill.fail')],
    [
      { background: '#E6F2EA', color: '#17603F' },
      { background: '#FCEAE8', color: '#A51C14' },
    ],
  );
});

test('«Прогоны», таблица «Завершённые»: колонка «Балл» стоит перед «Успехом среди оценённых»; два прогона «1 из 15» получают 69 и 28', async () => {
  // В первом прогоне у 14 кейсов не выполнен один критерий из трёх, во втором — неверные действия, нарушен запрет и один критерий из трёх.
  const close = listed(11, ['o', ...fill(14, 67)]);
  const far = listed(12, ['o', ...fill(14, 23)]);
  assert.deepEqual([close.success, far.success], [{ passed: 1, evaluated: 15 }, { passed: 1, evaluated: 15 }], 'по числу успехов прогоны неразличимы');
  const page = await runsPage([close, far]);
  assert.deepEqual(headers(page), ['Прогон', 'Тип', 'Тестовый оператор', 'Балл', 'Успех среди оценённых', 'Вне оценки', 'Завершён', '']);
  assert.match(page, /<th title="0–100: 20 за пройденный кейс, 40 за действия, 40 за ответ">Балл<\/th>/, 'у заголовка — подсказка с формулой');
  assert.deepEqual(scores(page), [
    { value: 69, variant: '', title: null },
    { value: 28, variant: 'low', title: null },
  ]);
  // «N из M» и полоса результатов — на месте, в следующей колонке.
  for (const cells of rows(page)) assert.match(cells[SUCCESS], /^<div class="col" style="gap: 6px"><span class="num m5">1 из 15<\/span><div class="bar" style="width: 128px" aria-hidden="true">/);
  const count = (cells: string[], c: string) => cells.filter((x) => x === c).length;
  assert.deepEqual(
    bars(page).map((b) => [b.width, count(b.cells, 'ok'), count(b.cells, 'no')]),
    [
      [128, 1, 14],
      [128, 1, 14],
    ],
  );
  assert.match(page, /<p class="hint">[\s\S]*?Балл — от 0 до 100[\s\S]*?<\/p>/, 'подсказка под таблицей объясняет балл');
});

test('«Прогоны», зоны балла: 96 — зелёный, 44 — без цвета, 28 — красный; границы 80, 79, 40 и 39', async () => {
  // Во всех прогонах оценены все кейсы. 96 — обучение в демо: шесть кейсов по 100 и один 70; 44 — проверка до обучения.
  const page = await runsPage([
    listed(1, [...fill(6, 'o'), 70]),
    listed(2, [53, 47, 53, 23]),
    listed(3, ['o', ...fill(14, 23)]),
    listed(4, ['o', 60]),
    listed(5, [...fill(3, 'o'), ...fill(7, 70)]),
    listed(6, [40]),
    listed(7, [39]),
  ]);
  assert.deepEqual(scores(page), [
    { value: 96, variant: 'high', title: null },
    { value: 44, variant: '', title: null },
    { value: 28, variant: 'low', title: null },
    { value: 80, variant: 'high', title: null },
    { value: 79, variant: '', title: null },
    { value: 40, variant: '', title: null },
    { value: 39, variant: 'low', title: null },
  ]);
});

test('«Прогоны», балл по неполной оценке: пунктир без цвета зоны и подсказка «Оценено M из T кейсов»', async () => {
  // Из 15 кейсов 3 пройдены, 12 завершились техническим сбоем. Второй прогон остановлен после 5 кейсов из 15, все пять оценены на 30.
  const tech = listed(1, [...fill(3, 'o'), ...fill(12, 't')]);
  const stopped = listed(2, [...fill(5, 30), ...fill(10, '-')], { status: 'stopped' });
  const almost = listed(3, [...fill(20, 'o'), 't']);
  assert.deepEqual([tech.score.zone, stopped.score.zone, almost.score.zone], [null, null, null], 'зону не ставит уже сервер');
  const page = await runsPage([tech, stopped, almost]);
  assert.deepEqual(scores(page), [
    { value: 100, variant: 'partial', title: 'Оценено 3 из 15 кейсов' },
    { value: 30, variant: 'partial', title: 'Оценено 5 из 15 кейсов' },
    { value: 100, variant: 'partial', title: 'Оценено 20 из 21 кейса' },
  ]);
  assert.match(rows(page)[0][OUTSIDE], /12 технических сбоев/, 'причина неполной оценки — в колонке «Вне оценки»');
  assert.match(rows(page)[1][OUTSIDE], /Остановлен · 10 не начаты/);
});

test('«Прогоны», обучающий прогон: под баллом — число поправок оператора со склонением; у проверяющего прогона подписи нет', async () => {
  // Шесть кейсов пройдены, седьмой получил 70: балл 96. Поправки в балл не входят.
  const pattern = [...fill(6, 'o'), 70];
  const train = (id: number, corrections: number[]) => runListItem(training(record('completed', [line(1, pattern)], { id }), corrections));
  // У шестого прогона все кейсы — технические сбои: завершённых кейсов нет, и числа поправок нет.
  const broken = runListItem(training(record('completed', [line(1, 'tttt')], { id: 6 }), [3, 3, 3, 3]));
  const runs = [train(1, [2, 2, 0, 0, 0, 0, 1]), train(2, []), train(3, [1]), train(4, [0, 2]), listed(5, pattern), broken];
  assert.deepEqual(
    runs.map((r) => [r.score.value, r.corrections]),
    [
      [96, 5],
      [96, 0],
      [96, 1],
      [96, 2],
      [96, null],
      [null, null],
    ],
  );
  const page = await runsPage(runs);
  assert.deepEqual(captions(page), ['5 поправок', '0 поправок', '1 поправка', '2 поправки', null, null]);
  assert.deepEqual(
    scores(page).map((s) => (s ? [s.value, s.variant] : null)),
    [[96, 'high'], [96, 'high'], [96, 'high'], [96, 'high'], [96, 'high'], null],
    'поправки балл не меняют',
  );
});

test('«Прогоны», нет оценённых кейсов: в колонке «Балл» — прочерк, а не ноль; причина — в колонке успеха', async () => {
  const none = listed(1, 'tttt');
  assert.deepEqual([none.score.value, none.score.reason], [null, 'нет оценённых кейсов']);
  const [cells] = rows(await runsPage([none]));
  assert.equal(cells[SCORE], '<span class="t3">—</span>');
  assert.equal(cells[SUCCESS], '<span class="pill na">нет оценённых</span>');
  // Строка списка без поля score — ответ стенда прежней версии в открытой вкладке: прочерк, а не ошибка.
  const old: Record<string, unknown> = { ...listed(2, 'oooo') };
  delete old.score;
  delete old.corrections;
  const [oldCells] = rows(await runsPage([old]));
  assert.equal(oldCells[SCORE], '<span class="t3">—</span>');
  assert.match(oldCells[SUCCESS], /<span class="num m5">4 из 4<\/span>/);
});

test('«Прогоны», блок «Сейчас на стенде»: карточки идущих прогонов балл и поправки не показывают', async () => {
  const lines = [line(1, [...fill(14, 'o'), 53]), line(2, 'oooo*----------', 'running')];
  const running = runListItem(training(record('running', lines), [1, 2]));
  assert.deepEqual([running.score.value, running.score.evaluated, running.score.total, running.corrections], [98, 19, 30, 3], 'сервер отдаёт балл и поправки по уже оценённым кейсам');
  const page = await runsPage([running, runningRun]);
  assert.equal(bars(page).length, 3, 'обе карточки на месте: два блока линий и полоса прогона без повторений');
  assert.ok(!page.includes('class="score'), 'балла в карточках нет: пока прогон идёт, виден ход, а не результат');
  assert.doesNotMatch(page, /поправ/);
});
