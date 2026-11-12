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
