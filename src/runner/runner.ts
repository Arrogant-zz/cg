// Раннер прогонов (RUN-01–03, BASK-01–05): очередь, линии повторений на тестовых операторах, кейсы, команды обучения и проходы curator.
// Скиллы живут в агенте у тестового оператора: ClawGym их не устанавливает и не выгружает (решение владельца от 27.10.2026).
import type { App } from '../app.js';
import type { CaseDef, SolutionDef } from '../config/types.js';
import { Execution } from '../execution/execution.js';
import { AgentChannel } from '../execution/channel.js';
import { runDialog } from '../execution/dialog.js';
import { evaluate, execStats } from '../execution/evaluate.js';
import type { CommandEvent, StatusEvent } from '../execution/events.js';
import { LlmOperator } from '../operator/operator.js';
import { LlmJudge } from '../judge/judge.js';
import { ANSWER_JUDGE_PROMPT_VERSION, ANSWER_JUDGE_SYSTEM, JUDGE_PROMPT_VERSION, JUDGE_SYSTEM, OPERATOR_PROMPT_VERSION, OPERATOR_SYSTEM } from '../operator/prompts.js';
import { itemScores, scoringOf } from '../metrics/scoring.js';
import { createProvider } from '../llm/provider.js';
import { resolveRun, type ResolvedItem, type ResolvedRun, type RunOverrides } from './resolve.js';
import type { CuratorPassRecord, ItemRecord, LineRecord, PrepItem, RunRecord } from './types.js';
import { computeRunMetrics } from '../metrics/builtins.js';
import { runKey } from '../results/store.js';
import { HttpError } from '../util/http.js';
import { errorMessage, nowIso, randomHex, requestRef } from '../util/core.js';
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
    const preview = resolveRun(app.registry, app.env, configId, overrides, this.list());
    if (!preview.ok || !preview.resolved) {
      throw new HttpError(422, 'Прогон не запустится: ошибка в настройках. Агенту не отправлено ни одного запроса', preview.issues.filter((i) => i.severity === 'error'));
    }
    const r = preview.resolved;
    // Один диалог на оператора: продолжать нельзя, пока на нём идёт ручная сессия.
    const op = r.operator;
    const manual = op.mode === 'continue' ? app.manual.list().find((m) => m.status === 'active' && op.lines.some((l) => l.senderId === m.senderId)) : null;
    if (manual) throw new HttpError(409, `Тестовый оператор занят ручной сессией ${manual.key}: завершите её`);
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
      ...[r.models.operator, r.models.judge].map((m) => m?.source),
      ...r.metrics.map((m) => m.source),
    ].filter(Boolean) as { file: string; hash: string; text: string }[];
    for (const s of sources) if (!texts.has(s.file)) texts.set(s.file, s.file.startsWith('agents/') || s.file.startsWith('models/') ? redactSecrets(s.text) : s.text);
    if (reg.contract) texts.set(reg.contract.startMessage.file, reg.contract.startMessage.text);
    if (r.agent.request.bodySource) texts.set(r.agent.request.bodySource, JSON.stringify(r.agent.request.body, null, 2));
    texts.set(`prompts/${OPERATOR_PROMPT_VERSION}.txt`, OPERATOR_SYSTEM);
    texts.set(`prompts/${JUDGE_PROMPT_VERSION}.txt`, JUDGE_SYSTEM);
    texts.set(`prompts/${ANSWER_JUDGE_PROMPT_VERSION}.txt`, ANSWER_JUDGE_SYSTEM);
    for (const [file, text] of texts) {
      await app.store.saveText(id, `snapshot/${file}`, text);
      snapFiles.push({ file, hash: sources.find((s) => s.file === file)?.hash ?? '' });
    }

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
        prompts: { operator: OPERATOR_PROMPT_VERSION, judge: JUDGE_PROMPT_VERSION, answerJudge: ANSWER_JUDGE_PROMPT_VERSION },
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

  /** Удаление завершённого прогона с журналами и материалами (уточнение владельца от 26.10.2026). Прогоны, продолжившие его оператора, хранят историю у себя. */
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
      line.senderId ||= `${app.env.senderPrefix}${r.basket.id}-r${run.id}-${line.index}-${randomHex(3)}`;
      this.operatorPrep(run, line);

      const channel = new AgentChannel(r.agent, app.env, app.locks, app.unfinished);
      const operator = new LlmOperator(r.models.operator!, createProvider(r.models.operator!, app.env.raw));
      const judge = r.models.judge ? new LlmJudge(r.models.judge, createProvider(r.models.judge, app.env.raw)) : null;
      const prior = new Set<string>();
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
      if (training && cur.enabled && cur.final && line.counter > 0 && !signal.aborted && !line.error) {
        const last = [...line.items].reverse().find((i) => i.kind === 'case' && i.outcome && i.outcome !== 'technical');
        if (last) last.steps.curatorPass = line.curatorPasses.length + 1;
        await this.curatorPass(run, line, channel, 'final', this.lastPos(line), signal);
      }
      for (const i of line.items) if (i.status === 'pending') i.status = 'not_started';
      line.current = null;
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

  /** Тестовый оператор линии: новый — стартовые скиллы сборки агента, продолжение — скиллы после его прошлых прогонов. Файлы скиллов ClawGym не видит. */
  private operatorPrep(run: RunRecord, line: LineRecord): void {
    const ts = nowIso();
    const last = line.history[line.history.length - 1];
    const earlier = line.history.slice(0, -1).map((h) => `#${h.run}`);
    line.prep = {
      status: 'ok',
      durationMs: 0,
      items: [
        last
          ? { ok: true, text: `Продолжение на тестовом операторе прогона #${last.run} «${last.title}»: скиллы — после этого прогона`, note: earlier.length ? `раньше оператор прошёл ${earlier.join(', ')}` : '', ts }
          : { ok: true, text: 'Новый тестовый оператор: стартовые скиллы сборки агента', note: '', ts },
        { ok: true, text: `x-a2a-sender-id = ${line.senderId}`, note: 'на этом операторе можно продолжить следующий прогон', ts },
      ],
    };
    this.scheduleSave(run);
  }

  private async runItem(
    run: RunRecord,
    line: LineRecord,
    rec: ItemRecord,
    item: ResolvedItem,
    deps: { channel: AgentChannel; operator: LlmOperator; judge: LlmJudge | null; prior: Set<string>; signal: AbortSignal; live: Live },
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
    exec.closeTools();
    exec.setStatus(outcome.status, outcome.reason);
    exec.add<StatusEvent>({ type: 'status', status: outcome.status, reason: outcome.reason });
    rec.steps.reset = (exec.events.find((e) => e.type === 'command' && (e as CommandEvent).name === 'reset') as CommandEvent | undefined)?.status ?? null;
    rec.steps.dialog = outcome.status;

    line.current = { index: item.index, execName: name, phase: 'оценка' };
    this.scheduleSave(run);
    const ev = await evaluate(exec, outcome.resultSeq, deps.judge, deps.signal, scoringOf(run.settings.metrics));
    rec.outcome = ev.outcome;
    rec.reason = ev.reason;
    rec.checks = ev.checks;
    rec.steps.checks = ev.checks ? { passed: ev.checks.filter((c) => c.passed).length, total: ev.checks.length } : null;
    rec.steps.judge = ev.judge ? { status: ev.judge.status, passed: ev.judge.passed, total: ev.judge.total } : null;
    rec.answerFailed = ev.judge?.failed ?? [];
    rec.scores = ev.scores ? itemScores(ev.scores) : null;
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
      } else {
        rec.steps.capture = { status: 'not_sent', signal: null, path: null, reason: ev.outcome === 'technical' ? 'кейс прерван технически' : 'прогон остановлен' };
      }
    }
    rec.status = exec.status;
    rec.finishedAt = nowIso();
    // Таймер обнуляется: события после конца кейса — поздние вызовы прерванного хода — тоже сохраняются.
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    await persist();
    this.scheduleSave(run);
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
        return;
      }
    }
    const c = await channel.rawCommand(line.senderId, taskId, 'curator', signal);
    Object.assign(rec, { text: c.text, reply: c.reply, parsed: c.parsed, status: c.status, error: c.error, durationMs: Date.now() - t0, http: [...(rec.http ?? []), ...c.http] });
    line.counter = 0;
    const p: any = c.parsed;
    rec.report = p?.kind === 'complete' ? (p.report ?? null) : null;
    this.scheduleSave(run);
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
