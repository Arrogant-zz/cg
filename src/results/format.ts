// Версия формата записей в CLAWGYM_VAR: run.json, журналы кейсов, ручные сессии, журнал тестовых операторов. Каталог живёт
// дольше кода (синхронизация с S3), поэтому совместимость со старыми записями собрана здесь: остальной код видит только текущий вид.
// Несовместимое изменение записи — новая версия RECORD_FORMAT и шаг миграции к ней в списках ниже.
// Журналы HTTP-обменов — массивы без версии: их только показывают. Записи в памяти поля format не несут, его ставит сохранение.
import type { RunRecord, ItemRecord, OperatorStep } from '../runner/types.js';
import type { ManualRecord } from '../manual/manual.js';
import type { ExecutionJSON } from '../execution/execution.js';
import { errorMessage } from '../util/core.js';

export const RECORD_FORMAT = 2;

export type SavedExecution = ExecutionJSON & { item?: ItemRecord | null };

export type Loaded<T> = { ok: true; record: T } | { ok: false; reason: string };

/** Шаг n приводит запись версии n к версии n + 1; запись меняется на месте. */
type Step = (record: any) => void;

function load<T>(raw: unknown, steps: Step[]): Loaded<T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'запись — не JSON-объект' };
  const { format = 0, ...record } = raw as Record<string, unknown>;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 0) return { ok: false, reason: `непонятная версия формата «${String(format)}»` };
  // Более новая запись не читается: её поля могут значить другое, а пересохранение затёрло бы их старым видом.
  if (format > RECORD_FORMAT) return { ok: false, reason: `формат ${format} новее поддерживаемого ${RECORD_FORMAT}: запись сделана более новой версией ClawGym` };
  try {
    for (let n = format; n < RECORD_FORMAT; n++) steps[n](record);
  } catch (e) {
    return { ok: false, reason: `запись формата ${format} не приводится к текущему виду: ${errorMessage(e)}` };
  }
  return { ok: true, record: record as T };
}

// ------------------------------------------------------------------ формат 0 → 1

// Формат 0 — записи без версии, 25–28.10.2026. До 27.10 прогон шёл на наборе скиллов, установленном ClawGym:
// тестового оператора и его истории в записи нет, метрик аналитика M1 и M2 у кейсов тоже.

function runFrom0(r: any): void {
  const s = r.settings;
  if (!s.testOperator) {
    s.testOperator = { mode: 'new' };
    if (s.skillset) s.legacySkillset = s.skillset === 'build' ? 'стартовые скиллы сборки' : `набор ${s.skillset.title} ${s.skillset.version}`;
  }
  for (const l of r.lines) {
    l.history ??= [];
    for (const i of l.items) i.scores ??= null;
  }
}

/** Событие skills (установка набора до 27.10.2026) больше не пишется: такое событие показывается заметкой. */
function execFrom0(e: any): void {
  for (const ev of e.events ?? []) if (ev.type === 'skills') ev.type = 'note';
}

function sessionFrom0(s: any): void {
  if (s.execution) execFrom0(s.execution);
}

// ------------------------------------------------------------------ формат 1 → 2

// Формат 1 — записи 28.10.2026 до перечня входных данных. В снимке нет полных хешей и настроек окружения: такие прогоны
// сравниваются по коротким меткам основных файлов, и сопоставимость не подтверждается. История оператора — только прогоны.

function runFrom1(r: any): void {
  const snap = (r.snapshot ??= { createdAt: r.createdAt ?? '', files: [] });
  snap.settings ??= null;
  for (const f of (snap.files ??= [])) {
    f.group ??= null;
    f.sha256 ??= null;
  }
  for (const l of r.lines) for (const h of (l.history ??= [])) h.kind ??= 'run';
}

/** История оператора до сессии появилась в формате 2: у прежних сессий она неизвестна. */
function sessionFrom1(s: any): void {
  s.history ??= null;
}

const unchanged: Step = () => {};

/** Журнал тестовых операторов (operators.json): x-a2a-sender-id → шаги истории. */
export interface OperatorsRecord {
  operators: Record<string, OperatorStep[]>;
}

export const loadRunRecord = (raw: unknown) => load<RunRecord>(raw, [runFrom0, runFrom1]);
export const loadExecutionRecord = (raw: unknown) => load<SavedExecution>(raw, [execFrom0, unchanged]);
export const loadSessionRecord = (raw: unknown) => load<ManualRecord>(raw, [sessionFrom0, sessionFrom1]);
/** Журнал операторов появился в формате 2: прежних версий у него нет. */
export const loadOperatorsRecord = (raw: unknown) => load<OperatorsRecord>(raw, [unchanged, unchanged]);
