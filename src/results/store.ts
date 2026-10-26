// Хранение результатов отдельно от настроек: var/results/run-NNNN/, var/sessions/.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, listDirs, readJsonIf, safeJoin, settleWrites, walkFiles, writeJsonAtomic, writeText } from '../util/fsx.js';
import { randomHex } from '../util/core.js';

export const runKey = (id: number) => `run-${String(id).padStart(4, '0')}`;
export const sessionKey = (id: number) => `m-${String(id).padStart(4, '0')}`;

export class ResultsStore {
  readonly resultsDir: string;
  readonly sessionsDir: string;
  constructor(public dataDir: string) {
    this.resultsDir = path.join(dataDir, 'results');
    this.sessionsDir = path.join(dataDir, 'sessions');
  }

  async init(): Promise<void> {
    await ensureDir(this.resultsDir);
    await ensureDir(this.sessionsDir);
  }

  /** Секрет для request_ref: из окружения или сохранённый при первом запуске. */
  async secret(fromEnv: string | null): Promise<string> {
    if (fromEnv) return fromEnv;
    const file = path.join(this.dataDir, 'secret.json');
    const s = await readJsonIf<{ secret: string }>(file);
    if (s?.secret) return s.secret;
    const secret = randomHex(32);
    await writeJsonAtomic(file, { secret });
    return secret;
  }

  async nextNumber(kind: 'run' | 'session'): Promise<number> {
    const file = path.join(this.dataDir, 'counters.json');
    const c = (await readJsonIf<Record<string, number>>(file)) ?? {};
    let n = (c[kind] ?? 0) + 1;
    // Номер не должен совпасть с уже сохранённым результатом.
    const dir = kind === 'run' ? this.resultsDir : this.sessionsDir;
    const key = kind === 'run' ? runKey : sessionKey;
    const existing = kind === 'run' ? await listDirs(dir) : (await fsp.readdir(dir).catch(() => [] as string[])).map((f) => f.replace(/(\.http)?\.json$/, ''));
    while (existing.includes(key(n))) n++;
    c[kind] = n;
    await writeJsonAtomic(file, c);
    return n;
  }

  runDir(id: number): string {
    return path.join(this.resultsDir, runKey(id));
  }

  async saveRun(run: { id: number }): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(run.id), 'run.json'), run);
  }

  async loadRuns(): Promise<any[]> {
    const out: any[] = [];
    for (const d of await listDirs(this.resultsDir)) {
      const r = await readJsonIf(path.join(this.resultsDir, d, 'run.json')).catch(() => undefined);
      if (r) out.push(r);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  async saveExecution(runId: number, name: string, data: unknown): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(runId), 'executions', `${name}.json`), data);
  }

  async loadExecution(runId: number, name: string): Promise<any | undefined> {
    return readJsonIf(path.join(this.runDir(runId), 'executions', `${name}.json`));
  }

  async saveHttp(runId: number, name: string, list: unknown[]): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(runId), 'executions', `${name}.http.json`), list);
  }

  async loadHttp(runId: number, name: string): Promise<any[] | undefined> {
    return readJsonIf(path.join(this.runDir(runId), 'executions', `${name}.http.json`));
  }

  async saveSessionHttp(id: number, list: unknown[]): Promise<void> {
    await writeJsonAtomic(path.join(this.sessionsDir, `${sessionKey(id)}.http.json`), list);
  }

  async loadSessionHttp(id: number): Promise<any[] | undefined> {
    return readJsonIf(path.join(this.sessionsDir, `${sessionKey(id)}.http.json`));
  }

  /** Каталог прогона целиком: запись, журналы кейсов, HTTP-обмены, файлы скиллов и материалы. */
  async deleteRun(id: number): Promise<void> {
    const dir = this.runDir(id);
    await settleWrites(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  }

  async deleteSession(id: number): Promise<void> {
    for (const f of [`${sessionKey(id)}.json`, `${sessionKey(id)}.http.json`]) {
      const file = path.join(this.sessionsDir, f);
      await settleWrites(file);
      await fsp.rm(file, { force: true });
    }
  }

  async saveFiles(runId: number, sub: string, files: { path: string; content: string }[]): Promise<void> {
    const base = path.join(this.runDir(runId), sub);
    await fsp.rm(base, { recursive: true, force: true });
    for (const f of files) await writeText(safeJoin(base, f.path), f.content);
  }

  async saveText(runId: number, rel: string, text: string): Promise<void> {
    await writeText(safeJoin(this.runDir(runId), rel), text);
  }

  async listRunFiles(runId: number): Promise<string[]> {
    return walkFiles(this.runDir(runId));
  }

  async readRunFile(runId: number, rel: string): Promise<Buffer> {
    return fsp.readFile(safeJoin(this.runDir(runId), rel));
  }

  async saveSession(id: number, data: unknown): Promise<void> {
    await writeJsonAtomic(path.join(this.sessionsDir, `${sessionKey(id)}.json`), data);
  }

  async loadSessions(): Promise<any[]> {
    const out: any[] = [];
    for (const f of (await fsp.readdir(this.sessionsDir).catch(() => [] as string[])).filter((x) => x.endsWith('.json') && !x.endsWith('.http.json')).sort()) {
      const s = await readJsonIf(path.join(this.sessionsDir, f)).catch(() => undefined);
      if (s) out.push(s);
    }
    return out;
  }
}
