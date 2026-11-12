// Журнал выполнения в интерфейсе (web/js/lib.js): реплика к подтверждению и её судьба у решения оператора.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Модули интерфейса без DOM на верхнем уровне — загружаются как есть, без сборки.
const web = (file: string) => import(pathToFileURL(path.resolve('web/js', file)).href);
const lib = await web('lib.js');

const decision = (extra: Record<string, unknown> = {}) => ({
  seq: 7,
  type: 'operator_decision',
  hidden: true,
  event: 'confirmation',
  callId: 'call-1',
  decision: { confirmation: 'reject', reply: 'Сначала проверьте <каналы> уведомлений', correction: true, lessonId: 'L-1', reason: 'до смены канала нужна проверка' },
  model: 'fake-operator',
  durationMs: 1,
  usage: null,
  attempts: [],
  ...extra,
});

test('решение по подтверждению: текст реплики как есть и её судьба — пересмотрена решением #N, не отправлена или без подписи', () => {
  const reviewed = String(lib.decisionBlock(decision({ replyReviewed: 12 })));
  assert.match(reviewed, /Сначала проверьте &lt;каналы&gt; уведомлений/, 'текст реплики показан как есть и экранирован');
  assert.match(reviewed, /её пересмотрело решение <a class="ev" href="#ev-12" data-action="toEvent" data-seq="12">#12<\/a>/);
  assert.doesNotMatch(reviewed, /кейс завершён/);

  const dropped = String(lib.decisionBlock(decision({ replyDropped: true })));
  assert.match(dropped, /реплика не отправлена: кейс завершён/);
  assert.doesNotMatch(dropped, /пересмотрело/);

  const old = String(lib.decisionBlock(decision()));
  assert.match(old, /Сначала проверьте/);
  assert.doesNotMatch(old, /реплика не отправлена/, 'прежняя запись: реплика ушла склеенным сообщением, подписи у решения нет');

  const turnEnd = String(lib.decisionBlock(decision({ event: 'turn_end', decision: { reply: 'Продолжайте', finish: false } })));
  assert.doesNotMatch(turnEnd, /Продолжайте/, 'реплику решения на конец хода показывает сообщение оператора');
});

test('сообщение оператора из прежней записи: склеенная реплика к подтверждениям подписана, как раньше', () => {
  const queued = String(lib.messageView({ seq: 9, type: 'operator_message', text: 'Сначала проверьте каналы', queued: true }));
  assert.match(queued, /реплика к отклонению — после конца хода/);
  assert.doesNotMatch(String(lib.messageView({ seq: 10, type: 'operator_message', text: 'Продолжайте' })), /после конца хода/);
});

// Заметка урока вне каталога — свободный текст LLM-оператора: в метку урока он не попадает.
const NOTE = 'Перед закрытием нужен звонок клиенту: <проверить> "Face ID" и записать результат заметкой.';
const NOTE_HTML = 'Перед закрытием нужен звонок клиенту: &lt;проверить&gt; &quot;Face ID&quot; и записать результат заметкой.';
const marks = (extra: Record<string, unknown> = {}) => ({ correction: true, lessonId: null, lessonNote: null, explanation: false, approval: false, finish: false, ...extra });
const reply = (m: Record<string, unknown>, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => String(lib.messageView({ seq: 9, type: 'operator_message', text: 'Исправьте дату', marks: marks(m), ...extra }, opts));
/** Метка поправки под репликой: [1] — подсказка, [2] — содержимое. */
const mark = (h: string) => /<span class="lesson"(?: title="([^"]*)")?>([^<]*)<\/span>/.exec(h);

test('метка поправки под репликой: урок из каталога — идентификатор, вне каталога — короткая подпись и заметка в подсказке, без урока — «не указан»', () => {
  const noted = mark(reply({ lessonNote: NOTE }));
  assert.equal(noted?.[2], 'поправка · урок вне каталога', 'в метке короткая подпись, а не текст заметки');
  assert.equal(noted?.[1], NOTE_HTML, 'текст заметки — в подсказке метки, экранирован');

  const known = mark(reply({ lessonId: 'L-1' }));
  assert.equal(known?.[2], 'поправка · L-1');
  assert.equal(known?.[1], undefined, 'у урока из каталога подсказки нет');
  assert.equal(mark(reply({ lessonId: 'L-1', repeated: true }))?.[2], 'поправка · L-1 · повторная');
  assert.equal(mark(reply({ lessonId: 'L-1', lessonNote: NOTE }))?.[2], 'поправка · L-1', 'идентификатор урока важнее заметки');
  assert.equal(mark(reply({}))?.[2], 'поправка · урок не указан');

  // Ручная отметка: решения оператора у реплики нет, текст заметки доступен только в подсказке.
  const manual = reply({ lessonNote: NOTE, manual: true }, { type: 'human_message' });
  assert.equal(mark(manual)?.[2], 'поправка · урок вне каталога');
  assert.equal(mark(manual)?.[1], NOTE_HTML);
  assert.match(manual, /<span>ручная отметка<\/span>/);

  const agentView = reply({ lessonNote: NOTE }, {}, { full: false });
  assert.equal(mark(agentView), null, 'в виде «что видел агент» меток нет');
  assert.doesNotMatch(agentView, /Перед закрытием/);
});

test('решение оператора: заметка урока вне каталога — строкой с подписью перед обоснованием, а не меткой; урок из каталога — меткой', () => {
  const turnEnd = (d: Record<string, unknown>) => String(lib.decisionBlock(decision({ event: 'turn_end', decision: { reply: 'Исправьте дату', confirmation: null, correction: true, lessonId: null, lessonNote: null, finish: false, reason: 'обоснование решения', ...d } })));

  const noted = turnEnd({ lessonNote: NOTE });
  assert.ok(noted.includes(`<span><span class="m5">Урок вне каталога.</span> ${NOTE_HTML}</span>`), 'текст заметки целиком, с подписью, экранирован');
  assert.ok(noted.indexOf('Урок вне каталога.') < noted.indexOf('обоснование решения'), 'заметка стоит перед обоснованием');
  assert.doesNotMatch(noted, /урок вне каталога:/, 'метки с текстом заметки нет');
  assert.doesNotMatch(noted, /class="lesson"/);

  const known = turnEnd({ lessonId: 'L-1' });
  assert.match(known, /<span class="lesson">урок: L-1<\/span>/);
  assert.doesNotMatch(known, /Урок вне каталога/);

  const both = turnEnd({ lessonId: 'L-1', lessonNote: NOTE });
  assert.match(both, /<span class="lesson">урок: L-1<\/span>/);
  assert.doesNotMatch(both, /Урок вне каталога|Перед закрытием/, 'при известном уроке заметка не показывается');

  // Решение по подтверждению: заметка идёт после реплики к подтверждению.
  const conf = String(lib.decisionBlock(decision({ decision: { confirmation: 'reject', reply: 'Сначала проверьте каналы', correction: true, lessonId: null, lessonNote: NOTE, reason: 'обоснование решения' } })));
  assert.ok(conf.indexOf('Сначала проверьте каналы') < conf.indexOf('Урок вне каталога.'), 'заметка — после реплики к подтверждению');
  assert.ok(conf.indexOf('Урок вне каталога.') < conf.indexOf('обоснование решения'));
});

// ---------------------------------------------------------------- проверяющая корзина: напоминание стенда и реакция оператора

const REMINDER = 'Обращение ведёте вы: действуйте так, как считаете верным. Подсказывать я не буду. Если не хватает данных — спросите. Если считаете работу законченной — так и скажите.';

test('напоминание стенда в ленте: метка под сообщением оператора, без меток поправки и одобрения; ответ на вопрос о факте — без меток', () => {
  const reminder = { seq: 12, type: 'operator_message', text: REMINDER, reminder: true, decisionSeq: 11 };
  const shown = String(lib.messageView(reminder));
  assert.match(shown, /<div class="kvh" style="justify-content: flex-end"><span>напоминание стенда<\/span><\/div>/);
  assert.match(shown, /Обращение ведёте вы: действуйте так, как считаете верным\./);
  assert.doesNotMatch(shown, /поправка|одобрение результата|завершение: да|объяснение правила/);
  // Агент получает напоминание обычной репликой оператора: в виде «что видел агент» метки нет.
  const agentView = String(lib.messageView(reminder, { full: false }));
  assert.match(agentView, /Обращение ведёте вы/);
  assert.doesNotMatch(agentView, /напоминание стенда|class="kvh"/);

  const answer = String(lib.messageView({ seq: 14, type: 'operator_message', text: 'Покупка 12 октября.', decisionSeq: 13 }));
  assert.match(answer, /Покупка 12 октября\./);
  assert.doesNotMatch(answer, /class="kvh"/, 'у ответа на вопрос о факте меток нет');

  // Реплика прежнего вида показана, как раньше.
  const approved = reply({ correction: false, approval: true, finish: true });
  assert.match(approved, /<span>одобрение результата<\/span><span>завершение: да<\/span>/);
  assert.doesNotMatch(approved, /напоминание стенда/);
});

test('решение на конец хода в проверке: метка реакции и обоснование, без меток «поправка», «завершение» и «одобрение»; решение прежнего вида — как раньше', () => {
  const check = (reaction: string, text: string | null = null) => String(lib.decisionBlock(decision({ event: 'turn_end', callId: undefined, decision: { reaction, reply: text, reason: 'обоснование выбора' } })));
  const shown = { remind: check('remind'), answer: check('answer', 'Покупка 12 октября.'), done: check('done') };
  assert.match(shown.remind, /<div class="kvh"><span>реакция: напоминание<\/span><\/div>/);
  assert.match(shown.answer, /<div class="kvh"><span>реакция: ответ на вопрос<\/span><\/div>/);
  assert.match(shown.done, /<div class="kvh"><span>реакция: агент закончил<\/span><\/div>/);
  for (const h of Object.values(shown)) {
    assert.match(h, /Решение оператора · скрыто от агента/);
    assert.match(h, /<span>обоснование выбора<\/span>/);
    assert.doesNotMatch(h, /поправка|завершение|одобрение|подтверждение:/);
  }
  assert.doesNotMatch(shown.answer, /Покупка 12 октября/, 'текст ответа показывает сообщение оператора, а не решение');

  const before = String(lib.decisionBlock(decision({ event: 'turn_end', decision: { reply: 'Хорошо, можно закрывать обращение.', confirmation: null, correction: false, lessonId: null, lessonNote: null, explanation: false, approval: true, finish: true, reason: 'ответ соответствует эталону' } })));
  assert.match(before, /<div class="kvh"><span>поправка: нет<\/span><span>завершение: да<\/span><span>одобрение<\/span><\/div>/);
  assert.doesNotMatch(before, /реакция/);
});

test('реплика к подтверждению в проверке: «не отправлена: в проверке реплики к подтверждениям не уходят» вместо «кейс завершён»; текст реплики виден', () => {
  const dropped = String(lib.decisionBlock(decision({ replyDropped: true, replyDropReason: 'checking' })));
  assert.match(dropped, /<span>реплика не отправлена: в проверке реплики к подтверждениям не уходят<\/span>/);
  assert.doesNotMatch(dropped, /кейс завершён/);
  assert.match(dropped, /Сначала проверьте &lt;каналы&gt; уведомлений/);
  assert.match(String(lib.decisionBlock(decision({ replyDropped: true }))), /<span>реплика не отправлена: кейс завершён<\/span>/, 'без причины — прежняя подпись');
});

test('статус «Лимит напоминаний»: завершение по лимиту, как лимит ходов, а не технический сбой', () => {
  assert.equal(lib.STATUS_TITLES.limit_reminders, 'Лимит напоминаний');
  assert.ok(!lib.TECH.has('limit_reminders'));
  const status = (s: string, reason: string) => String(lib.feed([{ seq: 20, type: 'status', status: s, reason }]));
  const reminders = status('limit_reminders', 'Агент оставил без действий 2 напоминания подряд');
  assert.match(reminders, /кейс завершён<\/span><span>Агент оставил без действий 2 напоминания подряд · результат зафиксирован до служебных команд<\/span>/);
  assert.equal(reminders.replace('Агент оставил без действий 2 напоминания подряд', '…'), status('limit_turns', 'Достигнут лимит 20 ходов').replace('Достигнут лимит 20 ходов', '…'), 'та же строка, что у лимита ходов');
  assert.notEqual(reminders.replace('Агент оставил без действий 2 напоминания подряд', '…'), status('operator_timeout', '…'), 'технический сбой показан иначе');
  // Итог кейса — по оценке, без фиолетовой пилюли сбоя стенда; в шагах — число ходов, а не название сбоя.
  const item = { status: 'limit_reminders', outcome: 'failed', steps: { reset: 'ok', dialog: 'limit_reminders', checks: { passed: 0, total: 2 } }, stats: { turns: 3 } };
  assert.match(String(lib.outcomePill(item)), /<span class="pill fail">/);
  assert.match(String(lib.stepsView(item, false)), /<span class="sp ">.*?3 хода<\/span>/);
  assert.doesNotMatch(String(lib.stepsView(item, false)) + String(lib.outcomePill(item)), /tech|Лимит напоминаний/);
});
