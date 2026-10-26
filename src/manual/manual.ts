// Ручной режим (MAN-01–04): любой кейс с его заглушками, реплики, решения по инструментам и команды задаёт человек.
import type { App } from '../app.js';
import { Execution } from '../execution/execution.js';
import { AgentChannel } from '../execution/channel.js';
import { startMessage } from '../execution/dialog.js';
import { evaluate, execStats, type Evaluation, type ExecStats } from '../execution/evaluate.js';
import type { MessageEvent, StatusEvent } from '../execution/events.js';
import { createInstaller, type Installer, type WsFile } from '../skillsets/installer.js';
import { StubState } from '../stubs/engine.js';
import { findVersion } from '../skillsets/store.js';
import { LlmJudge } from '../judge/judge.js';
import { createProvider, modelReadiness } from '../llm/provider.js';
import { checkAllowedHost } from '../agent/client.js';
import { resolveEnvRefs } from '../config/loader.js';
import type { CommandName } from '../agent/commands.js';
import type { PrepItem } from '../runner/types.js';
import { sessionKey } from '../results/store.js';
import { HttpError } from '../util/http.js';
import { diffTrees } from '../util/diff.js';
import { manifestChecksum } from '../util/fsx.js';
import { errorMessage, nowIso, plural, randomHex, requestRef } from '../util/core.js';
import { logger } from '../util/log.js';

const log = logger('manual');

export interface ManualCreate {
  case: string;
  agent: string;
  model?: string | null;
  skillset?: { id: string; version: string } | 'build' | null;
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
  agent: { id: string; title: string };
  agentModel: { id: string | null; title: string; value: string | null; note: string };
  skillset: { id: string; title: string; version: string; checksum: string } | 'build' | null;
  senderId: string;
  senderMode: 'new' | 'existing';
  prep: PrepItem[];
  busy: string | null;
  evaluation: (Evaluation & { stats: ExecStats }) | null;
  execution: ReturnType<Execution['toJSON']> | null;
}

interface Live {
  exec: Execution;
  channel: AgentChannel;
  installer: Installer;
  owner: string;
  lastSkills: WsFile[] | null;
}

export class ManualManager {
  sessions = new Map<number, ManualRecord>();
  private live = new Map<number, Live>();
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(private app: App) {}

