// HTTP API интерфейса и автоматизации (запуск прогона без UI — тоже через этот API или CLI).
import type { App } from '../app.js';
import { HttpError, Router, sendFile } from '../util/http.js';
import { buildZip } from '../util/zip.js';
import { compareRuns } from '../results/compare.js';
import { isExecName, runKey } from '../results/store.js';
import * as v from './views.js';
import type { RunOverrides } from '../runner/resolve.js';

/** Номер прогона или сессии — только цифры в пределах безопасного целого: Number() принял бы «1e0» и «0x1» и округлил бы большое число. */
const num = (s: string) => {
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n)) throw new HttpError(400, 'Ожидался номер');
  return n;
};

/** Имя журнала кейса из адреса: неверное — 400, а не чтение файла вне каталога прогона. */
const execParam = (name: string) => {
  if (!isExecName(name)) throw new HttpError(400, `Неверное имя журнала кейса «${name}»`);
  return name;
};

/** Позиции дозапуска: список ключей L1-P04; без поля — все подходящие. */
function itemsOf(b: Record<string, unknown>): { items?: string[] } {
  const v = b.items;
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && /^L\d+-P\d+$/.test(x))) throw new HttpError(400, 'items — список позиций вида L1-P04');
  return { items: [...new Set(v as string[])] };
}

/** Линии продолжения: список номеров; без поля — все, которые можно продолжить. */
function linesOf(b: Record<string, unknown>): { lines?: number[] } {
  const v = b.lines;
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v) || !v.every((x) => Number.isSafeInteger(x) && (x as number) >= 1)) throw new HttpError(400, 'lines — список номеров линий');
  return { lines: [...new Set(v as number[])] };
}

/** Тестовый оператор при запуске: new — новый, номер — продолжить на операторе этого прогона; без поля — как в файле прогона. */
function overridesOf(o: { continueFrom?: unknown }): RunOverrides {
  const c = o.continueFrom;
  if (c === undefined || c === null || c === '') return {};
  if (c === 'new') return { continueFrom: 'new' };
  // Номер — числом или строкой из цифр: Number(true) дал бы прогон №1.
  const n = typeof c === 'number' ? c : typeof c === 'string' && /^\d+$/.test(c) ? Number(c) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'continueFrom — номер прогона или new');
  return { continueFrom: n };
}

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

  r.get('/api/run-configs', () => v.runConfigs(app));
  r.get('/api/run-configs/:id/preview', ({ params, query }) => v.preview(app, params.id, overridesOf({ continueFrom: query.get('continueFrom') ?? undefined })));

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
    const run = await app.runs.create(String(b.config), overridesOf(b.overrides ?? {}));
    return v.runListItem(run);
  });
  r.get('/api/runs/:id', async ({ params }) => {
    const run = app.runs.get(num(params.id));
    return v.runDetail(run, await app.runs.dorun(run));
  });
  r.post('/api/runs/:id/stop', async ({ params }) => v.runListItem(await app.runs.stop(num(params.id))));
  // Дозапуск завершённого прогона (решение владельца от 12.11.2026): перезапуск позиций проверки, продолжение линий обучения, переоценка.
  r.post('/api/runs/:id/rerun', async ({ params, body }) => v.runListItem(await app.runs.dorunStart(num(params.id), 'rerun', itemsOf(await body()))));
  r.post('/api/runs/:id/resume', async ({ params, body }) => v.runListItem(await app.runs.dorunStart(num(params.id), 'resume', linesOf(await body()))));
  r.post('/api/runs/:id/reevaluate', async ({ params, body }) => v.runListItem(await app.runs.dorunStart(num(params.id), 'reevaluate', itemsOf(await body()))));
  r.get('/api/runs/:id/executions/:name', async ({ params }) => {
    const id = num(params.id);
    const name = execParam(params.name);
    const run = app.runs.get(id);
    const live = app.runs.liveExecution(id, name);
    // Позиция журнала: итоговая попытка или прежняя. У прежней в журнале сохранена позиция на её конец.
    const item = run.lines.flatMap((l) => l.items).find((i) => i.execName === name || i.attempts?.some((a) => a.execName === name)) ?? null;
    const current = !!item && item.execName === name;
    const attempts = item ? v.attemptsOf(item) : [];
    // Ожидания — только у идущего выполнения: в запись они не входят.
    if (live && current) return { ...live.toJSON(), item, attempts, live: true, waits: live.waits() };
    const saved = live && !current ? { ...live.toJSON(), item: null } : await app.store.loadExecution(id, name);
    if (!saved) throw new HttpError(404, 'Журнал кейса не найден');
    return { ...saved, item: current ? item : (saved.item ?? item), attempts, live: false, waits: [] };
  });
  r.get('/api/runs/:id/executions/:name/http', async ({ params, query, res }) => {
    const id = num(params.id);
    const name = execParam(params.name);
    app.runs.get(id);
    const live = app.runs.liveExecution(id, name);
    const list = live ? live.http : ((await app.store.loadHttp(id, name)) ?? []);
    if (query.get('download')) return sendFile(res, `${runKey(id)}-${name}-http.json`, JSON.stringify(list, null, 2), 'application/json');
    return list;
  });
  r.delete('/api/runs/:id', async ({ params }) => {
    await app.runs.delete(num(params.id));
    return { ok: true };
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
  r.get('/api/manual/:id', ({ params }) => {
    const id = num(params.id);
    return { ...app.manual.get(id), waits: app.manual.liveExec(id)?.waits() ?? [] };
  });
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
  r.delete('/api/manual/:id', async ({ params }) => {
    await app.manual.delete(num(params.id));
    return { ok: true };
  });
  r.get('/api/manual/:id/http', async ({ params, query, res }) => {
    const id = num(params.id);
    const list = await app.manual.http(id);
    if (query.get('download')) return sendFile(res, `${app.manual.get(id).key}-http.json`, JSON.stringify(list, null, 2), 'application/json');
    return list;
  });
  r.get('/api/mcp/traffic', ({ query }) => {
    const unbound = query.get('unbound') === '1';
    return app.mcp.traffic.filter((x) => !unbound || !x.execId).slice().reverse();
  });
  r.get('/api/manual/:id/export', ({ params, res }) => {
    const s = app.manual.get(num(params.id));
    sendFile(res, `${s.key}.json`, JSON.stringify(s, null, 2), 'application/json');
  });
  return r;
}
