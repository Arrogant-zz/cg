// Выполнение одного кейса: журнал событий, состояние заглушек, удерживаемые MCP-вызовы.
// Общий для автоматического и ручного режима; различается только тем, кто решает по подтверждениям.
import crypto from 'node:crypto';
import type { BasketType, CaseDef, ContractDef, SolutionDef } from '../config/types.js';
import type { Env } from '../env.js';
import { StubState, matchStub, renderResponse, templateContext, yamlSnippet } from '../stubs/engine.js';
import { renderString } from '../util/template.js';
import { isAbortError, nowIso, randomHex, sleep } from '../util/core.js';
import type { ExecEvent, MessageEvent, ToolCallEvent } from './events.js';
import type { HttpExchange } from '../util/httplog.js';

export interface McpCallResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ConfirmDecision = { action: 'approve' | 'reject'; by: 'operator' | 'human' | 'auto'; decisionSeq?: number | null };

type Resolution =
  | { action: 'approve' | 'reject'; by: 'operator' | 'human' | 'auto'; decisionSeq?: number | null }
  | { action: 'answer'; json?: unknown; text?: string }
  | { action: 'error'; message: string }
  | { action: 'timeout' }
  | { action: 'stopped' };

interface Pending {
  ev: ToolCallEvent;
  kind: 'confirmation' | 'answer';
  resolve: (r: Resolution) => void;
  timer: NodeJS.Timeout;
}

export interface ExecutionInit {
  id: string;
  mode: 'auto' | 'manual';
  caseDef: CaseDef;
  contract: ContractDef;
  solution: SolutionDef | null;
  basketType: BasketType | null;
  senderId: string;
  caseNumber: string;
  requestRef: string;
  taskIdScope: 'execution' | 'message';
  env: Env;
  run: { runId: number; line: number; position: number } | null;
}

export type ExecChange = { kind: 'event'; event: ExecEvent } | { kind: 'status' } | { kind: 'http'; id: string };

export class Execution {
  readonly id: string;
  readonly mode: 'auto' | 'manual';
  readonly caseDef: CaseDef;
  readonly contract: ContractDef;
  readonly solution: SolutionDef | null;
  readonly basketType: BasketType | null;
  readonly senderId: string;
  readonly caseNumber: string;
  readonly requestRef: string;
  readonly run: ExecutionInit['run'];
  private readonly env: Env;
  private readonly taskIdScope: 'execution' | 'message';

  taskIds: string[] = [];
  currentTaskId: string;
  events: ExecEvent[] = [];
  private seq = 0;
  stub: StubState;
  status = 'preparing';
  reason = '';
  startedAt = nowIso();
  finishedAt: string | null = null;
  turns = 0;
  operatorCalls = 0;
  flags = { operatorTimeout: false, stopped: false };
  pending = new Map<string, Pending>();
  /** HTTP-обмены выполнения: запросы к агенту и запросы агента к MCP. В toJSON не входят — отдаются отдельно. */
  http: HttpExchange[] = [];
  abort = new AbortController();
  /** Автоматический режим: решение по подтверждению принимает LLM-оператор. */
  confirmationHandler: ((ev: ToolCallEvent) => Promise<ConfirmDecision>) | null = null;
  /** Для привязки новых x-task-id в режиме taskIdScope: message. */
  onTaskId: ((taskId: string) => void) | null = null;
  private listeners = new Set<(c: ExecChange) => void>();

  constructor(init: ExecutionInit) {
    this.id = init.id;
    this.mode = init.mode;
    this.caseDef = init.caseDef;
    this.contract = init.contract;
    this.solution = init.solution;
    this.basketType = init.basketType;
    this.senderId = init.senderId;
    this.caseNumber = init.caseNumber;
    this.requestRef = init.requestRef;
    this.run = init.run;
    this.env = init.env;
    this.taskIdScope = init.taskIdScope;
    this.stub = new StubState(init.caseDef.state);
    this.currentTaskId = this.mintTaskId();
  }

