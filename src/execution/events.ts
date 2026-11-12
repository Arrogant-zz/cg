// События журнала выполнения кейса (RES-01). Роли и источники сообщений разделены;
// hidden — сведения, которых агент не видел: решения оператора, разметка, оценка.
import type { CaseScores } from '../metrics/scoring.js';

export type EventType =
  | 'command'
  | 'start_message'
  | 'agent_message'
  | 'operator_message'
  | 'human_message'
  | 'operator_decision'
  | 'tool_call'
  | 'judge'
  | 'checks'
  | 'scores'
  | 'status'
  | 'note'
  | 'mode_violation';

export interface BaseEvent {
  seq: number;
  ts: string;
  type: EventType;
  hidden?: boolean;
  /** HTTP-обмен этого события: запрос к агенту или запрос агента к MCP. */
  httpId?: string | null;
}

export type ToolOutcome =
  | 'pending'
  | 'stub'
  | 'default'
  | 'manual'
  | 'manual_error'
  | 'no_stub'
  | 'unknown_tool'
  | 'rejected'
  | 'timeout'
  | 'stopped'
  /** Вызов с подтверждением после закрытия кейса терминальным инструментом: агент сразу получил errors.closed. */
  | 'closed';

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  taskId: string;
  requiresConfirmation: boolean;
  stub: { id: string; origin: 'case' | 'default'; candidates: number; call: number } | null;
  confirmation: null | {
    decision: 'approve' | 'reject' | 'pending';
    by: 'operator' | 'human' | 'auto' | 'timeout' | 'stopped' | 'closed' | null;
    waitedMs: number | null;
    deadline: string | null;
    decisionSeq: number | null;
  };
  awaiting: null | 'confirmation' | 'answer';
  deadline: string | null;
  outcome: ToolOutcome;
  isError: boolean;
  result: unknown;
  effect: Record<string, unknown> | null;
  /** Выполнение состоялось: инструмент вернул ответ заглушки или человека без ошибки. */
  executed: boolean;
  unexpected: boolean;
  durationMs: number | null;
  yaml?: string;
  /** Инструмент есть в контракте, но выключен (enabled: false): агент получил ошибку «не найден». */
  disabled?: boolean;
  /** Вызов пришёл после завершения кейса — от хода, который стенд перестал ждать: агент сразу получил ошибку. */
  late?: boolean;
  /** Вызов подходит под пометку terminal контракта: выполненный, он закрывает кейс. Его видит оператор при подтверждении. */
  terminal?: true;
  /** Этот вызов закрыл кейс. */
  closedCase?: true;
  /** Вызов пришёл после закрытия кейса в том же ходе или ждал решения в момент закрытия. */
  afterClose?: true;
}

export interface MessageEvent extends BaseEvent {
  type: 'start_message' | 'agent_message' | 'operator_message' | 'human_message';
  text: string;
  turn?: number;
  durationMs?: number;
  usage?: { input: number | null; output: number | null; total: number | null } | null;
  taskId?: string;
  marks?: { correction: boolean; lessonId: string | null; lessonNote: string | null; explanation: boolean; approval: boolean; finish: boolean; manual?: boolean; repeated?: boolean };
  decisionSeq?: number;
  /** Склеенные реплики к подтверждениям, ушедшие после хода, — только в прежних записях: теперь их пересматривает решение на конец хода. */
  queued?: boolean;
  /** Напоминание стенда в проверяющей корзине: фиксированный текст, а не реплика LLM-оператора. decisionSeq — решение, по которому оно отправлено. */
  reminder?: true;
}

export interface CommandEvent extends BaseEvent {
  type: 'command';
  name: 'reset' | 'capture' | 'curator';
  text: string;
  status: 'running' | 'ok' | 'failed' | 'skipped' | 'unrecognized';
  reply: string | null;
  parsed: unknown;
  durationMs: number | null;
  error?: string;
  by: 'runner' | 'human';
  pass?: number;
  /** Команда ждала в очереди агента за прерванным запросом и не дождалась: сессия агента занята. */
  busy?: boolean;
}

