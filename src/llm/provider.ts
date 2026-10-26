// LLM за своим интерфейсом (plan.md, п. 5): провайдер выбирается в models/*.yaml.
// openai-compatible — для внутреннего шлюза контура; gigachat-v1 и gigachat-v2 — GigaChat API с клиентским сертификатом;
// anthropic — через официальный SDK, если он установлен.
import crypto from 'node:crypto';
import type { ModelDef } from '../config/types.js';
import { resolveEnvRefs } from '../config/loader.js';
import { errorMessage, sleep } from '../util/core.js';
import { TlsFileError, describeNetError, isTlsError, missingTlsFiles, postJson, readTls, type TlsFiles } from './http.js';

export interface LlmUsage {
  input: number | null;
  output: number | null;
}

export interface LlmRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName: string;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage | null;
  model: string;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind = 'config' | 'http' | 'network' | 'timeout' | 'refusal' | 'truncated' | 'aborted' | 'sdk';

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Путь метода по умолчанию: baseUrl — корень API, для GigaChat без версии (https://…/api). */
const DEFAULT_PATH: Record<string, string> = {
  'openai-compatible': '/chat/completions',
  'gigachat-v1': '/v1/chat/completions',
  'gigachat-v2': '/v2/chat/completions',
};

const joinPath = (base: string, m: ModelDef) => `${base.replace(/\/+$/, '')}${m.path ?? DEFAULT_PATH[m.provider] ?? ''}`;

/** Адрес вызова до подстановки окружения — для справочника. */
export const endpointOf = (m: ModelDef): string | null => (m.baseUrl ? joinPath(m.baseUrl, m) : null);

const isGigaChat = (m: ModelDef) => m.provider === 'gigachat-v1' || m.provider === 'gigachat-v2';

function resolved(model: ModelDef, env: NodeJS.ProcessEnv) {
  const missing: string[] = [];
  const r = (v: string | null) => {
    if (v === null) return null;
    const x = resolveEnvRefs(v, env);
    missing.push(...x.missing);
    return x.value;
  };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(model.headers)) headers[k] = r(v) ?? '';
  const t = model.tls;
  // Пустое значение после подстановки (${env:NAME:-}) означает «не задано».
  const tls: TlsFiles | null = t ? { cert: r(t.cert) || null, key: r(t.key) || null, pfx: r(t.pfx) || null, passphrase: r(t.passphrase) || null, ca: r(t.ca) || null } : null;
  const baseUrl = r(model.baseUrl);
  const url = baseUrl ? joinPath(baseUrl, model) : null;
  const https = !!url?.startsWith('https://');
  // Клиентский сертификат необязателен: без файлов вызов идёт как есть — например, по http к sidecar Istio, который сам делает mTLS.
  const clientCert = !!(tls && (tls.cert || tls.key || tls.pfx));
  return { baseUrl, url, https, clientCert, apiKey: r(model.apiKey), name: r(model.model), headers, tls, missing };
}

type Resolved = ReturnType<typeof resolved>;

function tlsProblem(r: Resolved): string | null {
  if (!r.clientCert) return null;
  if (r.tls!.pfx && (r.tls!.cert || r.tls!.key)) return 'укажите либо tls.cert и tls.key, либо tls.pfx';
  if (!r.tls!.pfx && (!r.tls!.cert || !r.tls!.key)) return 'для клиентского сертификата нужны оба файла: tls.cert и tls.key';
  if (r.url && !r.https) return 'клиентский сертификат передаётся только по https: для http-адреса (например, внутри Istio) не задавайте tls.cert, tls.key и tls.pfx';
  return null;
}

/** Проверка без сетевых вызовов: что нужно модели, чтобы её можно было вызвать. */
export function modelReadiness(model: ModelDef, env: NodeJS.ProcessEnv): string | null {
  if (model.provider === 'deployment' || model.provider === 'agent-request') return null;
  const r = resolved(model, env);
  if (r.missing.length) return `не заданы переменные окружения: ${[...new Set(r.missing)].join(', ')}`;
  if ((model.provider === 'openai-compatible' || isGigaChat(model)) && (!r.baseUrl || !r.name)) return 'нет baseUrl или model';
  const problem = tlsProblem(r);
  if (problem) return problem;
  if (r.tls && r.https) {
    const absent = missingTlsFiles(r.tls);
    if (absent.length) return `нет файлов сертификата: ${absent.join(', ')}`;
  }
  return null;
}

