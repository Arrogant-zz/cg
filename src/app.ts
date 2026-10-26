// Сборка приложения: настройки, MCP-сервер, раннер, ручной режим, журнал стенда, SSE.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from './env.js';
import type { Registry } from './config/types.js';
import { loadRegistry } from './config/loader.js';
import { McpServer, StandLog, TaskBindings } from './mcp/server.js';
import { ResultsStore } from './results/store.js';
import { RunManager } from './runner/runner.js';
import { ManualManager } from './manual/manual.js';
import { AgentClient } from './agent/client.js';
import { SseHub } from './util/sse.js';
import { KeyedMutex, Semaphore } from './util/sync.js';
import { buildRoutes } from './api/routes.js';
import { serveStatic } from './util/http.js';
import { logger, setLogLevel } from './util/log.js';
import { errorMessage, nowIso } from './util/core.js';

const log = logger('app');
export const VERSION = '0.1.0';

export interface AgentHealth {
  ok: boolean | null;
  note: string;
  at: string;
}

export class App {
  registry!: Registry;
  store: ResultsStore;
  bindings = new TaskBindings();
  stand = new StandLog();
  sse = new SseHub();
  sessions: Semaphore;
  locks = new KeyedMutex();
  secret = '';
  runs: RunManager;
  manual: ManualManager;
  mcp: McpServer;
  health = new Map<string, AgentHealth>();
  version = VERSION;
  private servers: http.Server[] = [];
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(public env: Env) {
    setLogLevel(env.logLevel);
    this.store = new ResultsStore(env.dataDir);
    this.sessions = new Semaphore(env.maxParallelSessions);
    this.runs = new RunManager(this);
    this.manual = new ManualManager(this);
    this.mcp = new McpServer(env, () => this.registry?.contract ?? null, this.bindings, this.stand, VERSION);
    this.stand.onAdd((e) => this.publish('stand', 'stand', e));
  }

  async init(): Promise<void> {
    await this.store.init();
    this.secret = await this.store.secret(this.env.requestRefSecret);
    await this.reload();
    await this.runs.init();
    await this.manual.init();
    if (this.env.maxParallelSessions > 3) this.stand.add('warn', 'sessions', `MAX_PARALLEL_SESSIONS=${this.env.maxParallelSessions}: стенд по сведениям от 15 октября выдерживает 2–3 сессии`);
  }

  async reload(): Promise<Registry> {
    const reg = await loadRegistry(this.env.home, this.env.dataDir);
    this.registry = reg;
    const errors = reg.issues.filter((i) => i.severity === 'error').length;
    log.info(`Настройки: ${reg.fileCount} файлов, кейсов ${reg.cases.size}, решений ${reg.solutions.size}, корзин ${reg.baskets.size}, ошибок ${errors}`);
    this.publish('config', 'config', { loadedAt: reg.loadedAt, errors });
    void this.checkHealth();
    return reg;
  }

  publish(topic: string, type: string, data: unknown): void {
    this.sse.publish(topic, type, data);
  }

  async checkHealth(): Promise<void> {
    for (const a of this.registry.agents.values()) {
      try {
        const h = await new AgentClient(a, this.env.raw, this.env.allowedHosts).health();
        this.health.set(a.id, { ...h, at: nowIso() });
      } catch (e) {
        this.health.set(a.id, { ok: false, note: errorMessage(e), at: nowIso() });
      }
    }
    this.publish('stand', 'health', Object.fromEntries(this.health));
  }

  /** HTTP: интерфейс, API, SSE и MCP на одном порту; MCP — ещё и на отдельном, если задан MCP_PORT. */
  async listen(): Promise<{ port: number; mcpPort: number | null }> {
    const routes = buildRoutes(this);
    const handler = async (req: http.IncomingMessage, res: http.ServerResponse, mcpOnly: boolean) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === this.env.mcpPath || url.pathname === `${this.env.mcpPath}/`) return this.mcp.handle(req, res);
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: VERSION, configLoadedAt: this.registry.loadedAt }));
        return;
      }
      if (mcpOnly) {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname === '/api/events') {
        const topics = url.searchParams.get('topics');
        this.sse.attach(req, res, topics ? topics.split(',') : null);
        return;
      }
      if (await routes.handle(req, res)) return;
      if (req.method === 'GET') {
        if (url.pathname.startsWith('/static/') && serveStatic(this.env.webDir, url.pathname.slice('/static/'.length), res)) return;
        if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
          if (serveStatic(this.env.webDir, 'assets/clawgym-icon.svg', res, 'max-age=86400')) return;
        }
        if (!url.pathname.startsWith('/api/') && serveStatic(this.env.webDir, 'index.html', res)) return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Не найдено' }));
    };
    const main = http.createServer((req, res) => {
      handler(req, res, false).catch((e) => {
        log.error('Запрос', e);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    main.requestTimeout = 0;
    main.headersTimeout = 60_000;
    main.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve) => main.listen(this.env.port, this.env.host, resolve));
    this.servers.push(main);
    let mcpPort: number | null = null;
    if (this.env.mcpPort !== null) {
      const ms = http.createServer((req, res) => {
        handler(req, res, true).catch(() => !res.headersSent && res.writeHead(500).end());
      });
      ms.requestTimeout = 0;
      await new Promise<void>((resolve) => ms.listen(this.env.mcpPort!, this.env.host, resolve));
      this.servers.push(ms);
      mcpPort = (ms.address() as AddressInfo).port;
    }
    this.healthTimer = setInterval(() => void this.checkHealth(), 30_000);
    this.healthTimer.unref();
    return { port: (main.address() as AddressInfo).port, mcpPort };
  }

  async close(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.runs.close();
    this.sse.close();
    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.close(() => r());
            s.closeAllConnections?.();
          }),
      ),
    );
  }
}
