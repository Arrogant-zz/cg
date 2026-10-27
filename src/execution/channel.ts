// Отправка сообщений и служебных команд агенту. В одну сессию — один запрос за раз (MAN-03, SOL-04).
import type { AgentDef } from '../config/types.js';
import type { Env } from '../env.js';
import { AgentClient, AgentError, type AgentReply } from '../agent/client.js';
import { parseCapture, parseCurator, renderCommand, type CommandName } from '../agent/commands.js';
import { KeyedMutex } from '../util/sync.js';
import { errorMessage, nowIso } from '../util/core.js';
import type { Execution } from './execution.js';
import type { CommandEvent, MessageEvent, NoteEvent } from './events.js';
import type { HttpExchange } from '../util/httplog.js';

export type SendResult = { ok: true; reply: MessageEvent; raw: AgentReply } | { ok: false; error: AgentError };

/**
 * Запрос, который стенд перестал ждать, хотя агент его получил: таймаут, обрыв или остановка прогона.
 * Агент мог продолжить работу, а его сессия обрабатывает запросы по очереди — следующий встанет за этим.
 */
export interface UnfinishedRequest {
  /** Подпись запроса: «Стартовое сообщение», «/skill-curator». */
  what: string;
  taskId: string;
  sentAt: string;
  /** Следующий запрос прождал его AGENT_BUSY_WAIT_MS и не дождался: сессия агента занята. */
  stuck: boolean;
}

export interface RawCommandResult {
  name: CommandName;
  text: string;
  status: CommandEvent['status'];
  reply: string | null;
  parsed: unknown;
  durationMs: number;
  error?: string;
  startedAt: string;
  /** HTTP-обмен команды; у прохода curator вне кейса хранится в записи прохода. */
  http: HttpExchange[];
  /** Команда ждала в очереди агента за прерванным запросом и не дождалась. */
  busy: boolean;
}

