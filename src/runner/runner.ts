// Раннер прогонов (RUN-01–03, BASK-01–05, SK-03–06): очередь, линии повторений, кейсы, команды обучения,
// проходы curator, итоговое состояние скиллов, новая версия после обучения и контроль неизменности в проверке.
import type { App } from '../app.js';
import type { CaseDef, SolutionDef } from '../config/types.js';
import { Execution } from '../execution/execution.js';
import { AgentChannel } from '../execution/channel.js';
import { runDialog } from '../execution/dialog.js';
import { evaluate, execStats } from '../execution/evaluate.js';
import type { CommandEvent, StatusEvent } from '../execution/events.js';
import { LlmOperator } from '../operator/operator.js';
import { LlmJudge } from '../judge/judge.js';
import { JUDGE_PROMPT_VERSION, JUDGE_SYSTEM, OPERATOR_PROMPT_VERSION, OPERATOR_SYSTEM } from '../operator/prompts.js';
import { createProvider } from '../llm/provider.js';
import { createInstaller, type Installer, type WsFile } from '../skillsets/installer.js';
import { registerVersion } from '../skillsets/store.js';
import { resolveRun, type ResolvedItem, type ResolvedRun, type RunOverrides } from './resolve.js';
import type { CuratorPassRecord, ItemRecord, LineRecord, PrepItem, RunRecord } from './types.js';
import { computeRunMetrics } from '../metrics/builtins.js';
import { runKey } from '../results/store.js';
import { HttpError } from '../util/http.js';
import { diffTrees } from '../util/diff.js';
import { manifestChecksum } from '../util/fsx.js';
import { errorMessage, nowIso, plural, randomHex, requestRef } from '../util/core.js';
import { logger } from '../util/log.js';

const log = logger('runner');

interface Live {
  abort: AbortController;
  resolved: ResolvedRun;
  execs: Map<string, Execution>;
}

export const execName = (line: number, pos: number) => `L${line}-P${String(pos).padStart(2, '0')}`;

