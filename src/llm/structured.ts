// Структурированный ответ модели с проверкой схемы и одним повтором при ошибке формата (SOL-05).
import AjvModule from 'ajv';
import type { LlmProvider, LlmRequest, LlmUsage } from './provider.js';
import { LlmError, extractJson } from './provider.js';
import { errorMessage } from '../util/core.js';

const Ajv: any = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });

export interface Attempt {
  n: number;
  ok: boolean;
  kind?: 'llm' | 'format';
  error?: string;
  durationMs: number;
  usage: LlmUsage | null;
  text?: string;
}

export class StructuredError extends Error {
  constructor(
    public kind: 'llm' | 'format' | 'timeout' | 'aborted',
    message: string,
    public attempts: Attempt[],
  ) {
    super(message);
  }
}

export interface StructuredResult<T> {
  value: T;
  attempts: Attempt[];
  usage: LlmUsage | null;
  durationMs: number;
  model: string;
}

export function sumUsage(list: (LlmUsage | null | undefined)[]): LlmUsage | null {
  const present = list.filter(Boolean) as LlmUsage[];
  if (!present.length) return null;
  const add = (k: keyof LlmUsage) => (present.some((u) => u[k] !== null) ? present.reduce((s, u) => s + (u[k] ?? 0), 0) : null);
  return { input: add('input'), output: add('output') };
}

/**
 * check — смысловые проверки поверх схемы; возвращает список ошибок.
 * formatRetries — сколько раз переспросить модель с описанием ошибки формата.
 */
export async function structuredCall<T>(
  provider: LlmProvider,
  req: LlmRequest,
  check: (v: T) => string[],
  formatRetries = 1,
): Promise<StructuredResult<T>> {
  const validate = ajv.compile(req.schema);
  const attempts: Attempt[] = [];
  const started = Date.now();
  let user = req.user;
  let model = '';
  for (let n = 1; n <= formatRetries + 1; n++) {
    const t0 = Date.now();
    let text: string;
    let usage: LlmUsage | null = null;
    try {
      // Переспрос формата — отдельный обмен в журнале HTTP со своей подписью.
      const r = await provider.complete({ ...req, user, label: n > 1 && req.label ? `${req.label} · переспрос формата` : req.label });
      text = r.text;
      usage = r.usage;
      model = r.model;
    } catch (e) {
      const le = e instanceof LlmError ? e : new LlmError('unexpected', errorMessage(e));
      attempts.push({ n, ok: false, kind: 'llm', error: le.message, durationMs: Date.now() - t0, usage: null });
      const kind = le.kind === 'timeout' ? 'timeout' : le.kind === 'aborted' ? 'aborted' : 'llm';
      throw new StructuredError(kind, le.message, attempts);
    }
    let value: unknown;
    let errors: string[] = [];
    try {
      value = extractJson(text);
      if (!validate(value)) {
        errors = (validate.errors ?? []).map((e: any) => `${e.instancePath || '(корень)'} ${e.message}`);
      } else {
        errors = check(value as T);
      }
    } catch (e) {
      errors = [errorMessage(e)];
    }
    if (!errors.length) {
      attempts.push({ n, ok: true, durationMs: Date.now() - t0, usage, text });
      return { value: value as T, attempts, usage: sumUsage(attempts.map((a) => a.usage)), durationMs: Date.now() - started, model };
    }
    attempts.push({ n, ok: false, kind: 'format', error: errors.join('; '), durationMs: Date.now() - t0, usage, text });
    user =
      req.user +
      `\n\nПредыдущий ответ не прошёл проверку: ${errors.join('; ')}.\nВерни только JSON-объект строго по схеме, без пояснений вокруг.`;
  }
  throw new StructuredError('format', `Ответ модели не прошёл проверку формата: ${attempts[attempts.length - 1].error}`, attempts);
}
