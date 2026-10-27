// Стресс-тесты устойчивости: один сценарий за раз, временные файлы и локальные заглушки.
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadRegistry } from '../../src/config/loader.js';
import { loadEnv } from '../../src/env.js';
import { Execution, type ExecutionInit } from '../../src/execution/execution.js';
import { CONFIG, REPO } from '../helpers.js';

export { CONFIG, REPO };
export const stress = (name: string, fn: (t: TestContext) => unknown | Promise<unknown>) => test(name, { timeout: 8000 }, fn);

export function temp(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-stress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function put(dir: string, file: string, value: unknown, raw = false): void {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw ? String(value) : JSON.stringify(value), 'utf8');
}

export async function execution(overrides: Partial<ExecutionInit> = {}): Promise<Execution> {
  const reg = await loadRegistry(CONFIG);
  return new Execution({
    id: 'stress', mode: 'manual', caseDef: reg.cases.get('notifications-channel-change')!,
    contract: reg.contract!, solution: null, basketType: null, senderId: 'stress-local',
    caseNumber: 'CG-STRESS', requestRef: 'stress-ref', taskIdScope: 'message',
    env: loadEnv({ AGENT_MCP_TIMEOUT_MS: '500', OPERATOR_DECISION_MARGIN_MS: '100' }, REPO), run: null,
    ...overrides,
  });
}

/** node:http сохраняет битые %-последовательности URL; fetch может нормализовать вход. */
export function request(base: string, url: string, body?: string, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; text: string; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(base).origin + url, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(2500),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data: any;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode!, text, data });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Повторяемый генератор: seed печатается в названии теста. */
export function random(seed: number): () => number {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
}
