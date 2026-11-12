// Балл прогона на странице прогона и в сравнении (web/js/pages/run.js и compare.js): блок «Балл прогона» над плитками метрик,
// колонка «Балл» в таблицах «Результаты по решениям» и «По кейсам», плитка «Балл на общих кейсах» (решения владельца
// от 12–13 ноября 2026 года, docs/CONTRACTS.md, правило 30). Ответы API — настоящие, с офлайн-стенда: модули интерфейса
// отрисовывают их без сборки, fetch подменяется только на время отрисовки. Формулу интерфейс не повторяет — числа считает
// стенд; здесь проверяется, что и где показано. Раскладку тест не видит — её показывает только браузер.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG, startStand, type Stand } from './helpers.js';

const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);

/** Страница на записанных ответах API; адрес без ответа — 404, как у стенда. */
async function render(page: string, params: string[], data: Record<string, unknown>, query = ''): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const p = String(input);
    return p in data ? new Response(JSON.stringify(data[p]), { status: 200 }) : new Response(JSON.stringify({ error: 'Не найдено' }), { status: 404 });
  }) as typeof fetch;
  try {
    return String(await (await web(page)).render({ params, state: {}, query: new URLSearchParams(query), navigate: () => undefined, rerender: () => undefined }));
  } finally {
    globalThis.fetch = real;
  }
}

/** Страница прогона по его записи из ответа стенда. */
const runPage = (run: any) => render('pages/run.js', [String(run.id)], { [`/api/runs/${run.id}`]: run, '/api/run-configs': [] });

/** Страница сравнения прогонов A и B по ответам стенда. */
const comparePage = (runs: unknown, a: number, b: number, compare: unknown) => render('pages/compare.js', [], { '/api/runs': runs, [`/api/compare?a=${a}&b=${b}`]: compare }, `a=${a}&b=${b}`);

/** Ряд плиток страницы по его подписи: разметка между тегами section. */
function kpis(markup: string, label: string): string {
  const m = new RegExp(`<section class="kpis" aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`).exec(markup);
  assert.ok(m, `на странице нет ряда плиток «${label}»`);
  return m[1].trim();
}

/** Заголовки плиток ряда по порядку. */
const tileTitles = (block: string) => [...block.matchAll(/<span class="k">([^<]*)<\/span>/g)].map((m) => m[1]);

/** Плитка с этим заголовком целиком. */
function tile(block: string, title: string): string {
  const m = new RegExp(`<div class="kpi[^"]*"><span class="k">${title}</span>[\\s\\S]*?</div>`).exec(block);
  assert.ok(m, `нет плитки «${title}»`);
  return m[0];
}

/** Таблица страницы, в которой есть эта колонка: заголовки и ячейки строк по порядку колонок. */
function table(markup: string, column: string): { head: string[]; rows: string[][] } {
  for (const t of markup.matchAll(/<table class="tbl[^"]*">([\s\S]*?)<\/table>/g)) {
    const head = [...(/<thead>([\s\S]*?)<\/thead>/.exec(t[1])?.[1] ?? '').matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    if (!head.includes(column)) continue;
    const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(t[1])?.[1] ?? '';
    return { head, rows: [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1])) };
  }
  return assert.fail(`на странице нет таблицы с колонкой «${column}»`);
}

const DASH = '<span class="t3">—</span>';
/** Балл кейса в таблице результатов: без вариантов зоны. */
const plain = (value: number) => `<span class="score">${value}</span>`;
/** Блок «Балл прогона» с баллом: вид плитки, цвет числа и строки подписи. */
const scoreTile = (cls: string, value: string, ...captions: string[]) => `<div class="${cls}"><span class="k">Балл прогона</span>${value}${captions.map((c) => `<span class="cap">${c}</span>`).join('')}</div>`;
const big = (value: number, zone = '') => `<span class="v${zone}">${value} <small>из 100</small></span>`;

// Демо-прогоны: проверка до обучения, обучение, та же проверка на обученном операторе.
let s: Stand;
let demo: { check: any; train: any; trained: any; runs: any; compare: any };

before(async () => {
  s = await startStand();
  const run = async (config: string) => {
    const created = await s.api('POST', '/api/runs', { config });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    return s.waitRun(created.data.id);
  };
  const check = await run('demo-check');
  const train = await run('demo-train');
  const trained = await run('demo-check-trained');
  demo = { check, train, trained, runs: (await s.api('GET', '/api/runs')).data, compare: (await s.api('GET', `/api/compare?a=${check.id}&b=${trained.id}`)).data };
});
after(async () => {
  await s?.close();
});

