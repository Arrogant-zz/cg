// Экран «Прогоны» (web/js/pages/runs.js): полоса результатов корзины — отметка на каждый кейс в порядке позиций, цвет — исход.
// Отметки стоят в сетке web/app.css: не уже 5,5 px, что не помещается — переходит на следующий ряд. В одной строке с постоянным
// зазором у корзины на 36 кейсов полоса становилась бледными штрихами, а с 44 кейсов пропадала. Раскладку тест не видит — её
// показывает только браузер, — но возврат к одной строке и расхождение ширины полосы, зазора и наименьшей ширины отметки ловит.
// У прогона с повторениями полоса строилась по одной линии, а число успехов рядом с ней — по всем, и они расходились. Теперь
// у каждой линии свой блок с номером слева, и число пересчитывается по отметкам (решение владельца от 12 ноября 2026 года).
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
  tech: 0,
  notEvaluated: 0,
  notStarted: 59,
  repetitions: 1,
};

// Прогоны с повторениями — синтетические записи для runListItem: тест проверяет вместе подсчёт на сервере и разметку.
const CASE: Record<string, { status: string; outcome: string | null }> = {
  o: { status: 'completed', outcome: 'passed' },
  x: { status: 'completed', outcome: 'failed' },
  t: { status: 'failed', outcome: 'technical' },
  '*': { status: 'running', outcome: null },
  '-': { status: 'not_started', outcome: null },
};

/** Линия по строке исходов. У идущей и ждущей сессию линии будущие кейсы ещё «ожидают», у законченной — «не начат». */
function line(index: number, pattern: string, status = 'completed') {
  const open = status === 'running' || status === 'queued';
  const cur = pattern.indexOf('*');
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

function record(status: string, lines: ReturnType<typeof line>[]): RunRecord {
  return {
    id: 9,
    title: `Проверка · 15 обращений × ${lines.length}`,
    type: 'checking',
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
