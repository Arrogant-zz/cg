import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setPath, setDotted, queryPath, getDotted } from '../../src/util/jsonpath.js';
import { renderDeep, renderLines, renderValue } from '../../src/util/template.js';
import { Semaphore, KeyedMutex } from '../../src/util/sync.js';
import { StubState, renderResponse, condMatches, yamlSnippet } from '../../src/stubs/engine.js';
import { redactSecrets } from '../../src/runner/inputs.js';
import { loadEnv } from '../../src/env.js';
import { stress, random } from './helpers.js';
import YAML from 'yaml';

for (const [name, write] of [
  ['JSONPath', (o: any) => setPath(o, '$.__proto__.stressPolluted', 'injected')],
  ['JSONPath constructor', (o: any) => setPath(o, '$.constructor.prototype.stressPolluted', 'injected')],
  ['точечный путь', (o: any) => setDotted(o, '__proto__.stressPolluted', 'injected')],
  ['эффект заглушки', (o: any) => new StubState(o).applyEffect({ '__proto__.stressPolluted': 'injected' }, {})],
] as const) {
  stress(`CORE-01 ${name}: вход не должен менять прототип всех объектов`, () => {
    try {
      try { write({}); } catch { /* Явный отказ в опасном пути допустим. */ }
      assert.equal(({} as any).stressPolluted, undefined, 'чужой ввод изменил Object.prototype');
    } finally {
      delete (Object.prototype as any).stressPolluted;
    }
  });
}

stress('CORE-02 чтение отсутствующего поля не находит унаследованные данные', () => {
  assert.deepEqual(queryPath({}, '$.constructor'), []);
  assert.equal(getDotted({}, 'toString'), undefined);
});

stress('CORE-03 ключ __proto__ в JSON-ответе остаётся собственным полем', () => {
  const input = JSON.parse('{"__proto__":{"admin":true},"ok":1}');
  const output = renderDeep(input, {});
  assert.ok(Object.hasOwn(output, '__proto__'), 'renderDeep потерял собственное поле и заменил прототип');
  assert.equal((output as any).admin, undefined);
});

stress('CORE-04 отменённый до acquire запрос не занимает свободный слот', async () => {
  const sem = new Semaphore(1);
  const c = new AbortController();
  c.abort();
  try {
    await assert.rejects(sem.acquire('cancelled', c.signal));
    assert.equal(sem.used, 0);
  } finally { sem.release('cancelled'); }
});

stress('CORE-05 отменённый до acquire запрос не зависает в очереди', async () => {
  const sem = new Semaphore(1);
  sem.tryAcquire('owner');
  const c = new AbortController(); c.abort();
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      sem.acquire('cancelled', c.signal).then(() => 'acquired', () => 'rejected'),
      new Promise<string>((r) => { timer = setTimeout(() => r('hung'), 80); }),
    ]);
    assert.equal(outcome, 'rejected', 'уже отменённый запрос не должен ждать освобождения сессии');
    assert.equal(sem.queued, 0);
  } finally { clearTimeout(timer); sem.release('owner'); sem.release('cancelled'); }
});

stress('CORE-06 отмена в очереди не отбирает слот у следующего', async () => {
  const sem = new Semaphore(1); sem.tryAcquire('owner');
  const c = new AbortController();
  const cancelled = sem.acquire('cancelled', c.signal);
  const next = sem.acquire('next');
  const rejected = assert.rejects(cancelled);
  c.abort(); await rejected;
  sem.release('owner'); await next;
  assert.deepEqual(sem.owners(), ['next']);
  sem.release('next'); assert.equal(sem.used, 0);
});

stress('CORE-07 исключение внутри mutex не ломает следующие операции и независимый ключ', async () => {
  const mutex = new KeyedMutex(); const order: string[] = [];
  const first = mutex.run('a', async () => { order.push('first'); throw new Error('failure'); });
  const second = mutex.run('a', async () => { order.push('second'); return 42; });
  const other = mutex.run('b', async () => 'independent');
  await assert.rejects(first, /failure/);
  assert.equal(await other, 'independent'); assert.equal(await second, 42);
  assert.deepEqual(order, ['first', 'second']); assert.equal(mutex.isBusy('a'), false);
});

