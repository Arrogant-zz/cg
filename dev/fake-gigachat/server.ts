// fake-gigachat: GigaChat API v1 и v2 для офлайн-тестов, по OpenAPI developers.sber.ru (октябрь 2026).
// По HTTPS требует клиентский сертификат, подписанный переданным CA. Запрос сверяется со схемой: нарушение — HTTP 422, как у GigaChat.
// Модель с суффиксом -blacklist или -length имитирует срабатывание фильтра или обрезку ответа.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { fakeAnswer } from '../fake-llm/brain.js';

export interface FakeGigaChatRequest {
  path: string;
  body: any;
  /** CN клиентского сертификата. */
  client: string | null;
  requestId: string | null;
}

export interface FakeGigaChat {
  server: http.Server;
  /** Корень API: провайдер добавляет /v1/chat/completions или /v2/chat/completions. */
  url: string;
  requests: FakeGigaChatRequest[];
  close(): Promise<void>;
}

const V1_KEYS = ['model', 'messages', 'function_call', 'functions', 'temperature', 'top_p', 'stream', 'max_tokens', 'repetition_penalty', 'update_interval', 'response_format'];
const V2_KEYS = ['model', 'messages', 'model_options', 'stream', 'disable_filter', 'ranker_options', 'user_info', 'tool_config', 'tools', 'flags'];
const V2_OPTIONS = ['temperature', 'top_p', 'max_tokens', 'repetition_penalty', 'update_interval', 'unnormalized_history', 'top_logprobs', 'response_format', 'parallel_tool_calls'];

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownKeys(o: Record<string, unknown>, allowed: string[], where: string): string | null {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  return extra.length ? `${where}: неизвестные поля ${extra.join(', ')}` : null;
}

function checkSampling(o: Record<string, any>, where: string): string | null {
  if (o.temperature !== undefined && !(typeof o.temperature === 'number' && o.temperature > 0)) return `${where}.temperature: нужно число больше 0`;
  if (o.top_p !== undefined && !(typeof o.top_p === 'number' && o.top_p >= 0 && o.top_p <= 1)) return `${where}.top_p: нужно число от 0 до 1`;
  if (o.max_tokens !== undefined && !(Number.isInteger(o.max_tokens) && o.max_tokens > 0)) return `${where}.max_tokens: нужно целое больше 0`;
  if (o.stream === true) return 'stream: fake-gigachat не поддерживает поток';
  const f = o.response_format;
  if (f !== undefined) {
    if (!isObj(f)) return `${where}.response_format: нужен объект`;
    if (f.type === 'text') return unknownKeys(f, ['type'], `${where}.response_format`);
    if (f.type !== 'json_schema') return `${where}.response_format.type: text или json_schema`;
    if (!isObj(f.schema)) return `${where}.response_format.schema: нужна JSON-схема`;
    if (f.strict !== undefined && typeof f.strict !== 'boolean') return `${where}.response_format.strict: нужно boolean`;
    return unknownKeys(f, ['type', 'schema', 'strict'], `${where}.response_format`);
  }
  return null;
}

function checkV1(b: any): string | null {
  if (!isObj(b)) return 'тело — не объект';
  if (typeof b.model !== 'string' || !b.model) return 'model: обязательное поле';
  if (!Array.isArray(b.messages) || !b.messages.length) return 'messages: обязательное поле';
  for (const [i, m] of b.messages.entries()) {
    if (!['system', 'user', 'assistant', 'function'].includes(m?.role)) return `messages[${i}].role: system, user, assistant или function`;
    if (typeof m.content !== 'string') return `messages[${i}].content: нужна строка`;
    if (m.role === 'system' && i > 0) return 'Invalid params: system message must be the first message';
  }
  return unknownKeys(b, V1_KEYS, 'запрос') ?? checkSampling(b, 'запрос');
}