const LABELS: Record<'start' | 'operator' | 'human', string> = { start: 'Стартовое сообщение', operator: 'Реплика LLM-оператора', human: 'Реплика человека' };
const COMMAND_LABELS: Record<CommandName, string> = { reset: '/reset', capture: '/case-capture', curator: '/skill-curator' };
const span = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} мин` : `${Math.round(ms / 1000)} с`);

export class AgentChannel {
  readonly client: AgentClient;
  constructor(
    public agent: AgentDef,
    private env: Env,
    private locks: KeyedMutex,
    /** Прерванные запросы по тестовому оператору — общие для прогонов и ручных сессий. */
    private unfinished: Map<string, UnfinishedRequest>,
  ) {
    this.client = new AgentClient(agent, env.raw, env.allowedHosts);
  }

  busy(senderId: string): boolean {
    return this.locks.isBusy(senderId);
  }

  /** Прерванный запрос оператора, за которым встанет следующий; stuck — следующий его уже не дождался. */
  unfinishedFor(senderId: string): UnfinishedRequest | null {
    return this.unfinished.get(senderId) ?? null;
  }

  /** Перед запросом: если у оператора висит прерванный запрос, этот встанет за ним в очередь — срок продлевается, в журнале кейса видно, чего ждём. */
  private waitFor(senderId: string, label: string, exec: Execution | null): UnfinishedRequest | null {
    const u = this.unfinished.get(senderId) ?? null;
    if (u && exec) {
      const ago = span(Date.now() - Date.parse(u.sentAt));
      exec.add<NoteEvent>({ type: 'note', text: `Агент ещё выполняет прерванный запрос «${u.what}» (x-task-id ${u.taskId}), отправленный ${ago} назад: ${label.charAt(0).toLowerCase()}${label.slice(1)} встанет за ним в очередь — ждём не дольше ${span(this.env.agentBusyWaitMs)}` });
    }
    return u;
  }

  /** После запроса: ответ получен — сессия агента свободна; запрос дошёл, а ответа нет — агент мог продолжить работу. */
  private settle(senderId: string, what: string, taskId: string, sentAt: string, err: AgentError | null, waited: UnfinishedRequest | null): void {
    if (!err || err.kind === 'http' || err.kind === 'parse' || err.kind === 'agent') this.unfinished.delete(senderId);
    else if (err.unfinished) this.unfinished.set(senderId, waited ? { ...waited, stuck: err.kind !== 'aborted' } : { what, taskId, sentAt, stuck: false });
  }

  /** Запрос прождал прерванный и не дождался: причина — занятая сессия агента, а не сам запрос. */
  private busyError(err: AgentError, waited: UnfinishedRequest | null): string | null {
    if (!waited || !err.unfinished || err.kind !== 'timeout') return null;
    return `Агент не освободил сессию: прерванный запрос «${waited.what}» не закончился за ${span(this.env.agentBusyWaitMs)} ожидания`;
  }

  timeoutFor(name: CommandName | 'message'): number {
    if (name === 'reset') return this.env.resetTimeoutMs;
    if (name === 'capture') return this.env.captureTimeoutMs;
    if (name === 'curator') return this.env.curatorTimeoutMs;
    return this.env.turnTimeoutMs;
  }

  /** Реплика в диалог кейса: событие исходящего сообщения, затем ответ агента. */
  async sendMessage(
    exec: Execution,
    text: string,
    kind: 'start' | 'operator' | 'human',
    extra: Partial<MessageEvent> = {},
    signal?: AbortSignal,
  ): Promise<SendResult> {
    return this.locks.run(exec.senderId, async () => {
      const taskId = exec.taskIdForRequest();
      const type = kind === 'start' ? 'start_message' : kind === 'operator' ? 'operator_message' : 'human_message';
      const waited = this.waitFor(exec.senderId, LABELS[kind], exec);
      const sentAt = nowIso();
      const out = exec.add<MessageEvent>({ type, text, taskId, ...extra });
      const onExchange = (x: HttpExchange, phase: 'start' | 'end') => {
        if (phase === 'start') {
          x.eventSeq = out.seq;
          out.httpId = x.id;
          exec.update(out);
          exec.addHttp(x);
        } else exec.updateHttp(x);
      };
      try {
        const r = await this.client.send({
          text,
          taskId,
          senderId: exec.senderId,
          timeoutMs: this.timeoutFor('message'),
          waitMs: waited ? this.env.agentBusyWaitMs : 0,
          signal: signal ?? exec.abort.signal,
          label: waited ? `${LABELS[kind]} · за прерванным запросом` : LABELS[kind],
          onExchange,
        });
        this.settle(exec.senderId, LABELS[kind], taskId, sentAt, null, waited);
        const turn = exec.turns + 1;
        const ev = exec.add<MessageEvent>({ type: 'agent_message', text: r.text, turn, durationMs: r.durationMs, usage: r.usage, taskId, httpId: r.exchange.id });
        r.exchange.replySeq = ev.seq;
        exec.updateHttp(r.exchange);
        return { ok: true as const, reply: ev, raw: r };
      } catch (e) {
        const err = e instanceof AgentError ? e : new AgentError('network', errorMessage(e));
        this.settle(exec.senderId, LABELS[kind], taskId, sentAt, err, waited);
        err.message = this.busyError(err, waited) ?? err.message;
        exec.add<NoteEvent>({ type: 'note', text: `Агент: ${err.message}`, httpId: err.exchange?.id ?? null, data: { kind: err.kind, httpStatus: err.httpStatus, body: err.body } });
        return { ok: false as const, error: err };
      }
    });
  }

  /** Служебная команда в журнал кейса. */
  async command(exec: Execution, name: CommandName, by: 'runner' | 'human', signal?: AbortSignal): Promise<CommandEvent> {
    return this.locks.run(exec.senderId, async () => {
      const text = renderCommand(this.agent, name, { requestRef: exec.requestRef, topic: exec.caseDef.topic, taskId: exec.startTaskId ?? exec.currentTaskId });
      const waited = this.waitFor(exec.senderId, COMMAND_LABELS[name], exec);
      const ev = exec.add<CommandEvent>({ type: 'command', name, text, status: 'running', reply: null, parsed: null, durationMs: null, by });
      const onExchange = (x: HttpExchange, phase: 'start' | 'end') => {
        if (phase === 'start') {
          x.eventSeq = ev.seq;
          ev.httpId = x.id;
          exec.update(ev);
          exec.addHttp(x);
        } else exec.updateHttp(x);
      };
      const r = await this.rawUnlocked(exec.senderId, exec.taskIdForRequest(), name, text, waited, signal ?? exec.abort.signal, onExchange);
      Object.assign(ev, { status: r.status, reply: r.reply, parsed: r.parsed, durationMs: r.durationMs, error: r.error, ...(r.busy ? { busy: true } : {}) });
      exec.update(ev);
      return ev;
    });
  }

  /** Команда вне кейса — проход curator между решениями. */
  async rawCommand(senderId: string, taskId: string, name: CommandName, signal?: AbortSignal): Promise<RawCommandResult> {
    const text = renderCommand(this.agent, name, {});
    return this.locks.run(senderId, () => this.rawUnlocked(senderId, taskId, name, text, this.waitFor(senderId, COMMAND_LABELS[name], null), signal));
  }

  private async rawUnlocked(
    senderId: string,
    taskId: string,
    name: CommandName,
    text: string,
    waited: UnfinishedRequest | null,
    signal?: AbortSignal,
    onExchange?: (x: HttpExchange, phase: 'start' | 'end') => void,
  ): Promise<RawCommandResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const http: HttpExchange[] = [];
    const track = (x: HttpExchange, phase: 'start' | 'end') => {
      if (phase === 'start') http.push(x);
      onExchange?.(x, phase);
    };
    try {
      const r = await this.client.send({
        text,
        taskId,
        senderId,
        timeoutMs: this.timeoutFor(name),
        waitMs: waited ? this.env.agentBusyWaitMs : 0,
        signal,
        label: waited ? `${COMMAND_LABELS[name]} · за прерванным запросом` : COMMAND_LABELS[name],
        onExchange: track,
      });
      this.settle(senderId, COMMAND_LABELS[name], taskId, startedAt, null, waited);
      const base = { name, text, reply: r.text, durationMs: Date.now() - t0, startedAt, http, busy: false };
      // HTTP 200 на /reset — сессия сброшена при любом тексте, даже «Command not available.» (уточнение владельца от 27.10.2026).
      if (name === 'reset') return { ...base, status: 'ok', parsed: null };
      if (name === 'capture') {
        const p = parseCapture(r.text);
        const status = p.kind === 'captured' ? 'ok' : p.kind === 'skipped' ? 'skipped' : p.kind === 'failed' ? 'failed' : 'unrecognized';
        return { ...base, status, parsed: p };
      }
      const p = parseCurator(r.text);
      const status = p.kind === 'complete' ? 'ok' : p.kind === 'empty' ? 'skipped' : p.kind === 'failed' ? 'failed' : 'unrecognized';
      return { ...base, status, parsed: p };
    } catch (e) {
      const err = e instanceof AgentError ? e : new AgentError('network', errorMessage(e));
      this.settle(senderId, COMMAND_LABELS[name], taskId, startedAt, err, waited);
      const busy = this.busyError(err, waited);
      return { name, text, status: 'failed', reply: null, parsed: null, durationMs: Date.now() - t0, error: busy ?? err.message, startedAt, http, busy: !!busy };
    }
  }
}