stress('CORE-08 300 вложенных значений round-trip через JSONPath, seed=0xC1A0', () => {
  const rng = random(0xC1A0);
  const values = [null, false, 0, '', 'Привет 👨‍👩‍👧‍👦\u0000\u202e', { x: ['a', 9] }];
  for (let i = 0; i < 300; i++) {
    const value = values[Math.floor(rng() * values.length)];
    const p = `$.root[${Math.floor(rng() * 5)}]['ключ.${i}'].value`;
    const obj = {}; setPath(obj, p, value);
    assert.deepEqual(queryPath(obj, p), [value], `итерация ${i}, ${p}`);
  }
});

stress('CORE-09 шаблон сохраняет false, 0, null, объекты и не исполняет код', () => {
  for (const v of [false, 0, null, '', { a: [1, null] }, '${process.env.SECRET}', '{{now}}', '<script>alert(1)</script>']) {
    assert.deepEqual(renderValue('{{args.value}}', { args: { value: v } }), v);
  }
  assert.equal(renderLines('A: {{a}}\nB: {{b}}\nC: {{c}}', { a: false, b: 0, c: '' }), 'A: false\nB: 0');
});

stress('CORE-10 регулярное выражение из when не должно блокировать процесс на 2 секунды', () => {
  // Опасный regexp выполняется только в дочернем процессе с принудительным завершением.
  const module = new URL('../../src/stubs/engine.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {condMatches} from ${JSON.stringify(module)}; condMatches('a'.repeat(32) + '!', {regex:'^(a+)+$'}); process.stdout.write('done');`,
  ], { timeout: 2000, maxBuffer: 4096 });
  assert.equal(result.error?.code, undefined, `regexp заблокировал процесс: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(result.stdout.toString(), 'done');
});

stress('CORE-11 YAML-фрагмент ответа выдерживает переводы строк и опасные символы', () => {
  const text = 'первая\n---\n# comment\n  : [x]\n\tтаб\n\u0000\nпоследняя\n';
  const snippet = yamlSnippet('tool', { value: 'a: b\n---' }, { text });
  assert.equal(YAML.parse(snippet).tools.tool[0].result.text, text);
});

for (const [label, source, secret] of [
  ['flow YAML', 'headers: {Authorization: Bearer canary-flow-secret}', 'canary-flow-secret'],
  ['блок YAML', 'headers:\n  Authorization: |\n    Bearer canary-block-secret\n', 'canary-block-secret'],
  ['нестандартный заголовок', 'headers:\n  X-Custom-Token: canary-custom-secret\n', 'canary-custom-secret'],
  ['JSON', '{"headers":{"Authorization":"Bearer canary-json-secret"}}', 'canary-json-secret'],
] as const) {
  stress(`CORE-12 снимок подключения скрывает секрет: ${label}`, () => {
    assert.ok(!redactSecrets(source).includes(secret), 'секрет сохранился в снимке, доступном через экспорт материалов');
  });
}

for (const [key, value] of [['TURN_TIMEOUT_MS', '-1'], ['RESET_TIMEOUT_MS', '0.5'], ['PORT', '65536'], ['MAX_PARALLEL_SESSIONS', '1.5']] as const) {
  stress(`CORE-13 недопустимое окружение ${key}=${value} отклоняется до запуска`, () => {
    assert.throws(() => loadEnv({ [key]: value }, '/tmp/stress-config-root'));
  });
}

stress('CORE-14 сравнение условий не меняет исходные значения', () => {
  const a = { nested: { values: [null, false, 0] } };
  const before = JSON.stringify(a);
  assert.equal(condMatches(a, { nested: { values: [null, false, 0] } }), true);
  assert.equal(JSON.stringify(a), before);
  const state = new StubState({ list: ['first'] });
  const copy = state.snapshot(); (copy.list as string[]).push('other');
  assert.deepEqual(state.snapshot(), { list: ['first'] });
  assert.equal(renderResponse({ result: { json: null } }, {}, state).text, 'null');
});