/** Как модель авторизуется после подстановки окружения — для справочника; null, пока окружение не задано. */
export function modelAuth(model: ModelDef, env: NodeJS.ProcessEnv): string | null {
  if (model.provider === 'deployment' || model.provider === 'agent-request') return null;
  const r = resolved(model, env);
  if (r.missing.length) return null;
  const parts = [r.tls?.pfx ? 'клиентский сертификат PKCS#12' : r.clientCert ? 'клиентский сертификат' : '', r.apiKey ? 'токен' : ''].filter(Boolean);
  if (parts.length) return parts.join(' и ');
  if (r.url && !r.https) return 'без сертификата: http, защиту соединения обеспечивает сеть (Istio)';
  return 'без сертификата и токена';
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** POST с повторами при 429, 5xx и сетевых сбоях. Ошибки сертификата и остальные HTTP-ошибки не повторяются. */
async function postWithRetries(model: ModelDef, r: Resolved, body: unknown, signal: AbortSignal | undefined, headers: () => Record<string, string>): Promise<{ data: any; requestId: string | null }> {
  const p = model.params;
  const url = String(r.url);
  const text = JSON.stringify(body);
  const retries = p.retries ?? 2;
  const timeoutMs = p.timeoutMs ?? 120_000;
  let lastErr: LlmError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)), signal);
    let tls = null;
    try {
      tls = r.tls && r.https ? readTls(r.tls) : null;
    } catch (e) {
      throw new LlmError('config', e instanceof TlsFileError ? e.message : errorMessage(e));
    }
    const h = headers();
    const requestId = h['X-Request-ID'] ?? null;
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await postJson(url, h, text, tls, sig);
    } catch (e: any) {
      if (signal?.aborted) throw new LlmError('aborted', 'Вызов модели прерван');
      if (timeout.aborted) {
        lastErr = new LlmError('timeout', `Модель не ответила за ${Math.round(timeoutMs / 1000)} с`);
        continue;
      }
      const code = String(e?.code ?? '');
      const text = describeNetError(e, r.clientCert);
      // Ключ не расшифрован или не подходит к сертификату — ошибка настройки, до соединения с моделью.
      if (/^ERR_OSSL_/.test(code) || /bad decrypt|key values mismatch|no start line/i.test(String(e?.message))) throw new LlmError('config', `Клиентский сертификат не загружен: ${text}`);
      const err = new LlmError('network', `Модель недоступна: ${text}`);
      if (isTlsError(code)) throw err;
      lastErr = err;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const rid = requestId ? ` (X-Request-ID ${requestId})` : '';
      const certHint = r.clientCert && (res.status === 401 || res.status === 403 || /SSL certificate|client certificate/i.test(res.text)) ? '. Проверьте клиентский сертификат и его права доступа: tls.cert и tls.key или tls.pfx' : '';
      lastErr = new LlmError('http', `Модель вернула HTTP ${res.status}${rid}: ${res.text.slice(0, 300)}${certHint}`, res.status);
      if (RETRYABLE.has(res.status)) {
        const ra = Number(res.headers['retry-after']);
        if (ra > 0 && ra < 60) await sleep(ra * 1000, signal);
        continue;
      }
      throw lastErr;
    }
    try {
      return { data: JSON.parse(res.text), requestId };
    } catch {
      throw new LlmError('http', 'Ответ модели — не JSON');
    }
  }
  throw lastErr ?? new LlmError('network', 'Модель недоступна');
}

function ready(model: ModelDef, env: NodeJS.ProcessEnv) {
  const r = resolved(model, env);
  if (r.missing.length) throw new LlmError('config', `Не заданы переменные окружения: ${[...new Set(r.missing)].join(', ')}`);
  const problem = tlsProblem(r);
  if (problem) throw new LlmError('config', `Клиентский сертификат: ${problem}`);
  return r;
}

