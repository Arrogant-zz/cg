// Раннер прогонов (RUN-01–03, BASK-01–05): очередь, линии повторений на тестовых операторах, кейсы, команды обучения и проходы curator.
// Скиллы живут в агенте у тестового оператора: ClawGym их не устанавливает и не выгружает (решение владельца от 27.10.2026).
// Повтор на месте после технического сбоя, дозапуск завершённого прогона и переоценка — решение владельца от 12.11.2026 (rerun.ts).
import path from 'node:path';
import type { App } from '../app.js';
import type { CaseDef, SolutionDef } from '../config/types.js';
import { Execution } from '../execution/execution.js';
import { AgentChannel } from '../execution/channel.js';
import { runDialog } from '../execution/dialog.js';
import { evaluate, execStats, reevaluate, type Evaluation } from '../execution/evaluate.js';
import { RETRYABLE_STATUSES, type CommandEvent, type ScoresEvent, type StatusEvent } from '../execution/events.js';
import { LlmOperator } from '../operator/operator.js';
import { LlmJudge } from '../judge/judge.js';
import { ANSWER_JUDGE_PROMPT_VERSION, JUDGE_PROMPT_VERSION, OPERATOR_CHECK_PROMPT_VERSION, OPERATOR_PROMPT_VERSION } from '../operator/prompts.js';
import { itemScores, scoringOf } from '../metrics/scoring.js';
import { createProvider } from '../llm/provider.js';
import { resolveRun, type ResolvedItem, type ResolvedRun, type RunOverrides } from './resolve.js';
import { runStep, stepLabel, stepsAfter, type OperatorHold } from './operators.js';
import {
  NOTE,
  attemptName,
  checkSnapshot,
  linesOf,
  operatorReasons,
  parsePosKey,
  posKey,
  reevaluateItems,
  rerunItems,
  resumeLines,
  snapshotReasons,
  type DorunState,
  type SnapshotCheck,
} from './rerun.js';
import type { CuratorPassRecord, ItemRecord, LineRecord, RerunRecord, RunRecord, SnapshotFile } from './types.js';
import type { HttpExchange } from '../util/httplog.js';
import { computeRunMetrics } from '../metrics/builtins.js';
import { runKey } from '../results/store.js';
import { HttpError } from '../util/http.js';
import { errorMessage, nowIso, randomHex, requestRef, sha256, shortHash } from '../util/core.js';
import { logger } from '../util/log.js';

const log = logger('runner');

/** Что дозапуск выполняет в линии: элементы корзины по индексу; forceFinal — финальный проход, даже если счётчик пуст. */
interface LineJob {
  indexes: Set<number>;
  forceFinal: boolean;
}

/** Дозапуск завершённого прогона: запись в run.reruns и линии, которых он касается. */
interface Job {
  rerun: RerunRecord;
  lines: Map<number, LineJob>;
  /** Дозапуск начал работу: линия получила сессию агента или началась переоценка. До этого его можно снять без следа. */
  began: boolean;
}

interface Live {
  abort: AbortController;
  resolved: ResolvedRun;
  execs: Map<string, Execution>;
  /** Прогон взят из очереди в работу. */
  started: boolean;
  /** Тестовые операторы прогона заняты от запуска до конца: другой прогон или ручная сессия их не возьмут. */
  hold: OperatorHold;
  /** Дозапуск; нет — первый запуск прогона. */
  job?: Job;
}

interface Deps {
  channel: AgentChannel;
  operator: LlmOperator;
  judge: LlmJudge | null;
  prior: Set<string>;
  signal: AbortSignal;
  live: Live;
}

/** Попытка позиции: её выполнение, ключ отложенного сохранения и сохранение журнала. */
interface Attempt {
  exec: Execution;
  key: string;
  persist: () => Promise<unknown>;
}

export class RunManager {
  runs = new Map<number, RunRecord>();
  private live = new Map<number, Live>();
  private timer: NodeJS.Timeout | null = null;
  private saveTimers = new Map<number, NodeJS.Timeout>();
  /** Отложенные сохранения журналов кейсов; ключ — «прогон/кейс». */
  private persists = new Map<string, { timer: NodeJS.Timeout; persist: () => Promise<unknown> }>();
  /** Позиция на конец прежней попытки: её журнал сохраняет её, а не итоговую, даже если поздние события придут после повтора. */
  private frozen = new Map<string, ItemRecord>();
  /** Прогон, собранный из снимка, и расхождения с ним: снимок, код и окружение процесса не меняются, поэтому — один раз на прогон. */
  private snapshots = new Map<number, Promise<SnapshotCheck>>();

  constructor(private app: App) {}

  async init(): Promise<void> {
    for (const r of await this.app.store.loadRuns((file, reason) => this.app.stand.add('warn', 'store.skipped', `Прогон из ${file} не загружен: ${reason}`))) {
      if (r.status === 'running' || r.status === 'queued') await this.recover(r);
      this.runs.set(r.id, r);
    }
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }

  /**
   * Прогон шёл или ждал в очереди, когда ClawGym перезапустили. Запись приводится к виду, с которого его можно дозапустить:
   * прерванная позиция — технический сбой с причиной, не начатые — «Не начат», идущий проход curator — сбой.
   * Дозапуск, который не успел начаться, снимается, и прогон возвращается к прежнему статусу.
   */
  private async recover(r: RunRecord): Promise<void> {
    const job = r.reruns.find((x) => x.status === 'queued' || x.status === 'running') ?? null;
    if (job?.status === 'queued') {
      this.restore(r, job);
      job.status = 'stopped';
      job.error = 'ClawGym перезапущен до начала дозапуска';
      job.finishedAt = nowIso();
      await this.app.store.saveRun(r);
      return;
    }
    const wasRunning = r.status === 'running';
    r.status = 'failed';
    r.error = wasRunning ? 'ClawGym перезапущен во время прогона: начатый шаг не завершён' : 'ClawGym перезапущен до старта прогона — запустите его снова';
    r.finishedAt = wasRunning ? nowIso() : (r.finishedAt ?? nowIso());
    if (job) {
      job.status = 'failed';
      job.error = 'ClawGym перезапущен во время дозапуска';
      job.finishedAt = r.finishedAt;
    }
    for (const l of r.lines) {
      if (l.status === 'running' || l.status === 'queued') l.status = 'failed';
      l.current = null;
      for (const i of l.items) await this.closeInterrupted(r, i);
      for (const p of l.curatorPasses) {
        if (p.status !== 'running') continue;
        p.status = 'failed';
        p.error = 'ClawGym перезапущен во время прохода curator';
      }
    }
    await this.app.store.saveRun(r);
  }

