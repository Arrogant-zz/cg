// Свободный текст в интерфейсе — заметка LLM-оператора, сообщение об ошибке, вывод сравнения — не стоит в неразрывной
// метке или пилюле: текст длиннее блока уходил бы за край листа. Блоки ленты — web/js/lib.js, страницы — web/js/pages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Модули интерфейса без DOM на верхнем уровне — загружаются как есть, без сборки; ответы API подменяются через fetch.
const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);
const lib = await web('lib.js');

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const FREE = `свободный текст ${'очень длинный '.repeat(30)}конец`;
const VOID = new Set(['br', 'hr', 'img', 'input']);

/** Классы ближайшего элемента вокруг каждого вхождения текста в содержимом разметки; в атрибутах текст не ищется. */
function holders(markup: string, text: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"]|"[^"]*")*)>|[^<]+/g;
  for (let m = token.exec(markup); m; m = token.exec(markup)) {
    if (m[2] === undefined) {
      if (m[0].includes(text)) out.push(open[open.length - 1] ?? '');
    } else if (m[1]) open.pop();
    else if (!VOID.has(m[2].toLowerCase()) && !m[3].endsWith('/')) open.push(/\sclass="([^"]*)"/.exec(m[3])?.[1] ?? '');
  }
  assert.equal(open.length, 0, 'теги разметки закрыты');
  return out;
}

/** Метка урока или пилюля без класса note: текст в ней не переносится. */
const nowrapChip = (cls: string) => /(^| )(pill|lesson)( |$)/.test(cls) && !/(^| )note( |$)/.test(cls);

/** Текст показан столько раз и ни разу — в неразрывной метке или пилюле. */
function assertFree(where: string, markup: string, times: number): void {
  const found = holders(markup, FREE);
  assert.equal(found.length, times, `${where}: сколько раз показан текст`);
  for (const cls of found) assert.ok(!nowrapChip(cls), `${where}: свободный текст в неразрывной метке или пилюле «${cls}»`);
}

test('проверка отличает неразрывную пилюлю и метку урока от пилюли со свободным текстом', () => {
  assert.deepEqual(holders(`<div class="hid"><span class="pill tech"><svg class="ic"><path d="M1 1"/></svg>${FREE}</span></div>`, FREE), ['pill tech']);
  assert.deepEqual(holders(`<span class="lesson" title="${FREE}">поправка</span>`, FREE), [], 'текст в атрибуте не считается');
  assert.ok(nowrapChip('pill tech') && nowrapChip('lesson') && nowrapChip('pill na'));
  assert.ok(!nowrapChip('pill tech note') && !nowrapChip('cap') && !nowrapChip(''));
});

test('лента: заметка урока, обоснование и ошибки — обычным текстом или в пилюле note, а не в неразрывной метке', () => {
  const marks = { correction: true, lessonId: null, lessonNote: FREE, explanation: false, approval: false, finish: false };
  const reply = String(lib.messageView({ seq: 9, type: 'operator_message', text: 'Исправьте дату', marks }));
  assertFree('метка под репликой', reply, 0);
  assert.match(reply, /<span class="lesson" title="свободный текст [^"]*">поправка · урок вне каталога<\/span>/, 'заметка под репликой — только в подсказке метки');

  const decision = (extra: Record<string, unknown>) => String(lib.decisionBlock({ seq: 7, type: 'operator_decision', hidden: true, event: 'turn_end', model: 'fake-operator', durationMs: 1, usage: null, attempts: [], ...extra }));
  const made = { reply: 'Исправьте дату', confirmation: null, correction: true, lessonId: null, lessonNote: null, finish: false, reason: 'обоснование' };
  assertFree('заметка в решении', decision({ decision: { ...made, lessonNote: FREE } }), 1);
  assertFree('обоснование решения', decision({ decision: { ...made, reason: FREE } }), 1);

  const failed = decision({ error: FREE, attempts: [{ n: 1, ok: false, kind: 'llm', error: 'Модель не ответила за 30 с' }] });
  assertFree('ошибка решения', failed, 1);
  assert.match(failed, /<span class="pill tech note" style="align-self: flex-start">свободный текст /);

  // Ошибка обмена показана дважды: пилюлей в заголовке карточки и текстом на месте ответа.
  const request = { method: 'POST', url: '/chat/completions', headers: {}, body: '{}', bytes: 2, truncated: false };
  const exchange = String(lib.exchangeCard({ id: 'x1', kind: 'llm', label: 'LLM-оператор · конец хода', startedAt: '2026-11-11T10:00:00.000Z', finishedAt: '2026-11-11T10:00:31.000Z', durationMs: 31_000, request, response: null, error: FREE }));
  assertFree('ошибка HTTP-обмена', exchange, 2);
  assert.match(exchange, /<span class="pill tech note"><svg/);

  assertFree('сбой служебной команды', String(lib.commandLine({ seq: 3, name: 'reset', status: 'failed', error: FREE, durationMs: 10, parsed: null })), 1);
  assertFree('запись стенда', String(lib.feed([{ seq: 4, type: 'note', text: FREE }], { full: true })), 1);
});

