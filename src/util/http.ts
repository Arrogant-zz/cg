// Маленький маршрутизатор поверх node:http: без внешних зависимостей для закрытого контура.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  url: URL;
  body: () => Promise<any>;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) {
    return this.add('GET', p, h);
  }
  post(p: string, h: Handler) {
    return this.add('POST', p, h);
  }
  delete(p: string, h: Handler) {
    return this.add('DELETE', p, h);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined {
    const segs = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p === '*') {
          params['*'] = segs.slice(i).join('/');
          return { route, params };
        }
        if (i >= segs.length) {
          ok = false;
          break;
        }
        if (p.startsWith(':')) params[p.slice(1)] = segs[i];
        else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok && segs.length === route.parts.length) return { route, params };
    }
    return undefined;
  }

  /** true — маршрут найден и обработан. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = this.match(req.method ?? 'GET', url.pathname);
    if (!m) return false;
    // POST — только с телом JSON. Такой запрос с чужой страницы браузер шлёт лишь после OPTIONS, а стенд его не разрешает:
    // форма или fetch без CORS не запустят прогон и не напишут в ручную сессию от имени сотрудника. DELETE без OPTIONS не уходит и так.
    if (req.method === 'POST' && !isJson(req.headers['content-type'])) {
      sendJson(res, 415, { error: 'Нужен заголовок Content-Type: application/json' });
      return true;
    }
    const ctx: Ctx = { req, res, params: m.params, query: url.searchParams, url, body: () => readJsonBody(req) };
    try {
      const result = await m.route.handler(ctx);
      if (!res.headersSent && !res.writableEnded) {
        if (result === undefined) {
          res.statusCode = 204;
          res.end();
        } else sendJson(res, 200, result);
      }
    } catch (e: any) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message, details: e.details });
      else {
        console.error('[http]', req.method, url.pathname, e);
        sendJson(res, 500, { error: e?.message ?? String(e) });
      }
    }
    return true;
  }
}

/** Тип содержимого — application/json, параметры вроде charset допускаются. */
const isJson = (type: string | undefined): boolean => /^application\/json\s*(;|$)/i.test(type ?? '');

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export async function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Слишком большое тело запроса');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Тело запроса — не JSON');
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Статика из каталога; true — файл отдан. */
export function serveStatic(root: string, rel: string, res: ServerResponse, cache = 'no-cache'): boolean {
  const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!target.startsWith(path.resolve(root))) return false;
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  res.writeHead(200, { 'Content-Type': contentType(target), 'Content-Length': st.size, 'Cache-Control': cache });
  fs.createReadStream(target).pipe(res);
  return true;
}

export function sendFile(res: ServerResponse, name: string, data: Buffer | string, type: string): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.end(buf);
}
