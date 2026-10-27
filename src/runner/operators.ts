// Тестовые операторы (x-a2a-sender-id) — замечание ревью 2, решение владельца от 28.10.2026.
// Резерв: оператор занимается одним синхронным шагом при запуске прогона или ручной сессии и освобождается в их конце,
// поэтому два запуска на одном операторе не идут параллельно. Журнал: через какие прогоны и ручные сессии оператор прошёл.
// История продолжения берётся из журнала, а не из выбранного прошлого прогона: скиллы в агенте у оператора текущие, отката нет.
import type { ManualRecord } from '../manual/manual.js';
import type { StandLog } from '../mcp/server.js';
import type { ResultsStore } from '../results/store.js';
import type { OperatorStep, RunRecord } from './types.js';
import { HttpError } from '../util/http.js';
import { logger } from '../util/log.js';

const log = logger('operators');

/** Подпись шага истории: «#12 обучение», «m-0003 ручная». */
export const stepLabel = (s: OperatorStep): string => (s.kind === 'manual' ? `${s.key} ручная` : `#${s.run} ${s.type === 'training' ? 'обучение' : 'проверка'}`);

export const runStep = (r: Pick<RunRecord, 'id' | 'title' | 'type'>, line: number): OperatorStep => ({ kind: 'run', run: r.id, title: r.title, type: r.type, line });

export const manualStep = (id: number, key: string, title: string): OperatorStep => ({ kind: 'manual', session: id, key, title });

const sameStep = (a: OperatorStep, b: OperatorStep): boolean =>
  a.kind === 'run' ? b.kind === 'run' && a.run === b.run && a.line === b.line : b.kind === 'manual' && a.session === b.session;

/** Что оператор прошёл после прогона: агент продолжит со скиллами после этих шагов, а не сразу после прогона. */
export function stepsAfter(history: OperatorStep[], run: number): OperatorStep[] {
  const i = history.findIndex((s) => s.kind === 'run' && s.run === run);
  return i < 0 ? [] : history.slice(i + 1);
}

export interface OperatorState {
  /** Через какие прогоны и ручные сессии оператор прошёл, по порядку; пусто — ClawGym его не знает. */
  history(senderId: string): OperatorStep[];
  /** Кем оператор занят сейчас: «прогоном #12», «ручной сессией m-0003»; null — свободен. */
  holder(senderId: string): string | null;
}

/** Сливает последовательность в историю, сохраняя порядок обеих: недостающий шаг встаёт после последнего найденного. */
function merge(into: OperatorStep[], seq: OperatorStep[]): boolean {
  let at = 0;
  let changed = false;
  for (const s of seq) {
    const i = into.findIndex((x) => sameStep(x, s));
    if (i >= 0) at = i + 1;
    else {
      into.splice(at++, 0, s);
      changed = true;
    }
  }
  return changed;
}

/**
 * Дополняет журнал записями в порядке начала: линиями прогонов, которые начинались, и ручными сессиями.
 * История, сохранённая в линии или сессии, восстанавливает и шаги удалённых прогонов.
 */