test('«Прогон», проверка до обучения в демо: блок «Балл прогона» стоит над плитками метрик, первые плитки — M1 и M2', async () => {
  const page = await runPage(demo.check);
  assert.equal(kpis(page, 'Балл прогона'), scoreTile('kpi', big(44), 'пройдено 0 из 4 · действия 56 % · ответ 54 %'), 'балл 44 без цвета зоны и разложение');
  assert.ok(page.indexOf('aria-label="Балл прогона"') < page.indexOf('aria-label="Метрики прогона"'), 'блок — над плитками метрик');
  const tiles = tileTitles(kpis(page, 'Метрики прогона'));
  assert.deepEqual(tiles.slice(0, 2), ['M1 · Финальное действие', 'M2 · Качество внутри сценария'], 'первые плитки — по-прежнему M1 и M2');
  assert.ok(!tiles.includes('Балл прогона'), 'балл — не одна из плиток выбранных метрик');
  assert.doesNotMatch(page, /по повторениям/, 'у прогона без повторений баллов линий нет');
});

test('«Прогон», таблица «Результаты по решениям»: колонка «Балл» после «Итога», баллы кейсов — без цвета зоны', async () => {
  const page = await runPage(demo.check);
  const results = table(page, 'Итог');
  assert.deepEqual(results.head, ['№', 'Кейс · решение', 'Итог', 'Балл', 'Действия', 'Ответ', 'M1 · M2', 'Команды', 'Время']);
  assert.deepEqual(
    results.rows.map((r) => r[3]),
    [53, 47, 53, 23].map(plain),
    'баллы кейсов проверки до обучения по позициям',
  );
  assert.doesNotMatch(page, /class="score (high|low|partial)"/, 'балл кейса по зонам не красится: исход показывает плашка итога');
  // После обучения все кейсы пройдены: балл прогона — зелёный, баллы кейсов — по-прежнему без цвета.
  const trained = await runPage(demo.trained);
  assert.equal(kpis(trained, 'Балл прогона'), scoreTile('kpi', big(100, ' up'), 'пройдено 4 из 4 · действия 100 % · ответ 100 %'));
  assert.deepEqual(
    table(trained, 'Итог').rows.map((r) => r[3]),
    [100, 100, 100, 100].map(plain),
  );
  assert.doesNotMatch(trained, /class="score (high|low|partial)"/);
});

test('«Прогон», обучение в демо: балл 96 — зелёный; у кейса, пройденного после поправок, — 100, поправки — в своей колонке', async () => {
  const page = await runPage(demo.train);
  assert.equal(kpis(page, 'Балл прогона'), scoreTile('kpi', big(96, ' up'), 'пройдено 6 из 7 · действия 96 % · ответ 100 %'));
  const results = table(page, 'Итог');
  assert.deepEqual(results.head, ['№', 'Кейс · решение', 'Итог', 'Балл', 'Действия', 'Ответ', 'M1 · M2', 'Поправки', 'Команды', 'Время']);
  const first = results.rows[0];
  assert.match(first[2], /<span class="pill pass">[\s\S]*Пройден<\/span>/);
  assert.equal(first[3], plain(100));
  assert.match(first[7], /^<span class="num">2<\/span>/, 'две поправки оператора балл кейса не снизили');
  // Блокировка суммы: попытку экспертизы оператор отклонил, остальное агент сделал верно — 70.
  const last = results.rows[6];
  assert.match(last[2], /Не пройден/);
  assert.equal(last[3], plain(70));
});

