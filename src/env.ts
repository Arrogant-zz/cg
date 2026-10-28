// Переменные окружения ClawGym. Значения по умолчанию подобраны для локального запуска с fake-agent.
import path from 'node:path';

export interface Env {
  port: number;
  host: string;
  /** Справочники и настройки: contracts/, cases/, solutions/, baskets/, runs/, agents/, models/, metrics/, templates/, data/. */
  configDir: string;
  /** Изменяемые данные: results/ прогонов, sessions/ ручного режима, counters.json, secret.json. */
  varDir: string;
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
  /** Сколько следующий запрос ждёт в очереди агента за прерванным: стенд перестал ждать ответа, а агент мог продолжить работу. */
  agentBusyWaitMs: number;
  unmatchedMode: 'manual' | 'error';
  maxParallelSessions: number;
  requestRefSecret: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  raw: NodeJS.ProcessEnv;
}

/** Предел таймеров Node.js: больший срок setTimeout срабатывает сразу. */
const MAX_MS = 2_147_483_647;

/** Целое число из окружения в границах. Иначе запуск останавливается с именем переменной: молча подменённое значение незаметно. */
function int(e: NodeJS.ProcessEnv, name: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = e[name];
  if (v === undefined || v === '') return def;
  const n = /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
  if (Number.isSafeInteger(n) && n >= min && n <= max) return n;
  throw new Error(`${name}=«${v}»: нужно целое число ${max === Number.MAX_SAFE_INTEGER ? `не меньше ${min}` : `от ${min} до ${max}`}`);
}

/** Каталог внутри другого или тот же: при раздельной синхронизации с S3 файлы одного попадут в копию другого. */
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

export function loadEnv(e: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Env {
  // Решение владельца от 28.10.2026: справочники и данные — два независимых каталога. Старые переменные не подхватываются молча,
  // иначе результаты уйдут с постоянного тома в каталог по умолчанию.
  const legacy = ['CLAWGYM_HOME', 'CLAWGYM_DATA'].filter((k) => e[k] !== undefined && e[k] !== '');
  if (legacy.length) throw new Error(`${legacy.join(', ')} больше не ${legacy.length > 1 ? 'используются' : 'используется'}: задайте CLAWGYM_CONFIG (справочники) и CLAWGYM_VAR (результаты и сессии)`);
  const configDir = path.resolve(cwd, e.CLAWGYM_CONFIG || 'config');
  const varDir = path.resolve(cwd, e.CLAWGYM_VAR || 'var');
  if (overlaps(configDir, varDir)) throw new Error(`CLAWGYM_CONFIG (${configDir}) и CLAWGYM_VAR (${varDir}) не должны совпадать или лежать один в другом`);
  const unmatched = (e.UNMATCHED_MODE ?? 'manual').toLowerCase();
  const mode = (e.MCP_RESPONSE_MODE ?? 'json').toLowerCase();
  const level = (e.LOG_LEVEL ?? 'info').toLowerCase();
  return {
    port: int(e, 'PORT', 8080, 0, 65535),
    host: e.HOST ?? '0.0.0.0',
    configDir,
    varDir,
    webDir: path.resolve(cwd, e.CLAWGYM_WEB || 'web'),
    mcpPort: e.MCP_PORT ? int(e, 'MCP_PORT', 0, 0, 65535) : null,
    mcpPath: e.MCP_PATH ?? '/mcp',
    mcpTaskIdHeader: (e.MCP_TASK_ID_HEADER ?? 'x-task-id').toLowerCase(),
    mcpResponseMode: mode === 'sse' ? 'sse' : 'json',
    allowedHosts: (e.AGENT_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,::1')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    senderPrefix: e.SENDER_PREFIX ?? 'lab-',
    // Ожидания хода, MCP-вызова и служебных команд — от 1 мс; запас решения оператора и ожидание занятого агента могут быть нулём.
    agentMcpTimeoutMs: int(e, 'AGENT_MCP_TIMEOUT_MS', 600_000, 1, MAX_MS),
    operatorMarginMs: int(e, 'OPERATOR_DECISION_MARGIN_MS', 30_000, 0, MAX_MS),
    turnTimeoutMs: int(e, 'TURN_TIMEOUT_MS', 900_000, 1, MAX_MS),
    resetTimeoutMs: int(e, 'RESET_TIMEOUT_MS', 120_000, 1, MAX_MS),
    captureTimeoutMs: int(e, 'CAPTURE_TIMEOUT_MS', 300_000, 1, MAX_MS),
    curatorTimeoutMs: int(e, 'CURATOR_TIMEOUT_MS', 900_000, 1, MAX_MS),
    agentBusyWaitMs: int(e, 'AGENT_BUSY_WAIT_MS', 900_000, 0, MAX_MS),
    unmatchedMode: unmatched === 'error' ? 'error' : 'manual',
    maxParallelSessions: int(e, 'MAX_PARALLEL_SESSIONS', 2, 1),
    requestRefSecret: e.REQUEST_REF_SECRET ?? null,
    logLevel: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as Env['logLevel'],
    raw: e,
  };
}