export function mergeRecords(ledger: Map<string, OperatorStep[]>, runs: RunRecord[], sessions: ManualRecord[]): boolean {
  const uses = [
    ...runs.flatMap((r) => r.lines.filter((l) => l.senderId && l.startedAt).map((l) => ({ at: l.startedAt!, senderId: l.senderId, seq: [...l.history, runStep(r, l.index)] }))),
    ...sessions.filter((s) => s.senderId).map((s) => ({ at: s.createdAt, senderId: s.senderId, seq: [...(s.history ?? []), manualStep(s.id, s.key, s.case.title)] })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let changed = false;
  for (const u of uses) {
    let list = ledger.get(u.senderId);
    if (!list) ledger.set(u.senderId, (list = []));
    if (merge(list, u.seq)) changed = true;
  }
  return changed;
}

/**
 * Операторы без резервов и без записи на диск — предпросмотр в CLI рядом с работающим ClawGym и тесты. saved — журнал из
 * operators.json. Занятость — по прогонам в очереди и в работе и по активным сессиям.
 */
export function operatorsFromRecords(runs: RunRecord[], sessions: ManualRecord[] = [], saved: Record<string, OperatorStep[]> = {}): OperatorState {
  const ledger = new Map(Object.entries(saved).map(([id, steps]) => [id, [...steps]]));
  mergeRecords(ledger, runs, sessions);
  return {
    history: (id) => [...(ledger.get(id) ?? [])],
    holder: (id) => {
      const r = runs.find((x) => (x.status === 'queued' || x.status === 'running') && x.lines.some((l) => l.senderId === id));
      if (r) return `прогоном #${r.id}`;
      const s = sessions.find((x) => x.status === 'active' && x.senderId === id);
      return s ? `ручной сессией ${s.key}` : null;
    },
  };
}

/** Резерв операторов одного прогона или ручной сессии; снимается целиком в их конце. */
export class OperatorHold {
  readonly ids = new Set<string>();
  constructor(
    private readonly operators: TestOperators,
    readonly kind: 'run' | 'manual',
    /** Кем занят оператор — для сообщения «Тестовый оператор занят …». */
    public label: string,
  ) {}

  /** Ещё один оператор под тот же резерв — например, новый оператор линии при её старте. */
  add(senderId: string): void {
    this.operators.take(this, [senderId]);
  }

  release(): void {
    this.operators.free(this);
  }
}

export class TestOperators implements OperatorState {
  private holds = new Map<string, OperatorHold>();
  private ledger = new Map<string, OperatorStep[]>();
  /** Журнал на диске не загрузился — новее этой версии ClawGym или повреждён: он не перезаписывается, история ведётся в памяти. */
  private readOnly = false;

  constructor(
    private readonly store: ResultsStore,
    private readonly stand: StandLog,
  ) {}

  /** Журнал из CLAWGYM_VAR, дополненный записями прогонов и сессий: так он переживает и удаление прогонов, и восстановление var без журнала. */
  async init(runs: RunRecord[], sessions: ManualRecord[]): Promise<void> {
    const saved = await this.store.loadOperators((file, reason) => {
      this.readOnly = true;
      this.stand.add('warn', 'store.skipped', `Журнал тестовых операторов ${file} не загружен: ${reason}. История операторов собрана по прогонам и сессиям и не сохраняется, пока файл не исправят или не уберут`);
    });
    for (const [id, steps] of Object.entries(saved ?? {})) this.ledger.set(id, [...steps]);
    if (mergeRecords(this.ledger, runs, sessions)) this.save();
  }

  /** Резерв до первого await: проверка и занятие — один синхронный шаг. Занят другим — 409, и ничего не резервируется. */
  reserve(senderIds: string[], kind: OperatorHold['kind'], label: string): OperatorHold {
    const hold = new OperatorHold(this, kind, label);
    this.take(hold, senderIds);
    return hold;
  }

  /** Для OperatorHold: под резерв уходят все операторы или ни одного. */
  take(hold: OperatorHold, senderIds: string[]): void {
    const busy = senderIds.map((id) => this.holds.get(id)).find((h) => h && h !== hold);
    if (busy) throw new HttpError(409, `Тестовый оператор занят ${busy.label}: ${busy.kind === 'run' ? 'дождитесь его завершения' : 'завершите её'}`);
    for (const id of senderIds) {
      this.holds.set(id, hold);
      hold.ids.add(id);
    }
  }

  free(hold: OperatorHold): void {
    for (const id of hold.ids) if (this.holds.get(id) === hold) this.holds.delete(id);
    hold.ids.clear();
  }

  holder(senderId: string): string | null {
    return this.holds.get(senderId)?.label ?? null;
  }

  history(senderId: string): OperatorStep[] {
    return [...(this.ledger.get(senderId) ?? [])];
  }

  /** Оператор начал прогон или ручную сессию. Шаг пишется сразу: удаление прогона его из истории оператора не стирает. */
  record(senderId: string, step: OperatorStep): void {
    let list = this.ledger.get(senderId);
    if (!list) this.ledger.set(senderId, (list = []));
    if (list.some((s) => sameStep(s, step))) return;
    list.push(step);
    this.save();
  }

  private save(): void {
    if (this.readOnly) return;
    this.store.saveOperators(Object.fromEntries(this.ledger)).catch((e) => log.error('Сохранение журнала операторов', e));
  }
}
