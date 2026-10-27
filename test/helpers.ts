// Офлайн-стенд для тестов: ClawGym + fake-agent + fake-gigachat на свободных портах, данные во временном каталоге.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { App } from '../src/app.js';
import { startFakeAgent } from '../dev/fake-agent/server.js';
import { startFakeGigaChat } from '../dev/fake-gigachat/server.js';

export const REPO = path.resolve(process.cwd());
/** Справочники стенда — CLAWGYM_CONFIG по умолчанию. */
export const CONFIG = path.join(REPO, 'config');

export interface Stand {
  app: App;
  base: string;
  agentUrl: string;
  dataDir: string;
  /** Запросы к fake-agent; ts — когда пришёл: оператор после обучения тот же, что в обучающем прогоне. */
  agentRequests: { sender: string; text: string; ts: string }[];
  close(): Promise<void>;
  api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T }>;
  waitRun(id: number, timeoutMs?: number): Promise<any>;
}

export async function startStand(extraEnv: Record<string, string> = {}): Promise<Stand> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-test-'));
  const llm = await startFakeGigaChat();
  const raw: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    CLAWGYM_CONFIG: CONFIG,
    CLAWGYM_VAR: dataDir,
    FAKE_GIGACHAT_URL: llm.url,
    LOG_LEVEL: 'warn',
    AGENT_MCP_TIMEOUT_MS: '60000',
    OPERATOR_DECISION_MARGIN_MS: '5000',
    MAX_PARALLEL_SESSIONS: '3',
    ...extraEnv,
  };
  const app = new App(loadEnv(raw, REPO));
  await app.init();
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const agent = await startFakeAgent({
    port: 0,
    mcpUrl: `${base}/mcp`,
    workspaces: path.join(dataDir, 'fake-workspaces'),
    buildSkills: path.join(REPO, 'dev/fake-agent/build'),
    failOn: extraEnv.FAKE_AGENT_FAIL_ON ?? null,
    slowOn: extraEnv.FAKE_AGENT_SLOW_ON ?? null,
    slowMs: Number(extraEnv.FAKE_AGENT_SLOW_MS ?? 0),
  });
  raw.FAKE_AGENT_URL = agent.url;
  await app.checkHealth();
  const agentRequests: { sender: string; text: string; ts: string }[] = [];
  agent.server.prependListener('request', (req) => {
    if (req.url === '/a2a') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          agentRequests.push({ sender: String(req.headers['x-a2a-sender-id']), text: b.params.message.parts.map((p: any) => p.text).join('\n'), ts: new Date().toISOString() });
        } catch {
          /* не JSON */
        }
      });
    }
  });
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
  return {
    app,
    base,
    agentUrl: agent.url,
    dataDir,
    agentRequests,
    api,
    async waitRun(id: number, timeoutMs = 90_000) {
      const t0 = Date.now();
      for (;;) {
        const r = await api('GET', `/api/runs/${id}`);
        if (['completed', 'stopped', 'failed'].includes(r.data.status)) return r.data;
        if (Date.now() - t0 > timeoutMs) throw new Error(`Прогон #${id} не завершился: ${r.data.status}`);
        await new Promise((x) => setTimeout(x, 200));
      }
    },
    async close() {
      await app.close();
      await new Promise<void>((r) => agent.server.close(() => r()));
      agent.server.closeAllConnections?.();
      await llm.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, what = 'условие'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
