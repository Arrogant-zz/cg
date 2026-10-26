// Обновления в браузере через Server-Sent Events.
import type { IncomingMessage, ServerResponse } from 'node:http';

interface Client {
  res: ServerResponse;
  topics: Set<string> | null;
}

export class SseHub {
  private clients = new Set<Client>();
  private timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => {
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, 20000);
    this.timer.unref();
  }

  /** topics=null — все события. */
  attach(req: IncomingMessage, res: ServerResponse, topics: string[] | null): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const c: Client = { res, topics: topics && topics.length ? new Set(topics) : null };
    this.clients.add(c);
    req.on('close', () => this.clients.delete(c));
  }

  publish(topic: string, type: string, data: unknown): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify({ topic, type, data })}\n\n`;
    for (const c of this.clients) {
      if (!c.topics || [...c.topics].some((t) => topic === t || topic.startsWith(t + ':'))) c.res.write(payload);
    }
  }

  get size(): number {
    return this.clients.size;
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}