  async init(): Promise<void> {
    for (const s of (await this.app.store.loadSessions()) as ManualRecord[]) {
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

    let modelValue: string | null = null;
    let agentModel = { id: null as string | null, title: agent.model.fixed ?? 'задана развёртыванием', value: null as string | null, note: 'модель задана развёртыванием агента' };
    if (agent.model.switch === 'request') {
      const m = req.model ? reg.models.get(req.model) : null;
      if (!m || m.provider !== 'agent-request') throw new HttpError(422, 'Подключение переключает модель запросом: выберите модель агента с provider: agent-request');
      modelValue = m.model;
      agentModel = { id: m.id, title: m.title, value: m.model, note: `значение в ${agent.model.path}` };
    } else if (req.model && req.model !== agent.model.fixed) {
      const m = reg.models.get(req.model);
      if (m && m.provider !== 'deployment') throw new HttpError(422, 'Стенд не переключает модель агента запросом: выбор недоступен');
    }

    let version: ReturnType<typeof findVersion> = null;
    if (req.skillset && req.skillset !== 'build') {
      version = findVersion(reg, req.skillset.id, req.skillset.version);
      if (!version) throw new HttpError(404, `Версия ${req.skillset.version} набора «${req.skillset.id}» не найдена`);
      if (agent.skills.kind === 'none') throw new HttpError(422, `Агент не умеет устанавливать набор скиллов: ${agent.skills.note}`);
    }

    const id = await app.store.nextNumber('session');
    const owner = `manual-${id}`;
    if (!app.sessions.tryAcquire(owner)) throw new HttpError(409, `Все сессии агента заняты: ${app.sessions.used} из ${app.sessions.capacity}`);
    const senderMode = req.sender?.mode === 'existing' && req.sender.id ? 'existing' : 'new';
    const senderId = senderMode === 'existing' ? req.sender!.id!.trim() : `${app.env.senderPrefix}manual-${id}-${randomHex(3)}`;
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
    const channel = new AgentChannel(agent, app.env, app.locks, modelValue);
    const installer = createInstaller(agent.skills, app.env.raw);
    const rec: ManualRecord = {
      id,
      key: sessionKey(id),
      status: 'active',
      createdAt: nowIso(),
      closedAt: null,
      note: '',
      case: { id: c.id, title: c.title, topic: c.topic, file: c.source.file, hash: c.source.hash, solutions: [...reg.solutions.values()].filter((s) => s.case === c.id).length },
      agent: { id: agent.id, title: agent.title },
      agentModel,
      skillset: version ? { id: version.set.id, title: version.set.title, version: version.version.id, checksum: version.version.checksum } : req.skillset === 'build' ? 'build' : null,
      senderId,
      senderMode,
      prep: [],
      busy: 'подготовка',
      evaluation: null,
      execution: null,
    };
    this.sessions.set(id, rec);
    const live: Live = { exec, channel, installer, owner, lastSkills: null };
    this.live.set(id, live);
    exec.onChange(() => this.schedule(id));
    this.schedule(id, true);

    // Подготовка набора, обязательный /reset и стартовое сообщение — в фоне.
    void this.background(id, async () => {
      if (version) {
        const push = (ok: boolean | null, text: string, note = '') => rec.prep.push({ ok, text, note, ts: nowIso() });
        try {
          if (senderMode === 'new') await installer.prepare(senderId);
          await installer.install(senderId, version.version.files.map((f) => ({ path: f.path, content: f.content })));
          const got = await installer.exportSkills(senderId);
          live.lastSkills = got;
          if (manifestChecksum(got) === version.version.checksum) push(true, `Рабочая копия ${version.version.id} установлена: ${got.length} ${plural(got.length, 'файл', 'файла', 'файлов')}, контрольные суммы совпали`);
          else push(false, 'Набор в workspace не совпал с выбранным', diffTrees(version.version.files, got, false).slice(0, 3).map((x) => `${x.kind} ${x.path}`).join(', '));
          const pend = await installer.pending(senderId);
          push(pend.length ? false : true, pend.length ? `В сессии есть pending-кейсы: ${pend.length}` : 'Чужих pending-кейсов и свежих уроков нет');
        } catch (e) {
          push(false, 'Не удалось подготовить набор скиллов', errorMessage(e));
          exec.add({ type: 'note', text: `Подготовка набора не прошла: ${errorMessage(e)}` } as any);
        }
      } else if (rec.skillset === 'build') rec.prep.push({ ok: null, text: 'Стартовые скиллы сборки агента: набор не устанавливался', note: '', ts: nowIso() });
      else rec.prep.push({ ok: null, text: 'Набор скиллов не выбран', note: '', ts: nowIso() });
      await this.startCase(id);
    });
    return rec;
  }

  private async startCase(id: number): Promise<void> {
    const l = this.live.get(id)!;
    const rec = this.sessions.get(id)!;
    rec.busy = '/reset';
    this.schedule(id);
    l.exec.setStatus('running');
    const r = await l.channel.command(l.exec, 'reset', 'runner');
    if (r.status !== 'ok') {
      l.exec.add<StatusEvent>({ type: 'status', status: 'reset_failed', reason: r.error ?? 'Агент не подтвердил /reset' });
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
      this.live.get(id)?.exec.add({ type: 'note', text: `Сбой стенда: ${errorMessage(e)}` } as any);
    } finally {
      rec.busy = null;
      this.schedule(id, true);
    }
  }

  async message(id: number, body: { text: string; correction?: boolean; lessonId?: string | null; lessonNote?: string | null }): Promise<void> {
    const l = this.activeLive(id);
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
        // После /reset кейс начинается заново с теми же заглушками: состояние выполнения сбрасывается.
        l.exec.stub = new StubState(l.exec.caseDef.state);
        await this.startCaseFromReset(id, l);
        return;
      }
      const ev = await l.channel.command(l.exec, name, 'human');
      if (name === 'curator' && l.installer.canExport) {
        try {
          const files = await l.installer.exportSkills(l.exec.senderId);
          const changes = l.lastSkills ? diffTrees(l.lastSkills, files, false) : [];
          l.lastSkills = files;
          l.exec.add({ type: 'skills', text: changes.length ? `После ручного curator изменено файлов: ${changes.length}` : 'Ручной curator не изменил прикладные скиллы', data: { changes, commandSeq: ev.seq, note: 'Версия по ручному curator не регистрируется: правило не согласовано' } } as any);
        } catch (e) {
          l.exec.add({ type: 'skills', text: `Состояние скиллов не выгружено: ${errorMessage(e)}` } as any);
        }
      }
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
    ev.marks = { ...(ev.marks ?? { explanation: false, approval: false, finish: false }), correction: !!body.correction, lessonId: body.correction ? (body.lessonId ?? null) : null, lessonNote: body.correction ? (body.lessonNote ?? null) : null, manual: true } as any;
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
      const resultSeq = l.exec.events[l.exec.events.length - 1]?.seq ?? 0;
      l.exec.setStatus('completed', 'Ручная сессия завершена');
      l.exec.add<StatusEvent>({ type: 'status', status: 'completed', reason: 'Ручная сессия завершена человеком' });
      const ev = await evaluate(l.exec, resultSeq, judge);
      rec.evaluation = { ...ev, stats: execStats(l.exec) };
    } finally {
      rec.busy = null;
    }
    rec.status = 'closed';
    rec.closedAt = nowIso();
    rec.execution = l.exec.toJSON();
    this.app.bindings.unbindAll(l.exec);
    this.app.sessions.release(l.owner);
    this.live.delete(id);
    this.schedule(id, true);
    return rec;
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
      if (l) rec.execution = l.exec.toJSON();
      this.app.store.saveSession(id, rec).catch((e) => log.error('Сохранение сессии', e));
      this.app.publish(`manual:${id}`, 'manual', { id, busy: rec.busy, status: rec.status });
      this.app.publish('runs', 'manual', { id, status: rec.status });
    };
    if (now) save();
    else this.timers.set(id, setTimeout(save, 250));
  }
}
