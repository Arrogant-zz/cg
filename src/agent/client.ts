// REST-подключение агента (AG-01, AG-02): шаблон запроса, заголовки x-task-id и x-a2a-sender-id, разбор ответа.
import crypto from 'node:crypto';
import type { AgentDef } from '../config/types.js';
import { resolveEnvRefs } from '../config/loader.js';
import { deepClone, maskHeaders } from '../util/core.js';
import { queryPath, setPath, PathError } from '../util/jsonpath.js';
import { renderDeep } from '../util/template.js';

export type AgentErrorKind = 'timeout' | 'http' | 'network' | 'parse' | 'aborted' | 'agent' | 'config';

export class AgentError extends Error {
  constructor(
    public kind: AgentErrorKind,
    message: string,
    public httpStatus?: number,
    public body?: string,
  ) {
    super(message);
  }
}

export interface AgentUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}

export interface AgentReply {
  text: string;
  status: string | null;
  usage: AgentUsage | null;
  httpStatus: number;
  durationMs: number;
  request: { url: string; headers: Record<string, string>; body: unknown };
  raw: unknown;
}

export interface SendOptions {
  text: string;
  taskId: string;
  senderId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Значение модели для model.switch: request. */
  modelValue?: string | null;
}

/** Хост адреса агента должен быть в AGENT_ALLOWED_HOSTS: стенд нельзя направить на ПРОМ. */
export function checkAllowedHost(url: string, allowed: string[]): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return `Адрес агента «${url}» не является URL`;
  }
  if (allowed.includes('*')) return null;
  const ok = allowed.some((a) => host === a || (a.startsWith('.') && host.endsWith(a)) || (a.startsWith('*.') && host.endsWith(a.slice(1))));
  return ok ? null : `Хост ${host} не входит в AGENT_ALLOWED_HOSTS (${allowed.join(', ')})`;
}

export function buildRequest(agent: AgentDef, env: NodeJS.ProcessEnv, opts: Omit<SendOptions, 'timeoutMs' | 'signal'>) {
  const missing: string[] = [];
  const url = resolveEnvRefs(agent.request.url, env);
  missing.push(...url.missing);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const [k, v] of Object.entries(agent.request.headers)) {
    const r = resolveEnvRefs(v, env);
    missing.push(...r.missing);
    headers[k] = r.value;
  }
  headers[agent.request.taskIdHeader] = opts.taskId;
  headers[agent.request.senderIdHeader] = opts.senderId;
  const vars = { text: opts.text, taskId: opts.taskId, senderId: opts.senderId, messageId: crypto.randomUUID(), model: opts.modelValue ?? '' };
  const body: any = renderDeep(deepClone(agent.request.body), vars);
  try {
    if (agent.request.textPath) setPath(body, agent.request.textPath, opts.text);
    if (agent.model.switch === 'request' && agent.model.path && opts.modelValue) setPath(body, agent.model.path, opts.modelValue);
  } catch (e) {
    throw new AgentError('config', e instanceof PathError ? e.message : String(e));
  }
  return { url: url.value, headers, body, missing };
}

function joinTexts(values: unknown[]): string {
  return values
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => v !== null && v !== undefined)
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join('\n')
    .trim();
}

function numberAt(obj: unknown, p: string | null): number | null {
  if (!p) return null;
  const v = queryPath(obj, p)[0];
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
}

export function parseReply(agent: AgentDef, raw: unknown): { text: string; status: string | null; usage: AgentUsage | null; agentError: string | null } {
  const r = agent.response;
  const texts = queryPath(raw, r.replyPath);
  const agentError = r.errorPath ? joinTexts(queryPath(raw, r.errorPath)) || null : null;
  const status = r.statusPath ? ((queryPath(raw, r.statusPath)[0] as any) ?? null) : null;
  const u = r.usage;
  const usage: AgentUsage = { input: numberAt(raw, u.inputPath), output: numberAt(raw, u.outputPath), total: numberAt(raw, u.totalPath) };
  const hasUsage = usage.input !== null || usage.output !== null || usage.total !== null;
  if (!texts.length && !agentError) {
    throw new AgentError('parse', `В ответе агента нет поля ${r.replyPath} — реплику извлечь нельзя`);
  }
  return { text: joinTexts(texts), status: status === null ? null : String(status), usage: hasUsage ? usage : null, agentError };
}

export class AgentClient {
  constructor(
    public def: AgentDef,
    private env: NodeJS.ProcessEnv,
    private allowedHosts: string[],
  ) {}

  async send(opts: SendOptions): Promise<AgentReply> {
    const req = buildRequest(this.def, this.env, opts);
    if (req.missing.length) throw new AgentError('config', `Не заданы переменные окружения: ${[...new Set(req.missing)].join(', ')}`);
    const hostErr = checkAllowedHost(req.url, this.allowedHosts);
    if (hostErr) throw new AgentError('config', hostErr);
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.def.request.timeoutMs ?? opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(req.url, { method: this.def.request.method, headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (e: any) {
      if (opts.signal?.aborted) throw new AgentError('aborted', 'Запрос агенту прерван остановкой');
      if (timeout.aborted) throw new AgentError('timeout', `Агент не ответил за ${Math.round((this.def.request.timeoutMs ?? opts.timeoutMs) / 1000)} с`);
      throw new AgentError('network', `Агент недоступен: ${e?.cause?.code ?? e?.message ?? e}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e: any) {
      if (timeout.aborted) throw new AgentError('timeout', 'Агент не дослал ответ до таймаута');
      throw new AgentError('network', `Ответ агента оборвался: ${e?.message ?? e}`);
    }
    if (!res.ok) throw new AgentError('http', `Агент вернул HTTP ${res.status}`, res.status, text.slice(0, 2000));
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AgentError('parse', 'Ответ агента — не JSON', res.status, text.slice(0, 2000));
    }
    const parsed = parseReply(this.def, raw);
    if (parsed.agentError) throw new AgentError('agent', `Агент сообщил об ошибке: ${parsed.agentError}`, res.status, text.slice(0, 2000));
    return {
      text: parsed.text,
      status: parsed.status,
      usage: parsed.usage,
      httpStatus: res.status,
      durationMs: Date.now() - started,
      request: { url: req.url, headers: maskHeaders(req.headers), body: req.body },
      raw,
    };
  }

  /** ok: null — доступность не проверялась: у подключения нет healthUrl. */
  async health(): Promise<{ ok: boolean | null; note: string }> {
    const base = resolveEnvRefs(this.def.request.url, this.env);
    if (base.missing.length) return { ok: false, note: `не заданы ${base.missing.join(', ')}` };
    if (!this.def.healthUrl) return { ok: null, note: 'доступность не проверяется' };
    const url = resolveEnvRefs(this.def.healthUrl, this.env);
    if (url.missing.length) return { ok: false, note: `не заданы ${url.missing.join(', ')}` };
    try {
      const res = await fetch(url.value, { signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, note: res.ok ? 'доступен' : `HTTP ${res.status}` };
    } catch (e: any) {
      return { ok: false, note: `недоступен: ${e?.cause?.code ?? e?.message ?? e}` };
    }
  }
}
