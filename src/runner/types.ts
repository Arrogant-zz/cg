// Сохраняемая запись прогона: настройки, план, линии (повторения) с тестовыми операторами, элементы корзины, проходы curator, итоги.
import type { ExecStats, Outcome } from '../execution/evaluate.js';
import type { CheckItem } from '../execution/events.js';
import type { BasketDef, CuratorPolicy, Issue, Limits } from '../config/types.js';
import type { PlanStep } from './plan.js';
import type { MetricAvailability } from './resolve.js';
import type { HttpExchange } from '../util/httplog.js';
import type { ItemScores } from '../metrics/scoring.js';
import type { InputGroup, InputSetting } from './inputs.js';

export type RunStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

/** Лимиты в записи прогона. maxReminders нет в записях до 12.11.2026: лимита напоминаний тогда не было. */
export type RecordLimits = Omit<Limits, 'maxReminders'> & { maxReminders?: number };

export interface PrepItem {
  ok: boolean | null;
  text: string;
  note: string;
  ts: string;
}

/** Прежняя попытка позиции: её заменила повторная попытка на месте или перезапуск. Журнал попытки остаётся в executions/. */
export interface AttemptRecord {
  n: number;
  execName: string;
  status: string;
  outcome: Outcome | null;
  reason: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Дозапуск завершённого прогона: перезапуск позиций проверки, продолжение обучающих линий или переоценка (решение владельца от 12.11.2026). */
export interface RerunRecord {
  n: number;
  kind: 'rerun' | 'resume' | 'reevaluate';
  /** Позиции (L1-P04) — у перезапуска и переоценки; линии — у продолжения. */
  items: string[];
  lines: number[];
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  error: string | null;
  /** Статус и ошибки прогона и линий до дозапуска: после него они не висят на прогоне, а дозапуск, убранный из очереди, их возвращает. */
  previous: { status: RunStatus; run: string | null; lines: { line: number; error: string }[] };
}

export interface ItemRecord {
  index: number;
  kind: 'case' | 'curator';
  pos: number | null;
  solution: { id: string; title: string; style: string | null; file: string; hash: string } | null;
  case: { id: string; title: string; topic: string; file: string; hash: string } | null;
  /** Журнал итоговой попытки: L1-P07 у первой, L1-P07-2 у второй. */
  execName: string | null;
  status: string;
  outcome: Outcome | null;
  reason: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Прежние попытки позиции; поля выше — итоговая попытка. Пусто в записях до 12.11.2026. */
  attempts: AttemptRecord[];
  /** Граница результата итоговой попытки: судья и проверки смотрят события не дальше неё. null — нет в записях до 12.11.2026. */
  resultSeq: number | null;
  /** Итог оценки получен повторным вызовом судьи — на месте или переоценкой после прогона. */
  reevaluated: boolean;
  steps: {
    reset: string | null;
    dialog: string | null;
    checks: { passed: number; total: number } | null;
    judge: { status: string; passed: number; total: number } | null;
    capture: { status: string; signal: string | null; path: string | null; reason: string | null } | null;
    curatorPass: number | null;
  };
  checks: CheckItem[] | null;
  answerFailed: string[];
  /** Метрики аналитика по кейсу (M1, M2); null у технических сбоев и в записях до 27.10.2026. */
  scores: ItemScores | null;
  stats: ExecStats | null;
  repeated: string[];
  limits: RecordLimits;
}

export interface CuratorPassRecord {
  pass: number;
  afterPos: number;
  reason: 'every' | 'final' | 'explicit';
  status: string;
  startedAt: string;
  durationMs: number | null;
  reset: { status: string; durationMs: number | null; error?: string } | null;
  text: string;
  reply: string | null;
  /** Строка результата curator: сколько кейсов разобрано, скиллов создано и обновлено. Сами файлы остаются в агенте. */
  parsed: unknown;
  error?: string;
  report: string | null;
  /** HTTP-обмены прохода: /reset и /skill-curator. */
  http?: HttpExchange[];
}

/** Прогон (его линия) или ручная сессия, через которые прошёл тестовый оператор: так видно, с какими скиллами он начинает следующий. */
export type OperatorStep =
  | { kind: 'run'; run: number; title: string; type: 'training' | 'checking'; line: number }
  | { kind: 'manual'; session: number; key: string; title: string };

/** Файл снимка. group и sha256 — null в записях до 28.10.2026: тогда сравнение идёт по коротким меткам основных файлов. */
export interface SnapshotFile {
  file: string;
  hash: string;
  group: InputGroup | null;
  sha256: string | null;
}

export interface LineRecord {
  index: number;
  /** x-a2a-sender-id тестового оператора: у него в агенте живут скиллы. */
  senderId: string;
  /** Через что оператор прошёл до этого прогона, по журналу операторов; пусто — новый оператор со стартовыми скиллами сборки. */
  history: OperatorStep[];
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  prep: { status: 'ok' | 'failed' | 'skipped' | 'pending'; items: PrepItem[]; durationMs: number | null };
  items: ItemRecord[];
  curatorPasses: CuratorPassRecord[];
  counter: number;
  current: { index: number; execName: string | null; phase: string } | null;
}

export interface RunRecord {
  id: number;
  key: string;
  configId: string;
  configFile: string;
  configHash: string;
  title: string;
  type: 'training' | 'checking';
  status: RunStatus;
  error: string | null;
  createdAt: string;
  startAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  overrides: Record<string, unknown>;
  settings: {
    basket: { id: string; title: string; file: string; hash: string; type: 'training' | 'checking'; curator: CuratorPolicy; checking: BasketDef['checking']; items: number };
    /** model — метка модели из подключения: модель и стартовые скиллы задаёт сборка агента. */
    agent: { id: string; title: string; file: string; hash: string; build: string | null; model: string | null; learningKit: string | null };
    /** Новый тестовый оператор или продолжение на операторе прошлого прогона (решение владельца от 27.10.2026). */
    testOperator: { mode: 'new' } | { mode: 'continue'; run: number; title: string; type: 'training' | 'checking'; configId: string };
    /** Только записи до 27.10.2026: набор скиллов, который ClawGym установил оператору (results/format.ts). */
    legacySkillset?: string;
    operator: { id: string; title: string; provider: string; model: string | null; file: string; hash: string } | null;
    judge: { id: string; title: string; provider: string; model: string | null; file: string; hash: string } | null;
    metrics: { id: string; title: string; builtin: string; version: string; params?: Record<string, unknown> }[];
    limits: RecordLimits;
    repetitions: number;
    /** Повторов на месте после технического сбоя; нет в записях до 12.11.2026 — тогда повтора не было. */
    retries?: number;
    /** operatorCheck — подсказка конца хода в проверяющей корзине; в записях до 12.11.2026 её нет. */
    prompts: { operator: string; operatorCheck?: string; judge: string; answerJudge?: string };
    contract: { file: string; hash: string; version: string; conditional: boolean };
  };
  /** Входные данные прогона: копии файлов в snapshot/ и значимые настройки окружения; settings — null в записях до 28.10.2026. */
  snapshot: { createdAt: string; files: SnapshotFile[]; settings: InputSetting[] | null };
  plan: PlanStep[];
  planText: string[];
  metricsAvailability: MetricAvailability[];
  warnings: Issue[];
  lines: LineRecord[];
  /** Дозапуски после первого завершения; пусто в записях до 12.11.2026. */
  reruns: RerunRecord[];
  summary: unknown;
}
