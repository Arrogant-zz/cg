// Ручной режим (MAN-01–04): любой кейс с его заглушками, реплики, решения по инструментам и команды задаёт человек.
import type { App } from '../app.js';
import { Execution } from '../execution/execution.js';
import { AgentChannel } from '../execution/channel.js';
import { startMessage } from '../execution/dialog.js';
import { evaluate, execStats, type Evaluation, type ExecStats } from '../execution/evaluate.js';
import type { MessageEvent, NoteEvent, StatusEvent } from '../execution/events.js';
import { StubState } from '../stubs/engine.js';
import { LlmJudge } from '../judge/judge.js';
import { scoringOf } from '../metrics/scoring.js';
import { createProvider, modelReadiness } from '../llm/provider.js';
import { checkAllowedHost } from '../agent/client.js';
import { resolveEnvRefs } from '../config/loader.js';
import type { CommandName } from '../agent/commands.js';
import type { OperatorStep, PrepItem } from '../runner/types.js';
import { manualStep, stepLabel, type OperatorHold } from '../runner/operators.js';
import { sessionKey } from '../results/store.js';
import { HttpError } from '../util/http.js';
import { errorMessage, nowIso, randomHex, requestRef } from '../util/core.js';
import { logger } from '../util/log.js';

const log = logger('manual');

/** Тестовый оператор: новый — стартовые скиллы сборки агента; существующий — скиллы, накопленные им раньше (например, в прогоне обучения). */
export interface ManualCreate {
  case: string;
  agent: string;
  sender?: { mode: 'new' | 'existing'; id?: string };
}

export interface ManualRecord {
  id: number;
  key: string;
  status: 'active' | 'closed';
  createdAt: string;
  closedAt: string | null;
  note: string;
  case: { id: string; title: string; topic: string; file: string; hash: string; solutions: number };
  agent: { id: string; title: string; build: string | null; model: string | null };
  senderId: string;
  senderMode: 'new' | 'existing';
  /** Через что оператор прошёл до этой сессии, по журналу операторов; null — сессия до 28.10.2026. */
  history: OperatorStep[] | null;
  prep: PrepItem[];
  busy: string | null;
  evaluation: (Evaluation & { stats: ExecStats }) | null;
  execution: ReturnType<Execution['toJSON']> | null;
}

interface Live {
  exec: Execution;
  channel: AgentChannel;
  owner: string;
  /** Тестовый оператор занят сессией до её завершения: прогон или другая сессия его не возьмут. */
  hold: OperatorHold;
}

export class ManualManager {
  sessions = new Map<number, ManualRecord>();
  private live = new Map<number, Live>();
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(private app: App) {}

  async init(): Promise<void> {
    for (const s of await this.app.store.loadSessions((file, reason) => this.app.stand.add('warn', 'store.skipped', `Ручная сессия из ${file} не загружена: ${reason}`))) {
      if (s.status === 'active') {
        s.status = 'closed';
        s.closedAt = s.closedAt ?? nowIso();
        s.busy = null;
        s.note = 'Сессия закрыта: ClawGym перезапущен. Журнал сохранён.';
        await this.app.store.saveSession(s.id, s);
      }
      this.sessions.set(s.id, s);
    }
  }

  list(): ManualRecord[] {
    return [...this.sessions.values()].sort((a, b) => b.id - a.id).map((s) => ({ ...s, execution: null }));
  }