/** Секреты в копии файла подключения для снимка: значения, заданные не ссылкой на окружение, скрываются. */
export function redactSecrets(text: string): string {
  return text.replace(/^(\s*["']?(?:authorization|proxy-authorization|x-api-key|api-key|apikey|apiKey|token|password)["']?\s*:\s*)(.+)$/gim, (m, k: string, v: string) =>
    v.includes('${env:') ? m : `${k}"***"`,
  );
}

export class RunManager {
  runs = new Map<number, RunRecord>();
  private live = new Map<number, Live>();
  private timer: NodeJS.Timeout | null = null;
  private saveTimers = new Map<number, NodeJS.Timeout>();

  constructor(private app: App) {}

  async init(): Promise<void> {
    for (const r of (await this.app.store.loadRuns()) as RunRecord[]) {
      if (r.status === 'running' || r.status === 'queued') {
        const wasRunning = r.status === 'running';
        r.status = 'failed';
        r.error = wasRunning ? 'ClawGym перезапущен во время прогона: начатый шаг не завершён' : 'ClawGym перезапущен до старта прогона — запустите его снова';
        r.finishedAt = r.finishedAt ?? nowIso();
        for (const l of r.lines) {
          if (l.status === 'running' || l.status === 'queued') l.status = 'failed';
          for (const i of l.items) if (i.status === 'running') i.status = 'internal_error';
        }
        await this.app.store.saveRun(r);
      }
      this.runs.set(r.id, r);
    }
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const l of this.live.values()) l.abort.abort(new Error('ClawGym останавливается'));
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
    const preview = resolveRun(app.registry, app.env, configId, overrides);
    if (!preview.ok || !preview.resolved) {
      throw new HttpError(422, 'Прогон не запустится: ошибка в настройках. Агенту не отправлено ни одного запроса', preview.issues.filter((i) => i.severity === 'error'));
    }
    const r = preview.resolved;
    const id = await app.store.nextNumber('run');
    const createdAt = nowIso();

    // Снимок: копии файлов, участвующих в прогоне; правка исходников потом не меняет результат.
    const snapFiles: { file: string; hash: string }[] = [];
    const texts = new Map<string, string>();
    const reg = app.registry;
    const sources = [
      r.config.source,
      r.basket.source,
      r.agent.source,
      ...(reg.contract ? [reg.contract.source] : []),
      ...(reg.contract?.defaultsSource ? [reg.contract.defaultsSource] : []),
      ...r.items.flatMap((i) => [i.solution?.source, i.caseDef?.source, ...(i.caseDef?.dataFiles ?? [])]),
      ...[r.models.agent, r.models.operator, r.models.judge].map((m) => m?.source),
      ...r.metrics.map((m) => m.source),
      ...(r.skillset && r.skillset !== 'build' ? [r.skillset.set.source] : []),
    ].filter(Boolean) as { file: string; hash: string; text: string }[];
    for (const s of sources) if (!texts.has(s.file)) texts.set(s.file, s.file.startsWith('agents/') || s.file.startsWith('models/') ? redactSecrets(s.text) : s.text);
    if (reg.contract) texts.set(reg.contract.startMessage.file, reg.contract.startMessage.text);
    if (r.agent.request.bodySource) texts.set(r.agent.request.bodySource, JSON.stringify(r.agent.request.body, null, 2));
    texts.set(`prompts/${OPERATOR_PROMPT_VERSION}.txt`, OPERATOR_SYSTEM);
    texts.set(`prompts/${JUDGE_PROMPT_VERSION}.txt`, JUDGE_SYSTEM);
    if (r.skillset && r.skillset !== 'build') {
      texts.set(
        'skillset.json',
        JSON.stringify({ skillset: r.skillset.set.id, version: r.skillset.version.id, checksum: r.skillset.version.checksum, files: r.skillset.version.files.map((f) => ({ path: f.path, sha256: f.sha256 })) }, null, 2),
      );
    }
    for (const [file, text] of texts) {
      await app.store.saveText(id, `snapshot/${file}`, text);
      snapFiles.push({ file, hash: sources.find((s) => s.file === file)?.hash ?? '' });
    }

    const lines: LineRecord[] = [];
    for (let li = 1; li <= r.repetitions; li++) lines.push(this.newLine(li, r));
    const ss = r.skillset;
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
        agent: { id: r.agent.id, title: r.agent.title, file: r.agent.source.file, hash: r.agent.source.hash, build: r.agent.build, learningKit: r.agent.learningKit, installer: r.agent.skills.kind },
        agentModel: { ...r.agentModel, id: r.models.agent?.id ?? null },
        operator: r.models.operator ? { id: r.models.operator.id, title: r.models.operator.title, provider: r.models.operator.provider, model: r.models.operator.model, file: r.models.operator.source.file, hash: r.models.operator.source.hash } : null,
        judge: r.models.judge ? { id: r.models.judge.id, title: r.models.judge.title, provider: r.models.judge.provider, model: r.models.judge.model, file: r.models.judge.source.file, hash: r.models.judge.source.hash } : null,
        skillset: ss === 'build' ? 'build' : ss ? { id: ss.set.id, title: ss.set.title, version: ss.version.id, requested: ss.requested, checksum: ss.version.checksum, files: ss.version.files.length } : null,
        metrics: r.metrics.map((m) => ({ id: m.id, title: m.title, builtin: m.builtin, version: m.version })),
        limits: r.limits,
        repetitions: r.repetitions,
        prompts: { operator: OPERATOR_PROMPT_VERSION, judge: JUDGE_PROMPT_VERSION },
        contract: reg.contract ? { file: reg.contract.source.file, hash: reg.contract.source.hash, version: reg.contract.version, conditional: reg.contract.conditional } : { file: '', hash: '', version: '', conditional: true },
      },
      snapshot: { createdAt, files: snapFiles },
      plan: preview.plan,
      planText: preview.planText,
      metricsAvailability: preview.metrics,
      warnings: preview.issues.filter((i) => i.severity === 'warning'),
      lines,
      summary: null,
    };
    this.runs.set(id, run);
    this.live.set(id, { abort: new AbortController(), resolved: r, execs: new Map() });
    await app.store.saveRun(run);
    this.publish(run);
    log.info(`Прогон #${id} (${r.config.id}) поставлен в очередь`);
    setImmediate(() => this.tick());
    return run;
  }

  private newLine(index: number, r: ResolvedRun): LineRecord {
    const items: ItemRecord[] = r.items.map((i) => this.newItem(i));
    return {
      index,
      senderId: '',
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      error: null,
      prep: { status: 'pending', items: [], durationMs: null },
      items,
      curatorPasses: [],
      counter: 0,
      current: null,
      skills: {
        mode: r.skillset === 'build' ? 'build' : r.skillset ? 'version' : 'none',
        source: r.skillset && r.skillset !== 'build' ? { skillset: r.skillset.set.id, version: r.skillset.version.id, checksum: r.skillset.version.checksum, files: r.skillset.version.files.length } : null,
        initial: null,
        final: null,
        changes: null,
        newVersion: null,
        versionNote: '',
        immutability: null,
      },
      materials: [],
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
      steps: { reset: null, dialog: null, checks: null, judge: null, capture: null, curatorPass: null },
      checks: null,
      answerFailed: [],
      stats: null,
      repeated: [],
      limits: i.limits,
    };
  }

  /** Остановка: новые элементы не запускаются, удерживаемые вызовы получают ошибку (RUN-03). */
  async stop(id: number): Promise<RunRecord> {
    const run = this.get(id);
    const live = this.live.get(id);
    if (run.status === 'queued') {
      run.status = 'stopped';
      run.error = 'Убран из очереди до старта';
      run.finishedAt = nowIso();
      for (const l of run.lines) l.status = 'stopped';
      live?.abort.abort(new Error('Прогон остановлен'));
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

  /** Удаление завершённого прогона с журналами и материалами (уточнение владельца от 26.10.2026). Версии скиллов, полученные прогоном, остаются. */
  async delete(id: number): Promise<void> {
    const run = this.get(id);
    if (run.status === 'queued') throw new HttpError(409, `Прогон #${id} в очереди: сначала уберите его из очереди`);
    if (run.status === 'running' || this.live.has(id)) throw new HttpError(409, `Прогон #${id} идёт: сначала остановите его и дождитесь завершения`);
    const t = this.saveTimers.get(id);
    if (t) clearTimeout(t);
    this.saveTimers.delete(id);
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
      if (!live || (live as any).started) continue;
      if (run.startAt && Date.parse(run.startAt) > Date.now()) continue;
      (live as any).started = true;
      this.execute(run, live).catch((e) => {
        log.error(`Прогон #${run.id} упал`, e);
        run.status = 'failed';
        run.error = errorMessage(e);
        run.finishedAt = nowIso();
        this.scheduleSave(run, true);
      });
    }
  }

  private async execute(run: RunRecord, live: Live): Promise<void> {
    await Promise.all(run.lines.map((l) => this.runLine(run, l, live)));
    const aborted = live.abort.signal.aborted;
    run.finishedAt = nowIso();
    if (aborted) run.status = 'stopped';
    else if (run.lines.every((l) => l.status === 'failed')) {
      run.status = 'failed';
      run.error = run.error ?? run.lines.map((l) => l.error).filter(Boolean).join('; ');
    } else run.status = 'completed';
    if (!run.startedAt) run.startedAt = run.finishedAt;
    run.summary = computeRunMetrics(run);
    await this.app.store.saveRun(run);
    for (const e of live.execs.values()) this.app.bindings.unbindAll(e);
    this.live.delete(run.id);
    this.publish(run);
    await this.app.reload().catch((e) => log.warn(`Не удалось перечитать настройки после прогона: ${errorMessage(e)}`));
    log.info(`Прогон #${run.id} — ${run.status}`);
  }

  private async runLine(run: RunRecord, line: LineRecord, live: Live): Promise<void> {
    const app = this.app;
    const r = live.resolved;
    const signal = live.abort.signal;
    const owner = `run-${run.id}-l${line.index}`;
    try {
      await app.sessions.acquire(owner, signal);
    } catch {
      line.status = 'stopped';
      this.scheduleSave(run);
      return;
    }
    try {
      if (run.status === 'queued') {
        run.status = 'running';
        run.startedAt = nowIso();
      }
      line.status = 'running';
      line.startedAt = nowIso();
      line.senderId = `${app.env.senderPrefix}${r.basket.id}-r${run.id}-${line.index}-${randomHex(3)}`;
      this.scheduleSave(run);

      const channel = new AgentChannel(r.agent, app.env, app.locks, r.agentModel.value);
      const installer = createInstaller(r.agent.skills, app.env.raw);
      const operator = new LlmOperator(r.models.operator!, createProvider(r.models.operator!, app.env.raw));
      const judge = r.models.judge ? new LlmJudge(r.models.judge, createProvider(r.models.judge, app.env.raw)) : null;

      const initial = await this.prepare(run, line, r, installer);
      if (!initial.ok) {
        line.status = 'failed';
        line.error = 'Подготовка набора скиллов не прошла — кейсы не запускались';
        for (const i of line.items) i.status = 'not_started';
        return;
      }
      let prev: WsFile[] | null = initial.files;
      const prior = new Set<string>();
      const training = r.basket.type === 'training';
      const cur = r.basket.curator;

      for (const item of r.items) {
        const rec = line.items.find((x) => x.index === item.index)!;
        if (signal.aborted) break;
        if (item.kind === 'curator') {
          if (training) prev = await this.curatorPass(run, line, channel, installer, prev, 'explicit', this.lastPos(line), signal);
          rec.status = 'completed';
          continue;
        }
        await this.runItem(run, line, rec, item, { channel, operator, judge, installer, prior, signal, live });
        if (training && cur.enabled && cur.every > 0 && line.counter >= cur.every && !signal.aborted) {
          rec.steps.curatorPass = line.curatorPasses.length + 1;
          prev = await this.curatorPass(run, line, channel, installer, prev, 'every', item.pos!, signal);
        }
      }
      if (training && cur.enabled && cur.final && line.counter > 0 && !signal.aborted) {
        const last = [...line.items].reverse().find((i) => i.kind === 'case' && i.outcome && i.outcome !== 'technical');
        if (last) last.steps.curatorPass = line.curatorPasses.length + 1;
        prev = await this.curatorPass(run, line, channel, installer, prev, 'final', this.lastPos(line), signal);
      }
      for (const i of line.items) if (i.status === 'pending') i.status = 'not_started';
      line.current = null;
      await this.finalizeSkills(run, line, r, installer, initial.files, signal.aborted);
      line.status = signal.aborted ? 'stopped' : 'completed';
    } catch (e) {
      log.error(`Линия ${line.index} прогона #${run.id}`, e);
      line.status = 'failed';
      line.error = errorMessage(e);
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

  /** Подготовка рабочей копии выбранной версии (SK-03): установка, сверка контрольных сумм, чужие pending-кейсы. */
  private async prepare(run: RunRecord, line: LineRecord, r: ResolvedRun, installer: Installer): Promise<{ ok: boolean; files: WsFile[] | null }> {
    const t0 = Date.now();
    const items: PrepItem[] = [];
    const push = (ok: boolean | null, text: string, note = '') => {
      items.push({ ok, text, note, ts: nowIso() });
      line.prep.items = items;
      this.scheduleSave(run);
    };
    line.prep.status = 'pending';
    line.current = { index: -1, execName: null, phase: 'подготовка' };
    let files: WsFile[] | null = null;
    let ok = true;
    const ss = r.skillset;
    if (ss && ss !== 'build') {
      const v = ss.version;
      try {
        await installer.prepare(line.senderId);
        await installer.install(line.senderId, v.files.map((f) => ({ path: f.path, content: f.content })));
        files = await installer.exportSkills(line.senderId);
        const sum = manifestChecksum(files);
        if (sum === v.checksum) push(true, `Рабочая копия ${v.id} установлена: ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}, контрольные суммы совпали`);
        else {
          const ch = diffTrees(v.files, files, false);
          push(false, 'Набор не совпал с выбранным — кейсы не запускаются', ch.slice(0, 4).map((c) => `${c.kind} ${c.path}`).join(', '));
          ok = false;
        }
        const pend = await installer.pending(line.senderId);
        if (pend.length) {
          push(false, `В сессии есть чужие pending-кейсы и свежие уроки: ${pend.length}`, pend.slice(0, 3).join(', '));
          ok = false;
        } else push(true, 'Чужих pending-кейсов и свежих уроков в сессии нет');
      } catch (e) {
        push(false, 'Не удалось подготовить набор скиллов', errorMessage(e));
        ok = false;
      }
    } else if (ss === 'build') {
      push(null, 'Стартовые скиллы сборки агента: набор не устанавливался (промежуточный режим)');
      if (installer.canExport) {
        try {
          files = await installer.exportSkills(line.senderId);
          push(true, `Исходное состояние выгружено: ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}`);
        } catch (e) {
          push(null, 'Исходное состояние скиллов не выгружено', errorMessage(e));
        }
      }
    } else push(null, 'Набор скиллов не выбран');
    push(true, `Техническая сессия прогона: x-a2a-sender-id = ${line.senderId}`);
    if (files) {
      line.skills.initial = { checksum: manifestChecksum(files), files: files.length };
      await this.app.store.saveFiles(run.id, `skills/L${line.index}/initial`, files);
    }
    line.prep.status = ok ? 'ok' : 'failed';
    line.prep.durationMs = Date.now() - t0;
    return { ok, files };
  }

  private async runItem(
    run: RunRecord,
    line: LineRecord,
    rec: ItemRecord,
    item: ResolvedItem,
    deps: { channel: AgentChannel; operator: LlmOperator; judge: LlmJudge | null; installer: Installer; prior: Set<string>; signal: AbortSignal; live: Live },
  ): Promise<void> {
    const app = this.app;
    const r = deps.live.resolved;
    const caseDef = item.caseDef as CaseDef;
    const solution = item.solution as SolutionDef;
    const name = execName(line.index, item.pos!);
    const caseNumber = r.repetitions > 1 ? `CG-${run.id}-${line.index}-${String(item.pos).padStart(2, '0')}` : `CG-${run.id}-${String(item.pos).padStart(2, '0')}`;
    const exec = new Execution({
      id: `run${run.id}-${name}`,
      mode: 'auto',
      caseDef,
      contract: app.registry.contract!,
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
    line.current = { index: item.index, execName: name, phase: 'диалог' };
    let persistTimer: NodeJS.Timeout | null = null;
    const persist = () => Promise.all([app.store.saveExecution(run.id, name, { ...exec.toJSON(), item: rec }), app.store.saveHttp(run.id, name, exec.http)]);
    exec.onChange((c) => {
      // Шаг /reset отмечается сразу, не дожидаясь конца диалога.
      if (c.kind === 'event' && c.event.type === 'command' && c.event.name === 'reset' && c.event.status !== 'running' && !rec.steps.reset) {
        rec.steps.reset = c.event.status;
        this.scheduleSave(run);
      }
      if (!persistTimer) {
        persistTimer = setTimeout(() => {
          persistTimer = null;
          persist().catch(() => undefined);
        }, 400);
      }
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
    exec.setStatus(outcome.status, outcome.reason);
    exec.add<StatusEvent>({ type: 'status', status: outcome.status, reason: outcome.reason });
    rec.steps.reset = (exec.events.find((e) => e.type === 'command' && (e as CommandEvent).name === 'reset') as CommandEvent | undefined)?.status ?? null;
    rec.steps.dialog = outcome.status;

    line.current = { index: item.index, execName: name, phase: 'оценка' };
    this.scheduleSave(run);
    const ev = await evaluate(exec, outcome.resultSeq, deps.judge, deps.signal);
    rec.outcome = ev.outcome;
    rec.reason = ev.reason;
    rec.checks = ev.checks;
    rec.steps.checks = ev.checks ? { passed: ev.checks.filter((c) => c.passed).length, total: ev.checks.length } : null;
    rec.steps.judge = ev.judge ? { status: ev.judge.status, passed: ev.judge.passed, total: ev.judge.total } : null;
    rec.answerFailed = ev.judge?.failed ?? [];
    rec.stats = execStats(exec);
    rec.repeated = rec.stats.lessons.filter((l) => deps.prior.has(l));
    for (const l of rec.stats.lessons) deps.prior.add(l);

    if (r.basket.type === 'training') {
      if (ev.outcome !== 'technical' && !deps.signal.aborted) {
        line.current = { index: item.index, execName: name, phase: 'capture' };
        this.scheduleSave(run);
        const cmd = await deps.channel.command(exec, 'capture', 'runner', deps.signal);
        const p: any = cmd.parsed;
        rec.steps.capture = { status: cmd.status, signal: p?.signal ?? null, path: p?.path ?? null, reason: p?.reason ?? cmd.error ?? null };
        line.counter++;
        if (p?.kind === 'captured') await this.material(run, line, deps.installer, 'capture', `Кейс capture · позиция ${item.pos}`, p.path, `materials/L${line.index}/capture-P${String(item.pos).padStart(2, '0')}.md`);
        else line.materials.push({ kind: 'capture', label: `Кейс capture · позиция ${item.pos}`, file: null, ok: false, note: cmd.status === 'skipped' ? 'capture пропущен агентом' : `capture не сохранил кейс: ${rec.steps.capture.reason ?? cmd.status}` });
      } else {
        rec.steps.capture = { status: 'not_sent', signal: null, path: null, reason: ev.outcome === 'technical' ? 'кейс прерван технически' : 'прогон остановлен' };
        line.materials.push({ kind: 'capture', label: `Кейс capture · позиция ${item.pos}`, file: null, ok: false, note: 'capture не отправлялся' });
      }
    }
    rec.status = exec.status;
    rec.finishedAt = nowIso();
    if (persistTimer) clearTimeout(persistTimer);
    await persist();
    this.scheduleSave(run);
  }

  /** Проход curator между решениями (BASK-02, SK-04): /reset → /skill-curator → выгрузка изменений. */
  private async curatorPass(
    run: RunRecord,
    line: LineRecord,
    channel: AgentChannel,
    installer: Installer,
    prev: WsFile[] | null,
    reason: CuratorPassRecord['reason'],
    afterPos: number,
    signal: AbortSignal,
  ): Promise<WsFile[] | null> {
    const pass = line.curatorPasses.length + 1;
    const rec: CuratorPassRecord = { pass, afterPos, reason, status: 'running', startedAt: nowIso(), durationMs: null, reset: null, text: '', reply: null, parsed: null, changes: null, exportNote: '', report: null };
    line.curatorPasses.push(rec);
    line.current = { index: -1, execName: null, phase: `curator ${reason === 'final' ? 'финальный' : pass}` };
    this.scheduleSave(run);
    const taskId = `cg-${run.id}-${line.index}-cur${pass}-${randomHex(2)}`;
    const t0 = Date.now();
    if (run.settings.basket.curator && (run.settings.basket.curator as any).resetBefore) {
      const rs = await channel.rawCommand(line.senderId, taskId, 'reset', signal);
      rec.reset = { status: rs.status, durationMs: rs.durationMs, error: rs.error };
      rec.http = [...rs.http];
      if (rs.status !== 'ok') {
        rec.status = 'failed';
        rec.error = `Сбой /reset перед curator: ${rs.error ?? rs.status}`;
        rec.durationMs = Date.now() - t0;
        line.counter = 0;
        this.scheduleSave(run);
        return prev;
      }
    }
    const c = await channel.rawCommand(line.senderId, taskId, 'curator', signal);
    Object.assign(rec, { text: c.text, reply: c.reply, parsed: c.parsed, status: c.status, error: c.error, durationMs: Date.now() - t0, http: [...(rec.http ?? []), ...c.http] });
    line.counter = 0;
    // Изменения выгружаются и при сбое команды: правки могли примениться до ошибки.
    let next = prev;
    if (installer.canExport) {
      try {
        const files = await installer.exportSkills(line.senderId);
        rec.changes = prev ? diffTrees(prev, files) : null;
        if (!prev) rec.exportNote = 'исходное состояние неизвестно — различия не посчитаны';
        await this.app.store.saveFiles(run.id, `skills/L${line.index}/after-curator-${pass}`, files);
        next = files;
      } catch (e) {
        rec.exportNote = `состояние после прохода не выгружено: ${errorMessage(e)}`;
      }
    } else rec.exportNote = 'подключение не выгружает файлы скиллов';
    const p: any = c.parsed;
    if (p?.kind === 'complete') {
      rec.report = p.report;
      await this.material(run, line, installer, 'curator', `Отчёт curator ${pass}`, p.report, `materials/L${line.index}/curator-${pass}.md`);
    } else {
      line.materials.push({ kind: 'curator', label: `Отчёт curator ${pass}`, file: null, ok: p?.kind === 'empty', note: p?.kind === 'empty' ? 'очередь была пуста' : `проход не завершён: ${c.error ?? c.status}` });
    }
    this.scheduleSave(run);
    return next;
  }

  private async material(run: RunRecord, line: LineRecord, installer: Installer, kind: string, label: string, wsPath: string, rel: string): Promise<void> {
    const text = installer.canExport ? await installer.readFile(line.senderId, wsPath).catch(() => null) : null;
    if (text !== null) {
      await this.app.store.saveText(run.id, rel, text);
      line.materials.push({ kind, label, file: rel, ok: true, note: wsPath });
    } else {
      line.materials.push({ kind, label, file: null, ok: false, note: installer.canExport ? `файл ${wsPath} не получен` : `путь ${wsPath}; файлы workspace недоступны подключению` });
    }
  }

  /** Итоговое состояние скиллов: новая версия после обучения (SK-05), неизменность в проверке (SK-06). */
  private async finalizeSkills(run: RunRecord, line: LineRecord, r: ResolvedRun, installer: Installer, initial: WsFile[] | null, aborted: boolean): Promise<void> {
    const s = line.skills;
    const training = r.basket.type === 'training';
    if (!installer.canExport) {
      s.versionNote = 'Подключение не выгружает файлы скиллов — итоговое состояние неизвестно, новая версия не создана';
      if (!training) s.immutability = { status: 'unchecked', files: 0, changes: [], note: 'Неизменность не проверялась: нет доступа к файлам' };
      return;
    }
    let final: WsFile[];
    try {
      final = await installer.exportSkills(line.senderId);
    } catch (e) {
      s.versionNote = `Итоговое состояние не выгружено: ${errorMessage(e)}`;
      if (!training) s.immutability = { status: 'unchecked', files: 0, changes: [], note: s.versionNote };
      return;
    }
    s.final = { checksum: manifestChecksum(final), files: final.length };
    await this.app.store.saveFiles(run.id, `skills/L${line.index}/final`, final);
    const base = r.skillset && r.skillset !== 'build' ? r.skillset.version.files : initial;
    if (!base) {
      s.versionNote = 'Исходное состояние неизвестно — изменения не посчитаны';
      return;
    }
    s.changes = diffTrees(base, final);
    if (!training) {
      s.immutability = {
        status: s.changes.length ? 'changed' : 'unchanged',
        files: final.length,
        changes: s.changes,
        note: s.changes.length ? 'Проверка изменила набор — это не обучение, изменения отмечены отдельно' : `${final.length} ${plural(final.length, 'файл сверен', 'файла сверены', 'файлов сверены')} до и после`,
      };
      return;
    }
    if (!s.changes.length) {
      s.versionNote = 'Обучение не изменило прикладные скиллы — новая версия не создана';
      return;
    }
    if (r.skillset === 'build' || !r.skillset) {
      s.versionNote = 'Набор не выбирался — итоговое состояние сохранено как материал, версия не регистрируется';
      return;
    }
    if (aborted) {
      s.versionNote = 'Обучение прервано: итоговое состояние сохранено как материал, версия не создана';
      return;
    }
    const partial = line.curatorPasses.some((p) => !['ok', 'skipped'].includes(p.status));
    const id = await registerVersion(
      this.app.env.dataDir,
      r.skillset.set,
      final.map((f) => ({ path: f.path, content: f.content })),
      { from: r.skillset.version.id, run: run.id, line: line.index, note: `результат прогона #${run.id}${r.repetitions > 1 ? `, линия ${line.index}` : ''}` },
      partial ? 'partial' : 'ready',
    );
    s.newVersion = { id, status: partial ? 'partial' : 'ready' };
    s.versionNote = partial
      ? `Версия ${id} сохранена как частичная: один из проходов curator завершился сбоем`
      : `Версия ${id} ссылается на ${r.skillset.version.id} и прогон #${run.id}. Исходная версия не изменена`;
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