test('«Прогон», блок «Балл прогона» на изменённом ответе стенда: неполная оценка, ответ не оценён, баллы повторений, красная зона', async () => {
  const block = async (score: Record<string, unknown>) => kpis(await runPage({ ...demo.check, score: { ...demo.check.score, ...score } }), 'Балл прогона');
  const decomposition = 'пройдено 0 из 4 · действия 56 % · ответ 54 %';
  // Из 4 кейсов 3 пройдены, один завершился техническим сбоем: пунктирная линия, текст в подписи, зелёного нет.
  const partial = { value: 100, zone: null, evaluated: 3, total: 4, passed: 3, actions: 100, answer: 100 };
  assert.equal(await block(partial), scoreTile('kpi dim', big(100), 'пройдено 3 из 3 · действия 100 % · ответ 100 % · оценено 3 из 4 кейсов'));
  assert.equal(await block({ ...partial, zone: 'high' }), await block(partial), 'балл по части корзины не красится, что бы ни пришло в ответе');
  // У двух не пройденных кейсов вызов судьи завершился сбоем.
  assert.equal(await block({ noAnswer: 2 }), scoreTile('kpi', big(44), decomposition, 'у 2 кейсов ответ не оценён: балл по действиям'));
  assert.match(await block({ noAnswer: 1 }), /<span class="cap">у 1 кейса ответ не оценён: балл по действиям<\/span>/);
  // Три линии, во всех оценены все кейсы: баллы повторений в порядке линий.
  const lines = (values: (number | null)[]) => values.map((value, k) => ({ line: k + 1, value, evaluated: value === null ? 0 : 4, total: 4 }));
  assert.equal(await block({ evaluated: 12, total: 12, lines: lines([41, 47, 44]) }), scoreTile('kpi', big(44), 'пройдено 0 из 12 · действия 56 % · ответ 54 %', 'по повторениям: 41 · 47 · 44'));
  // Первая из трёх линий упала до первого кейса: у неё прочерк, балл прогона — по неполной оценке.
  assert.equal(
    await block({ value: 55, evaluated: 8, total: 12, lines: lines([null, 50, 60]) }),
    scoreTile('kpi dim', big(55), 'пройдено 0 из 8 · действия 56 % · ответ 54 % · оценено 8 из 12 кейсов', 'по повторениям: — · 50 · 60'),
  );
  // Красная зона и части, которой нет ни у одного кейса.
  assert.equal(await block({ value: 28, zone: 'low', answer: null }), scoreTile('kpi', big(28, ' down'), 'пройдено 0 из 4 · действия 56 %'));
  // Запись прогона без поля score — ответ стенда прежней версии: страница открывается без блока.
  const old = { ...demo.check };
  delete old.score;
  const page = await runPage(old);
  assert.doesNotMatch(page, /aria-label="Балл прогона"/);
  assert.deepEqual(
    table(page, 'Итог').rows.map((r) => r[3]),
    [DASH, DASH, DASH, DASH],
  );
});

