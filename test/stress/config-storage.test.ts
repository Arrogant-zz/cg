import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from '../../src/config/loader.js';
import { ResultsStore } from '../../src/results/store.js';
import { RECORD_FORMAT, loadRunRecord, loadSessionRecord, loadExecutionRecord } from '../../src/results/format.js';
import { writeJsonAtomic, readJson, settleWrites, safeJoin } from '../../src/util/fsx.js';
import { stress, temp, put, CONFIG } from './helpers.js';

const minimal = (dir: string) => {
  put(dir, 'contracts/tools.json', { tools: [] });
  put(dir, 'contracts/start-message.txt', 'Тематика: {{case.topic}}\nrequest_ref: {{requestRef}}', true);
};

for (const [label, content] of [
  ['дублирующийся ключ', 'id: bad\nid: other\ntitle: Broken\ntopic: Broken'],
  ['незакрытый YAML', 'id: bad\ntitle: [\n'],
  ['массив вместо объекта', '- one\n- two'],
  ['null', 'null'],
] as const) {
  stress(`CFG-01 ${label}: файл изолирован, соседний кейс загружается`, async (t) => {
    const dir = temp(t); minimal(dir);
    put(dir, 'cases/bad.yaml', content, true);
    put(dir, 'cases/good.json', { id: 'good', title: 'Good', topic: 'Topic' });
    const reg = await loadRegistry(dir);
    assert.ok(reg.cases.has('good'));
    assert.ok(reg.issues.some((i) => i.file === 'cases/bad.yaml' && i.severity === 'error'));
  });
}

stress('CFG-02 YAML alias bomb: диагностируется в issues, не обрушает reload', async (t) => {
  const dir = temp(t); minimal(dir);
  put(dir, 'cases/bomb.yaml', [
    'id: bomb', 'title: Bomb', 'topic: Topic', 'start:',
    '  a: &a [x, x, x, x, x, x, x, x, x, x]',
    '  b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
    '  c: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
  ].join('\n'), true);
  const reg = await loadRegistry(dir);
  assert.ok(reg.issues.some((i) => i.file === 'cases/bomb.yaml' && i.severity === 'error'));
});

stress('CFG-03 неизвестный YAML alias не выходит необработанным исключением', async (t) => {
  const dir = temp(t); minimal(dir);
  put(dir, 'cases/bad.yaml', 'id: bad\ntitle: Bad\ntopic: Topic\nstart: {value: *missing}', true);
  const reg = await loadRegistry(dir);
  assert.ok(reg.issues.some((i) => i.file === 'cases/bad.yaml' && i.severity === 'error'));
});

stress('CFG-04 response.file не читает файлы вне config/data', async (t) => {
  const parent = temp(t); const dir = path.join(parent, 'config'); minimal(dir);
  put(parent, 'outside.json', { canary: 'outside-config' });
  put(dir, 'cases/escape.json', {
    id: 'escape', title: 'Escape', topic: 'Topic',
    tools: { t: [{ result: { file: '../../outside.json' } }] },
  });
  const reg = await loadRegistry(dir);
  const c = reg.cases.get('escape');
  assert.ok(!c?.dataFiles.some((f) => f.text.includes('outside-config')), 'загрузчик прочитал внешний файл');
  assert.ok(reg.issues.some((i) => i.file === 'cases/escape.json' && i.severity === 'error'));
});

stress('CFG-05 регулярное выражение с ошибкой выявляется при загрузке с полем и строкой', async (t) => {
  const dir = temp(t); minimal(dir);
  put(dir, 'cases/bad.yaml', 'id: bad\ntitle: Bad\ntopic: Topic\ntools:\n  t:\n    - when: {value: {regex: "["}}\n      result: {json: {}}', true);
  const reg = await loadRegistry(dir);
  assert.ok(reg.issues.some((i) => i.severity === 'error' && i.field === 'tools.t[0].when.value.regex' && i.line === 6));
});

stress('CFG-06 невалидные файлы в отложенной _папке не мешают загрузке', async (t) => {
  const dir = temp(t); minimal(dir);
  put(dir, 'cases/_draft/bomb.yaml', 'not: [valid', true);
  put(dir, 'cases/good.json', { id: 'good', title: 'Good', topic: 'Topic' });
  const reg = await loadRegistry(dir);
  assert.ok(reg.cases.has('good'));
  assert.ok(!reg.issues.some((i) => i.file.includes('_draft')));
});

for (const [kind, load] of [['run', loadRunRecord], ['session', loadSessionRecord], ['execution', loadExecutionRecord]] as const) {
  stress(`STORE-01 пустая запись текущей версии ${kind} отклоняется`, () => {
    const result = load({ format: RECORD_FORMAT });
    assert.equal(result.ok, false, 'номер формата не доказывает целостность структуры записи');
  });
}

