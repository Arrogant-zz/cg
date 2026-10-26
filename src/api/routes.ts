// HTTP API интерфейса и автоматизации (запуск прогона без UI — тоже через этот API или CLI).
import type { App } from '../app.js';
import { HttpError, Router, sendFile } from '../util/http.js';
import { buildZip } from '../util/zip.js';
import { diffTrees } from '../util/diff.js';
import { compareRuns } from '../results/compare.js';
import { runKey } from '../results/store.js';
import * as v from './views.js';

const num = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Ожидался номер');
  return n;
};

export function buildRoutes(app: App): Router {
  const r = new Router();

  r.get('/api/status', () => v.status(app));
  r.get('/api/config/issues', () => ({ loadedAt: app.registry.loadedAt, files: app.registry.fileCount, issues: app.registry.issues }));
  r.post('/api/config/reload', async () => {
    const reg = await app.reload();
    return { loadedAt: reg.loadedAt, files: reg.fileCount, issues: reg.issues };
  });
  r.get('/api/stand-log', () => app.stand.entries.slice().reverse());

  r.get('/api/cases', () => v.cases(app));
  r.get('/api/cases/:id', ({ params }) => v.caseDetail(app, params.id));
  r.get('/api/baskets', () => v.baskets(app));
  r.get('/api/baskets/:id', ({ params }) => v.basketDetail(app, params.id));
  r.get('/api/directory', () => v.directory(app));

  r.get('/api/skillsets', () => v.skillsets(app));
  r.get('/api/skillsets/:id', ({ params }) => v.skillsetDetail(app, params.id));
  r.get('/api/skillsets/:id/diff', ({ params, query }) => {
    const s = app.registry.skillsets.get(params.id);
    if (!s) throw new HttpError(404, 'Набор не найден');
    const a = s.versions.find((x) => x.id === query.get('from'));
    const b = s.versions.find((x) => x.id === query.get('to'));
    if (!a || !b) throw new HttpError(404, 'Версия не найдена');
    return { from: a.id, to: b.id, changes: diffTrees(a.files, b.files) };
  });
  r.get('/api/skillsets/:id/versions/:ver/file', ({ params, query }) => {
    const s = app.registry.skillsets.get(params.id);
    const ver = s?.versions.find((x) => x.id === params.ver);
    const f = ver?.files.find((x) => x.path === query.get('path'));
    if (!f) throw new HttpError(404, 'Файл не найден');
    return { path: f.path, sha256: f.sha256, content: f.content };
  });
  r.get('/api/skillsets/:id/versions/:ver/download', ({ params, res }) => {
    const s = app.registry.skillsets.get(params.id);
    const ver = s?.versions.find((x) => x.id === params.ver);
    if (!s || !ver) throw new HttpError(404, 'Версия не найдена');
    sendFile(res, `${s.id}-${ver.id}.zip`, buildZip(ver.files.map((f) => ({ path: f.path, data: f.content }))), 'application/zip');
  });

  r.get('/api/run-configs', () => v.runConfigs(app));
  r.get('/api/run-configs/:id/preview', ({ params, query }) => v.preview(app, params.id, query.get('skillsetVersion') ? { skillsetVersion: query.get('skillsetVersion')! } : {}));

  r.get('/api/runs', () => ({
    runs: app.runs.list().map(v.runListItem),
    manual: app.manual
      .list()
      .filter((s) => s.status === 'active')
      .map((s) => ({ ...s, execution: { pending: app.manual.liveExec(s.id)?.pendingList() ?? [] } })),
  }));
  r.post('/api/runs', async ({ body }) => {
    const b = await body();
    if (!b.config) throw new HttpError(400, 'Нужно поле config — идентификатор файла в runs/');
    const run = await app.runs.create(String(b.config), b.overrides ?? {});
    return v.runListItem(run);
  });
  r.get('/api/runs/:id', ({ params }) => v.runDetail(app.runs.get(num(params.id))));
  r.post('/api/runs/:id/stop', async ({ params }) => v.runListItem(await app.runs.stop(num(params.id))));
  r.get('/api/runs/:id/executions/:name', async ({ params }) => {
    const id = num(params.id);
    const run = app.runs.get(id);
    const live = app.runs.liveExecution(id, params.name);
    const item = run.lines.flatMap((l) => l.items).find((i) => i.execName === params.name) ?? null;
    if (live) return { ...live.toJSON(), item, live: true };
    const saved = await app.store.loadExecution(id, params.name);
    if (!saved) throw new HttpError(404, 'Журнал кейса не найден');
    return { ...saved, item: item ?? saved.item, live: false };
  });
  r.get('/api/runs/:id/materials.zip', async ({ params, res }) => {
    const id = num(params.id);
    app.runs.get(id);
    const files = await app.store.listRunFiles(id);
    const entries = await Promise.all(files.map(async (f) => ({ path: `${runKey(id)}/${f}`, data: await app.store.readRunFile(id, f) })));
    sendFile(res, `${runKey(id)}.zip`, buildZip(entries), 'application/zip');
  });
  r.get('/api/runs/:id/file', async ({ params, query }) => {
    const id = num(params.id);
    const rel = query.get('path') ?? '';
    try {
      return { path: rel, content: (await app.store.readRunFile(id, rel)).toString('utf8') };
    } catch {
      throw new HttpError(404, 'Файл не найден');
    }
  });
  r.get('/api/compare', ({ query }) => {
    const a = app.runs.get(num(query.get('a') ?? ''));
    const b = app.runs.get(num(query.get('b') ?? ''));
    return compareRuns(a, b);
  });

  r.get('/api/manual', () => app.manual.list());
  r.post('/api/manual', async ({ body }) => {
    const rec = await app.manual.create(await body());
    return { id: rec.id, key: rec.key };
  });
  r.get('/api/manual/:id', ({ params }) => app.manual.get(num(params.id)));
  r.post('/api/manual/:id/message', async ({ params, body }) => {
    await app.manual.message(num(params.id), await body());
    return { ok: true };
  });
  r.post('/api/manual/:id/command', async ({ params, body }) => {
    const b = await body();
    if (!['reset', 'capture', 'curator'].includes(b.name)) throw new HttpError(400, 'Команда: reset, capture или curator');
    await app.manual.command(num(params.id), b.name);
    return { ok: true };
  });
  r.post('/api/manual/:id/tool/:callId', async ({ params, body }) => {
    app.manual.tool(num(params.id), params.callId, await body());
    return { ok: true };
  });
  r.post('/api/manual/:id/mark', async ({ params, body }) => {
    const b = await body();
    app.manual.mark(num(params.id), Number(b.seq), b);
    return { ok: true };
  });
  r.post('/api/manual/:id/finish', async ({ params, body }) => app.manual.finish(num(params.id), await body()));
  r.get('/api/manual/:id/export', ({ params, res }) => {
    const s = app.manual.get(num(params.id));
    sendFile(res, `${s.key}.json`, JSON.stringify(s, null, 2), 'application/json');
  });
  return r;
}
