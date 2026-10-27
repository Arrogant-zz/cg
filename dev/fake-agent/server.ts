// HTTP fake-agent: A2A SendMessage в формате AEFClaw (templates/aefclaw-a2a-message.json, ответ result.task).
// Как у AEFClaw, скиллы живут внутри агента у тестового оператора (x-a2a-sender-id): снаружи их не устанавливают и не выгружают.
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { FakeAgent, McpClient, Workspace } from './agent.js';

export interface FakeAgentOptions {
  port?: number;
  host?: string;
  mcpUrl: string;
  workspaces: string;
  buildSkills: string | null;
  mcpTimeoutMs?: number;
  /** Регулярное выражение: сообщения, на которые агент отвечает HTTP 500. */
  failOn?: string | null;
  delayMs?: number;
}

export async function startFakeAgent(o: FakeAgentOptions): Promise<{ server: http.Server; port: number; url: string }> {
  const agents = new Map<string, FakeAgent>();
  const queues = new Map<string, Promise<unknown>>();
  const get = (sender: string) => {
    let a = agents.get(sender);
    if (!a) {
      a = new FakeAgent(new Workspace(path.join(o.workspaces, sender.replace(/[^\w.-]/g, '_')), o.buildSkills), new McpClient(o.mcpUrl, o.mcpTimeoutMs ?? 900_000));
      agents.set(sender, a);
    }
    return a;
  };
  // Один диалог на отправителя: запросы одного x-a2a-sender-id выполняются по очереди.
  const serial = <T>(sender: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(sender) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    queues.set(sender, next);
    return next;
  };

  const json = (res: http.ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const body = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString('utf8');
    return t ? JSON.parse(t) : {};
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', sessions: agents.size });
      if (req.method === 'POST' && url.pathname === '/a2a') {
        const sender = String(req.headers['x-a2a-sender-id'] ?? '');
        const taskId = String(req.headers['x-task-id'] ?? '');
        if (!sender || !taskId) return json(res, 400, { error: { message: 'Нужны заголовки x-a2a-sender-id и x-task-id' } });
        const b = await body(req);
        const text: string = b?.params?.message?.parts?.map((p: any) => p.text).join('\n') ?? '';
        if (o.failOn && new RegExp(o.failOn, 'u').test(text)) return json(res, 500, { error: { message: 'fake-agent: имитация сбоя' } });
        const a = get(sender);
        const reply = await serial(sender, async () => {
          await a.ws.ensure();
          if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
          return a.handle(text, taskId);
        });
        return json(res, 200, {
          jsonrpc: '2.0',
          id: b?.id ?? null,
          result: {
            task: {
              id: `fa-task-${Date.now()}`,
              contextId: b?.params?.message?.contextId ?? taskId,
              status: {
                state: 'TASK_STATE_COMPLETED',
                message: { messageId: `fa-${Date.now()}`, role: 'ROLE_AGENT', parts: [{ mediaType: 'text/plain', text: reply }] },
              },
              metadata: {
                model: 'fake-agent',
                usage: { input_tokens: Math.ceil(text.length / 4) + 600, output_tokens: Math.ceil(reply.length / 4) },
              },
            },
          },
        });
      }
      json(res, 404, { error: 'not found' });
    } catch (e: any) {
      json(res, 500, { error: { message: e?.message ?? String(e) } });
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://${o.host ?? '127.0.0.1'}:${port}` };
}
