// Клиентский сертификат GigaChat (mTLS в контуре): файлы, их чтение и понятные ошибки. Сам запрос — util/request.ts.
import fs from 'node:fs';
import type { RequestOptions } from 'node:https';

/** Пути к файлам и пароль после подстановки окружения; пустая строка — не задано. */
export interface TlsFiles {
  cert: string | null;
  key: string | null;
  pfx: string | null;
  passphrase: string | null;
  ca: string | null;
}

export class TlsFileError extends Error {}

const FILES = ['cert', 'key', 'pfx', 'ca'] as const;

/** Файлы сертификата, которых нет на диске: проверка готовности без сетевых вызовов. */
export function missingTlsFiles(tls: TlsFiles): string[] {
  return FILES.filter((k) => tls[k] && !fs.existsSync(tls[k]!)).map((k) => `tls.${k}: ${tls[k]}`);
}

/** Содержимое файлов читается при каждом вызове: обновлённый сертификат подхватывается без перезапуска. */
export function readTls(tls: TlsFiles): RequestOptions {
  const out: RequestOptions = {};
  for (const k of FILES) {
    const file = tls[k];
    if (!file) continue;
    try {
      out[k] = fs.readFileSync(file);
    } catch (e: any) {
      throw new TlsFileError(`Не прочитан файл tls.${k} (${file}): ${e?.code ?? e?.message ?? e}`);
    }
  }
  if (tls.passphrase) out.passphrase = tls.passphrase;
  return out;
}

/** Ошибки сертификатов не лечатся повтором: их нужно исправить в настройках. */
export function isTlsError(code: string): boolean {
  return /^(ERR_SSL_|ERR_OSSL_|ERR_TLS_|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|HOSTNAME_MISMATCH)/.test(code);
}

/** Понятное объяснение сетевой ошибки: что проверить в настройках сертификата. */
export function describeNetError(e: any, withCert = false): string {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? e);
  if (withCert && (code === 'ECONNRESET' || code === 'EPIPE')) return `сервер сбросил соединение (${code}): возможно, он не принял клиентский сертификат — проверьте, кем он подписан`;
  if (/ALERT_(CERTIFICATE_REQUIRED|UNKNOWN_CA|BAD_CERTIFICATE|CERTIFICATE_UNKNOWN|ACCESS_DENIED|HANDSHAKE_FAILURE|CERTIFICATE_REVOKED|CERTIFICATE_EXPIRED)/.test(code)) {
    return `сервер не принял клиентский сертификат (${code}): проверьте tls.cert и tls.key или tls.pfx`;
  }
  if (['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)) {
    return `сертификат сервера не подтверждён (${code}): укажите в tls.ca корневой сертификат, которым он подписан`;
  }
  if (code === 'CERT_HAS_EXPIRED') return 'срок сертификата сервера истёк (CERT_HAS_EXPIRED)';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `имя сервера не совпадает с его сертификатом: ${msg}`;
  if (code === 'ERR_OSSL_BAD_DECRYPT' || /bad decrypt|mac verify failure/i.test(msg)) return `ключ не расшифрован (${code || msg}): проверьте tls.passphrase`;
  if (code === 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' || /key values mismatch/i.test(msg)) return 'ключ tls.key не подходит к сертификату tls.cert';
  if (code.startsWith('ERR_OSSL_PEM') || /no start line|unsupported/i.test(msg)) return `файл сертификата или ключа не прочитан (${code || msg}): нужен PEM или PKCS#12 в tls.pfx`;
  return code ? `${code}${msg && !msg.includes(code) ? `: ${msg}` : ''}` : msg;
}