test('«Сравнение», проверка до и после обучения в демо: плитка «Балл на общих кейсах» после «Успеха на общих кейсах», колонка «Балл» по кейсам', async () => {
  const [a, b] = [demo.check.id, demo.trained.id];
  const page = await comparePage(demo.runs, a, b, demo.compare);
  const block = kpis(page, 'Метрики A и B');
  assert.deepEqual(tileTitles(block).slice(0, 4), ['M1 · Финальное действие', 'M2 · Качество внутри сценария', 'Успех на общих кейсах', 'Балл на общих кейсах'], 'плитки ΔM1 и ΔM2 — первые');
  assert.equal(tile(block, 'Балл на общих кейсах'), '<div class="kpi"><span class="k">Балл на общих кейсах</span><span class="v">44 <span class="ar">→</span> 100</span><span class="delta up">+56</span></div>');
  const cases = table(page, 'Изменение');
  assert.deepEqual(cases.head, ['№', 'Кейс', `#${a}`, `#${b}`, 'Изменение', 'Балл', 'case_score', 'Что видно в журнале']);
  const cell = (from: number | string, to: number | string, delta = '') => `${from} <span class="t3">→</span> ${to}${delta}`;
  const up = (d: number) => ` <span class="delta up" style="display: inline">+${d}</span>`;
  assert.deepEqual(
    cases.rows.map((r) => r[5]),
    [cell(53, 100, up(47)), cell(47, 100, up(53)), cell(53, 100, up(47)), cell(23, 100, up(77))],
  );
  assert.doesNotMatch(page, /class="score/, 'баллы сравнения по зонам не красятся: смысл несёт знак разницы');

  // Изменённый ответ стенда. Позиция 4: кейс не пройден в обоих прогонах, балл вырос с 23 до 67 — «без изменений» и разница +44.
  // Позиция 3: балл снизился; позиция 2: балл тот же — разницы нет; позиция 1 не сравнивается — баллы видны, разницы нет.
  const patch: Record<number, Record<string, unknown>> = { 0: { change: 'na', scoreA: null }, 1: { scoreB: 47 }, 2: { scoreB: 40 }, 3: { change: 'same', scoreB: 67 } };
  const changed = { ...demo.compare, common: { ...demo.compare.common, scoreA: 41, scoreB: 41 }, cases: demo.compare.cases.map((c: any, k: number) => ({ ...c, ...patch[k] })) };
  const other = await comparePage(demo.runs, a, b, changed);
  const rows = table(other, 'Изменение').rows;
  assert.match(rows[3][4], /<span class="pill">Без изменений<\/span>/, 'признак изменения — по итогу кейса, а не по баллу');
  assert.deepEqual(
    rows.map((r) => r[5]),
    [cell('—', 100), cell(47, 47), cell(53, 40, ' <span class="delta down" style="display: inline">−13</span>'), cell(23, 67, up(44))],
  );
  assert.equal(tile(kpis(other, 'Метрики A и B'), 'Балл на общих кейсах'), '<div class="kpi"><span class="k">Балл на общих кейсах</span><span class="v">41 <span class="ar">→</span> 41</span><span class="delta same">без изменений</span></div>');
});

/** Справочники с проверяющей корзиной из двух кейсов без повтора на месте: сбой /reset остаётся техническим итогом. */
function config(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-web-score-'));
  fs.cpSync(CONFIG, dir, { recursive: true });
  const w = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
  w('baskets/web-check.yaml', ['id: web-check', 'title: web-check', 'type: checking', 'checking:', '  confirmations: approve', 'items:', '  - solution: spasibo-bonus-missing/facts-only', '  - solution: card-hold-amount/facts-only', ''].join('\n'));
  w('runs/web-check.yaml', 'id: web-check\ntitle: web-check\nbasket: web-check\nagent: fake-agent\nmodels: { operator: fake-operator, judge: fake-judge }\nretries: 0\n');
  return dir;
}

test('прогон с техническими сбоями: нет оценённых кейсов — «нет данных» с причиной и прочерки; после перезапуска позиции — пунктир без красного', async () => {
  const dir = config();
  // Первые два /reset падают: оба кейса первого прогона — технический сбой; второй прогон проходит без сбоев.
  const t = await startStand({ CLAWGYM_CONFIG: dir, FAKE_AGENT_FAIL_ON: '^/reset$', FAKE_AGENT_FAIL_TIMES: '2' });
  try {
    const start = async () => (await t.waitRun((await t.api('POST', '/api/runs', { config: 'web-check' })).data.id)).id;
    const detail = async (id: number) => (await t.api('GET', `/api/runs/${id}`)).data;
    const broken = await start();
    const clean = await start();

    // Все кейсы — технический сбой: балла нет, а не ноль.
    let run = await detail(broken);
    assert.deepEqual(run.lines[0].items.map((i: any) => i.outcome), ['technical', 'technical']);
    let page = await runPage(run);
    assert.equal(kpis(page, 'Балл прогона'), '<div class="kpi dim"><span class="k">Балл прогона</span><span class="v na">нет данных</span><span class="cap">нет оценённых кейсов</span></div>');
    assert.deepEqual(
      table(page, 'Итог').rows.map((r) => r[3]),
      [DASH, DASH],
      'у кейса с техническим сбоем в колонке «Балл» — прочерк',
    );

    // Ни одна позиция не оценена в обоих прогонах: балла сравнения нет.
    const runs = (await t.api('GET', '/api/runs')).data;
    const compare = async () => (await t.api('GET', `/api/compare?a=${broken}&b=${clean}`)).data;
    let cmp = await comparePage(runs, broken, clean, await compare());
    assert.equal(
      tile(kpis(cmp, 'Метрики A и B'), 'Балл на общих кейсах'),
      '<div class="kpi dim"><span class="k">Балл на общих кейсах</span><span class="v na">нет данных</span><span class="cap">нет кейсов, оценённых в обоих прогонах</span></div>',
    );
    const arrow = '<span class="t3">→</span>';
    assert.deepEqual(
      table(cmp, 'Изменение').rows.map((r) => r[5]),
      [`— ${arrow} 53`, `— ${arrow} 23`],
      'позиции не сравниваются: балл есть только у прогона, где кейс оценён, разницы нет',
    );

    // Вторая позиция перезапущена и оценена на 23, первая осталась техническим сбоем: балл по неполной оценке — без красного.
    assert.equal((await t.api('POST', `/api/runs/${broken}/rerun`, { items: ['L1-P02'] })).status, 200);
    await t.waitRun(broken);
    run = await detail(broken);
    assert.deepEqual([run.score.value, run.score.zone, run.score.evaluated, run.score.total], [23, null, 1, 2]);
    page = await runPage(run);
    assert.equal(kpis(page, 'Балл прогона'), scoreTile('kpi dim', big(23), 'пройдено 0 из 1 · действия 25 % · ответ 33 % · оценено 1 из 2 кейсов'));
    assert.deepEqual(
      table(page, 'Итог').rows.map((r) => r[3]),
      [DASH, plain(23)],
    );
    assert.ok(page.indexOf('id="dorun-h"') < page.indexOf('aria-label="Балл прогона"'), 'блок «Балл прогона» — между блоком дозапуска и плитками метрик');
    // Теперь общая позиция одна — вторая: балл сравнения — по ней.
    cmp = await comparePage((await t.api('GET', '/api/runs')).data, broken, clean, await compare());
    assert.equal(tile(kpis(cmp, 'Метрики A и B'), 'Балл на общих кейсах'), '<div class="kpi"><span class="k">Балл на общих кейсах</span><span class="v">23 <span class="ar">→</span> 23</span><span class="delta same">без изменений</span></div>');
  } finally {
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