/** Страница с ответами API по адресу; адрес без ответа получает 404, как у стенда. */
async function page(file: string, data: Record<string, unknown>, params: string[] = []): Promise<string> {
  globalThis.fetch = (async (input: unknown) => {
    const p = String(input);
    return p in data ? new Response(JSON.stringify(data[p]), { status: 200 }) : new Response(JSON.stringify({ error: 'Не найдено' }), { status: 404 });
  }) as typeof fetch;
  return String(await (await web(`pages/${file}`)).render({ params, state: {}, query: new URLSearchParams() }));
}

const T = '2026-11-11T10:00:00.000Z';
// Балл прогона — как его отдаёт стенд: у прогона с одним пройденным кейсом и у прогона без оценённых кейсов.
const SCORED = { value: 100, zone: 'high', evaluated: 1, total: 1, passed: 1, actions: 100, answer: 100, noAnswer: 0, reason: '' };
const NO_SCORE = { value: null, zone: null, evaluated: 0, total: 0, passed: 0, actions: null, answer: null, noAnswer: 0, reason: 'нет оценённых кейсов' };
const checkRun = (id: number, configId: string) => ({ id, title: 'Проверка', configFile: `runs/${configId}.yaml`, configId, type: 'checking', testOperator: `новый · cg-${id}-1`, status: 'completed', success: { evaluated: 1, passed: 1 }, score: SCORED, corrections: null, bars: [['ok']], tech: 0, notEvaluated: 0, finishedAt: T });

test('«Прогоны»: сообщение о сбое стенда у завершённого прогона — в пилюле note', async () => {
  const failed = { ...checkRun(12, 'check'), status: 'failed', error: FREE, success: { evaluated: 0, passed: 0 }, score: NO_SCORE, bars: [[]] };
  const runs = await page('runs.js', { '/api/runs': { runs: [failed, checkRun(11, 'check')], manual: [] }, '/api/status': { stand: [] }, '/api/mcp/traffic?unbound=1': [] });
  assertFree('сбой стенда', runs, 1);
  assert.match(runs, /<span class="pill tech note"><svg/);
  assert.match(runs, /<span class="pill na">нет оценённых<\/span>/, 'подпись из фиксированного набора остаётся неразрывной');
});