  /**
   * Позиция, которую застал перезапуск ClawGym. Итог уже есть — прерван capture: итог остаётся, а capture считается
   * неотправленным, хотя агент мог его принять. Итога нет — технический сбой «Внутренняя ошибка стенда», и в журнал кейса
   * дописывается событие статуса, как при сбое стенда посреди линии.
   */
  private async closeInterrupted(run: RunRecord, i: ItemRecord): Promise<void> {
    if (i.status === 'pending') i.status = 'not_started';
    if (i.status !== 'running') return;
    i.finishedAt = nowIso();
    if (i.outcome) {
      i.status = i.steps.dialog ?? 'completed';
      if (run.type === 'training' && !i.steps.capture) i.steps.capture = { status: 'interrupted', signal: null, path: null, reason: 'прерван перезапуском ClawGym: агент мог его принять' };
      return;
    }
    i.status = 'internal_error';
    i.outcome = 'technical';
    i.reason = 'ClawGym перезапущен во время кейса';
    if (!i.execName) return;
    try {
      const saved = await this.app.store.loadExecution(run.id, i.execName);
      if (!saved) return;
      const seq = saved.events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
      const ev: StatusEvent = { type: 'status', status: 'internal_error', reason: i.reason, seq, ts: i.finishedAt };
      await this.app.store.saveExecution(run.id, i.execName, { ...saved, events: [...saved.events, ev], status: 'internal_error', reason: i.reason, finishedAt: saved.finishedAt ?? i.finishedAt, item: i });
    } catch (e) {
      log.warn(`Журнал кейса ${i.execName} прогона #${run.id} не дополнен статусом: ${errorMessage(e)}`);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const l of this.live.values()) l.abort.abort(new Error('ClawGym останавливается'));
  }

  /** Перед остановкой ClawGym: отложенные сохранения прогонов и журналов кейсов — сразу. */
  flush(): void {
    for (const key of [...this.persists.keys()]) this.persistNow(key)?.catch(() => undefined);
    for (const id of [...this.saveTimers.keys()]) {
      const run = this.runs.get(id);
      if (run) this.scheduleSave(run, true);
    }
  }