export interface DecisionEvent extends BaseEvent {
  type: 'operator_decision';
  hidden: true;
  event: 'turn_end' | 'confirmation';
  callId?: string;
  /** Решение модели по схеме оператора; у конца хода в проверяющей корзине — реакция: reaction, reply, reason. */
  decision: Record<string, unknown> | null;
  model: string;
  durationMs: number;
  usage: { input: number | null; output: number | null } | null;
  attempts: { n: number; ok: boolean; kind?: string; error?: string; durationMs: number }[];
  error?: string;
  forced?: string;
  /** Решение пришло, когда вызов уже получил ошибку закрытого кейса: на кейс оно не влияет. */
  moot?: true;
  /** Реплика к решению не ушла агенту: кейс завершился раньше, чем оператор её пересмотрел, — терминальным инструментом, решением оператора, лимитом или сбоем. */
  replyDropped?: true;
  /** Почему реплика к подтверждению не ушла, если не из-за завершения кейса: checking — в проверяющей корзине реплики к подтверждениям агенту не уходят. */
  replyDropReason?: 'checking';
  /** Номер решения на конец хода, которое пересмотрело реплику к подтверждению: сама реплика агенту не уходит. */
  replyReviewed?: number;
}

export interface JudgeEvent extends BaseEvent {
  type: 'judge';
  hidden: true;
  status: 'ok' | 'failed' | 'skipped';
  model: string | null;
  criteria: { id: string; text: string; passed: boolean; reason: string }[];
  summary: string;
  durationMs: number | null;
  usage: { input: number | null; output: number | null } | null;
  error?: string;
  /** Повторный вызов судьи: сразу после сбоя (inline) или переоценка после прогона (after). */
  repeat?: 'inline' | 'after';
  /** Сбой этого вызова заменил повторный вызов с таким номером события. */
  replacedBy?: number;
}

export interface CheckItem {
  id: string;
  kind: 'required' | 'forbidden' | 'final';
  text: string;
  passed: boolean | null;
  evidence: number[];
  note: string;
}

export interface ChecksEvent extends BaseEvent {
  type: 'checks';
  hidden: true;
  items: CheckItem[];
}

/** Метрики аналитика по кейсу: класс финального действия, F1 по инструментам, A_judge и case_score. */
export interface ScoresEvent extends BaseEvent, CaseScores {
  type: 'scores';
  hidden: true;
  /** Метрики пересчитаны переоценкой после прогона: прежнее событие scores остаётся в журнале. */
  reevaluation?: boolean;
}

export interface StatusEvent extends BaseEvent {
  type: 'status';
  status: string;
  reason: string;
}

export interface NoteEvent extends BaseEvent {
  type: 'note' | 'mode_violation';
  text: string;
  data?: unknown;
}

export type ExecEvent = ToolCallEvent | MessageEvent | CommandEvent | DecisionEvent | JudgeEvent | ChecksEvent | ScoresEvent | StatusEvent | NoteEvent;

/** Технические статусы: не неуспех агента (фиолетовые в интерфейсе). */
export const TECH_STATUSES = new Set([
  'reset_failed',
  'agent_busy',
  'agent_error',
  'agent_timeout',
  'operator_error',
  'operator_format_error',
  'operator_timeout',
  'operator_mode_violation',
  'stopped',
  'internal_error',
  'prepare_failed',
]);

/**
 * Технические статусы, после которых кейс сразу повторяется на месте (решение владельца от 12.11.2026): сбои LLM-оператора,
 * /reset и ошибка агента. Таймаут агента не повторяется — агент ещё доделывает прерванный ход, новый запрос ждал бы его;
 * «агент занят», остановка и внутренняя ошибка стенда останавливают линию.
 */
export const RETRYABLE_STATUSES = new Set(['operator_error', 'operator_format_error', 'operator_timeout', 'operator_mode_violation', 'reset_failed', 'agent_error']);

/** Технические итоги LLM-оператора: метрика «Сбои LLM-оператора». */
export const OPERATOR_FAILURES = new Set(['operator_error', 'operator_format_error', 'operator_timeout', 'operator_mode_violation']);

export const LIMIT_STATUSES = new Set(['limit_turns', 'limit_duration', 'limit_operator_calls', 'limit_reminders']);

export const STATUS_TITLES: Record<string, string> = {
  preparing: 'Подготовка',
  running: 'Выполняется',
  completed: 'Завершён',
  limit_turns: 'Исчерпан лимит ходов',
  limit_duration: 'Исчерпан лимит времени',
  limit_operator_calls: 'Исчерпан лимит запросов оператора',
  limit_reminders: 'Исчерпан лимит напоминаний',
  reset_failed: 'Сбой /reset',
  agent_busy: 'Агент занят прерванным запросом',
  agent_error: 'Сбой агента',
  agent_timeout: 'Таймаут агента',
  operator_error: 'Сбой LLM-оператора',
  operator_format_error: 'Ошибка формата оператора',
  operator_timeout: 'Таймаут оператора',
  operator_mode_violation: 'Нарушение режима проверки',
  stopped: 'Остановлен',
  internal_error: 'Внутренняя ошибка стенда',
  prepare_failed: 'Сбой подготовки',
  closed: 'Закрыт',
};
