// Страница прогона и разбор кейса: дозапуск и попытки позиции (решение владельца от 12 ноября 2026 года).
// Ответы API — настоящие, с офлайн-стенда: модули интерфейса отрисовывают их без сборки, fetch подменяется только на время
// отрисовки. Недоступная кнопка дозапуска видна неактивной с причиной; у позиции с повтором — пометка «попытка N»,
// в разборе кейса — переключатель попыток, технический итог прежней попытки — фиолетовый.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG, startStand, until, type Stand } from './helpers.js';

const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);

/** Страница на записанных ответах API; адрес без ответа — 404, как у стенда. */
async function render(page: string, params: string[], data: Record<string, unknown>): Promise<string> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const p = String(input);
    return p in data ? new Response(JSON.stringify(data[p]), { status: 200 }) : new Response(JSON.stringify({ error: 'Не найдено' }), { status: 404 });
  }) as typeof fetch;
  try {
    return String(await (await web(page)).render({ params, state: {}, query: new URLSearchParams(), navigate: () => undefined, rerender: () => undefined }));
  } finally {
    globalThis.fetch = real;
  }
}

/** Страница прогона: запись прогона и настройки прогонов — как их отдаёт стенд сейчас. */
async function runPage(s: Stand, id: number): Promise<string> {
  const run = (await s.api('GET', `/api/runs/${id}`)).data;
  const configs = (await s.api('GET', '/api/run-configs')).data;
  return render('pages/run.js', [String(id)], { [`/api/runs/${id}`]: run, '/api/run-configs': configs });
}

async function casePage(s: Stand, id: number, name: string): Promise<string> {
  const ex = (await s.api('GET', `/api/runs/${id}/executions/${name}`)).data;
  const run = (await s.api('GET', `/api/runs/${id}`)).data;
  return render('pages/exec.js', [String(id), name], { [`/api/runs/${id}/executions/${name}`]: ex, [`/api/runs/${id}`]: run });
}

