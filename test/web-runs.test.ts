// Экран «Прогоны» (web/js/pages/runs.js): полоса результатов корзины — отметка на каждый кейс в порядке позиций, цвет — исход.
// Отметки стоят в сетке web/app.css: не уже 5,5 px, что не помещается — переходит на следующий ряд. В одной строке с постоянным
// зазором у корзины на 36 кейсов полоса становилась бледными штрихами, а с 44 кейсов пропадала. Раскладку тест не видит — её
// показывает только браузер, — но возврат к одной строке и расхождение ширины полосы, зазора и наименьшей ширины отметки ловит.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const T = '2026-11-11T17:33:00.000Z';
const OUTCOME: Record<string, string> = { o: 'ok', x: 'no', t: 'tech' };

// Обучающий прогон как в отчёте владельца от 11 ноября 2026 года: 36 кейсов, 23 успеха, 9 неуспехов, 4 технических сбоя.
// Позиции по порядку: o — пройден, x — не пройден, t — технический сбой.
const finished = ['xoxxto', 'xoooxo', 'txoooo', 'oxotoo', 'ooxooo', 'otooxo'].join('').split('').map((c) => OUTCOME[c]);
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
  bar: finished,
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
  bar: live,
  progress: { done: 40, total: 100, phase: null, pos: 41, turns: null },
  models: { operator: 'fake-operator', judge: 'fake-judge' },
  success: { passed: 26, evaluated: 40 },
  tech: 0,
  notEvaluated: 0,
  notStarted: 59,
  repetitions: 1,
};

test('правило стилей: полоса — сетка, отметка не уже 5,5 px, при короткой корзине отметки делят ширину поровну', () => {
  const grid = rule(appCss, 'web/app.css', '.bar');
  assert.equal(grid.display, 'grid', 'отметки стоят в сетке и переносятся в ряды, а не сжимаются в одну строку');
  assert.equal(grid['grid-template-columns'], 'repeat(auto-fit,minmax(5.5px,1fr))', 'колонок столько, сколько помещается; пустые схлопываются');
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
});

test('«Прогоны», карточка идущего прогона: отметка на каждый кейс корзины, в том числе на текущий и не начатые', async () => {
  const found = bars(await runsPage([runningRun]));
  assert.equal(found.length, 1, 'одна полоса — в карточке идущего прогона');
  assert.equal(found[0].width, null, 'ширину полосы в карточке задаёт карточка');
  assert.equal(found[0].cells.length, 100);
  assert.deepEqual(found[0].cells, live);
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
