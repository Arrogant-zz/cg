// Версия формата записей в CLAWGYM_VAR: run.json, журналы кейсов, ручные сессии, журнал тестовых операторов. Каталог живёт
// дольше кода (синхронизация с S3), поэтому совместимость со старыми записями собрана здесь: остальной код видит только текущий вид.
// Несовместимое изменение записи — новая версия RECORD_FORMAT и шаг миграции к ней в списках ниже.
// Журналы HTTP-обменов — массивы без версии: их только показывают. Записи в памяти поля format не несут, его ставит сохранение.
import AjvModule from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { RunRecord, ItemRecord, OperatorStep } from '../runner/types.js';
import type { ManualRecord } from '../manual/manual.js';
import type { ExecutionJSON } from '../execution/execution.js';
import { errorMessage } from '../util/core.js';

export const RECORD_FORMAT = 2;

export type SavedExecution = ExecutionJSON & { item?: ItemRecord | null };

export type Loaded<T> = { ok: true; record: T } | { ok: false; reason: string };

/** Шаг n приводит запись версии n к версии n + 1; запись меняется на месте. */
type Step = (record: any) => void;

const Ajv: any = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });

const object = { type: 'object' };
const arrayOf = (items: object) => ({ type: 'array', items });

// Номер формата не доказывает целостность: файл мог оборваться или быть затёрт. После миграции проверяются только поля,
// без которых ClawGym не запускается и не строит списки прогонов и сессий. Миграции создают их и у записей прежних версий;
// остальные поля не проверяются, чтобы запись с недостающим необязательным полем оставалась видна.
const RUN_SCHEMA = {
  type: 'object',
  required: ['id', 'settings', 'snapshot', 'lines'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    settings: object,
    snapshot: { type: 'object', required: ['files'], properties: { files: { type: 'array' } } },
    lines: arrayOf({ type: 'object', required: ['items', 'history'], properties: { items: arrayOf(object), history: arrayOf(object) } }),
  },
};

const SESSION_SCHEMA = {
  type: 'object',
  required: ['id', 'history'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    history: { type: ['array', 'null'], items: object },
    createdAt: { type: 'string' },
    case: object,
    execution: { type: ['object', 'null'], properties: { events: arrayOf(object) } },
  },
  // Сессия с тестовым оператором — шаг его истории: для неё нужны время начала и кейс.
  dependencies: { senderId: ['createdAt', 'case'] },
};

const EXECUTION_SCHEMA = { type: 'object', required: ['events'], properties: { events: arrayOf(object), case: object } };

const OPERATORS_SCHEMA = { type: 'object', required: ['operators'], properties: { operators: { type: 'object', additionalProperties: arrayOf(object) } } };

const TYPE_NAMES: Record<string, string> = { object: 'объект', array: 'массив', integer: 'целое число', string: 'строка', null: 'null' };

/** Первые ошибки проверки — по-русски, с путём поля: «lines[0].items — не массив». */
function describe(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 3)
    .map((e) => {
      const at = e.instancePath
        .split('/')
        .filter(Boolean)
        .map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`))
        .join('')
        .replace(/^\./, '');
      const p: any = e.params;
      if (p.missingProperty) return `нет поля «${at ? `${at}.` : ''}${p.missingProperty}»`;
      if (e.keyword === 'type') return `«${at}» — не ${String(p.type).split(',').map((t) => TYPE_NAMES[t] ?? t).join(' и не ')}`;
      if (e.keyword === 'minimum') return `«${at}» меньше ${p.limit}`;
      return `«${at}»: ${e.message}`;
    })
    .join('; ');
}

function load<T>(raw: unknown, steps: Step[], valid: ValidateFunction): Loaded<T> {
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
  if (!valid(record)) return { ok: false, reason: `запись повреждена: ${describe(valid.errors)}` };
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

const validRun: ValidateFunction = ajv.compile(RUN_SCHEMA);
const validExecution: ValidateFunction = ajv.compile(EXECUTION_SCHEMA);
const validSession: ValidateFunction = ajv.compile(SESSION_SCHEMA);
const validOperators: ValidateFunction = ajv.compile(OPERATORS_SCHEMA);

export const loadRunRecord = (raw: unknown) => load<RunRecord>(raw, [runFrom0, runFrom1], validRun);
export const loadExecutionRecord = (raw: unknown) => load<SavedExecution>(raw, [execFrom0, unchanged], validExecution);
export const loadSessionRecord = (raw: unknown) => load<ManualRecord>(raw, [sessionFrom0, sessionFrom1], validSession);
/** Журнал операторов появился в формате 2: прежних версий у него нет. */
export const loadOperatorsRecord = (raw: unknown) => load<OperatorsRecord>(raw, [unchanged, unchanged], validOperators);