/** Кнопка дозапуска по действию: её разметка целиком. */
const button = (html: string, action: string): string => html.match(new RegExp(`<button class="btn" type="button" data-action="${action}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? '';

function config(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-web-rerun-'));
  fs.cpSync(CONFIG, dir, { recursive: true });
  const w = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
  w('baskets/web-check.yaml', ['id: web-check', 'title: web-check', 'type: checking', 'checking:', '  confirmations: approve', 'items:', '  - solution: spasibo-bonus-missing/facts-only', '  - solution: card-hold-amount/facts-only', ''].join('\n'));
  w('baskets/web-train.yaml', ['id: web-train', 'title: web-train', 'type: training', 'curator:', '  every: 2', '  final: true', 'items:', '  - solution: spasibo-bonus-missing/explain-now', '  - solution: card-operation-dispute/explain-now', '  - solution: spasibo-bonus-missing/explain-on-ask', ''].join('\n'));
  w('runs/web-check.yaml', 'id: web-check\ntitle: web-check\nbasket: web-check\nagent: fake-agent\nmodels: { operator: fake-operator, judge: fake-judge }\nretries: 0\n');
  w('runs/web-train.yaml', 'id: web-train\ntitle: web-train\nbasket: web-train\nagent: fake-agent\nmodels: { operator: fake-operator, judge: fake-judge }\n');
  return dir;
}

test('«Прогон»: перезапуск сбоев проверки — кнопка с числом позиций, пометка «попытка N»; разбор — переключатель попыток', async () => {
  const dir = config();
  const s = await startStand({ CLAWGYM_CONFIG: dir, FAKE_AGENT_FAIL_ON: '^/reset$', FAKE_AGENT_FAIL_TIMES: '2' });
  try {
    const id = (await s.api('POST', '/api/runs', { config: 'web-check' })).data.id;
    await s.waitRun(id);
    let page = await runPage(s, id);
    assert.match(page, /<h2 class="h3" id="dorun-h">Дозапуск<\/h2>/);
    const rerun = button(page, 'rerun');
    assert.match(rerun, /Перезапустить сбои · 2/);
    assert.doesNotMatch(rerun, /disabled/, 'кнопка доступна');
    assert.match(page, /L1-P01, L1-P02/);
    assert.match(page, /Сборку агента и версию модели ClawGym не видит/);
    assert.doesNotMatch(page, /data-action="resume"|data-action="reevaluate"/, 'продолжения и переоценки у проверки без упавших оценок нет');

    await s.api('POST', `/api/runs/${id}/rerun`, { items: ['L1-P02'] });
    await s.waitRun(id);
    page = await runPage(s, id);
    assert.match(page, /попытка 2 · до неё: Сбой \/reset/, 'пометка у позиции с повтором');
    assert.match(button(page, 'rerun'), /Перезапустить сбои · 1/);

    const last = await casePage(s, id, 'L1-P02-2');
    assert.match(last, /aria-label="Попытки позиции"/);
    assert.match(last, /data-name="L1-P02" aria-pressed="false">1<span class="pill tech">/, 'прежняя попытка — фиолетовым техническим итогом');
    assert.match(last, /data-name="L1-P02-2" aria-pressed="true">2 · итоговая/);
    const prev = await casePage(s, id, 'L1-P02');
    assert.match(prev, /Это попытка 1: её заменила повторная попытка, итог позиции — по итоговой\./);
    assert.match(prev, /<a class="btn ghost" href="\/runs\/\d+\/cases\/L1-P01">Позиция 1<\/a>/, 'соседние позиции считаются от позиции прежней попытки');
    assert.doesNotMatch(await casePage(s, id, 'L1-P01'), /Попытки позиции/, 'у позиции с одной попыткой переключателя нет');

    // Оператор занят ручной сессией: кнопка видна неактивной с причиной.
    const sender = (await s.api('GET', `/api/runs/${id}`)).data.lines[0].senderId;
    const session = await s.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent', sender: { mode: 'existing', id: sender } });
    assert.equal(session.status, 200, JSON.stringify(session.data));
    page = await runPage(s, id);
    assert.match(button(page, 'rerun'), /disabled aria-disabled="true"/);
    assert.match(page, /<li>Тестовый оператор занят ручной сессией m-\d+<\/li>/);
    await until(async () => !(await s.api('GET', `/api/manual/${session.data.id}`)).data.busy, 20000, 'ручная сессия свободна');
    await s.api('POST', `/api/manual/${session.data.id}/finish`, {});

    // Прогон без сбоев: блока дозапуска нет.
    const clean = (await s.api('POST', '/api/runs', { config: 'web-check' })).data.id;
    await s.waitRun(clean);
    assert.doesNotMatch(await runPage(s, clean), /id="dorun-h"/);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('«Прогон»: продолжение обучающей линии с позиции и переоценка упавшей оценки; разбор — повтор судьи и заменённый сбой', async () => {
  const dir = config();
  // Судья по критериям первой позиции падает и при повторе; агент медленно отвечает на стартовое сообщение — линию останавливают.
  fs.appendFileSync(path.join(dir, 'models/fake-judge.yaml'), "headers:\n  X-Fake-Fail: 'judge'\n  X-Fake-Fail-Times: '4'\n");
  const s = await startStand({ CLAWGYM_CONFIG: dir, FAKE_AGENT_SLOW_ON: 'Тематика', FAKE_AGENT_SLOW_MS: '600' });
  try {
    const id = (await s.api('POST', '/api/runs', { config: 'web-train' })).data.id;
    await until(async () => (await s.api('GET', `/api/runs/${id}`)).data.lines[0].items[1].status === 'running', 20000, 'вторая позиция');
    await s.api('POST', `/api/runs/${id}/stop`);
    await s.waitRun(id);
    let page = await runPage(s, id);
    assert.match(button(page, 'resume'), /Продолжить линию с позиции 2/);
    assert.match(button(page, 'resume'), /data-line="1"/);
    assert.match(page, /Остаток корзины — по порядку, с \/case-capture и проходами curator\./);
    assert.match(button(page, 'reevaluate'), /Переоценить · 1/);
    assert.doesNotMatch(page, /data-action="rerun"/, 'перезапуска позиций у обучения нет');

    await s.api('POST', `/api/runs/${id}/reevaluate`, {});
    await s.waitRun(id);
    page = await runPage(s, id);
    assert.match(page, /оценка — повтором судьи/);
    assert.match(page, /повторным вызовом судьи — 1/);
    const ex = (await s.api('GET', `/api/runs/${id}`)).data.lines[0].items[0].execName;
    const cp = await casePage(s, id, ex);
    assert.match(cp, /<span>Повтор судьи<\/span><span class="t2">переоценка после прогона · заменил сбой <a href="#ev-\d+">#\d+<\/a>/);
    assert.match(cp, /Сбой заменён повторным вызовом судьи — <a href="#ev-\d+">событие #\d+<\/a>/);
    assert.match(cp, /LLM-оценка ответа · fake-judge[^<]*· переоценка после прогона/);
    assert.match(cp, /Оценка получена повторным вызовом судьи после его сбоя\./);
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
