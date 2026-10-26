// MCP-сервер ClawGym по транспорту Streamable HTTP (JSON-RPC 2.0 в POST).
// Вызов привязывается к выполнению кейса по x-task-id: заголовок, затем _meta, затем аргумент.
// Транспорт и версия протокола — предположение до сверки с MCP-клиентом AEFClaw (docs/CONTRACTS.md).
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ContractDef } from '../config/types.js';
import type { Env } from '../env.js';
import type { Execution, McpCallResult } from '../execution/execution.js';
import { readBody } from '../util/http.js';
import { nowIso } from '../util/core.js';
import { renderString } from '../util/template.js';
import { logger } from '../util/log.js';
import { clip, finishExchange, maskedHeaders, startExchange, type HttpExchange } from '../util/httplog.js';

const log = logger('mcp');

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface StandLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  data?: unknown;
}

/** Общий журнал стенда: вызовы без привязки, сбои доставки — видны в интерфейсе, а не только в логе. */
export class StandLog {
  entries: StandLogEntry[] = [];
  private listeners = new Set<(e: StandLogEntry) => void>();
  add(level: StandLogEntry['level'], kind: string, message: string, data?: unknown) {
    const e = { ts: nowIso(), level, kind, message, data };
    this.entries.push(e);
    if (this.entries.length > 500) this.entries.shift();
    for (const l of this.listeners) l(e);
    if (level !== 'info') log.warn(`${kind}: ${message}`);
  }
  onAdd(fn: (e: StandLogEntry) => void) {
    this.listeners.add(fn);
  }
}

/** x-task-id → выполнение кейса. */
export class TaskBindings {
  private map = new Map<string, Execution>();
  bind(taskId: string, exec: Execution) {
    this.map.set(taskId, exec);
  }
  bindAll(exec: Execution) {
    for (const t of exec.taskIds) this.map.set(t, exec);
    exec.onTaskId = (t) => this.map.set(t, exec);
  }
  unbindAll(exec: Execution) {
    for (const t of exec.taskIds) if (this.map.get(t) === exec) this.map.delete(t);
  }
  get(taskId: string): Execution | undefined {
    return this.map.get(taskId);
  }
  get size() {
    return this.map.size;
  }
}

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

interface McpSession {
  id: string;
  protocolVersion: string;
  clientInfo: unknown;
  createdAt: string;
  lastSeen: string;
}

/** Контекст одного HTTP-запроса агента: обмен для журнала и выполнение, к которому он привязан. */
interface CallCtx {
  x: HttpExchange;
  exec: Execution | null;
}

const TRAFFIC_LIMIT = 300;

export class McpServer {
  sessions = new Map<string, McpSession>();
  /** Последние HTTP-обмены MCP; без привязки к кейсу — initialize, tools/list и вызовы без x-task-id. */
  traffic: HttpExchange[] = [];

