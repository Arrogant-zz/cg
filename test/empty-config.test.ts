// Справочники без кейсов, решений, корзин и настроек прогонов: каталоги пусты или их нет. Так выглядит config/ в поставке.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry } from '../src/config/loader.js';
import { CONFIG, startStand } from './helpers.js';

/** Каталоги, которые есть в справочниках без датасетов, и каталоги, которые пусты или отсутствуют. */
const KEPT = ['contracts', 'agents', 'models', 'metrics', 'templates'];
const EMPTY = ['cases', 'solutions', 'baskets', 'runs'];

/** Справочники из пяти каталогов набора; пустые каталоги с заглушкой .gitkeep — по флагу. Каталог config/ тест не читает. */
function emptyConfig(t: TestContext, placeholders: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of KEPT) fs.cpSync(path.join(CONFIG, d), path.join(dir, d), { recursive: true });
  if (placeholders) {
    for (const d of EMPTY) {
      fs.mkdirSync(path.join(dir, d));
      fs.writeFileSync(path.join(dir, d, '.gitkeep'), '');
    }
  }
  return dir;
}

for (const [label, placeholders] of [
  ['каталогов нет', false],
  ['каталоги пусты, в каждом .gitkeep', true],
] as const) {
  test(`справочники без кейсов, решений, корзин и прогонов — ${label}: загрузка без ошибок и предупреждений`, async (t) => {
    const reg = await loadRegistry(emptyConfig(t, placeholders));
    assert.deepEqual(reg.issues, [], 'ни ошибок, ни предупреждений');
    assert.deepEqual([reg.cases.size, reg.solutions.size, reg.baskets.size, reg.runs.size], [0, 0, 0, 0]);
    assert.ok(reg.contract, 'контракт инструментов загружен');
    assert.ok(reg.agents.size > 0 && reg.models.size > 0 && reg.metrics.size > 0, 'подключения, модели и метрики загружены');
  });
}

test('стенд на справочниках без кейсов, корзин и прогонов: списки в API пусты, подключения и инструменты доступны', async (t) => {
  const s = await startStand({ CLAWGYM_CONFIG: emptyConfig(t, true) });
  try {
    assert.deepEqual((await s.api('GET', '/api/cases')).data, { cases: [], solutions: 0, errors: 0, warnings: 0 });
    assert.deepEqual((await s.api('GET', '/api/baskets')).data, []);
    assert.deepEqual((await s.api('GET', '/api/run-configs')).data, []);
    assert.deepEqual((await s.api('GET', '/api/runs')).data.runs, []);
    const dir = (await s.api('GET', '/api/directory')).data;
    assert.ok(dir.agents.length > 0, 'подключения агентов видны');
    assert.ok(dir.tools.length > 0, 'инструменты контракта видны');
  } finally {
    await s.close();
  }
});
