// Простой журнал процесса. События стенда, видимые пользователю, ведёт StandLog.
import { nowIso } from './core.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let current: Level = 'info';
export function setLogLevel(l: Level): void {
  current = l;
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (LEVELS[level] < LEVELS[current]) return;
  const line = `${nowIso()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) out(line, extra);
  else out(line);
}

export function logger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => write('debug', scope, m, x),
    info: (m: string, x?: unknown) => write('info', scope, m, x),
    warn: (m: string, x?: unknown) => write('warn', scope, m, x),
    error: (m: string, x?: unknown) => write('error', scope, m, x),
  };
}
export type Logger = ReturnType<typeof logger>;
