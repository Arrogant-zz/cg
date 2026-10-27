// Переменные окружения ClawGym. Значения по умолчанию подобраны для локального запуска с fake-agent.
import path from 'node:path';

export interface Env {
  port: number;
  host: string;
  /** Корень настроек: contracts/, cases/, solutions/, baskets/, runs/, agents/, models/, metrics/, data/. */
  home: string;
  /** Результаты прогонов, ручные сессии, полученные версии скиллов. */
  dataDir: string;
  webDir: string;
  mcpPort: number | null;
  mcpPath: string;
  mcpTaskIdHeader: string;
  mcpResponseMode: 'json' | 'sse';
  allowedHosts: string[];
  senderPrefix: string;
  agentMcpTimeoutMs: number;
  operatorMarginMs: number;
  turnTimeoutMs: number;
  resetTimeoutMs: number;
  captureTimeoutMs: number;
  curatorTimeoutMs: number;
  unmatchedMode: 'manual' | 'error';
  maxParallelSessions: number;
  requestRefSecret: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  raw: NodeJS.ProcessEnv;
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Ожидалось число, получено «${v}»`);
  return n;
}

export function loadEnv(e: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Env {
  const home = path.resolve(cwd, e.CLAWGYM_HOME ?? '.');
  const unmatched = (e.UNMATCHED_MODE ?? 'manual').toLowerCase();
  const mode = (e.MCP_RESPONSE_MODE ?? 'json').toLowerCase();
  const level = (e.LOG_LEVEL ?? 'info').toLowerCase();
  return {
    port: num(e.PORT, 8080),
    host: e.HOST ?? '0.0.0.0',
    home,
    dataDir: path.resolve(home, e.CLAWGYM_DATA ?? 'var'),
    webDir: path.resolve(e.CLAWGYM_WEB ?? path.join(home, 'web')),
    mcpPort: e.MCP_PORT ? num(e.MCP_PORT, 0) : null,
    mcpPath: e.MCP_PATH ?? '/mcp',
    mcpTaskIdHeader: (e.MCP_TASK_ID_HEADER ?? 'x-task-id').toLowerCase(),
    mcpResponseMode: mode === 'sse' ? 'sse' : 'json',
    allowedHosts: (e.AGENT_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,::1')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    senderPrefix: e.SENDER_PREFIX ?? 'lab-',
    agentMcpTimeoutMs: num(e.AGENT_MCP_TIMEOUT_MS, 600_000),
    operatorMarginMs: num(e.OPERATOR_DECISION_MARGIN_MS, 30_000),
    turnTimeoutMs: num(e.TURN_TIMEOUT_MS, 900_000),
    resetTimeoutMs: num(e.RESET_TIMEOUT_MS, 120_000),
    captureTimeoutMs: num(e.CAPTURE_TIMEOUT_MS, 300_000),
    curatorTimeoutMs: num(e.CURATOR_TIMEOUT_MS, 900_000),
    unmatchedMode: unmatched === 'error' ? 'error' : 'manual',
    maxParallelSessions: Math.max(1, num(e.MAX_PARALLEL_SESSIONS, 2)),
    requestRefSecret: e.REQUEST_REF_SECRET ?? null,
    logLevel: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as Env['logLevel'],
    raw: e,
  };
}