test('«Прогон»: ошибка прохода curator — в пилюле note', async () => {
  const pass = { pass: 1, reason: 'count', afterPos: 3, status: 'failed', error: FREE, durationMs: 900_000, startedAt: T, http: [], parsed: null, reply: null };
  const run = {
    ...checkRun(12, 'train'),
    type: 'training',
    startedAt: T,
    error: null,
    testOperatorLabel: 'новый · cg-12-1',
    settings: { agent: { id: 'fake-agent', title: 'fake-agent', model: null }, operator: { id: 'op' }, judge: { id: 'judge' }, basket: { id: 'train', items: 3, hash: 'abc' }, prompts: { operator: 'operator-v3', judge: 'judge-v1' }, metrics: [], limits: {}, contract: { version: '1', hash: 'abc' } },
    snapshot: { createdAt: T, files: [], settings: [] },
    plan: [],
    summary: [],
    lines: [{ index: 1, status: 'completed', senderId: 'cg-12-1', error: null, items: [], curatorPasses: [pass], current: null }],
  };
  const result = await page('run.js', { '/api/runs/12': run, '/api/run-configs': [] }, ['12']);
  assertFree('ошибка прохода curator', result, 1);
  assert.match(result, /<span class="pill tech note"><svg/);
});

test('«Сравнение»: вывод о сопоставимости условий — в пилюле note', async () => {
  const side = (id: number) => ({ id, type: 'checking', testOperator: 'новый' });
  const compare = { a: side(10), b: side(11), comparable: false, conclusion: FREE, rows: [], limitations: [], metrics: [], common: { passA: 0, passB: 0, n: 0 }, counts: { better: 0, worse: 0, same: 0, incomparable: 0 }, cases: [] };
  const data = { '/api/runs': { runs: [checkRun(11, 'after'), checkRun(10, 'before')], manual: [] }, '/api/compare?a=10&b=11': compare };
  const differ = await page('compare.js', data);
  assertFree('вывод сравнения', differ, 1);
  assert.match(differ, /<span class="pill na note">свободный текст /);
  const same = await page('compare.js', { ...data, '/api/compare?a=10&b=11': { ...compare, comparable: true } });
  assertFree('вывод сравнения, условия совпадают', same, 1);
  assert.match(same, /<span class="pill pass note"><svg/);
});

test('«Справочники»: доступность агента и причина неготовности модели — в пилюле note', async () => {
  const agent = (id: string, health: { ok: boolean | null; note: string }) => ({
    id,
    file: `agents/${id}.yaml`,
    title: `Агент ${id}`,
    health,
    contractConditional: true,
    issues: [],
    request: { method: 'POST', url: '/a2a', missing: [], urlResolved: 'http://127.0.0.1:8080/a2a', headers: [], body: 'templates/a2a.json', textPath: '$.text', taskIdHeader: 'x-task-id', taskIdScope: 'execution', senderIdHeader: 'x-a2a-sender-id' },
    response: { mode: 'sync', sample: null, replyPath: '$.reply', statusPath: null, errorPath: null, usage: { inputPath: null, outputPath: null, totalPath: null } },
    mcp: { contract: 'contracts/tools.json', taskIdHeader: 'x-task-id', protocols: ['2025-06-18'] },
    commands: { reset: '/reset', capture: '/case-capture', curator: '/skill-curator' },
    model: null,
    build: null,
    learningKit: null,
    sessions: { max: 1 },
  });
  const model = (id: string, readiness: string | null) => ({ id, title: id, roles: ['operator'], provider: 'gigachat', model: 'GigaChat-2-Max', params: {}, endpoint: null, auth: null, description: null, readiness });
  const directory = { agents: [agent('down', { ok: false, note: FREE }), agent('unchecked', { ok: null, note: FREE })], models: [model('not-ready', FREE), model('ready', null)], metrics: [], tools: [], contract: null };
  const shown = await page('directory.js', { '/api/directory': directory });
  assertFree('доступность агента и готовность модели', shown, 3);
  assert.match(shown, /<span class="pill tech note"><svg/, 'агент недоступен');
  assert.equal(shown.split('<span class="pill na note">свободный текст ').length - 1, 2, 'доступность не проверялась и модель не готова');
  assert.match(shown, /<span class="pill na">Сверка с кодом оркестратора — ожидает<\/span>/, 'подпись из фиксированного набора остаётся неразрывной');
});
