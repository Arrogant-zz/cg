// Хранение результатов отдельно от справочников, в CLAWGYM_VAR: results/run-NNNN/, sessions/.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, listDirs, readJsonIf, safeJoin, settleWrites, walkFiles, writeJsonAtomic, writeText } from '../util/fsx.js';
import { errorMessage, isPlainObject, randomHex } from '../util/core.js';
import { KeyedMutex } from '../util/sync.js';
import { RECORD_FORMAT, loadExecutionRecord, loadOperatorsRecord, loadRunRecord, loadSessionRecord, type Loaded, type SavedExecution } from './format.js';
import type { OperatorStep, RunRecord } from '../runner/types.js';
import type { ManualRecord } from '../manual/manual.js';

export const runKey = (id: number) => `run-${String(id).padStart(4, '0')}`;
export const sessionKey = (id: number) => `m-${String(id).padStart(4, '0')}`;

/** Пропущенная при загрузке запись: путь внутри CLAWGYM_VAR и причина. */
export type OnSkip = (file: string, reason: string) => void;

export class ResultsStore {
  readonly resultsDir: string;
  readonly sessionsDir: string;
  /** counters.json общий для прогонов и сессий: чтение и запись номера идут по очереди. */
  private counters = new KeyedMutex();
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

  /** Номер прогона или сессии. Одновременные запуски получают разные номера. */
  nextNumber(kind: 'run' | 'session'): Promise<number> {
    return this.counters.run('counters', () => this.allocate(kind));
  }

  private async allocate(kind: 'run' | 'session'): Promise<number> {
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

  /** Запись через миграцию формата (format.ts). Нет файла — undefined; повреждённая или более новая запись — пропуск с причиной. */
  private async readRecord<T>(file: string, load: (raw: unknown) => Loaded<T>, onSkip?: OnSkip): Promise<T | undefined> {
    const rel = path.relative(this.dataDir, file);
    let raw: unknown;
    try {
      raw = await readJsonIf(file);
    } catch (e) {
      onSkip?.(rel, `файл не читается: ${errorMessage(e)}`);
      return undefined;
    }
    if (raw === undefined) return undefined;
    const r = load(raw);
    if (r.ok) return r.record;
    onSkip?.(rel, r.reason);
    return undefined;
  }

  async saveRun(run: RunRecord): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(run.id), 'run.json'), { format: RECORD_FORMAT, ...run });
  }

  async loadRuns(onSkip?: OnSkip): Promise<RunRecord[]> {
    const out: RunRecord[] = [];
    for (const d of await listDirs(this.resultsDir)) {
      const r = await this.readRecord(path.join(this.resultsDir, d, 'run.json'), loadRunRecord, onSkip);
      if (r) out.push(r);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  async saveExecution(runId: number, name: string, data: SavedExecution): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(runId), 'executions', `${name}.json`), { format: RECORD_FORMAT, ...data });
  }

  /** Журнал кейса прогона; несовместимый журнал — ошибка с причиной, а не «не найден». */
  async loadExecution(runId: number, name: string): Promise<SavedExecution | undefined> {
    return this.readRecord(path.join(this.runDir(runId), 'executions', `${name}.json`), loadExecutionRecord, (file, reason) => {
      throw new Error(`${file}: ${reason}`);
    });
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

  /** Каталог прогона целиком: запись, журналы кейсов, HTTP-обмены и снимок настроек. */
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

  async saveText(runId: number, rel: string, text: string): Promise<void> {
    await writeText(safeJoin(this.runDir(runId), rel), text);
  }

  async listRunFiles(runId: number): Promise<string[]> {
    return walkFiles(this.runDir(runId));
  }

  async readRunFile(runId: number, rel: string): Promise<Buffer> {
    return fsp.readFile(safeJoin(this.runDir(runId), rel));
  }

  async saveSession(id: number, data: ManualRecord): Promise<void> {
    await writeJsonAtomic(path.join(this.sessionsDir, `${sessionKey(id)}.json`), { format: RECORD_FORMAT, ...data });
  }

  /** Журнал тестовых операторов: x-a2a-sender-id → через что оператор прошёл. Нет файла — undefined. */
  async loadOperators(onSkip?: OnSkip): Promise<Record<string, OperatorStep[]> | undefined> {
    const file = path.join(this.dataDir, 'operators.json');
    const r = await this.readRecord(file, loadOperatorsRecord, onSkip);
    if (!r) return undefined;
    if (!isPlainObject(r.operators) || !Object.values(r.operators).every(Array.isArray)) {
      onSkip?.(path.relative(this.dataDir, file), 'нет списка операторов с шагами истории');
      return undefined;
    }
    return r.operators;
  }

  async saveOperators(operators: Record<string, OperatorStep[]>): Promise<void> {
    await writeJsonAtomic(path.join(this.dataDir, 'operators.json'), { format: RECORD_FORMAT, operators });
  }

  async loadSessions(onSkip?: OnSkip): Promise<ManualRecord[]> {
    const out: ManualRecord[] = [];
    for (const f of (await fsp.readdir(this.sessionsDir).catch(() => [] as string[])).filter((x) => x.endsWith('.json') && !x.endsWith('.http.json')).sort()) {
      const s = await this.readRecord(path.join(this.sessionsDir, f), loadSessionRecord, onSkip);
      if (s) out.push(s);
    }
    return out;
  }
}
