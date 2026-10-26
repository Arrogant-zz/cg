// Небольшие общие помощники: время, идентификаторы, хеши, ожидание.
import crypto from 'node:crypto';

export const nowIso = (): string => new Date().toISOString();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const e = new Error(typeof reason === 'string' ? reason : 'Операция прервана');
  e.name = 'AbortError';
  return e;
}

export const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

export const randomHex = (bytes = 4): string => crypto.randomBytes(bytes).toString('hex');

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

/** Короткая метка содержимого, как `@a91c` в дизайне. */
export const shortHash = (data: string | Buffer): string => sha256(data).slice(0, 4);

/**
 * request_ref по рекомендации INTEGRATION.md: HMAC-SHA256 от номера обращения
 * с секретом стенда, первые 32 hex-символа. Стабилен для одного выполнения и его capture.
 */
export const requestRef = (caseNumber: string, secret: string): string =>
  crypto.createHmac('sha256', secret).update(caseNumber).digest('hex').slice(0, 32);

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function deepClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isPlainObject(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

export function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Секрет в журнале: оставляем только первые символы. */
export function maskSecret(v: string): string {
  if (!v) return v;
  if (v.length <= 8) return '***';
  return v.slice(0, 4) + '***';
}

export const MASKED_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie'];
const SECRET_NAME = /auth|token|secret|passw|key|cookie|signature|credential/i;

/** Имя заголовка или параметра адреса, значение которого нельзя показывать. */
export const isSecretName = (name: string) => MASKED_HEADERS.includes(name.toLowerCase()) || SECRET_NAME.test(name);

/** extra — заголовки, значения которых подставлены из окружения (${env:NAME}): они скрываются при любом имени. */
export function maskHeaders(h: Record<string, string>, extra: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = isSecretName(k) || extra.includes(k) ? maskSecret(String(v)) : String(v);
  return out;
}

/** Пароль в адресе и секретные параметры запроса скрываются; относительный адрес остаётся относительным. */
export function maskUrl(raw: string): string {
  const base = 'http://relative.invalid';
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return raw;
  }
  let changed = false;
  if (u.password) {
    u.password = '***';
    changed = true;
  }
  for (const [k, v] of [...u.searchParams]) {
    if (!isSecretName(k)) continue;
    u.searchParams.set(k, maskSecret(v));
    changed = true;
  }
  if (!changed) return raw;
  return u.origin === base ? u.pathname + u.search + u.hash : u.toString();
}
