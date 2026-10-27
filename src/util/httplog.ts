// HTTP-обмены для разбора: запрос ClawGym к агенту, запрос агента к MCP-серверу ClawGym и вызовы LLM-оператора и судьи.
// Заголовки авторизации маскируются, тела ограничены по размеру.
import type { IncomingHttpHeaders } from 'node:http';
import { isSecretName, maskSecret, maskUrl, nowIso, randomHex } from './core.js';

export const BODY_LIMIT = 256 * 1024;

export interface HttpPart {
  headers: Record<string, string>;
  body: string;
  bytes: number;
  truncated: boolean;
}

export interface HttpExchange {
  id: string;
  /** agent — ClawGym вызывает агента; mcp — агент вызывает MCP-сервер ClawGym; llm — ClawGym вызывает модель оператора или оценки. */
  kind: 'agent' | 'mcp' | 'llm';
  label: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  request: HttpPart & { method: string; url: string };
  response: (HttpPart & { status: number }) | null;
  error: string | null;
  taskId: string | null;
  senderId: string | null;
  mcpSessionId: string | null;
  execId: string | null;
  /** Событие журнала, к которому относится обмен: исходящая реплика, команда, вызов инструмента, решение оператора или оценка. */
  eventSeq: number | null;
  /** Ответ агента в журнале. */
  replySeq: number | null;
}

export function maskedHeaders(h: Record<string, string | string[] | undefined> | IncomingHttpHeaders | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === undefined) return;
    const key = k.toLowerCase();
    const val = Array.isArray(v) ? v.join(', ') : String(v);
    out[key] = isSecretName(key) ? maskSecret(val) : val;
  };
  if (typeof (h as Headers).forEach === 'function' && typeof (h as Headers).get === 'function') (h as Headers).forEach((v, k) => put(k, v));
  else for (const [k, v] of Object.entries(h)) put(k, v);
  return out;
}

export function clip(text: string): { body: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= BODY_LIMIT) return { body: text, bytes, truncated: false };
  // Разрезанный по границе байтов последний символ отбрасывается.
  return { body: Buffer.from(text).subarray(0, BODY_LIMIT).toString('utf8').replace(/\uFFFD$/, ''), bytes, truncated: true };
}

export function startExchange(
  kind: HttpExchange['kind'],
  label: string,
  req: { method: string; url: string; headers: Record<string, string>; body: string },
  ids: { taskId?: string | null; senderId?: string | null; mcpSessionId?: string | null } = {},
): HttpExchange {
  return {
    id: randomHex(6),
    kind,
    label,
    startedAt: nowIso(),
    finishedAt: null,
    durationMs: null,
    request: { method: req.method, url: maskUrl(req.url), headers: req.headers, ...clip(req.body) },
    response: null,
    error: null,
    taskId: ids.taskId ?? null,
    senderId: ids.senderId ?? null,
    mcpSessionId: ids.mcpSessionId ?? null,
    execId: null,
    eventSeq: null,
    replySeq: null,
  };
}

export function finishExchange(x: HttpExchange, res: { status: number; headers: Record<string, string>; body: string } | null, error: string | null = null): HttpExchange {
  x.finishedAt = nowIso();
  x.durationMs = Date.parse(x.finishedAt) - Date.parse(x.startedAt);
  x.response = res ? { status: res.status, headers: res.headers, ...clip(res.body) } : null;
  x.error = error;
  return x;
}
