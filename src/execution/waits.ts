// Текущие ожидания выполнения для интерфейса: кто держит ход диалога, на чём он стоит и сколько стенд готов ждать.
// Собираются из того, что стенд действительно ждёт: обмены с агентом без ответа, открытые вызовы LLM, удерживаемые вызовы.
// Тексты — здесь, интерфейс их только показывает. В запись выполнения ожидания не входят: они есть, пока выполнение идёт.
import type { Execution } from './execution.js';
import type { CommandEvent } from './events.js';
import type { HttpExchange } from '../util/httplog.js';

/** Открытая группа вызовов LLM — решение оператора или оценка, от llmLog() до attach(). */
export interface LlmCall {
  /** Подпись вызова в журнале HTTP: попытки подписаны ею с хвостом — «повтор 1», «переспрос формата», «прогон 2 из 3». */
  label: string;
  /** Что ждём — для строки ожидания. */
  title: string;
  startedAt: string;
  /** Общий срок вызова; у оценки его нет. */
  deadline: string | null;
  /** Решение по подтверждению этого вызова — для карточки вызова. */
  callId: string | null;
  exchanges: HttpExchange[];
}

export interface Wait {
  /** turn — кто держит ход диалога: строка в конце ленты и шапка; call — решение по удерживаемому вызову: карточка вызова. */
  scope: 'turn' | 'call';
  who: 'agent' | 'command' | 'llm' | 'human';
  text: string;
  detail: string | null;
  startedAt: string;
  deadline: string | null;
  /** Ждём человека: время показывается остатком до срока. */
  remaining: boolean;
  /** Скрыто от агента: решение оператора и оценка. */
  hidden: boolean;
  /** На чём стоит ход: вызов ждёт решения LLM-оператора или человека, запрос — в очереди за прерванным. */
  blocked: 'llm' | 'human' | 'queue' | null;
  callId: string | null;
  httpId: string | null;
}

const COMMAND_TITLES: Record<CommandEvent['name'], string> = { reset: '/reset', capture: '/case-capture', curator: '/skill-curator' };
const ANSWERS_TO: Record<string, string> = { start_message: 'на стартовое сообщение', operator_message: 'на реплику оператора', human_message: 'на вашу реплику' };

/** Чем попытка отличается от вызова: хвост подписи после подписи группы. */
function attemptOf(group: string, label: string): string | null {
  if (!label.startsWith(group)) return label;
  return label.slice(group.length).replace(/^[\s,·]+/, '') || null;
}

/** На чём стоит ход: удерживаемые вызовы ждут решения оператора (автоматический режим) или человека. */
function heldText(pending: ReturnType<Execution['pendingList']>, auto: boolean): string {
  if (pending.length > 1) return `стоит: ${pending.length} ${pending.length < 5 ? 'вызова ждут' : 'вызовов ждут'} ${auto ? 'решения LLM-оператора' : 'вашего решения'}`;
  const p = pending[0];
  return `стоит: ${p.tool} ждёт ${auto ? 'решения LLM-оператора' : p.kind === 'confirmation' ? 'вашего решения' : 'вашего ответа'}`;
}

export function waitsOf(exec: Execution): Wait[] {
  const out: Wait[] = [];
  const pending = exec.pendingList();
  const auto = exec.mode === 'auto';
  for (const x of exec.http) {
    if (x.kind !== 'agent' || x.finishedAt) continue;
    const ev = exec.events.find((e) => e.seq === x.eventSeq);
    const command = ev?.type === 'command' ? (ev as CommandEvent) : null;
    // Пришли вызовы этого хода — агент уже работает над запросом, очередь за прерванным позади.
    const working = exec.events.some((e) => e.type === 'tool_call' && e.seq > (x.eventSeq ?? 0));
    const behind = exec.behind.get(x.id);
    let blocked: Wait['blocked'] = null;
    let detail = command ? null : `Pagurus отвечает ${ANSWERS_TO[ev?.type ?? ''] ?? 'на запрос'}`;
    if (pending.length) {
      blocked = auto ? 'llm' : 'human';
      detail = heldText(pending, auto);
    } else if (behind && !working) {
      blocked = 'queue';
      detail = `в очереди за прерванным «${behind}»`;
    }
    out.push({ scope: 'turn', who: command ? 'command' : 'agent', text: command ? COMMAND_TITLES[command.name] : 'Ход агента', detail, startedAt: x.startedAt, deadline: x.deadline ?? null, remaining: false, hidden: false, blocked, callId: null, httpId: x.id });
  }
  for (const c of exec.llmCalls) {
    const last = c.exchanges[c.exchanges.length - 1];
    const detail = !last ? null : last.finishedAt ? 'пауза перед повтором' : attemptOf(c.label, last.label);
    out.push({ scope: c.callId ? 'call' : 'turn', who: 'llm', text: c.title, detail, startedAt: c.startedAt, deadline: c.deadline, remaining: false, hidden: true, blocked: null, callId: c.callId, httpId: last?.id ?? null });
  }
  // В автоматическом режиме по удерживаемому вызову решает оператор — его вызов LLM уже в списке.
  if (!auto) {
    for (const p of pending) {
      const ev = exec.toolCalls().find((c) => c.callId === p.callId);
      out.push({ scope: 'call', who: 'human', text: p.kind === 'confirmation' ? 'Ждёт вашего решения' : 'Ждёт вашего ответа', detail: p.tool, startedAt: ev?.ts ?? exec.startedAt, deadline: p.deadline, remaining: true, hidden: false, blocked: null, callId: p.callId, httpId: ev?.httpId ?? null });
    }
  }
  return out;
}
