// REST-подключение агента (AG-01, AG-02): шаблон запроса, заголовки x-task-id и x-a2a-sender-id, разбор ответа.
import crypto from 'node:crypto';
import type { AgentDef } from '../config/types.js';
import { resolveEnvRefs } from '../config/loader.js';
import { deepClone, maskHeaders, maskUrl } from '../util/core.js';
import { queryPath, setPath, PathError } from '../util/jsonpath.js';
import { renderDeep } from '../util/template.js';
import { finishExchange, maskedHeaders, startExchange, type HttpExchange } from '../util/httplog.js';
import { httpRequest, type HttpReply } from '../util/request.js';

export type AgentErrorKind = 'timeout' | 'http' | 'network' | 'parse' | 'aborted' | 'agent' | 'config';

export class AgentError extends Error {
  /** Запрос дошёл до агента, а ответа нет: агент мог продолжить работу, и его сессия ещё занята. */
  unfinished = false;
  constructor(
    public kind: AgentErrorKind,
    message: string,
    public httpStatus?: number,
    public body?: string,
    /** HTTP-обмен, если запрос до агента был отправлен. */
    public exchange?: HttpExchange,
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
  exchange: HttpExchange;
}

export interface SendOptions {
  text: string;
  taskId: string;
  senderId: string;
  timeoutMs: number;
  /** Сверх срока: запрос встанет в очередь агента за прерванным и подождёт, пока тот закончится. */
  waitMs?: number;
  signal?: AbortSignal;
  /** Подпись обмена в журнале HTTP: реплика, стартовое сообщение, команда. */
  label?: string;
  /** Обмен создан (start) и завершён (end): журнал HTTP видит и висящий запрос. */
  onExchange?: (x: HttpExchange, phase: 'start' | 'end') => void;
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
  const envHeaders: string[] = [];
  for (const [k, v] of Object.entries(agent.request.headers)) {
    const r = resolveEnvRefs(v, env);
    missing.push(...r.missing);
    headers[k] = r.value;
    if (v.includes('${env:')) envHeaders.push(k);
  }
  headers[agent.request.taskIdHeader] = opts.taskId;
  headers[agent.request.senderIdHeader] = opts.senderId;
  const vars = { text: opts.text, taskId: opts.taskId, senderId: opts.senderId, messageId: crypto.randomUUID() };
  const body: any = renderDeep(deepClone(agent.request.body), vars);
  try {
    if (agent.request.textPath) setPath(body, agent.request.textPath, opts.text);
  } catch (e) {
    throw new AgentError('config', e instanceof PathError ? e.message : String(e));
  }
  return { url: url.value, headers, envHeaders, body, missing };
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
    const bodyText = JSON.stringify(req.body);
    const x = startExchange(
      'agent',
      opts.label ?? 'Запрос к агенту',
      { method: this.def.request.method, url: req.url, headers: maskHeaders(req.headers, req.envHeaders), body: bodyText },
      { taskId: opts.taskId, senderId: opts.senderId },
    );
    opts.onExchange?.(x, 'start');
    const fail = (err: AgentError): AgentError => {
      if (!x.finishedAt) finishExchange(x, null, err.message);
      err.exchange = x;
      opts.onExchange?.(x, 'end');
      return err;
    };
    const started = Date.now();
    const limitMs = (this.def.request.timeoutMs ?? opts.timeoutMs) + (opts.waitMs ?? 0);
    const timeout = AbortSignal.timeout(limitMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: HttpReply;
    try {
      // node:http, а не fetch: у fetch ожидание заголовков ответа ограничено 300 с, а A2A в режиме sync отдаёт их в конце хода.
      res = await httpRequest(this.def.request.method, req.url, req.headers, bodyText, signal);
    } catch (e: any) {
      const err = opts.signal?.aborted
        ? new AgentError('aborted', 'Запрос агенту прерван остановкой')
        : timeout.aborted
          ? new AgentError('timeout', e?.responded ? 'Агент не дослал ответ до таймаута' : `Агент не ответил за ${Math.round(limitMs / 1000)} с`)
          : e?.responded
            ? new AgentError('network', `Ответ агента оборвался: ${e?.message ?? e}`)
            : new AgentError('network', `Агент недоступен: ${e?.code ?? e?.message ?? e}`);
      err.unfinished = e?.sent === true && e?.responded !== true;
      throw fail(err);
    }
    finishExchange(x, { status: res.status, headers: maskedHeaders(res.headers), body: res.text });
    if (res.status < 200 || res.status > 299) throw fail(new AgentError('http', `Агент вернул HTTP ${res.status}`, res.status, res.text.slice(0, 2000)));
    let raw: unknown;
    try {
      raw = JSON.parse(res.text);
    } catch {
      throw fail(new AgentError('parse', 'Ответ агента — не JSON', res.status, res.text.slice(0, 2000)));
    }
    let parsed: ReturnType<typeof parseReply>;
    try {
      parsed = parseReply(this.def, raw);
    } catch (e) {
      throw fail(e instanceof AgentError ? e : new AgentError('parse', String(e)));
    }
    if (parsed.agentError) throw fail(new AgentError('agent', `Агент сообщил об ошибке: ${parsed.agentError}`, res.status, res.text.slice(0, 2000)));
    opts.onExchange?.(x, 'end');
    return {
      text: parsed.text,
      status: parsed.status,
      usage: parsed.usage,
      httpStatus: res.status,
      durationMs: Date.now() - started,
      request: { url: maskUrl(req.url), headers: maskHeaders(req.headers, req.envHeaders), body: req.body },
      raw,
      exchange: x,
    };
  }

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
