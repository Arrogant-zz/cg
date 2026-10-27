// Сохраняемая запись прогона: настройки, план, линии (повторения) с тестовыми операторами, элементы корзины, проходы curator, итоги.
import type { ExecStats, Outcome } from '../execution/evaluate.js';
import type { CheckItem } from '../execution/events.js';
import type { BasketDef, CuratorPolicy, Issue, Limits } from '../config/types.js';
import type { PlanStep } from './plan.js';
import type { MetricAvailability } from './resolve.js';
import type { HttpExchange } from '../util/httplog.js';
import type { ItemScores } from '../metrics/scoring.js';

export type RunStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed';

export interface PrepItem {
  ok: boolean | null;
  text: string;
  note: string;
  ts: string;
}

export interface ItemRecord {
  index: number;
  kind: 'case' | 'curator';
  pos: number | null;
  solution: { id: string; title: string; style: string | null; file: string; hash: string } | null;
  case: { id: string; title: string; topic: string; file: string; hash: string } | null;
  execName: string | null;
  status: string;
  outcome: Outcome | null;
  reason: string;
  startedAt: string | null;
  finishedAt: string | null;
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
  limits: Limits;
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

/** Прогон, через который прошёл тестовый оператор: так видно, с какими скиллами он начинает следующий. */
export interface OperatorStep {
  run: number;
  title: string;
  type: 'training' | 'checking';
  line: number;
}

export interface LineRecord {
  index: number;
  /** x-a2a-sender-id тестового оператора: у него в агенте живут скиллы. */
  senderId: string;
  /** Прошлые прогоны этого оператора; пусто — новый оператор со стартовыми скиллами сборки. */
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
    limits: Limits;
    repetitions: number;
    prompts: { operator: string; judge: string; answerJudge?: string };
    contract: { file: string; hash: string; version: string; conditional: boolean };
  };
  snapshot: { createdAt: string; files: { file: string; hash: string }[] };
  plan: PlanStep[];
  planText: string[];
  metricsAvailability: MetricAvailability[];
  warnings: Issue[];
  lines: LineRecord[];
  summary: unknown;
}
