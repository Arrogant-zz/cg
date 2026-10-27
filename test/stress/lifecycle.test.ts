import assert from 'node:assert/strict';
import fs from 'node:fs';
import { App } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { RECORD_FORMAT } from '../../src/results/format.js';
import { startStand, until, type Stand } from '../helpers.js';
import { stress, temp, put, CONFIG, REPO } from './helpers.js';

async function idleManual(s: Stand) {
  // Сбой /reset оставляет ручную сессию открытой и свободной для действий человека.
  const rec = await s.app.manual.create({ case: 'notifications-channel-change', agent: 'fake-agent' });
  await until(async () => s.app.manual.get(rec.id).busy === null, 3000, 'окончание неуспешного reset');
  return rec;
}

stress('LIFE-01 отказ записи HTTP при завершении ручной сессии не запирает слот и оператора', async () => {
  const s = await startStand({ FAKE_AGENT_FAIL_ON: '^/reset$' });
  const original = s.app.store.saveSessionHttp.bind(s.app.store);
  let id: number | undefined;
  try {
    const rec = await idleManual(s); id = rec.id;
    assert.equal(s.app.sessions.used, 1);
    assert.ok(s.app.operators.holder(rec.senderId));
    s.app.store.saveSessionHttp = async () => { throw Object.assign(new Error('injected disk failure'), { code: 'ENOSPC' }); };
    await assert.rejects(s.app.manual.finish(rec.id, {}), /injected disk failure/);
    assert.equal(s.app.sessions.used, 0, 'закрытая сессия продолжает занимать общий слот');
    assert.equal(s.app.bindings.size, 0, 'x-task-id остался привязан к закрытой сессии');
    assert.equal(s.app.operators.holder(rec.senderId), null, 'оператор навсегда занят');
  } finally {
    s.app.store.saveSessionHttp = original;
    if (id !== undefined && s.app.manual.liveExec(id)) {
      s.app.manual.get(id).status = 'active';
      await s.app.manual.finish(id, {});
    }
    await s.close();
  }
});

stress('LIFE-02 ошибка выделения номера сессии откатывает резерв существующего оператора', async () => {
  const s = await startStand({ FAKE_AGENT_FAIL_ON: '^/reset$' });
  const original = s.app.store.nextNumber.bind(s.app.store);
  try {
    s.app.store.nextNumber = async () => { throw new Error('injected counter failure'); };
    await assert.rejects(s.app.manual.create({ case: 'notifications-channel-change', agent: 'fake-agent', sender: { mode: 'existing', id: 'stress-existing' } }), /injected counter failure/);
    assert.equal(s.app.operators.holder('stress-existing'), null);
    assert.equal(s.app.sessions.used, 0); assert.equal(s.app.bindings.size, 0);
  } finally { s.app.store.nextNumber = original; await s.close(); }
});

stress('LIFE-03 повреждённый run.json текущего формата не блокирует запуск приложения', async (t) => {
  const dir = temp(t);
  put(dir, 'results/run-0001/run.json', { format: RECORD_FORMAT, id: 1, status: 'running', lines: null });
  const app = new App(loadEnv({ CLAWGYM_CONFIG: CONFIG, CLAWGYM_VAR: dir, LOG_LEVEL: 'error' }, REPO));
  try {
    await app.init();
    assert.deepEqual(app.runs.list(), []);
    assert.ok(app.stand.entries.some((e) => e.kind === 'store.skipped'));
  } finally { await app.close(); }
});

stress('LIFE-04 после перезапуска активная ручная сессия закрывается, история и журнал остаются', async (t) => {
  const dir = temp(t);
  const s = await startStand({ FAKE_AGENT_FAIL_ON: '^/reset$' });
  let id: number; let sender: string;
  try {
    const rec = await idleManual(s); id = rec.id; sender = rec.senderId;
    s.app.manual.flush();
    await s.app.close();
    fs.cpSync(s.dataDir, dir, { recursive: true });
  } finally { await s.close(); }
  const app = new App(loadEnv({ CLAWGYM_CONFIG: CONFIG, CLAWGYM_VAR: dir, LOG_LEVEL: 'error' }, REPO));
  try {
    await app.init();
    const saved = app.manual.get(id!);
    assert.equal(saved.status, 'closed'); assert.equal(saved.busy, null);
    assert.match(saved.note, /перезапущен/);
    assert.ok(saved.execution!.events.length > 0);
    assert.equal(app.sessions.used, 0); assert.equal(app.bindings.size, 0);
    assert.equal(app.operators.holder(sender!), null);
    assert.ok(app.operators.history(sender!).some((step) => step.kind === 'manual' && step.session === id));
  } finally { await app.close(); }
});
