// HTTP-запрос через node:http(s), а не fetch. У встроенного fetch ожидание заголовков ответа ограничено 300 с,
// а A2A в режиме sync отдаёт их только в конце хода; клиентский сертификат для GigaChat fetch тоже не принимает.
import http from 'node:http';
import https from 'node:https';

export interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** Ошибка запроса: sent — тело запроса ушло целиком, responded — пришли заголовки ответа. */
export type HttpRequestError = Error & { code?: string; sent: boolean; responded: boolean };

/** Срок ответа задаёт только signal: своих таймаутов у запроса нет. */
export function httpRequest(method: string, url: string, headers: Record<string, string>, body: string, signal: AbortSignal, tls: https.RequestOptions | null = null): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    let sent = false;
    let responded = false;
    const fail = (e: unknown) => reject(Object.assign(e instanceof Error ? e : new Error(String(e)), { sent, responded }));
    const u = new URL(url);
    // Без пула соединений: каждый вызов проходит рукопожатие с текущим сертификатом и паролем, ошибка не прячется за открытым соединением.
    const options: https.RequestOptions = { method, headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, signal, agent: false, ...(tls ?? {}) };
    let req: http.ClientRequest;
    try {
      req = u.protocol === 'https:' ? https.request(u, options) : http.request(u, options);
    } catch (e) {
      // Неверный ключ или пароль: ошибка возникает при сборке TLS-контекста, до соединения.
      fail(e);
      return;
    }
    req.on('finish', () => (sent = true));
    req.on('response', (res) => {
      responded = true;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
      res.on('close', () => {
        if (!res.complete) fail(Object.assign(new Error('ответ оборвался'), { code: 'ECONNRESET' }));
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}