  constructor(
    private env: Env,
    private getContract: () => ContractDef | null,
    private bindings: TaskBindings,
    private stand: StandLog,
    private version: string,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const taskHeader = req.headers[this.env.mcpTaskIdHeader];
    const x = startExchange(
      'mcp',
      req.method ?? 'POST',
      { method: req.method ?? 'POST', url: req.url ?? this.env.mcpPath, headers: maskedHeaders(req.headers), body: '' },
      { taskId: typeof taskHeader === 'string' ? taskHeader : null, mcpSessionId: typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : null },
    );
    this.traffic.push(x);
    if (this.traffic.length > TRAFFIC_LIMIT) this.traffic.shift();
    const ctx: CallCtx = { x, exec: null };
    const send = (status: number, headers: Record<string, string | number>, body: string) => {
      res.writeHead(status, headers);
      res.end(body);
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v);
      finishExchange(x, { status, headers: h, body });
      ctx.exec?.updateHttp(x);
    };
    if (req.method === 'GET') {
      // Сервер не открывает поток уведомлений: допустимо по спецификации Streamable HTTP.
      x.label = 'GET: поток уведомлений не поддержан';
      send(405, { Allow: 'POST, DELETE' }, '');
      return;
    }
    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] ?? '');
      this.sessions.delete(sid);
      x.label = 'DELETE: закрытие сессии';
      send(204, {}, '');
      return;
    }
    if (req.method !== 'POST') {
      send(405, { Allow: 'POST, DELETE' }, '');
      return;
    }
    let payload: any;
    try {
      const raw = (await readBody(req)).toString('utf8');
      Object.assign(x.request, clip(raw));
      payload = JSON.parse(raw);
    } catch {
      x.label = 'нераспознанный JSON';
      this.reply(send, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const batch = Array.isArray(payload);
    const list: RpcRequest[] = batch ? payload : [payload];
    x.label = list
      .map((m) => (m?.method === 'tools/call' && typeof m.params?.name === 'string' ? `tools/call ${m.params.name}` : String(m?.method ?? '?')))
      .join(', ');
    const sessionHeader: Record<string, string> = {};
    const results = await Promise.all(list.map((m) => this.dispatch(m, req, sessionHeader, ctx)));
    const responses = results.filter((r) => r !== null);
    if (!responses.length) {
      send(202, sessionHeader, '');
      return;
    }
    this.reply(send, batch ? responses : responses[0], sessionHeader, req);
  }

  private reply(send: (status: number, headers: Record<string, string>, body: string) => void, body: unknown, headers: Record<string, string> = {}, req?: IncomingMessage) {
    const accept = String(req?.headers.accept ?? '');
    if (this.env.mcpResponseMode === 'sse' && accept.includes('text/event-stream')) {
      send(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers }, `event: message\ndata: ${JSON.stringify(body)}\n\n`);
      return;
    }
    send(200, { 'Content-Type': 'application/json', ...headers }, JSON.stringify(body));
  }

  private taskIdOf(req: IncomingMessage, params: any): string | null {
    const h = req.headers[this.env.mcpTaskIdHeader];
    if (typeof h === 'string' && h) return h;
    const meta = params?._meta ?? {};
    const m = meta[this.env.mcpTaskIdHeader] ?? meta.taskId ?? meta['x-task-id'];
    if (typeof m === 'string' && m) return m;
    const a = params?.arguments?.[this.env.mcpTaskIdHeader] ?? params?.arguments?.['x-task-id'];
    if (typeof a === 'string' && a) return a;
    return null;
  }

  private async dispatch(m: RpcRequest, req: IncomingMessage, sessionHeader: Record<string, string>, ctx: CallCtx): Promise<unknown | null> {
    const isNotification = m.id === undefined || m.id === null;
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const ok = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id: m.id, result });
    const fail = (code: number, message: string) => (isNotification ? null : { jsonrpc: '2.0', id: m.id, error: { code, message } });
    const sid = String(req.headers['mcp-session-id'] ?? '');
    if (sid && this.sessions.has(sid)) this.sessions.get(sid)!.lastSeen = nowIso();

    switch (m.method) {
      case 'initialize': {
        const asked = String(m.params?.protocolVersion ?? '');
        const version = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
        const id = crypto.randomUUID();
        this.sessions.set(id, { id, protocolVersion: version, clientInfo: m.params?.clientInfo ?? null, createdAt: nowIso(), lastSeen: nowIso() });
        sessionHeader['Mcp-Session-Id'] = id;
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'clawgym', version: this.version },
          instructions: 'ClawGym: тестовый MCP-сервер с заглушками инструментов.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list': {
        const c = this.getContract();
        if (!c) return fail(-32603, 'Контракт инструментов не загружен');
        return ok({ tools: c.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      }
      case 'tools/call': {
        const c = this.getContract();
        const name = m.params?.name;
        if (typeof name !== 'string') return fail(-32602, 'Нет params.name');
        const args = { ...(m.params?.arguments ?? {}) };
        const taskId = this.taskIdOf(req, m.params);
        delete args[this.env.mcpTaskIdHeader];
        delete args['x-task-id'];
        const exec = taskId ? this.bindings.get(taskId) : undefined;
        if (taskId) ctx.x.taskId = taskId;
        if (!exec) {
          this.stand.add('warn', 'mcp.unbound', taskId ? `Вызов ${name} с неизвестным x-task-id ${taskId}` : `Вызов ${name} без x-task-id`, { tool: name, args, taskId, httpId: ctx.x.id });
          const text = c ? renderString(c.errors.unknownTask, { tool: name }) : 'Неизвестный x-task-id';
          return ok({ content: [{ type: 'text', text }], isError: true } satisfies McpCallResult);
        }
        if (!ctx.exec) {
          // Обмен виден в журнале кейса сразу, в том числе пока вызов удерживается до подтверждения.
          ctx.exec = exec;
          exec.addHttp(ctx.x);
        }
        try {
          return ok(await exec.handleToolCall(name, args, taskId!, ctx.exec === exec ? ctx.x.id : null));
        } catch (e: any) {
          this.stand.add('error', 'mcp.error', `Сбой обработки ${name}: ${e?.message ?? e}`, { exec: exec.id });
          return ok({ content: [{ type: 'text', text: 'Внутренняя ошибка стенда' }], isError: true });
        }
      }
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  }
}