class OpenAiCompatible implements LlmProvider {
  constructor(
    private model: ModelDef,
    private env: NodeJS.ProcessEnv,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const r = ready(this.model, this.env);
    const p = this.model.params;
    const body: Record<string, unknown> = {
      model: r.name,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    };
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.maxTokens !== undefined) body.max_tokens = p.maxTokens;
    const fmt = p.responseFormat ?? 'json_schema';
    if (fmt === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } };
    else if (fmt === 'json_object') body.response_format = { type: 'json_object' };
    const headers = () => {
      const h: Record<string, string> = { 'Content-Type': 'application/json', ...r.headers };
      if (r.apiKey) h.Authorization = `Bearer ${r.apiKey}`;
      return h;
    };
    const { data } = await postWithRetries(this.model, r, body, req.signal, headers);
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (choice?.finish_reason === 'length') throw new LlmError('truncated', 'Ответ модели обрезан по max_tokens');
    if (typeof content !== 'string') throw new LlmError('http', 'В ответе модели нет choices[0].message.content');
    return {
      text: content,
      usage: data.usage ? { input: data.usage.prompt_tokens ?? null, output: data.usage.completion_tokens ?? null } : null,
      model: data.model ?? String(r.name),
    };
  }
}

/** finish_reason GigaChat, которые означают отказ фильтра, а не ошибку формата. */
const GIGACHAT_BLOCKED = new Set(['blacklist', 'request_blacklist', 'request_whitelist', 'request_filter', 'response_blacklist']);

/**
 * GigaChat API: v1 — POST /v1/chat/completions, v2 — POST /v2/chat/completions (OpenAPI developers.sber.ru, октябрь 2026).
 * Авторизация — клиентский сертификат (mTLS), если заданы его файлы; без них — адрес как есть, например http внутри Istio.
 * Токен в Authorization добавляется, только если задан apiKey.
 */
class GigaChat implements LlmProvider {
  constructor(
    private model: ModelDef,
    private env: NodeJS.ProcessEnv,
    private version: 'v1' | 'v2',
  ) {}

  body(req: LlmRequest, name: string): Record<string, unknown> {
    const p = this.model.params;
    const options: Record<string, unknown> = {};
    if (p.temperature !== undefined) options.temperature = p.temperature;
    if (p.maxTokens !== undefined) options.max_tokens = p.maxTokens;
    // Структурированный ответ GigaChat: схема лежит прямо в response_format, без обёртки json_schema.
    if ((p.responseFormat ?? 'json_schema') === 'json_schema') options.response_format = { type: 'json_schema', schema: req.schema, strict: true };
    if (this.version === 'v1') {
      return {
        model: name,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        stream: false,
        ...options,
      };
    }
    return {
      model: name,
      messages: [
        { role: 'system', content: [{ text: req.system }] },
        { role: 'user', content: [{ text: req.user }] },
      ],
      ...(Object.keys(options).length ? { model_options: options } : {}),
      stream: false,
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const r = ready(this.model, this.env);
    const headers = () => {
      const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-ID': crypto.randomUUID(), ...r.headers };
      if (r.apiKey) h.Authorization = `Bearer ${r.apiKey}`;
      return h;
    };
    const { data, requestId } = await postWithRetries(this.model, r, this.body(req, String(r.name)), req.signal, headers);
    const rid = requestId ? ` (X-Request-ID ${requestId})` : '';
    let finish: string | undefined;
    let text: unknown;
    let usage: LlmUsage | null = null;
    if (this.version === 'v1') {
      const choice = data?.choices?.[0];
      finish = choice?.finish_reason;
      text = choice?.message?.content;
      if (data?.usage) usage = { input: data.usage.prompt_tokens ?? null, output: data.usage.completion_tokens ?? null };
    } else {
      finish = data?.finish_reason;
      const blocks = (Array.isArray(data?.messages) ? data.messages : []).filter((m: any) => m?.role === 'assistant').flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
      const parts = blocks.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text);
      text = parts.length ? parts.join('') : undefined;
      if (data?.usage) usage = { input: data.usage.input_tokens ?? null, output: data.usage.output_tokens ?? null };
    }
    if (finish === 'length') throw new LlmError('truncated', `Ответ модели обрезан по max_tokens${rid}`);
    if (finish && GIGACHAT_BLOCKED.has(finish)) throw new LlmError('refusal', `GigaChat не ответил: сработал фильтр (finish_reason ${finish})${rid}`);
    if (finish === 'error' || finish === 'function_call' || finish === 'function_call_error') throw new LlmError('http', `GigaChat завершил ответ с finish_reason ${finish}${rid}`);
    if (typeof text !== 'string') throw new LlmError('http', `В ответе GigaChat нет текста: ${this.version === 'v1' ? 'choices[0].message.content' : 'messages[].content[].text'}${rid}`);
    return { text, usage, model: data.model ?? String(r.name) };
  }
}

