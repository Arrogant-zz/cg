// Демонстрационный набор справочников dev/config: на нём работают тесты и офлайн-демо.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadRegistry } from '../src/config/loader.js';
import { resolveRun } from '../src/runner/resolve.js';
import { loadEnv } from '../src/env.js';
import { DEMO_CONFIG, DEMO_VAR, demoEnv } from '../dev/demo-env.js';
import { CONFIG, REPO } from './helpers.js';

test('демонстрационный набор: загружается без ошибок, в нём настройки и корзины, на которых стоят тесты; предпросмотр demo-check — без ошибок', async () => {
  const reg = await loadRegistry(CONFIG);
  assert.deepEqual(
    reg.issues.filter((i) => i.severity === 'error'),
    [],
  );
  // Набор — вход остальных тестов: без этих настроек и корзин они падают далеко от причины.
  for (const id of ['demo-check', 'demo-train', 'demo-check-trained']) assert.ok(reg.runs.has(id), `нет настройки прогона «${id}» в ${CONFIG}/runs`);
  for (const id of ['second-line-check', 'second-line-train']) assert.ok(reg.baskets.has(id), `нет корзины «${id}» в ${CONFIG}/baskets`);
  const preview = resolveRun(reg, loadEnv({ CLAWGYM_CONFIG: CONFIG }, REPO), 'demo-check');
  assert.equal(preview.ok, true, JSON.stringify(preview.issues.filter((i) => i.severity === 'error')));
});

test('каталоги офлайн-демо: по умолчанию набор dev/config и данные .dev/var; заданные в окружении значения сильнее, пустая строка — не задано', () => {
  const dirs = (e: NodeJS.ProcessEnv) => {
    const env = loadEnv(demoEnv(e), '/srv/gym');
    return [env.configDir, env.varDir];
  };
  assert.deepEqual(dirs({}), ['/srv/gym/dev/config', '/srv/gym/.dev/var']);
  assert.deepEqual(dirs({ CLAWGYM_CONFIG: 'config' }), ['/srv/gym/config', '/srv/gym/.dev/var'], 'свои справочники на fake-agent, данные — демо');
  assert.deepEqual(dirs({ CLAWGYM_VAR: 'var' }), ['/srv/gym/dev/config', '/srv/gym/var'], 'прежние демо-прогоны из var/');
  assert.deepEqual(dirs({ CLAWGYM_CONFIG: '/mnt/config', CLAWGYM_VAR: '/mnt/var' }), ['/mnt/config', '/mnt/var']);
  const blank = demoEnv({ CLAWGYM_CONFIG: '', CLAWGYM_VAR: '' });
  assert.deepEqual([blank.CLAWGYM_CONFIG, blank.CLAWGYM_VAR], [DEMO_CONFIG, DEMO_VAR], 'пустая строка — не задано');
  assert.equal(demoEnv({ PORT: '8080' }).PORT, '8080', 'остальные переменные не меняются');
  // Демо по умолчанию читает тот же каталог, на котором стоят тесты.
  assert.equal(path.resolve(REPO, DEMO_CONFIG), CONFIG);
});
