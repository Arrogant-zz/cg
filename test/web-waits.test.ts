// Ожидания в интерфейсе (web/js/lib.js): время по часам стенда, «прошло из срока» и «осталось», строка ожидания, карточки вызова и обмена.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Модули интерфейса без DOM на верхнем уровне — загружаются как есть, без сборки.
const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);
const lib = await web('lib.js');

const t0 = '2026-10-28T10:00:00.000Z';
const at = Date.parse(t0);
const plus = (ms: number) => new Date(at + ms).toISOString();

test('часы стенда: смещение по заголовку Date учитывается от 2 с, погрешность заголовка — нет', () => {
  assert.equal(lib.clockSkew(new Date(at + 120_000).toUTCString(), at), 120_000);
  assert.equal(lib.clockSkew(null, at), null);
  assert.equal(lib.nextSkew(0, 120_000), 120_000, 'часы рабочего места отстают на 2 минуты');
  assert.equal(lib.nextSkew(0, 1000), 0, 'секунда — погрешность заголовка');
  assert.equal(lib.nextSkew(120_000, 121_000), 120_000, 'время не прыгает от погрешности');
  assert.equal(lib.nextSkew(120_000, null), 120_000, 'без заголовка смещение прежнее');
});

test('время ожидания: машина — «прошло из срока», без срока — прошедшее, после срока — не больше срока; человек — «осталось»', () => {
  const w = { startedAt: t0, deadline: plus(900_000), remaining: false };
  assert.equal(lib.waitClock(w, at + 72_000), '1:12 из 15:00');
  assert.equal(lib.waitClock({ ...w, deadline: null }, at + 9_000), '0:09');
  assert.equal(lib.waitClock(w, at + 901_000), '15:00 из 15:00');
  const human = { startedAt: t0, deadline: plus(600_000), remaining: true };
  assert.equal(lib.waitClock(human, at + 37_000), 'осталось 9:23');
  // Тикер обновляет время по атрибутам: начало, срок и признак остатка.
  assert.match(String(lib.waitTime(w)), new RegExp(`data-wait="${t0}" data-until="${plus(900_000)}"`));
  assert.match(String(lib.waitTime(human)), / data-left>/);
  assert.doesNotMatch(String(lib.waitTime({ ...w, deadline: null })), /data-until|data-left/);
  // Карточка вызова: у обратного отсчёта подпись «осталось».
  const card = String(lib.toolCard({ seq: 4, tool: 'hold_amount', args: {}, awaiting: 'confirmation', deadline: plus(600_000), outcome: 'pending', requiresConfirmation: true, confirmation: { decision: 'pending' } }));
  assert.match(card, /осталось <span class="mono" data-deadline=/);
});

const turn = { scope: 'turn', who: 'agent', text: 'Ход агента', detail: 'Pagurus отвечает на вашу реплику', startedAt: t0, deadline: plus(900_000), remaining: false, hidden: false, blocked: null, callId: null, httpId: 'h1' };
const announced = (html: string) => /data-announce="([^"]*)"/.exec(html)?.[1] ?? null;

test('строка ожидания: кто держит ход, время из срока, на чём ход стоит; диктору — текст без времени', () => {
  const agent = String(lib.waitRow(turn, { http: true }));
  assert.match(agent, /^<div class="wait-row" /);
  assert.match(agent, /<span class="dot live"><\/span><span class="m5">Ход агента<\/span><span class="num" data-wait=/);
  assert.match(agent, /<span class="t2">Pagurus отвечает на вашу реплику<\/span>/);
  assert.match(agent, /data-http="h1"/, 'ссылка на висящий обмен');
  assert.equal(announced(agent), 'Ход агента — Pagurus отвечает на вашу реплику');
  const human = String(lib.waitRow({ ...turn, detail: 'стоит: create_appeal ждёт вашего ответа', blocked: 'human' }));
  assert.match(human, /^<div class="wait-row you" /, 'ждут вас — пояснение заметнее');
  const llm = String(lib.waitRow({ ...turn, who: 'llm', text: 'LLM-оператор решает, что ответить', detail: 'повтор 1', deadline: plus(570_000), hidden: true }));
  assert.match(llm, /скрыто от агента/);
  const command = String(lib.waitRow({ ...turn, who: 'command', text: '/reset', detail: null, deadline: plus(120_000) }));
  assert.equal(announced(command), '/reset');
  for (const h of [agent, human, llm, command]) assert.doesNotMatch(announced(h)!, /\d:\d\d/, 'секунды диктор не читает');
  // Шапка: ждут вас — с остатком.
  const head = String(lib.waitBadge({ ...turn, scope: 'call', who: 'human', text: 'Ждёт вашего решения', detail: 'hold_amount', deadline: plus(600_000), remaining: true }));
  assert.match(head, /Ждёт вашего решения: hold_amount<span class="t2" style="font-weight: 400"><span class="num" data-wait=[^>]* data-left>/);
  assert.equal(lib.headWait([turn, { ...turn, scope: 'call', who: 'human' }]).who, 'human');
  assert.equal(lib.headWait([turn]), turn);
  assert.equal(lib.headWait([]), null);
});

