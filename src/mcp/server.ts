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

export class McpServer {
  sessions = new Map<string, McpSession>();

  constructor(
    private env: Env,
    private getContract: () => ContractDef | null,
    private bindings: TaskBindings,
    private stand: StandLog,
    private version: string,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      // Сервер не открывает поток уведомлений: допустимо по спецификации Streamable HTTP.
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }
    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] ?? '');
      this.sessions.delete(sid);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' }).end();
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      this.reply(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const batch = Array.isArray(payload);
    const list: RpcRequest[] = batch ? payload : [payload];
    const sessionHeader: Record<string, string> = {};
    const results = await Promise.all(list.map((m) => this.dispatch(m, req, sessionHeader)));
    const responses = results.filter((r) => r !== null);
    if (!responses.length) {
      res.writeHead(202, sessionHeader).end();
      return;
    }
    this.reply(res, batch ? responses : responses[0], sessionHeader, req);
  }

  private reply(res: ServerResponse, body: unknown, headers: Record<string, string> = {}, req?: IncomingMessage) {
    const accept = String(req?.headers.accept ?? '');
    if (this.env.mcpResponseMode === 'sse' && accept.includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...headers });
      res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
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

  private async dispatch(m: RpcRequest, req: IncomingMessage, sessionHeader: Record<string, string>): Promise<unknown | null> {
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
        if (!exec) {
          this.stand.add('warn', 'mcp.unbound', taskId ? `Вызов ${name} с неизвестным x-task-id ${taskId}` : `Вызов ${name} без x-task-id`, { tool: name, args, taskId });
          const text = c ? renderString(c.errors.unknownTask, { tool: name }) : 'Неизвестный x-task-id';
          return ok({ content: [{ type: 'text', text }], isError: true } satisfies McpCallResult);
        }
        try {
          return ok(await exec.handleToolCall(name, args, taskId!));
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
