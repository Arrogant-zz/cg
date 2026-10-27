// Отправка сообщений и служебных команд агенту. В одну сессию — один запрос за раз (MAN-03, SOL-04).
import type { AgentDef } from '../config/types.js';
import type { Env } from '../env.js';
import { AgentClient, AgentError, type AgentReply } from '../agent/client.js';
import { parseCapture, parseCurator, renderCommand, type CommandName } from '../agent/commands.js';
import { KeyedMutex } from '../util/sync.js';
import { errorMessage } from '../util/core.js';
import type { Execution } from './execution.js';
import type { CommandEvent, MessageEvent } from './events.js';
import type { HttpExchange } from '../util/httplog.js';

export type SendResult = { ok: true; reply: MessageEvent; raw: AgentReply } | { ok: false; error: AgentError };

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
}

const LABELS: Record<'start' | 'operator' | 'human', string> = { start: 'Стартовое сообщение', operator: 'Реплика LLM-оператора', human: 'Реплика человека' };
const COMMAND_LABELS: Record<CommandName, string> = { reset: '/reset', capture: '/case-capture', curator: '/skill-curator' };

export class AgentChannel {
  readonly client: AgentClient;
  constructor(
    public agent: AgentDef,
    private env: Env,
    private locks: KeyedMutex,
  ) {
    this.client = new AgentClient(agent, env.raw, env.allowedHosts);
  }

  busy(senderId: string): boolean {
    return this.locks.isBusy(senderId);
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
      const out = exec.add<MessageEvent>({ type, text, taskId, ...extra } as any);
      const onExchange = (x: HttpExchange, phase: 'start' | 'end') => {
        if (phase === 'start') {
          x.eventSeq = out.seq;
          out.httpId = x.id;
          exec.update(out);
          exec.addHttp(x);
        } else exec.updateHttp(x);
      };
      try {
        const r = await this.client.send({ text, taskId, senderId: exec.senderId, timeoutMs: this.timeoutFor('message'), signal: signal ?? exec.abort.signal, label: LABELS[kind], onExchange });
        const turn = exec.turns + 1;
        const ev = exec.add<MessageEvent>({ type: 'agent_message', text: r.text, turn, durationMs: r.durationMs, usage: r.usage, taskId, httpId: r.exchange.id });
        r.exchange.replySeq = ev.seq;
        exec.updateHttp(r.exchange);
        return { ok: true as const, reply: ev, raw: r };
      } catch (e) {
        const err = e instanceof AgentError ? e : new AgentError('network', errorMessage(e));
        exec.add({ type: 'note', text: `Агент: ${err.message}`, httpId: err.exchange?.id ?? null, data: { kind: err.kind, httpStatus: err.httpStatus, body: err.body } } as any);
        return { ok: false as const, error: err };
      }
    });
  }

  /** Служебная команда в журнал кейса. */
  async command(exec: Execution, name: CommandName, by: 'runner' | 'human', signal?: AbortSignal): Promise<CommandEvent> {
    return this.locks.run(exec.senderId, async () => {
      const text = renderCommand(this.agent, name, { requestRef: exec.requestRef, topic: exec.caseDef.topic, taskId: exec.startTaskId ?? exec.currentTaskId });
      const ev = exec.add<CommandEvent>({ type: 'command', name, text, status: 'running', reply: null, parsed: null, durationMs: null, by });
      const onExchange = (x: HttpExchange, phase: 'start' | 'end') => {
        if (phase === 'start') {
          x.eventSeq = ev.seq;
          ev.httpId = x.id;
          exec.update(ev);
          exec.addHttp(x);
        } else exec.updateHttp(x);
      };
      const r = await this.rawUnlocked(exec.senderId, exec.taskIdForRequest(), name, text, signal ?? exec.abort.signal, onExchange);
      Object.assign(ev, { status: r.status, reply: r.reply, parsed: r.parsed, durationMs: r.durationMs, error: r.error });
      exec.update(ev);
      return ev;
    });
  }

  /** Команда вне кейса — проход curator между решениями. */
  async rawCommand(senderId: string, taskId: string, name: CommandName, signal?: AbortSignal): Promise<RawCommandResult> {
    const text = renderCommand(this.agent, name, {});
    return this.locks.run(senderId, () => this.rawUnlocked(senderId, taskId, name, text, signal));
  }

  private async rawUnlocked(
    senderId: string,
    taskId: string,
    name: CommandName,
    text: string,
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
      const r = await this.client.send({ text, taskId, senderId, timeoutMs: this.timeoutFor(name), signal, label: COMMAND_LABELS[name], onExchange: track });
      const base = { name, text, reply: r.text, durationMs: Date.now() - t0, startedAt, http };
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
      return { name, text, status: 'failed', reply: null, parsed: null, durationMs: Date.now() - t0, error: err.message, startedAt, http };
    }
  }
}