function checkV2(b: any): string | null {
  if (!isObj(b)) return 'тело — не объект';
  if (typeof b.model !== 'string' || !b.model) return 'model: обязательное поле';
  if (!Array.isArray(b.messages) || !b.messages.length) return 'messages: обязательное поле';
  for (const [i, m] of b.messages.entries()) {
    if (!['system', 'user', 'assistant', 'tool'].includes(m?.role)) return `messages[${i}].role: system, user, assistant или tool`;
    if (!Array.isArray(m.content) || !m.content.length) return `messages[${i}].content: нужен массив частей`;
    for (const [j, part] of m.content.entries()) {
      if (!isObj(part) || !['text', 'files', 'function_result', 'function_call', 'inline_data'].some((k) => k in part)) return `messages[${i}].content[${j}]: нет text, files, function_result, function_call или inline_data`;
      if ('text' in part && typeof part.text !== 'string') return `messages[${i}].content[${j}].text: нужна строка`;
    }
  }
  const extra = unknownKeys(b, V2_KEYS, 'запрос');
  if (extra) return extra;
  if (b.stream === true) return 'stream: fake-gigachat не поддерживает поток';
  if (b.model_options === undefined) return null;
  if (!isObj(b.model_options)) return 'model_options: нужен объект';
  return unknownKeys(b.model_options, V2_OPTIONS, 'model_options') ?? checkSampling(b.model_options, 'model_options');
}

const textOf = (content: unknown): string => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : '');

function finishFor(model: string, blocked: string): string {
  if (model.endsWith('-blacklist')) return blocked;
  if (model.endsWith('-length')) return 'length';
  return 'stop';
}

export async function startFakeGigaChat(opts: { port?: number; host?: string; tls?: { cert: string | Buffer; key: string | Buffer; ca: string | Buffer } | null } = {}): Promise<FakeGigaChat> {
  const requests: FakeGigaChatRequest[] = [];
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
    const version = req.method === 'POST' && req.url === '/v1/chat/completions' ? 'v1' : req.method === 'POST' && req.url === '/v2/chat/completions' ? 'v2' : null;
    if (!version) return send(404, { status: 404, message: 'Not found' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, { status: 400, message: 'Bad request format' });
    }
    const peer = (req.socket as TLSSocket).getPeerCertificate?.();
    const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null;
    requests.push({ path: req.url!, body, client: peer?.subject?.CN ? String(peer.subject.CN) : null, requestId });
    const problem = version === 'v1' ? checkV1(body) : checkV2(body);
    if (problem) return send(422, { status: 422, message: problem });
    const system = textOf(body.messages.find((m: any) => m.role === 'system')?.content);
    const user = textOf(body.messages.find((m: any) => m.role === 'user')?.content);
    const content = fakeAnswer(system, user);
    const input = Math.ceil((system.length + user.length) / 4);
    const output = Math.ceil(content.length / 4);
    const created = Math.floor(Date.now() / 1000);
    if (version === 'v1') {
      return send(200, {
        choices: [{ message: { role: 'assistant', content }, index: 0, finish_reason: finishFor(body.model, 'blacklist') }],
        created,
        model: `${body.model}:2.0.28.2`,
        object: 'chat.completion',
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, precached_prompt_tokens: 0 },
      });
    }
    return send(200, {
      model: `${body.model}:2.0.28.2`,
      thread_id: crypto.randomUUID(),
      created_at: created,
      messages: [{ message_id: crypto.randomUUID(), role: 'assistant', content: [{ text: content }] }],
      finish_reason: finishFor(body.model, 'response_blacklist'),
      usage: { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, total_tokens: input + output },
    });
  };
  const host = opts.host ?? '127.0.0.1';
  const server = opts.tls
    ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key, ca: opts.tls.ca, requestCert: true, rejectUnauthorized: true }, handler)
    : http.createServer(handler);
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, r));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `${opts.tls ? 'https' : 'http'}://${host}:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}
