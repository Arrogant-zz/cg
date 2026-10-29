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