  private mintTaskId(): string {
    const base = this.run ? `cg-${this.run.runId}-${this.run.line}-${String(this.run.position).padStart(2, '0')}` : `cg-${this.id}`;
    const id = `${base}-${randomHex(2)}`;
    this.taskIds.push(id);
    this.onTaskId?.(id);
    return id;
  }

  /** x-task-id стартового сообщения: его же получает {{taskId}} в служебных командах (в оркестраторе request_ref = taskId). */
  startTaskId: string | null = null;
  private reservedTaskId: string | null = null;

  /** Резервирует x-task-id следующего запроса: стартовое сообщение подставляет его в текст до отправки. */
  reserveTaskId(): string {
    this.reservedTaskId ??= this.taskIdForRequest();
    return this.reservedTaskId;
  }

  /** x-task-id для очередного запроса агенту: один на выполнение или новый на сообщение. */
  taskIdForRequest(): string {
    if (this.reservedTaskId) {
      const id = this.reservedTaskId;
      this.reservedTaskId = null;
      return id;
    }
    if (this.taskIdScope === 'message' && this.events.some((e) => e.type === 'agent_message' || e.type === 'command')) {
      this.currentTaskId = this.mintTaskId();
    }
    return this.currentTaskId;
  }

  onChange(fn: (c: ExecChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: ExecChange) {
    for (const l of this.listeners) {
      try {
        l(c);
      } catch {
        /* слушатель не должен ломать выполнение */
      }
    }
  }

  add<T extends ExecEvent>(e: Omit<T, 'seq' | 'ts'> & { ts?: string }): T {
    const ev = { ...e, seq: ++this.seq, ts: e.ts ?? nowIso() } as unknown as T;
    this.events.push(ev);
    this.emit({ kind: 'event', event: ev });
    return ev;
  }

  update(ev: ExecEvent): void {
    this.emit({ kind: 'event', event: ev });
  }

  addHttp(x: HttpExchange): void {
    x.execId = this.id;
    this.http.push(x);
    this.emit({ kind: 'http', id: x.id });
  }

  /** Обмен меняется на месте: пришёл ответ или привязано событие. */
  updateHttp(x: HttpExchange): void {
    this.emit({ kind: 'http', id: x.id });
  }

  setStatus(status: string, reason = ''): void {
    this.status = status;
    this.reason = reason;
    if (!['preparing', 'running'].includes(status)) this.finishedAt = this.finishedAt ?? nowIso();
    this.emit({ kind: 'status' });
  }

  get terminal(): boolean {
    return !['preparing', 'running'].includes(this.status);
  }

  messages(): MessageEvent[] {
    return this.events.filter((e): e is MessageEvent => ['start_message', 'agent_message', 'operator_message', 'human_message'].includes(e.type));
  }

  toolCalls(): ToolCallEvent[] {
    return this.events.filter((e): e is ToolCallEvent => e.type === 'tool_call');
  }

  // ----------------------------------------------------------- MCP

  private errText(key: keyof ContractDef['errors'], tool: string): string {
    return renderString(this.contract.errors[key], { tool, caseNumber: this.caseNumber });
  }

  private toMcp(isError: boolean, value: unknown): McpCallResult {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const r: McpCallResult = { content: [{ type: 'text', text }] };
    if (isError) r.isError = true;
    if (!isError && this.contract.resultMode !== 'text' && value && typeof value === 'object' && !Array.isArray(value)) {
      r.structuredContent = value as Record<string, unknown>;
    }
    return r;
  }

  private finish(ev: ToolCallEvent, patch: Partial<ToolCallEvent>, t0: number): McpCallResult {
    Object.assign(ev, patch);
    ev.awaiting = null;
    ev.deadline = null;
    ev.durationMs = Date.now() - t0;
    this.update(ev);
    return this.toMcp(ev.isError, ev.result);
  }

  private waitPending(ev: ToolCallEvent, kind: 'confirmation' | 'answer', timeoutMs: number): Promise<Resolution> {
    return new Promise<Resolution>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(ev.callId);
        resolve({ action: 'timeout' });
      }, Math.max(1000, timeoutMs));
      this.pending.set(ev.callId, {
        ev,
        kind,
        timer,
        resolve: (r) => {
          clearTimeout(timer);
          this.pending.delete(ev.callId);
          resolve(r);
        },
      });
    });
  }

  /** Решение человека или оператора по удерживаемому вызову. */
  resolvePending(callId: string, r: Resolution): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    if (p.kind === 'confirmation' && !['approve', 'reject', 'timeout', 'stopped'].includes(r.action)) return false;
    if (p.kind === 'answer' && !['answer', 'error', 'timeout', 'stopped'].includes(r.action)) return false;
    p.resolve(r);
    return true;
  }

  /** Остановка: удерживаемые вызовы получают ошибку, новые запросы не отправляются. */
  stop(reason: string): void {
    this.flags.stopped = true;
    for (const p of [...this.pending.values()]) p.resolve({ action: 'stopped' });
    if (!this.abort.signal.aborted) this.abort.abort(new Error(reason));
  }

  async handleToolCall(name: string, args: Record<string, unknown>, taskId: string, httpId: string | null = null): Promise<McpCallResult> {
    const t0 = Date.now();
    const def = this.contract.tools.find((t) => t.name === name);
    const tool = def?.enabled ? def : undefined;
    const ev = this.add<ToolCallEvent>({
      httpId,
      type: 'tool_call',
      callId: crypto.randomUUID(),
      tool: name,
      args,
      taskId,
      requiresConfirmation: !!tool?.requiresConfirmation,
      ...(def && !def.enabled ? { disabled: true } : {}),
      stub: null,
      confirmation: null,
      awaiting: null,
      deadline: null,
      outcome: 'pending',
      isError: false,
      result: null,
      effect: null,
      executed: false,
      unexpected: false,
      durationMs: null,
    });
    const x = httpId ? this.http.find((h) => h.id === httpId) : undefined;
    if (x) {
      x.eventSeq = ev.seq;
      this.updateHttp(x);
    }
    if (!tool) return this.finish(ev, { outcome: 'unknown_tool', isError: true, result: this.errText('unknownTool', name), unexpected: true }, t0);
    if (this.flags.stopped) return this.finish(ev, { outcome: 'stopped', isError: true, result: this.errText('stopped', name) }, t0);

    if (tool.requiresConfirmation) {
      const auto = this.mode === 'auto';
      const timeoutMs = auto ? this.env.agentMcpTimeoutMs - this.env.operatorMarginMs : this.env.agentMcpTimeoutMs;
      const deadline = new Date(Date.now() + timeoutMs).toISOString();
      ev.confirmation = { decision: 'pending', by: null, waitedMs: null, deadline, decisionSeq: null };
      ev.awaiting = 'confirmation';
      ev.deadline = deadline;
      this.update(ev);
      const waiting = this.waitPending(ev, 'confirmation', timeoutMs);
      if (auto && this.confirmationHandler) {
        this.confirmationHandler(ev)
          .then((d) => this.resolvePending(ev.callId, d))
          .catch(() => this.resolvePending(ev.callId, { action: 'timeout' }));
      }
      const r = await waiting;
      const waitedMs = Date.now() - t0;
      if (r.action === 'approve') {
        ev.confirmation = { ...ev.confirmation, decision: 'approve', by: r.by, waitedMs, decisionSeq: r.decisionSeq ?? null };
        ev.awaiting = null;
        this.update(ev);
      } else if (r.action === 'reject') {
        ev.confirmation = { ...ev.confirmation, decision: 'reject', by: r.by, waitedMs, decisionSeq: r.decisionSeq ?? null };
        return this.finish(ev, { outcome: 'rejected', isError: true, result: this.errText('rejected', name) }, t0);
      } else if (r.action === 'stopped') {
        ev.confirmation = { ...ev.confirmation, decision: 'reject', by: 'stopped', waitedMs };
        return this.finish(ev, { outcome: 'stopped', isError: true, result: this.errText('stopped', name) }, t0);
      } else {
        if (auto) this.flags.operatorTimeout = true;
        ev.confirmation = { ...ev.confirmation, decision: 'reject', by: 'timeout', waitedMs };
        return this.finish(ev, { outcome: 'timeout', isError: true, result: this.errText('timeout', name) }, t0);
      }
    }

    const match = matchStub(this.caseDef.tools[name], this.contract.defaults[name], args);
    if (match) {
      const { response, call } = this.stub.next(match.stub);
      ev.stub = { id: match.stub.id, origin: match.stub.origin, candidates: match.candidates, call };
      const ctx = templateContext(this.caseDef, args, this.stub.state, { caseNumber: this.caseNumber, requestRef: this.requestRef, id: this.id, taskId });
      const rendered = renderResponse(response, ctx, this.stub);
      if (rendered.delayMs) {
        try {
          await sleep(rendered.delayMs, this.abort.signal);
        } catch (e) {
          if (isAbortError(e) || this.flags.stopped) return this.finish(ev, { outcome: 'stopped', isError: true, result: this.errText('stopped', name) }, t0);
        }
      }
      return this.finish(
        ev,
        {
          outcome: match.stub.origin === 'case' ? 'stub' : 'default',
          isError: rendered.isError,
          result: rendered.value,
          effect: rendered.effect,
          executed: !rendered.isError,
        },
        t0,
      );
    }

    if (this.mode === 'manual' && this.env.unmatchedMode === 'manual') {
      const deadline = new Date(Date.now() + this.env.agentMcpTimeoutMs).toISOString();
      ev.awaiting = 'answer';
      ev.deadline = deadline;
      this.update(ev);
      const r = await this.waitPending(ev, 'answer', this.env.agentMcpTimeoutMs);
      if (r.action === 'answer') {
        const value = r.json !== undefined ? r.json : (r.text ?? '');
        return this.finish(
          ev,
          { outcome: 'manual', isError: false, result: value, executed: true, unexpected: true, yaml: yamlSnippet(name, args, r.json !== undefined ? { json: r.json } : { text: r.text ?? '' }) },
          t0,
        );
      }
      if (r.action === 'error') {
        return this.finish(ev, { outcome: 'manual_error', isError: true, result: r.message, unexpected: true, yaml: yamlSnippet(name, args, { error: r.message }) }, t0);
      }
      if (r.action === 'stopped') return this.finish(ev, { outcome: 'stopped', isError: true, result: this.errText('stopped', name), unexpected: true }, t0);
      return this.finish(ev, { outcome: 'timeout', isError: true, result: this.errText('timeout', name), unexpected: true }, t0);
    }
    // Предложение из дизайна: без заглушки в автоматическом режиме агент получает ошибку инструмента.
    return this.finish(ev, { outcome: 'no_stub', isError: true, result: this.errText('noStub', name), unexpected: true }, t0);
  }

  pendingList(): { callId: string; kind: 'confirmation' | 'answer'; tool: string; deadline: string | null }[] {
    return [...this.pending.values()].map((p) => ({ callId: p.ev.callId, kind: p.kind, tool: p.ev.tool, deadline: p.ev.deadline }));
  }

  toJSON() {
    return {
      id: this.id,
      mode: this.mode,
      case: { id: this.caseDef.id, title: this.caseDef.title, topic: this.caseDef.topic, file: this.caseDef.source.file, hash: this.caseDef.source.hash },
      solution: this.solution ? { id: this.solution.id, title: this.solution.title, file: this.solution.source.file, hash: this.solution.source.hash, style: this.solution.operator.style } : null,
      basketType: this.basketType,
      senderId: this.senderId,
      caseNumber: this.caseNumber,
      requestRef: this.requestRef,
      taskIds: this.taskIds,
      run: this.run,
      status: this.status,
      reason: this.reason,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      turns: this.turns,
      operatorCalls: this.operatorCalls,
      state: this.stub.snapshot(),
      events: this.events,
      pending: this.pendingList(),
      httpCount: this.http.length,
    };
  }
}

export type ExecutionJSON = ReturnType<Execution['toJSON']>;