  /** Отложенное сохранение журнала кейса — сейчас; undefined — ничего не отложено. */
  private persistNow(key: string): Promise<unknown> | undefined {
    const p = this.persists.get(key);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.persists.delete(key);
    return p.persist();
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.id - a.id);
  }

  get(id: number): RunRecord {
    const r = this.runs.get(id);
    if (!r) throw new HttpError(404, `Прогон #${id} не найден`);
    return r;
  }

  liveExecution(runId: number, name: string): Execution | undefined {
    return this.live.get(runId)?.execs.get(name);
  }

  /** Запуск: проверка настроек, снимок, постановка в очередь (RUN-01, RUN-02). */
  async create(configId: string, overrides: RunOverrides = {}): Promise<RunRecord> {
    const app = this.app;
    const preview = resolveRun(app.registry, app.env, configId, overrides, this.list(), app.operators);
    if (!preview.ok || !preview.resolved) {
      throw new HttpError(422, 'Прогон не запустится: ошибка в настройках. Агенту не отправлено ни одного запроса', preview.issues.filter((i) => i.severity === 'error'));
    }
    const r = preview.resolved;
    // Один диалог на оператора. Резерв — до первого await: из двух одновременных запусков на одном операторе второй получает 409,
    // а не идёт параллельно. Ручная сессия держит оператора так же (замечание ревью от 28.10.2026).
    const op = r.operator;
    const hold = app.operators.reserve(op.mode === 'continue' ? op.lines.map((l) => l.senderId) : [], 'run', 'запускаемым прогоном');
    let queued = false;
    try {
      const id = await app.store.nextNumber('run');
      hold.label = `прогоном #${id}`;
      const createdAt = nowIso();

      // Снимок: копии входных данных по перечню, с которым прогон прошёл проверку; правка исходников потом не меняет результат.
      // Полный SHA-256 — для сравнения прогонов, короткая метка — для интерфейса.
      const snapFiles: SnapshotFile[] = [];
      for (const f of preview.inputs.files) {
        await app.store.saveText(id, `snapshot/${f.file}`, f.text);
        snapFiles.push({ file: f.file, group: f.group, hash: shortHash(f.text), sha256: sha256(f.text) });
      }
      const contract = r.contract;

      const lines: LineRecord[] = [];
      for (let li = 1; li <= r.repetitions; li++) lines.push(this.newLine(li, r));
      const run: RunRecord = {
        id,
        key: runKey(id),
        configId: r.config.id,
        configFile: r.config.source.file,
        configHash: r.config.source.hash,
        title: r.config.title,
        type: r.basket.type,
        status: 'queued',
        error: null,
        createdAt,
        startAt: r.startAt,
        startedAt: null,
        finishedAt: null,
        overrides: { ...overrides },
        settings: {
          basket: { id: r.basket.id, title: r.basket.title, file: r.basket.source.file, hash: r.basket.source.hash, type: r.basket.type, curator: r.basket.curator, checking: r.basket.checking, items: r.items.filter((i) => i.kind === 'solution').length },
          agent: { id: r.agent.id, title: r.agent.title, file: r.agent.source.file, hash: r.agent.source.hash, build: r.agent.build, model: r.agent.model, learningKit: r.agent.learningKit },
          testOperator: op.mode === 'continue' ? { mode: 'continue', run: op.source.id, title: op.source.title, type: op.source.type, configId: op.source.configId } : { mode: 'new' },
          operator: r.models.operator ? { id: r.models.operator.id, title: r.models.operator.title, provider: r.models.operator.provider, model: r.models.operator.model, file: r.models.operator.source.file, hash: r.models.operator.source.hash } : null,
          judge: r.models.judge ? { id: r.models.judge.id, title: r.models.judge.title, provider: r.models.judge.provider, model: r.models.judge.model, file: r.models.judge.source.file, hash: r.models.judge.source.hash } : null,
          metrics: r.metrics.map((m) => ({ id: m.id, title: m.title, builtin: m.builtin, version: m.version, params: m.params })),
          limits: r.limits,
          repetitions: r.repetitions,
          retries: r.retries,
          prompts: { operator: OPERATOR_PROMPT_VERSION, operatorCheck: OPERATOR_CHECK_PROMPT_VERSION, judge: JUDGE_PROMPT_VERSION, answerJudge: ANSWER_JUDGE_PROMPT_VERSION },
          contract: contract ? { file: contract.source.file, hash: contract.source.hash, version: contract.version, conditional: contract.conditional } : { file: '', hash: '', version: '', conditional: true },
        },
        snapshot: { createdAt, files: snapFiles, settings: preview.inputs.settings },
        plan: preview.plan,
        planText: preview.planText,
        metricsAvailability: preview.metrics,
        warnings: preview.issues.filter((i) => i.severity === 'warning'),
        lines,
        reruns: [],
        summary: null,
      };
      this.runs.set(id, run);
      this.live.set(id, { abort: new AbortController(), resolved: r, execs: new Map(), started: false, hold });
      queued = true;
      await app.store.saveRun(run);
      this.publish(run);
      log.info(`Прогон #${id} (${r.config.id}) поставлен в очередь`);
      setImmediate(() => this.tick());
      return run;
    } finally {
      // Запуск сорвался до очереди — операторы снова свободны. Прогон в очереди отпускает их сам, когда закончится.
      if (!queued) hold.release();
    }
  }

  private newLine(index: number, r: ResolvedRun): LineRecord {
    const items: ItemRecord[] = r.items.map((i) => this.newItem(i));
    // Продолжение: оператор и его история известны сразу; новый оператор получает x-a2a-sender-id при старте линии.
    const cont = r.operator.mode === 'continue' ? r.operator.lines[index - 1] : null;
    return {
      index,
      senderId: cont?.senderId ?? '',
      history: cont?.history ?? [],
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      error: null,
      prep: { status: 'pending', items: [], durationMs: null },
      items,
      curatorPasses: [],
      counter: 0,
      current: null,
    };
  }

  private newItem(i: ResolvedItem): ItemRecord {
    return {
      index: i.index,
      kind: i.kind === 'solution' ? 'case' : 'curator',
      pos: i.pos,
      solution: i.solution ? { id: i.solution.id, title: i.solution.title, style: i.solution.operator.style, file: i.solution.source.file, hash: i.solution.source.hash } : null,
      case: i.caseDef ? { id: i.caseDef.id, title: i.caseDef.title, topic: i.caseDef.topic, file: i.caseDef.source.file, hash: i.caseDef.source.hash } : null,
      execName: null,
      status: 'pending',
      outcome: null,
      reason: '',
      startedAt: null,
      finishedAt: null,
      attempts: [],
      resultSeq: null,
      reevaluated: false,
      steps: { reset: null, dialog: null, checks: null, judge: null, capture: null, curatorPass: null },
      checks: null,
      answerFailed: [],
      scores: null,
      stats: null,
      repeated: [],
      limits: i.limits,
    };
  }

  /** Остановка: новые элементы не запускаются, удерживаемые вызовы получают ошибку (RUN-03). */
  async stop(id: number): Promise<RunRecord> {
    const run = this.get(id);
    const live = this.live.get(id);
    if (run.status === 'queued' && live?.job && live.started) {
      // Дозапуск ждёт свободную сессию агента: ожидание отменяется, а прогон возвращается к прежнему статусу в execute.
      live.abort.abort(new Error('Дозапуск убран из очереди'));
      return run;
    }
    if (run.status === 'queued' && live?.job) {
      // Дозапуск убран из очереди до старта: прогон возвращается к прежнему статусу и ошибкам.
      const job = live.job;
      live.abort.abort(new Error('Дозапуск убран из очереди'));
      live.hold.release();
      this.live.delete(id);
      this.restore(run, job.rerun);
      job.rerun.status = 'stopped';
      job.rerun.error = 'Убран из очереди до старта';
      job.rerun.finishedAt = nowIso();
      await this.app.store.saveRun(run);
      this.publish(run);
      return run;
    }
    if (run.status === 'queued') {
      run.status = 'stopped';
      run.error = 'Убран из очереди до старта';
      run.finishedAt = nowIso();
      for (const l of run.lines) l.status = 'stopped';
      live?.abort.abort(new Error('Прогон остановлен'));
      live?.hold.release();
      this.live.delete(id);
      await this.app.store.saveRun(run);
      this.publish(run);
      return run;
    }
    if (run.status !== 'running' || !live) throw new HttpError(409, 'Прогон уже завершён');
    live.abort.abort(new Error('Прогон остановлен пользователем'));
    for (const e of live.execs.values()) if (!e.terminal) e.stop('Прогон остановлен пользователем');
    return run;
  }

  /** Статус и ошибки прогона и линий — как до дозапуска, который так и не начался. */
  private restore(run: RunRecord, rerun: RerunRecord): void {
    run.status = rerun.previous.status;
    run.error = rerun.previous.run;
    for (const p of rerun.previous.lines) {
      const l = run.lines.find((x) => x.index === p.line);
      if (l) l.error = p.error;
    }
  }

  /** Удаление завершённого прогона с журналами и материалами (уточнение владельца от 26.10.2026). Прогоны, продолжившие его оператора, хранят историю у себя. */
  async delete(id: number): Promise<void> {
    const run = this.get(id);
    if (run.status === 'queued') throw new HttpError(409, `Прогон #${id} в очереди: сначала уберите его из очереди`);
    if (run.status === 'running' || this.live.has(id)) throw new HttpError(409, `Прогон #${id} идёт: сначала остановите его и дождитесь завершения`);
    const t = this.saveTimers.get(id);
    if (t) clearTimeout(t);
    this.saveTimers.delete(id);
    this.snapshots.delete(id);
    this.runs.delete(id);
    await this.app.store.deleteRun(id);
    this.app.publish('runs', 'run', { id, status: 'deleted' });
    this.app.publish(`run:${id}`, 'run', { id, status: 'deleted' });
    log.info(`Прогон #${id} удалён`);
  }

  private tick(): void {
    for (const run of [...this.runs.values()].sort((a, b) => a.id - b.id)) {
      if (run.status !== 'queued') continue;
      const live = this.live.get(run.id);
      if (!live || live.started) continue;
      if (run.startAt && Date.parse(run.startAt) > Date.now()) continue;
      live.started = true;
      this.execute(run, live).catch((e) => {
        log.error(`Прогон #${run.id} упал`, e);
        run.status = 'failed';
        run.error = errorMessage(e);
        run.finishedAt = nowIso();
        if (live.job) Object.assign(live.job.rerun, { status: 'failed', error: run.error, finishedAt: run.finishedAt });
        this.scheduleSave(run, true);
      });
    }
  }

  private async execute(run: RunRecord, live: Live): Promise<void> {
    const job = live.job ?? null;
    try {
      if (job) Object.assign(job.rerun, { status: 'running', startedAt: nowIso() });
      if (job?.rerun.kind === 'reevaluate') await this.reevaluateJob(run, live, job);
      else await Promise.all(run.lines.filter((l) => !job || job.lines.has(l.index)).map((l) => this.runLine(run, l, live, job?.lines.get(l.index) ?? null)));
      const aborted = live.abort.signal.aborted;
      if (job && aborted && !job.began) {
        // Дозапуск остановлен, пока ждал сессию агента: он ничего не сделал — прогон такой же, как до него.
        this.restore(run, job.rerun);
        Object.assign(job.rerun, { status: 'stopped', error: 'Убран из очереди до старта', finishedAt: nowIso() });
      } else this.finish(run, job, aborted);
    } finally {
      // Линии закончились: привязки x-task-id, резерв операторов и живая запись снимаются тем же шагом, что итоговый статус, —
      // и тогда, когда упали метрики. Иначе завершённый прогон ещё миг нельзя удалить или дозапустить, его операторы заняты,
      // а поздние вызовы агента попадают в законченные кейсы. Запись run.json — после: её сбой ничего из этого не держит.
      for (const e of live.execs.values()) this.app.bindings.unbindAll(e);
      live.hold.release();
      this.live.delete(run.id);
      for (const k of [...this.frozen.keys()]) if (k.startsWith(`${run.id}/`)) this.frozen.delete(k);
    }
    await this.app.store.saveRun(run);
    this.publish(run);
    log.info(`Прогон #${run.id} — ${run.status}${job ? ` (дозапуск ${job.rerun.n}: ${job.rerun.kind})` : ''}`);
  }

  /** Итог прогона или дозапуска по его линиям: статус, ошибка, время и метрики. */
  private finish(run: RunRecord, job: Job | null, aborted: boolean): void {
    run.finishedAt = nowIso();
    if (job) {
      // Дозапуск: статус — по всем линиям, в том числе тем, которых он не касался. Остановленная линия, где остались
      // не начатые позиции, остаётся остановленной.
      run.status = aborted ? 'stopped' : run.lines.every((l) => l.status === 'failed') ? 'failed' : run.lines.some((l) => l.status === 'stopped') ? 'stopped' : 'completed';
      if (job.rerun.kind !== 'reevaluate') run.error = run.status === 'failed' ? run.lines.map((l) => l.error).filter(Boolean).join('; ') : null;
      const failed = run.lines.filter((l) => job.lines.has(l.index) && l.status === 'failed');
      job.rerun.status = aborted ? 'stopped' : failed.length ? 'failed' : 'completed';
      job.rerun.error ??= failed.map((l) => l.error).filter(Boolean).join('; ') || null;
      job.rerun.finishedAt = run.finishedAt;
    } else if (aborted) run.status = 'stopped';
    else if (run.lines.every((l) => l.status === 'failed')) {
      run.status = 'failed';
      run.error = run.error ?? run.lines.map((l) => l.error).filter(Boolean).join('; ');
    } else run.status = 'completed';
    if (!run.startedAt) run.startedAt = run.finishedAt;
    run.summary = computeRunMetrics(run);
  }

  private async runLine(run: RunRecord, line: LineRecord, live: Live, job: LineJob | null = null): Promise<void> {
    const app = this.app;
    const r = live.resolved;
    const signal = live.abort.signal;
    const owner = `run-${run.id}-l${line.index}`;
    const before = line.status;
    try {
      await app.sessions.acquire(owner, signal);
    } catch {
      // Дозапуск остановлен до сессии: линия не начиналась и остаётся какой была.
      line.status = job ? before : 'stopped';
      this.scheduleSave(run);
      return;
    }
    if (live.job) live.job.began = true;
    try {
      if (run.status === 'queued') {
        run.status = 'running';
        run.startedAt ??= nowIso();
      }
      line.status = 'running';
      line.startedAt ??= nowIso();
      line.finishedAt = null;
      if (!line.senderId) {
        line.senderId = `${app.env.senderPrefix}${r.basket.id}-r${run.id}-${line.index}-${randomHex(3)}`;
        live.hold.add(line.senderId);
      }
      // Оператор начал этот прогон: шаг в журнале операторов сразу, до первого запроса агенту. У дозапуска шаг уже есть.
      app.operators.record(line.senderId, runStep(run, line.index));
      if (!job || line.prep.status === 'pending') this.operatorPrep(run, line);

      const channel = new AgentChannel(r.agent, app.env, app.locks, app.unfinished);
      const operator = new LlmOperator(r.models.operator!, createProvider(r.models.operator!, app.env.raw));
      const judge = r.models.judge ? new LlmJudge(r.models.judge, createProvider(r.models.judge, app.env.raw)) : null;
      const prior = new Set<string>();
      // Дозапуск: уроки итоговых попыток позиций, которые шли раньше, — как если бы линия шла подряд.
      if (job) {
        const first = Math.min(...job.indexes);
        for (const i of line.items) if (i.index < first && i.kind === 'case' && i.outcome && i.outcome !== 'technical') for (const l of i.stats?.lessons ?? []) prior.add(l);
      }
      const training = r.basket.type === 'training';
      const cur = r.basket.curator;
      // Агент не освободил сессию после прерванного запроса: следующие кейсы ждали бы его по очереди — линия останавливается.
      const stuck = (): boolean => {
        const u = channel.unfinishedFor(line.senderId);
        if (!u?.stuck) return false;
        line.error = `Линия остановлена: агент не освободил сессию — прерванный запрос «${u.what}» не закончился за время ожидания`;
        for (const i of line.items) if (i.status === 'pending') i.reason = 'линия остановлена: агент занят прерванным запросом';
        return true;
      };

      for (const item of r.items) {
        if (job && !job.indexes.has(item.index)) continue;
        const rec = line.items.find((x) => x.index === item.index)!;
        if (signal.aborted) break;
        if (item.kind === 'curator') {
          if (training) await this.curatorPass(run, line, channel, 'explicit', this.lastPos(line), signal);
          rec.status = 'completed';
          if (stuck()) break;
          continue;
        }
        await this.runItem(run, line, rec, item, { channel, operator, judge, prior, signal, live });
        if (stuck()) break;
        if (training && cur.enabled && cur.every > 0 && line.counter >= cur.every && !signal.aborted) {
          rec.steps.curatorPass = line.curatorPasses.length + 1;
          await this.curatorPass(run, line, channel, 'every', item.pos!, signal);
          if (stuck()) break;
        }
      }
      if (training && cur.enabled && cur.final && (line.counter > 0 || !!job?.forceFinal) && !signal.aborted && !line.error) {
        const last = [...line.items].reverse().find((i) => i.kind === 'case' && i.outcome && i.outcome !== 'technical');
        if (last) last.steps.curatorPass = line.curatorPasses.length + 1;
        await this.curatorPass(run, line, channel, 'final', this.lastPos(line), signal);
      }
      for (const i of line.items) if (i.status === 'pending') i.status = 'not_started';
      line.current = null;
      // Дозапуск части позиций остановленной линии: где остались не начатые, линия по-прежнему остановлена.
      const left = line.items.some((i) => i.kind === 'case' && i.status === 'not_started');
      line.status = signal.aborted || (job && before === 'stopped' && left) ? 'stopped' : 'completed';
    } catch (e) {
      log.error(`Линия ${line.index} прогона #${run.id}`, e);
      line.status = 'failed';
      line.error = errorMessage(e);
      // Сбой стенда посреди линии: начатый кейс закрывается — удерживаемые вызовы получают ошибку, в записи он не остаётся «идёт».
      const reason = `сбой стенда: ${line.error}`;
      for (const i of line.items) {
        if (i.status === 'running') {
          const exec = i.execName ? live.execs.get(i.execName) : undefined;
          if (exec && !exec.terminal) {
            exec.stop(reason);
            exec.setStatus('internal_error', reason);
            exec.add<StatusEvent>({ type: 'status', status: 'internal_error', reason });
          }
          i.status = 'internal_error';
          i.outcome = 'technical';
          i.reason = reason;
          i.finishedAt = nowIso();
        } else if (i.status === 'pending') i.status = 'not_started';
      }
      for (const p of line.curatorPasses) {
        if (p.status !== 'running') continue;
        p.status = 'failed';
        p.error = reason;
      }
    } finally {
      line.finishedAt = nowIso();
      line.current = null;
      app.sessions.release(owner);
      this.scheduleSave(run, true);
    }
  }

  private lastPos(line: LineRecord): number {
    return [...line.items].reverse().find((i) => i.kind === 'case' && i.outcome)?.pos ?? 0;
  }

  /** Тестовый оператор линии: новый — стартовые скиллы сборки агента, продолжение — текущие скиллы после всей его истории. Файлы скиллов ClawGym не видит. */
  private operatorPrep(run: RunRecord, line: LineRecord): void {
    const ts = nowIso();
    const src = run.settings.testOperator;
    const later = src.mode === 'continue' ? stepsAfter(line.history, src.run) : [];
    const path = line.history.map(stepLabel).join(' → ');
    line.prep = {
      status: 'ok',
      durationMs: 0,
      items: [
        src.mode === 'continue'
          ? {
              ok: true,
              text: `Продолжение на тестовом операторе прогона #${src.run} «${src.title}»: скиллы — ${later.length ? `текущие, после ${later.map(stepLabel).join(' → ')}` : 'после этого прогона'}`,
              note: line.history.length > 1 ? `история оператора: ${path}` : '',
              ts,
            }
          : { ok: true, text: 'Новый тестовый оператор: стартовые скиллы сборки агента', note: '', ts },
        { ok: true, text: `x-a2a-sender-id = ${line.senderId}`, note: 'на этом операторе можно продолжить следующий прогон', ts },
      ],
    };
    this.scheduleSave(run);
  }

  /**
   * Позиция корзины. Быстрый технический сбой — сбой LLM-оператора, /reset или ошибка агента — сразу повторяется на месте,
   * пока не исчерпан retries (решение владельца от 12.11.2026). Capture, счётчик curator и уроки линии — по итоговой попытке.
   */
  private async runItem(run: RunRecord, line: LineRecord, rec: ItemRecord, item: ResolvedItem, deps: Deps): Promise<void> {
    const training = deps.live.resolved.basket.type === 'training';
    let a = await this.runAttempt(run, line, rec, item, deps);
    for (let n = 0; n < (run.settings.retries ?? 0) && RETRYABLE_STATUSES.has(a.exec.status) && !deps.signal.aborted; n++) {
      if (training) rec.steps.capture = { status: 'not_sent', signal: null, path: null, reason: 'кейс прерван технически, повтор на месте' };
      rec.status = a.exec.status;
      rec.finishedAt = nowIso();
      await (this.persistNow(a.key) ?? a.persist());
      this.scheduleSave(run);
      a = await this.runAttempt(run, line, rec, item, deps);
    }
    const exec = a.exec;
    // Повторная поправка — урок, который уже поправляли в итоговой попытке прежней позиции. Технический сбой не дошёл до
    // capture: агент на нём не учился, и его поправки повторными не делают.
    if (rec.outcome !== 'technical') for (const l of rec.stats?.lessons ?? []) deps.prior.add(l);

    if (training) {
      if (rec.outcome !== 'technical' && !deps.signal.aborted) {
        line.current = { index: item.index, execName: rec.execName, phase: 'capture' };
        this.scheduleSave(run);
        const cmd = await deps.channel.command(exec, 'capture', 'runner', deps.signal);
        const p: any = cmd.parsed;
        rec.steps.capture = { status: cmd.status, signal: p?.signal ?? null, path: p?.path ?? null, reason: p?.reason ?? cmd.error ?? null };
        line.counter++;
      } else {
        rec.steps.capture = { status: 'not_sent', signal: null, path: null, reason: rec.outcome === 'technical' ? 'кейс прерван технически' : 'прогон остановлен' };
      }
    }
    rec.status = exec.status;
    rec.finishedAt = nowIso();
    // Отложенное сохранение снимается: события после конца кейса — поздние вызовы прерванного хода — тоже сохраняются.
    await (this.persistNow(a.key) ?? a.persist());
    this.scheduleSave(run);
  }

  /** Попытка позиции — новое выполнение со своим журналом и x-task-id: диалог и оценка. Прежняя попытка уходит в attempts. */
  private async runAttempt(run: RunRecord, line: LineRecord, rec: ItemRecord, item: ResolvedItem, deps: Deps): Promise<Attempt> {
    const app = this.app;
    const r = deps.live.resolved;
    if (rec.execName) this.supersede(run, rec);
    const n = rec.attempts.length + 1;
    const caseDef = item.caseDef as CaseDef;
    const solution = item.solution as SolutionDef;
    const name = attemptName(line.index, item.pos!, n);
    // Номер обращения у всех попыток один: для агента это то же обращение. x-task-id и request_ref стартового сообщения — новые.
    const caseNumber = r.repetitions > 1 ? `CG-${run.id}-${line.index}-${String(item.pos).padStart(2, '0')}` : `CG-${run.id}-${String(item.pos).padStart(2, '0')}`;
    const exec = new Execution({
      id: `run${run.id}-${name}`,
      mode: 'auto',
      caseDef,
      // Контракт — из снимка запуска, а не из текущих настроек: «Проверить файлы снова» не меняет идущий прогон.
      contract: r.contract!,
      solution,
      basketType: r.basket.type,
      senderId: line.senderId,
      caseNumber,
      requestRef: requestRef(caseNumber, app.secret),
      taskIdScope: r.agent.request.taskIdScope,
      env: app.env,
      run: { runId: run.id, line: line.index, position: item.pos! },
    });
    app.bindings.bindAll(exec);
    deps.live.execs.set(name, exec);
    rec.execName = name;
    rec.status = 'running';
    rec.startedAt = nowIso();
    const phase = (p: string) => (n > 1 ? `${p} · попытка ${n}` : p);
    line.current = { index: item.index, execName: name, phase: phase('диалог') };
    const key = `${run.id}/${name}`;
    const persist = () => Promise.all([app.store.saveExecution(run.id, name, { ...exec.toJSON(), item: this.frozen.get(key) ?? rec }), app.store.saveHttp(run.id, name, exec.http)]);
    exec.onChange((c) => {
      // Шаг /reset отмечается сразу, не дожидаясь конца диалога.
      if (c.kind === 'event' && c.event.type === 'command' && c.event.name === 'reset' && c.event.status !== 'running' && !rec.steps.reset && rec.execName === name) {
        rec.steps.reset = c.event.status;
        this.scheduleSave(run);
      }
      if (!this.persists.has(key)) this.persists.set(key, { persist, timer: setTimeout(() => void this.persistNow(key)?.catch(() => undefined), 400) });
      app.publish(`run:${run.id}`, 'exec', { line: line.index, name, kind: c.kind, seq: c.kind === 'event' ? c.event.seq : null, status: exec.status });
    });
    this.scheduleSave(run);

    const outcome = await runDialog(exec, {
      channel: deps.channel,
      operator: deps.operator,
      mode: r.basket.type,
      checkingConfirmations: r.basket.checking.confirmations,
      limits: item.limits,
      confirmationTimeoutMs: app.env.agentMcpTimeoutMs - app.env.operatorMarginMs,
      priorLessons: deps.prior,
      signal: deps.signal,
    });
    exec.closeTools();
    exec.setStatus(outcome.status, outcome.reason);
    exec.add<StatusEvent>({ type: 'status', status: outcome.status, reason: outcome.reason });
    rec.steps.reset = (exec.events.find((e) => e.type === 'command' && (e as CommandEvent).name === 'reset') as CommandEvent | undefined)?.status ?? null;
    rec.steps.dialog = outcome.status;
    rec.resultSeq = outcome.resultSeq;

    line.current = { index: item.index, execName: name, phase: phase('оценка') };
    this.scheduleSave(run);
    const ev = await evaluate(exec, outcome.resultSeq, deps.judge, deps.signal, scoringOf(run.settings.metrics));
    this.applyEvaluation(rec, ev);
    rec.stats = execStats(exec);
    rec.repeated = rec.stats.lessons.filter((l) => deps.prior.has(l));
    return { exec, key, persist };
  }

  /** Новая попытка позиции: прежняя уходит в attempts со своим итогом, а её журнал сохраняет позицию на её конец. */
  private supersede(run: RunRecord, rec: ItemRecord): void {
    this.frozen.set(`${run.id}/${rec.execName}`, structuredClone(rec));
    rec.attempts.push({ n: rec.attempts.length + 1, execName: rec.execName!, status: rec.status, outcome: rec.outcome, reason: rec.reason, startedAt: rec.startedAt, finishedAt: rec.finishedAt });
    Object.assign(rec, { execName: null, status: 'pending', outcome: null, reason: '', startedAt: null, finishedAt: null, resultSeq: null, reevaluated: false, checks: null, answerFailed: [], scores: null, stats: null, repeated: [] });
    rec.steps = { reset: null, dialog: null, checks: null, judge: null, capture: null, curatorPass: null };
  }

  private applyEvaluation(rec: ItemRecord, ev: Evaluation): void {
    rec.outcome = ev.outcome;
    rec.reason = ev.reason;
    rec.checks = ev.checks;
    rec.steps.checks = ev.checks ? { passed: ev.checks.filter((c) => c.passed).length, total: ev.checks.length } : null;
    rec.steps.judge = ev.judge ? { status: ev.judge.status, passed: ev.judge.passed, total: ev.judge.total } : null;
    rec.answerFailed = ev.judge?.failed ?? [];
    rec.scores = ev.scores ? itemScores(ev.scores) : null;
    rec.reevaluated = ev.repeated;
  }

  /** Проход curator между решениями (BASK-02): /reset → /skill-curator. Что изменилось — по строке результата; файлы скиллов остаются в агенте. */
  private async curatorPass(run: RunRecord, line: LineRecord, channel: AgentChannel, reason: CuratorPassRecord['reason'], afterPos: number, signal: AbortSignal): Promise<void> {
    const pass = line.curatorPasses.length + 1;
    const rec: CuratorPassRecord = { pass, afterPos, reason, status: 'running', startedAt: nowIso(), durationMs: null, reset: null, text: '', reply: null, parsed: null, report: null };
    line.curatorPasses.push(rec);
    line.current = { index: -1, execName: null, phase: `curator ${reason === 'final' ? 'финальный' : pass}` };
    this.scheduleSave(run);
    const taskId = `cg-${run.id}-${line.index}-cur${pass}-${randomHex(2)}`;
    const t0 = Date.now();
    // Обмен — в записи прохода с момента отправки: страница прогона видит и висящий /skill-curator.
    const track = (x: HttpExchange, phase: 'start' | 'end') => {
      if (phase === 'start') (rec.http ??= []).push(x);
      this.scheduleSave(run);
    };
    if (run.settings.basket.curator.resetBefore) {
      const rs = await channel.rawCommand(line.senderId, taskId, 'reset', signal, track);
      rec.reset = { status: rs.status, durationMs: rs.durationMs, error: rs.error };
      if (rs.status !== 'ok') {
        rec.status = 'failed';
        rec.error = `Сбой /reset перед curator: ${rs.error ?? rs.status}`;
        rec.durationMs = Date.now() - t0;
        line.counter = 0;
        this.scheduleSave(run);
        return;
      }
    }
    const c = await channel.rawCommand(line.senderId, taskId, 'curator', signal, track);
    Object.assign(rec, { text: c.text, reply: c.reply, parsed: c.parsed, status: c.status, error: c.error, durationMs: Date.now() - t0 });
    line.counter = 0;
    const p: any = c.parsed;
    rec.report = p?.kind === 'complete' ? (p.report ?? null) : null;
    this.scheduleSave(run);
  }

  // ------------------------------------------------------------------ дозапуск (решение владельца от 12.11.2026)

  private snapshotCheck(run: RunRecord): Promise<SnapshotCheck> {
    let p = this.snapshots.get(run.id);
    if (!p) {
      p = checkSnapshot(run, path.join(this.app.store.runDir(run.id), 'snapshot'), this.app.env).catch(
        (e): SnapshotCheck => ({ resolved: null, errors: [{ severity: 'error', file: 'snapshot/', reason: `прогон не собирается из снимка: ${errorMessage(e)}` }], diffs: [], hidden: [] }),
      );
      this.snapshots.set(run.id, p);
    }
    return p;
  }

  /** Что у прогона можно дозапустить и что мешает: позиции и линии — по записи, условия — по снимку и тестовым операторам. */
  async dorun(run: RunRecord): Promise<DorunState> {
    const busy = run.status === 'queued' || run.status === 'running' || this.live.has(run.id);
    const rerun = rerunItems(run);
    const resume = resumeLines(run);
    const reeval = reevaluateItems(run);
    const common = busy ? ['Прогон в очереди или идёт: дождитесь его завершения'] : [];
    const snap = !busy && (rerun.length || resume.length || reeval.length) ? await this.snapshotCheck(run) : null;
    const reasons = (kind: 'rerun' | 'resume' | 'reevaluate', lines: number[]) => [
      ...common,
      ...(snap ? snapshotReasons(snap, kind) : []),
      ...(kind === 'reevaluate' ? [] : operatorReasons(run, lines, this.app.operators)),
    ];
    const rr = reasons('rerun', linesOf(rerun));
    const rs = reasons('resume', resume.map((l) => l.line));
    const re = reasons('reevaluate', []);
    return {
      rerun: { available: rerun.length > 0 && !rr.length, items: rerun, reasons: rerun.length ? rr : [] },
      resume: { available: resume.length > 0 && !rs.length, items: [], lines: resume, reasons: resume.length ? rs : [] },
      reevaluate: { available: reeval.length > 0 && !re.length, items: reeval, reasons: reeval.length ? re : [] },
      note: NOTE,
    };
  }

  /**
   * Дозапуск завершённого, остановленного или упавшего прогона: перезапуск позиций проверки (rerun), продолжение линий
   * обучения (resume) или переоценка упавших оценок (reevaluate). Прогон снова встаёт в очередь и собирается из снимка.
   */
  async dorunStart(id: number, kind: RerunRecord['kind'], sel: { items?: string[]; lines?: number[] } = {}): Promise<RunRecord> {
    const run = this.get(id);
    if (kind === 'rerun' && run.type !== 'checking') {
      throw new HttpError(409, 'Перезапуск позиций — только у проверяющего прогона', ['Обучающую линию можно продолжить с места остановки: POST /api/runs/:id/resume']);
    }
    if (kind === 'resume' && run.type !== 'training') {
      throw new HttpError(409, 'Продолжение — только для линий обучающего прогона', ['Проверяющий прогон перезапускается: POST /api/runs/:id/rerun']);
    }
    const positions = new Set(run.lines.flatMap((l) => l.items.filter((i) => i.kind === 'case' && i.pos !== null).map((i) => posKey(l.index, i.pos!))));
    const unknown = kind === 'resume' ? (sel.lines ?? []).filter((n) => !run.lines.some((l) => l.index === n)).map((n) => `линии ${n}`) : (sel.items ?? []).filter((k) => !positions.has(k)).map((k) => `позиции ${k}`);
    if (unknown.length) throw new HttpError(400, `В прогоне #${id} нет ${unknown.join(', ')}`);

    const state = await this.dorun(run);
    const snap = await this.snapshotCheck(run);
    const a = state[kind];
    const eligible: (string | number)[] = kind === 'resume' ? state.resume.lines.map((l) => l.line) : a.items;
    const wanted: (string | number)[] = kind === 'resume' ? (sel.lines ?? eligible) : (sel.items ?? eligible);
    const why = kind === 'rerun' ? 'перезапускаются только позиции с техническим сбоем и не начатые' : kind === 'reevaluate' ? 'оценка не падала: переоценивается только упавшая' : 'продолжить нельзя: линия дошла до конца корзины или после остановки прошёл curator';
    const reasons = [...a.reasons, ...wanted.filter((w) => !eligible.includes(w)).map((w) => `${typeof w === 'number' ? `Линия ${w}` : w}: ${why}`)];
    if (!wanted.length && !reasons.length) reasons.push(kind === 'rerun' ? 'Нет позиций для перезапуска' : kind === 'resume' ? 'Нет линий, которые можно продолжить' : 'Нет упавших оценок');
    if (reasons.length) throw new HttpError(409, `Дозапуск прогона #${id} недоступен`, reasons);

    // После await прогон мог встать в очередь: проверка и резерв операторов — один синхронный шаг, как при запуске.
    if (run.status === 'queued' || run.status === 'running' || this.live.has(id)) throw new HttpError(409, `Прогон #${id} в очереди или идёт`);
    const lines = kind === 'resume' ? (wanted as number[]) : linesOf(wanted as string[]);
    const senders = kind === 'reevaluate' ? [] : run.lines.filter((l) => lines.includes(l.index) && l.senderId).map((l) => l.senderId);
    const hold = this.app.operators.reserve(senders, 'run', `дозапуском прогона #${id}`);

    const jobLines = new Map<number, LineJob>();
    if (kind === 'resume') {
      for (const n of lines) {
        const from = state.resume.lines.find((l) => l.line === n)!.from;
        const line = run.lines.find((l) => l.index === n)!;
        jobLines.set(n, { indexes: new Set(from === null ? [] : line.items.filter((i) => i.index >= from).map((i) => i.index)), forceFinal: from === null });
      }
    } else {
      for (const k of wanted as string[]) {
        const p = parsePosKey(k)!;
        const index = run.lines.find((l) => l.index === p.line)!.items.find((i) => i.pos === p.pos)!.index;
        const lj = jobLines.get(p.line) ?? { indexes: new Set<number>(), forceFinal: false };
        lj.indexes.add(index);
        jobLines.set(p.line, lj);
      }
    }
    const rerun: RerunRecord = {
      n: run.reruns.length + 1,
      kind,
      items: kind === 'resume' ? [] : (wanted as string[]),
      lines,
      requestedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      error: null,
      previous: { status: run.status, run: run.error, lines: [] },
    };
    // Ошибки, с которыми остановились линии, переходят в запись дозапуска: после него они не висят на прогоне.
    if (kind !== 'reevaluate') {
      for (const l of run.lines.filter((x) => lines.includes(x.index) && x.error)) {
        rerun.previous.lines.push({ line: l.index, error: l.error! });
        l.error = null;
      }
      run.error = null;
    }
    run.reruns.push(rerun);
    run.status = 'queued';
    this.live.set(id, { abort: new AbortController(), resolved: snap.resolved!, execs: new Map(), started: false, hold, job: { rerun, lines: jobLines, began: false } });
    try {
      await this.app.store.saveRun(run);
    } catch (e) {
      this.live.delete(id);
      hold.release();
      this.restore(run, rerun);
      run.reruns.pop();
      throw e;
    }
    this.publish(run);
    log.info(`Прогон #${id}: дозапуск ${rerun.n} (${kind}) поставлен в очередь`);
    setImmediate(() => this.tick());
    return run;
  }

  /** Переоценка: журнал итоговой попытки, кейс и модель судьи — из снимка. Агенту ничего не уходит, сессия агента не нужна. */
  private async reevaluateJob(run: RunRecord, live: Live, job: Job): Promise<void> {
    const app = this.app;
    const r = live.resolved;
    const judge = new LlmJudge(r.models.judge!, createProvider(r.models.judge!, app.env.raw));
    const scoring = scoringOf(run.settings.metrics);
    const errors: string[] = [];
    job.began = true;
    if (run.status === 'queued') run.status = 'running';
    for (const line of run.lines) {
      const lj = job.lines.get(line.index);
      if (!lj) continue;
      for (const rec of line.items.filter((i) => lj.indexes.has(i.index))) {
        if (live.abort.signal.aborted) break;
        const item = r.items.find((x) => x.index === rec.index);
        const name = rec.execName!;
        try {
          if (!item?.caseDef) throw new Error('кейса позиции нет в снимке');
          line.current = { index: rec.index, execName: name, phase: 'переоценка' };
          this.scheduleSave(run);
          const saved = await app.store.loadExecution(run.id, name);
          if (!saved) throw new Error('журнал кейса не найден');
          const http = (await app.store.loadHttp(run.id, name)) ?? [];
          const exec = Execution.restore(
            { id: saved.id, mode: 'auto', caseDef: item.caseDef, contract: r.contract!, solution: item.solution, basketType: r.basket.type, senderId: saved.senderId, caseNumber: saved.caseNumber, requestRef: saved.requestRef, taskIdScope: r.agent.request.taskIdScope, env: app.env, run: saved.run },
            saved,
            http,
          );
          live.execs.set(name, exec);
          // Граница результата; у записей до 12.11.2026 её нет — событие перед итоговым статусом диалога.
          const status = saved.events.find((e) => e.type === 'status');
          const boundary = rec.resultSeq ?? (status ? status.seq - 1 : exec.events.length);
          const prevAnswer = ([...saved.events].reverse().find((e) => e.type === 'scores') as ScoresEvent | undefined)?.answer ?? null;
          const j = rec.steps.judge;
          const ev = await reevaluate(
            exec,
            boundary,
            judge,
            { checks: rec.checks ?? [], judge: { status: j?.status === 'ok' || j?.status === 'failed' ? j.status : 'skipped', passed: j?.passed ?? 0, total: j?.total ?? 0, failed: rec.answerFailed }, answer: prevAnswer },
            live.abort.signal,
            scoring,
          );
          const was = rec.reevaluated;
          this.applyEvaluation(rec, ev);
          rec.reevaluated = was || ev.repeated;
          await Promise.all([app.store.saveExecution(run.id, name, { ...exec.toJSON(), item: rec }), app.store.saveHttp(run.id, name, exec.http)]);
        } catch (e) {
          errors.push(`${posKey(line.index, rec.pos!)}: ${errorMessage(e)}`);
          log.warn(`Переоценка ${name} прогона #${run.id}: ${errorMessage(e)}`);
        }
        this.scheduleSave(run);
      }
      line.current = null;
    }
    if (errors.length) job.rerun.error = errors.join('; ');
  }

  private publish(run: RunRecord): void {
    this.app.publish('runs', 'run', { id: run.id, status: run.status });
    this.app.publish(`run:${run.id}`, 'run', { id: run.id, status: run.status });
  }

  /** Сохранение и уведомление не чаще раза в 300 мс; force — немедленно. */
  scheduleSave(run: RunRecord, force = false): void {
    const t = this.saveTimers.get(run.id);
    if (t && !force) return;
    if (t) clearTimeout(t);
    const doSave = () => {
      this.saveTimers.delete(run.id);
      if (!this.runs.has(run.id)) return;
      this.app.store.saveRun(run).catch((e) => log.error('Сохранение прогона', e));
      this.publish(run);
    };
    if (force) doSave();
    else this.saveTimers.set(run.id, setTimeout(doSave, 300));
  }
}