/** Модели, для которых по умолчанию включается серверный fallback при отказе (stop_reason: refusal). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

class AnthropicProvider implements LlmProvider {
  private client: any;
  constructor(
    private model: ModelDef,
    private env: NodeJS.ProcessEnv,
  ) {}

  private async sdk(): Promise<any> {
    if (this.client) return this.client;
    let mod: any;
    const name = '@anthropic-ai/sdk';
    try {
      mod = await import(name);
    } catch {
      throw new LlmError('config', 'Для provider: anthropic нужен пакет @anthropic-ai/sdk (optionalDependencies)');
    }
    const Anthropic = mod.default ?? mod.Anthropic;
    const r = resolved(this.model, this.env);
    if (r.missing.length) throw new LlmError('config', `Не заданы переменные окружения: ${[...new Set(r.missing)].join(', ')}`);
    const p = this.model.params;
    this.client = new Anthropic({
      ...(r.apiKey ? { apiKey: r.apiKey } : {}),
      ...(r.baseUrl ? { baseURL: r.baseUrl } : {}),
      timeout: p.timeoutMs ?? 600_000,
      maxRetries: p.retries ?? 2,
      ...(Object.keys(r.headers).length ? { defaultHeaders: r.headers } : {}),
    });
    (this.client as any).__errors = { APIError: Anthropic.APIError, APIConnectionTimeoutError: Anthropic.APIConnectionTimeoutError, APIConnectionError: Anthropic.APIConnectionError, APIUserAbortError: Anthropic.APIUserAbortError };
    return this.client;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const client = await this.sdk();
    const r = resolved(this.model, this.env);
    const p = this.model.params;
    const modelName = String(r.name);
    const params: Record<string, any> = {
      model: modelName,
      max_tokens: p.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: { type: 'json_schema', schema: req.schema }, ...(p.effort ? { effort: p.effort } : {}) },
    };
    const useFallbacks = (p.fallbacks ?? (FALLBACK_MODELS.has(modelName) ? 'default' : 'off')) === 'default';
    const E = client.__errors;
    let msg: any;
    try {
      if (useFallbacks) {
        msg = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal: req.signal });
      } else {
        msg = await client.messages.create(params, { signal: req.signal });
      }
    } catch (e: any) {
      if (E.APIUserAbortError && e instanceof E.APIUserAbortError) throw new LlmError('aborted', 'Вызов модели прерван');
      if (E.APIConnectionTimeoutError && e instanceof E.APIConnectionTimeoutError) throw new LlmError('timeout', 'Модель не ответила вовремя');
      if (E.APIConnectionError && e instanceof E.APIConnectionError) throw new LlmError('network', `Модель недоступна: ${errorMessage(e)}`);
      if (E.APIError && e instanceof E.APIError) throw new LlmError('http', `Anthropic API ${e.status}: ${errorMessage(e)}`, e.status);
      throw new LlmError('sdk', errorMessage(e));
    }
    if (msg.stop_reason === 'refusal') {
      const cat = msg.stop_details?.category ? ` (${msg.stop_details.category})` : '';
      throw new LlmError('refusal', `Модель отказалась отвечать${cat}`);
    }
    if (msg.stop_reason === 'max_tokens') throw new LlmError('truncated', 'Ответ модели обрезан по max_tokens');
    const text = (msg.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    return { text, usage: msg.usage ? { input: msg.usage.input_tokens ?? null, output: msg.usage.output_tokens ?? null } : null, model: msg.model ?? modelName };
  }
}

export function createProvider(model: ModelDef, env: NodeJS.ProcessEnv): LlmProvider {
  if (model.provider === 'openai-compatible') return new OpenAiCompatible(model, env);
  if (model.provider === 'gigachat-v1') return new GigaChat(model, env, 'v1');
  if (model.provider === 'gigachat-v2') return new GigaChat(model, env, 'v2');
  if (model.provider === 'anthropic') return new AnthropicProvider(model, env);
  throw new LlmError('config', `Модель «${model.id}» (${model.provider}) нельзя вызвать как LLM`);
}

/** Извлекает JSON из ответа: допускает обёртку в ```json и текст вокруг объекта. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* дальше — поиск фрагмента */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* продолжаем */
    }
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('В ответе нет JSON-объекта');
}
