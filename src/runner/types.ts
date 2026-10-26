// Сохраняемая запись прогона: настройки, план, линии (повторения), элементы корзины, проходы curator, итоги.
import type { TreeChange } from '../util/diff.js';
import type { ExecStats, Outcome } from '../execution/evaluate.js';
import type { CheckItem } from '../execution/events.js';
import type { Issue, Limits } from '../config/types.js';
import type { PlanStep } from './plan.js';
import type { MetricAvailability } from './resolve.js';

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
  parsed: unknown;
  error?: string;
  changes: TreeChange[] | null;
  exportNote: string;
  report: string | null;
}

export interface SkillsRecord {
  mode: 'version' | 'build' | 'none';
  source: { skillset: string; version: string; checksum: string; files: number } | null;
  initial: { checksum: string; files: number } | null;
  final: { checksum: string; files: number } | null;
  changes: TreeChange[] | null;
  newVersion: { id: string; status: 'ready' | 'partial' } | null;
  versionNote: string;
  immutability: { status: 'unchanged' | 'changed' | 'unchecked'; files: number; changes: TreeChange[]; note: string } | null;
}

export interface LineRecord {
  index: number;
  senderId: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  prep: { status: 'ok' | 'failed' | 'skipped' | 'pending'; items: PrepItem[]; durationMs: number | null };
  items: ItemRecord[];
  curatorPasses: CuratorPassRecord[];
  counter: number;
  current: { index: number; execName: string | null; phase: string } | null;
  skills: SkillsRecord;
  materials: { kind: string; label: string; file: string | null; ok: boolean; note: string }[];
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
    basket: { id: string; title: string; file: string; hash: string; type: 'training' | 'checking'; curator: unknown; checking: unknown; items: number };
    agent: { id: string; title: string; file: string; hash: string; build: string | null; learningKit: string | null; installer: string };
    agentModel: { title: string; value: string | null; note: string; switchable: boolean; id: string | null };
    operator: { id: string; title: string; provider: string; model: string | null; file: string; hash: string } | null;
    judge: { id: string; title: string; provider: string; model: string | null; file: string; hash: string } | null;
    skillset: { id: string; title: string; version: string; requested: string; checksum: string; files: number } | 'build' | null;
    metrics: { id: string; title: string; builtin: string; version: string }[];
    limits: Limits;
    repetitions: number;
    prompts: { operator: string; judge: string };
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
