// LLM за своим интерфейсом (plan.md, п. 5): провайдер выбирается в models/*.yaml.
// openai-compatible — для внутреннего шлюза контура; anthropic — через официальный SDK, если он установлен.
import type { ModelDef } from '../config/types.js';
import { resolveEnvRefs } from '../config/loader.js';
import { errorMessage, sleep } from '../util/core.js';

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
  return { baseUrl: r(model.baseUrl), apiKey: r(model.apiKey), name: r(model.model), headers, missing };
}

/** Проверка без сетевых вызовов: что нужно модели, чтобы её можно было вызвать. */
export function modelReadiness(model: ModelDef, env: NodeJS.ProcessEnv): string | null {
  if (model.provider === 'deployment' || model.provider === 'agent-request') return null;
  const r = resolved(model, env);
  if (r.missing.length) return `не заданы переменные окружения: ${[...new Set(r.missing)].join(', ')}`;
  if (model.provider === 'openai-compatible' && (!r.baseUrl || !r.name)) return 'нет baseUrl или model';
  return null;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

class OpenAiCompatible implements LlmProvider {
  constructor(
    private model: ModelDef,
    private env: NodeJS.ProcessEnv,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const r = resolved(this.model, this.env);
    if (r.missing.length) throw new LlmError('config', `Не заданы переменные окружения: ${[...new Set(r.missing)].join(', ')}`);
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...r.headers };
    if (r.apiKey) headers.Authorization = `Bearer ${r.apiKey}`;
    const url = `${String(r.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const retries = p.retries ?? 2;
    let lastErr: LlmError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)), req.signal);
      const timeout = AbortSignal.timeout(p.timeoutMs ?? 120_000);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      } catch (e: any) {
        if (req.signal?.aborted) throw new LlmError('aborted', 'Вызов модели прерван');
        lastErr = timeout.aborted ? new LlmError('timeout', `Модель не ответила за ${Math.round((p.timeoutMs ?? 120_000) / 1000)} с`) : new LlmError('network', `Модель недоступна: ${e?.cause?.code ?? e?.message ?? e}`);
        continue;
      }
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        lastErr = new LlmError('http', `Модель вернула HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
        if (RETRYABLE.has(res.status)) {
          const ra = Number(res.headers.get('retry-after'));
          if (ra > 0 && ra < 60) await sleep(ra * 1000, req.signal);
          continue;
        }
        throw lastErr;
      }
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new LlmError('http', 'Ответ модели — не JSON');
      }
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
    throw lastErr ?? new LlmError('network', 'Модель недоступна');
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