  get(id: number): ManualRecord {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, `Ручная сессия ${sessionKey(id)} не найдена`);
    const l = this.live.get(id);
    if (l) s.execution = l.exec.toJSON();
    return s;
  }

  liveExec(id: number): Execution | undefined {
    return this.live.get(id)?.exec;
  }

  async http(id: number): Promise<unknown[]> {
    this.get(id);
    const l = this.live.get(id);
    return l ? l.exec.http : ((await this.app.store.loadSessionHttp(id)) ?? []);
  }

  async create(req: ManualCreate): Promise<ManualRecord> {
    const app = this.app;
    const reg = app.registry;
    const c = reg.cases.get(req.case);
    if (!c) throw new HttpError(404, `Кейс «${req.case}» не найден`);
    const agent = reg.agents.get(req.agent);
    if (!agent) throw new HttpError(404, `Агент «${req.agent}» не найден`);
    if (!reg.contract) throw new HttpError(422, 'Контракт инструментов не загружен');
    const url = resolveEnvRefs(agent.request.url, app.env.raw);
    if (url.missing.length) throw new HttpError(422, `Не заданы переменные окружения агента: ${url.missing.join(', ')}`);
    const hostErr = checkAllowedHost(url.value, app.env.allowedHosts);
    if (hostErr) throw new HttpError(422, hostErr);

    // Существующий оператор задаётся явно: пустой id — ошибка, а не тихая подмена новым оператором.
    const senderMode = req.sender?.mode === 'existing' ? 'existing' : 'new';
    const existingId = req.sender?.id?.trim() ?? '';
    if (senderMode === 'existing' && !existingId) throw new HttpError(400, 'Укажите x-a2a-sender-id существующего тестового оператора');
    // Один диалог на оператора: резерв до первого await, как у прогона, — занятый прогоном или другой сессией оператор даёт 409.
    const hold = app.operators.reserve(senderMode === 'existing' ? [existingId] : [], 'manual', 'открываемой ручной сессией');
    const id = await app.store.nextNumber('session').catch((e) => {
      hold.release();
      throw e;
    });
    const owner = `manual-${id}`;
    if (!app.sessions.tryAcquire(owner)) {
      hold.release();
      throw new HttpError(409, `Все сессии агента заняты: ${app.sessions.used} из ${app.sessions.capacity}`);
    }
    hold.label = `ручной сессией ${sessionKey(id)}`;
    const senderId = senderMode === 'existing' ? existingId : `${app.env.senderPrefix}manual-${id}-${randomHex(3)}`;
    if (senderMode === 'new') hold.add(senderId);
    const history = app.operators.history(senderId);
    const caseNumber = `CG-M-${String(id).padStart(2, '0')}`;
    const exec = new Execution({
      id: sessionKey(id),
      mode: 'manual',
      caseDef: c,
      contract: reg.contract,
      solution: null,
      basketType: null,
      senderId,
      caseNumber,
      requestRef: requestRef(caseNumber, app.secret),
      taskIdScope: agent.request.taskIdScope,
      env: app.env,
      run: null,
    });
    app.bindings.bindAll(exec);
    const channel = new AgentChannel(agent, app.env, app.locks, app.unfinished);
    const rec: ManualRecord = {
      id,
      key: sessionKey(id),
      status: 'active',
      createdAt: nowIso(),
      closedAt: null,
      note: '',
      case: { id: c.id, title: c.title, topic: c.topic, file: c.source.file, hash: c.source.hash, solutions: [...reg.solutions.values()].filter((s) => s.case === c.id).length },
      agent: { id: agent.id, title: agent.title, build: agent.build, model: agent.model },
      senderId,
      senderMode,
      history,
      prep: [],
      busy: 'подготовка',
      evaluation: null,
      execution: null,
    };
    this.sessions.set(id, rec);
    const live: Live = { exec, channel, owner, hold };
    this.live.set(id, live);
    // Сессия — шаг истории оператора: в ней можно отправить /case-capture и /skill-curator, а значит, изменить его скиллы.
    app.operators.record(senderId, manualStep(id, rec.key, c.title));
    exec.onChange(() => this.schedule(id));
    this.schedule(id, true);

    // Скиллы — у тестового оператора в агенте: ClawGym их не устанавливает. Обязательный /reset и стартовое сообщение — в фоне.
    const known = history.length ? `скиллы после ${history.map(stepLabel).join(' → ')}` : 'скиллы, накопленные им раньше; его прогонов ClawGym не знает';
    rec.prep.push({
      ok: true,
      text: senderMode === 'new' ? 'Новый тестовый оператор: стартовые скиллы сборки агента' : `Существующий тестовый оператор: ${known}`,
      note: `x-a2a-sender-id = ${senderId}`,
      ts: nowIso(),
    });
    void this.background(id, () => this.startCase(id));
    return rec;
  }

  private async startCase(id: number): Promise<void> {
    const l = this.live.get(id)!;
    const rec = this.sessions.get(id)!;
    rec.busy = l.channel.unfinishedFor(l.exec.senderId) ? '/reset ждёт, пока агент закончит прерванный запрос' : '/reset';
    this.schedule(id);
    l.exec.setStatus('running');
    const r = await l.channel.command(l.exec, 'reset', 'runner');
    if (r.status !== 'ok') {
      l.exec.add<StatusEvent>({ type: 'status', status: r.busy ? 'agent_busy' : 'reset_failed', reason: r.error ?? 'Агент не подтвердил /reset' });
      return;
    }
    rec.busy = 'ход агента';
    this.schedule(id);
    const s = await l.channel.sendMessage(l.exec, startMessage(l.exec), 'start');
    if (s.ok) l.exec.turns++;
  }

  private activeLive(id: number): Live {
    const s = this.get(id);
    if (s.status !== 'active') throw new HttpError(409, 'Сессия закрыта');
    const l = this.live.get(id);
    if (!l) throw new HttpError(409, 'Сессия не активна');
    return l;
  }

  private ensureIdle(id: number, l: Live) {
    const rec = this.sessions.get(id)!;
    if (rec.busy || l.channel.busy(l.exec.senderId)) throw new HttpError(409, 'Агент ещё отвечает: в одной сессии один ход за раз');
  }

  private async background(id: number, fn: () => Promise<void>): Promise<void> {
    const rec = this.sessions.get(id)!;
    try {
      await fn();
    } catch (e) {
      log.error(`Ручная сессия ${id}`, e);
      this.live.get(id)?.exec.add<NoteEvent>({ type: 'note', text: `Сбой стенда: ${errorMessage(e)}` });
    } finally {
      rec.busy = null;
      this.schedule(id, true);
    }
  }

  async message(id: number, body: { text: string; correction?: boolean; lessonId?: string | null; lessonNote?: string | null }): Promise<void> {
    const l = this.activeLive(id);
    // Кейс закрыт терминальным инструментом: в закрытое обращение оператор не пишет, команды и завершение остаются.
    if (l.exec.closedBy) throw new HttpError(409, `Кейс закрыт терминальным инструментом ${l.exec.closedBy.tool}: реплики больше не принимаются`);
    this.ensureIdle(id, l);
    const text = String(body.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Пустое сообщение');
    const rec = this.sessions.get(id)!;
    rec.busy = 'ход агента';
    const marks: MessageEvent['marks'] = {
      correction: !!body.correction,
      lessonId: body.correction ? (body.lessonId ?? null) : null,
      lessonNote: body.correction ? (body.lessonNote ?? null) : null,
      explanation: false,
      approval: false,
      finish: false,
      manual: true,
    };
    void this.background(id, async () => {
      const r = await l.channel.sendMessage(l.exec, text, 'human', { marks });
      if (r.ok) l.exec.turns++;
    });
  }

  async command(id: number, name: CommandName): Promise<void> {
    const l = this.activeLive(id);
    this.ensureIdle(id, l);
    const rec = this.sessions.get(id)!;
    rec.busy = name === 'reset' ? '/reset' : name === 'capture' ? '/case-capture' : '/skill-curator';
    void this.background(id, async () => {
      if (name === 'reset') {
        // После /reset кейс начинается заново с теми же заглушками: состояние выполнения и закрытие кейса сбрасываются.
        l.exec.stub = new StubState(l.exec.caseDef.state);
        l.exec.reopen();
        await this.startCaseFromReset(id, l);
        return;
      }
      await l.channel.command(l.exec, name, 'human');
    });
  }

  private async startCaseFromReset(id: number, l: Live): Promise<void> {
    const rec = this.sessions.get(id)!;
    const r = await l.channel.command(l.exec, 'reset', 'human');
    if (r.status !== 'ok') return;
    rec.busy = 'ход агента';
    this.schedule(id);
    const s = await l.channel.sendMessage(l.exec, startMessage(l.exec), 'start');
    if (s.ok) l.exec.turns++;
  }

  tool(id: number, callId: string, body: { action: string; json?: unknown; text?: string; message?: string }): void {
    const l = this.activeLive(id);
    let ok = false;
    if (body.action === 'approve' || body.action === 'reject') ok = l.exec.resolvePending(callId, { action: body.action, by: 'human' });
    else if (body.action === 'answer') {
      let json: unknown;
      let text: string | undefined;
      if (body.json !== undefined) json = body.json;
      else if (typeof body.text === 'string') {
        try {
          json = JSON.parse(body.text);
        } catch {
          text = body.text;
        }
      }
      ok = l.exec.resolvePending(callId, json !== undefined ? { action: 'answer', json } : { action: 'answer', text: text ?? '' });
    } else if (body.action === 'error') ok = l.exec.resolvePending(callId, { action: 'error', message: String(body.message ?? 'Ошибка инструмента') });
    if (!ok) throw new HttpError(409, 'Вызов уже не ждёт решения');
  }

  mark(id: number, seq: number, body: { correction: boolean; lessonId?: string | null; lessonNote?: string | null }): void {
    const s = this.get(id);
    const l = this.live.get(id);
    const events = l ? l.exec.events : s.execution?.events ?? [];
    const ev = events.find((e) => e.seq === seq) as MessageEvent | undefined;
    if (!ev || (ev.type !== 'human_message' && ev.type !== 'operator_message')) throw new HttpError(404, 'Реплика не найдена');
    ev.marks = { ...(ev.marks ?? { explanation: false, approval: false, finish: false }), correction: !!body.correction, lessonId: body.correction ? (body.lessonId ?? null) : null, lessonNote: body.correction ? (body.lessonNote ?? null) : null, manual: true };
    if (l) l.exec.update(ev);
    this.schedule(id);
  }

  /** Завершение: автоматические проверки действий, по желанию — LLM-оценка; ручная разметка хранится отдельно. */
  async finish(id: number, body: { judge?: string | null }): Promise<ManualRecord> {
    const l = this.activeLive(id);
    this.ensureIdle(id, l);
    const rec = this.sessions.get(id)!;
    rec.busy = 'оценка';
    this.schedule(id);
    try {
      let judge: LlmJudge | null = null;
      if (body.judge) {
        const m = this.app.registry.models.get(body.judge);
        if (!m || !m.roles.includes('judge')) throw new HttpError(422, `Модель оценки «${body.judge}» не найдена`);
        const ready = modelReadiness(m, this.app.env.raw);
        if (ready) throw new HttpError(422, `Модель оценки «${m.id}»: ${ready}`);
        judge = new LlmJudge(m, createProvider(m, this.app.env.raw));
      }
      for (const p of l.exec.pendingList()) l.exec.resolvePending(p.callId, { action: 'stopped' });
      // Кейс закрыт терминальным инструментом — оценка до конца терминального хода: команды после закрытия в неё не входят.
      const resultSeq = l.exec.closedTurnEndSeq ?? l.exec.events[l.exec.events.length - 1]?.seq ?? 0;
      const closedBy = l.exec.closedBy;
      l.exec.endedBy = closedBy ? 'terminal' : 'human';
      l.exec.setStatus('completed', closedBy ? `Выполнен терминальный инструмент ${closedBy.tool}` : 'Ручная сессия завершена');
      l.exec.add<StatusEvent>({ type: 'status', status: 'completed', reason: closedBy ? `Выполнен терминальный инструмент ${closedBy.tool}; сессия завершена человеком` : 'Ручная сессия завершена человеком' });
      // Ручной сеанс: метрики аналитика по всем определениям из metrics/.
      const ev = await evaluate(l.exec, resultSeq, judge, undefined, scoringOf([...this.app.registry.metrics.values()]));
      rec.evaluation = { ...ev, stats: execStats(l.exec) };
    } finally {
      rec.busy = null;
    }
    rec.status = 'closed';
    rec.closedAt = nowIso();
    rec.execution = l.exec.toJSON();
    try {
      await this.app.store.saveSessionHttp(id, l.exec.http);
    } finally {
      // Сессия уже закрыта и оценена: слот агента, x-task-id и тестовый оператор свободны и при отказе диска, ошибка уходит в ответ.
      this.app.bindings.unbindAll(l.exec);
      this.app.sessions.release(l.owner);
      l.hold.release();
      this.live.delete(id);
      this.schedule(id, true);
    }
    return rec;
  }

  /** Удаление закрытой сессии с журналом и HTTP-обменами (уточнение владельца от 26.10.2026). Активную сессию сначала завершают. */
  async delete(id: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, `Ручная сессия ${sessionKey(id)} не найдена`);
    if (s.status === 'active' || this.live.has(id)) throw new HttpError(409, `Сессия ${s.key} активна: сначала завершите её`);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.sessions.delete(id);
    await this.app.store.deleteSession(id);
    this.app.publish(`manual:${id}`, 'manual', { id, status: 'deleted' });
    this.app.publish('runs', 'manual', { id, status: 'deleted' });
    log.info(`Ручная сессия ${s.key} удалена`);
  }

  /** Перед остановкой ClawGym: отложенные сохранения сессий — сразу. */
  flush(): void {
    for (const id of [...this.timers.keys()]) this.schedule(id, true);
  }

  private schedule(id: number, now = false): void {
    const t = this.timers.get(id);
    if (t && !now) return;
    if (t) clearTimeout(t);
    const save = () => {
      this.timers.delete(id);
      const rec = this.sessions.get(id);
      if (!rec) return;
      const l = this.live.get(id);
      if (l) {
        rec.execution = l.exec.toJSON();
        this.app.store.saveSessionHttp(id, l.exec.http).catch((e) => log.error('Сохранение HTTP-обменов сессии', e));
      }
      this.app.store.saveSession(id, rec).catch((e) => log.error('Сохранение сессии', e));
      this.app.publish(`manual:${id}`, 'manual', { id, busy: rec.busy, status: rec.status });
      this.app.publish('runs', 'manual', { id, status: rec.status });
    };
    if (now) save();
    else this.timers.set(id, setTimeout(save, 250));
  }
}