stress('STORE-02 оборванный JSON и будущий формат пропускаются с причиной', async (t) => {
  const dir = temp(t); const store = new ResultsStore(dir); await store.init();
  put(dir, 'results/run-0001/run.json', '{"id": 1,', true);
  put(dir, 'results/run-0002/run.json', { format: RECORD_FORMAT + 1, id: 2 });
  const skipped: string[] = [];
  assert.deepEqual(await store.loadRuns((file, reason) => skipped.push(`${file}: ${reason}`)), []);
  assert.equal(skipped.length, 2); assert.match(skipped.join('\n'), /новее/);
});

stress('STORE-03 частично затёртый run.json текущей версии не попадает в список прогонов', async (t) => {
  const dir = temp(t); const store = new ResultsStore(dir); await store.init();
  put(dir, 'results/run-0001/run.json', { format: RECORD_FORMAT, id: 1, status: 'running', lines: null });
  const skipped: string[] = [];
  const records = await store.loadRuns((file) => skipped.push(file));
  assert.equal(records.length, 0, 'битая запись принята и позже сломает RunManager.init/list');
  assert.equal(skipped.length, 1);
});

for (const value of [-1, 1.5, '9', Number.MAX_SAFE_INTEGER]) {
  stress(`STORE-04 повреждённый счётчик run=${JSON.stringify(value)} отклоняется`, async (t) => {
    const dir = temp(t); const store = new ResultsStore(dir); await store.init();
    put(dir, 'counters.json', { run: value });
    await assert.rejects(store.nextNumber('run'), /счётчик|counter|номер|число|integer|range/i);
    assert.deepEqual(await readJson(path.join(dir, 'counters.json')), { run: value }, 'ошибка не должна перезаписывать счётчик');
  });
}

stress('STORE-05 ошибка записи не отравляет очередь, следующая запись проходит', async (t) => {
  const dir = temp(t); const file = path.join(dir, 'state.json');
  const circular: any = {}; circular.self = circular;
  await assert.rejects(writeJsonAtomic(file, circular), /circular/i);
  await writeJsonAtomic(file, { recovered: true });
  assert.deepEqual(await readJson(file), { recovered: true });
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
});

stress('STORE-06 счётчики пропускают существующий номер при отставшем counters.json', async (t) => {
  const dir = temp(t); const store = new ResultsStore(dir); await store.init();
  put(dir, 'counters.json', { run: 0, session: 0 });
  put(dir, 'results/run-0001/marker', 'keep', true);
  put(dir, 'sessions/m-0001.json', { marker: 'keep' });
  assert.equal(await store.nextNumber('run'), 2);
  assert.equal(await store.nextNumber('session'), 2);
  assert.equal(fs.readFileSync(path.join(dir, 'results/run-0001/marker'), 'utf8'), 'keep');
});

stress('STORE-07 удаление ждёт начатую запись и не воскрешает каталог', async (t) => {
  const dir = temp(t); const store = new ResultsStore(dir); await store.init();
  const file = path.join(store.runDir(1), 'test.json');
  const write = writeJsonAtomic(file, { data: 'последние изменения' });
  await store.deleteRun(1); await write; await settleWrites(dir);
  assert.equal(fs.existsSync(store.runDir(1)), false);
});

stress('STORE-08 лексический выход за каталог и соседний общий префикс запрещены', () => {
  for (const input of ['../secret.json', '../../etc/passwd', '/etc/passwd', '../data-evil/file']) {
    assert.throws(() => safeJoin('/tmp/data', input));
  }
  assert.equal(safeJoin('/tmp/data', 'a/../ok.json'), '/tmp/data/ok.json');
});

stress('STORE-09 symlink в материалах не раскрывает файл вне каталога прогона', async (t) => {
  const dir = temp(t); const store = new ResultsStore(dir); await store.init();
  put(dir, 'outside.txt', 'canary-outside-run', true);
  fs.mkdirSync(store.runDir(1), { recursive: true });
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(store.runDir(1), 'linked.txt'));
  await assert.rejects(store.readRunFile(1, 'linked.txt'), /вне|link|symlink|path/i);
});

stress('STORE-10 имя execution не позволяет прочитать соседний run.json', async (t) => {
  const dir = temp(t); const store = new ResultsStore(dir); await store.init();
  put(dir, 'results/run-0001/run.json', { format: RECORD_FORMAT, canary: 'run-not-execution' });
  await assert.rejects(store.loadExecution(1, '../run'), /вне|имя|name|path/i);
});

stress('CFG-07 штатный каталог остаётся валидным после всех мутаций временных копий', async () => {
  const reg = await loadRegistry(CONFIG);
  assert.deepEqual(reg.issues.filter((i) => i.severity === 'error'), []);
});
