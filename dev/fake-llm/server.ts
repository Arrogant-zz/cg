// fake-llm: OpenAI-совместимый /v1/chat/completions для офлайн-разработки и тестов.
// Заголовок X-Fake-Fail: operator | judge | format — имитация сбоев модели.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeJudge, fakeOperator } from './brain.js';

function extract(user: string): any {
  const m = /```json\s*([\s\S]*?)```/.exec(user);
  return JSON.parse(m ? m[1] : user);
}

export async function startFakeLlm(port = 0, host = '127.0.0.1'): Promise<{ server: http.Server; port: number; url: string }> {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end('{"error":"bad json"}');
      return;
    }
    const system = String(body.messages?.find((m: any) => m.role === 'system')?.content ?? '');
    const user = String(body.messages?.find((m: any) => m.role === 'user')?.content ?? '');
    const role = system.includes('judge-v') ? 'judge' : 'operator';
    const fail = String(req.headers['x-fake-fail'] ?? '');
    if (fail === role) {
      res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":{"message":"fake-llm: модель недоступна"}}');
      return;
    }
    let content: string;
    try {
      const ctx = extract(user);
      content = fail === 'format' ? 'Не JSON, а рассуждение' : JSON.stringify(role === 'judge' ? fakeJudge(ctx) : fakeOperator(ctx));
    } catch (e: any) {
      content = JSON.stringify({ error: `fake-llm не понял контекст: ${e?.message}` });
    }
    const out = {
      id: `fake-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: 0 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const p = (server.address() as AddressInfo).port;
  return { server, port: p, url: `http://${host}:${p}/v1` };
}