test('лента: строка ожидания — последней в полном журнале; в виде «что видел агент» её нет; решение по вызову — в карточке, один таймер', () => {
  const events = [
    { type: 'start_message', seq: 1, text: 'Старт' },
    { type: 'tool_call', seq: 2, callId: 'c1', tool: 'hold_amount', args: {}, awaiting: 'confirmation', deadline: plus(570_000), outcome: 'pending', requiresConfirmation: true, confirmation: { decision: 'pending' } },
  ];
  const decision = { scope: 'call', who: 'llm', text: 'решает LLM-оператор', detail: null, startedAt: plus(5_000), deadline: plus(575_000), remaining: false, hidden: true, blocked: null, callId: 'c1', httpId: 'h2' };
  const blocked = { ...turn, detail: 'стоит: hold_amount ждёт решения LLM-оператора', blocked: 'llm' };
  const full = String(lib.feed(events, { full: true, waits: [blocked, decision] }));
  assert.ok(full.lastIndexOf('class="wait-row') > full.lastIndexOf('id="ev-'), 'строка — после всех событий');
  assert.match(full, /<span class="dot live"><\/span>решает LLM-оператор <span class="num" data-wait="[^"]+">/, 'в карточке — время решения без срока');
  assert.equal(full.split(`data-wait="${decision.startedAt}"`).length - 1, 1, 'время решения — только в карточке');
  assert.match(full, /стоит: hold_amount ждёт решения LLM-оператора/);
  const agentView = String(lib.feed(events, { full: false, waits: [blocked, decision] }));
  assert.doesNotMatch(agentView, /wait-row|решает LLM-оператор/);
  assert.doesNotMatch(String(lib.feed(events, { full: true })), /wait-row/, 'без ожиданий строки нет');
});

test('обмен без ответа: пока выполнение идёт — «ждёт ответа» со временем из срока; иначе пунктир с причиной; старая запись — без «из»', () => {
  const x = { id: 'x1', kind: 'agent', label: 'Реплика человека', startedAt: t0, finishedAt: null, durationMs: null, deadline: plus(900_000), request: { method: 'POST', url: '/a2a', headers: {}, body: '{}', bytes: 2, truncated: false }, response: null, error: null };
  const live = String(lib.exchangeCard(x, { live: true }));
  assert.match(live, /<span class="pill live">.*ждёт ответа <span class="num" data-wait="[^"]+" data-until="[^"]+">/);
  assert.match(live, /Ещё не получен: соединение удерживается/);
  const lost = String(lib.exchangeCard(x));
  assert.match(lost, /<span class="pill na">ответ не получен: стенд перезапущен до ответа<\/span>/);
  assert.doesNotMatch(lost, /data-wait|ждёт ответа/, 'время не идёт');
  const old = String(lib.exchangeCard({ ...x, deadline: undefined }, { live: true }));
  assert.match(old, /ждёт ответа <span class="num" data-wait="[^"]+">/, 'обмен без срока — время без «из»');
  // Ответ получен: длительность как раньше; список передаёт признак «идёт» каждой карточке.
  const done = String(lib.exchangeCard({ ...x, finishedAt: plus(41_000), durationMs: 41_000, response: { status: 200, headers: {}, body: '{}', bytes: 2, truncated: false } }));
  assert.match(done, /HTTP 200<\/span><span class="cap num">41 с<\/span>/);
  assert.match(String(lib.exchangesView([x], { live: true })), /ждёт ответа/);
  assert.match(String(lib.exchangesView([x])), /ответ не получен/);
});
