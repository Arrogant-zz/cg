// Предметная модель файловых настроек (CFG-01): кейс, решение, корзина, прогон, агент, модель, набор скиллов, метрика.

export type Severity = 'error' | 'warning';

/** Ошибка настройки: файл, поле, причина и что сделать (CFG-02). */
export interface Issue {
  severity: Severity;
  file: string;
  line?: number;
  field?: string;
  reason: string;
  action?: string;
}

export interface Source {
  /** Путь относительно корня настроек. */
  file: string;
  /** Короткая метка содержимого, @a91c. */
  hash: string;
  text: string;
}

// ---------- Контракт инструментов ----------

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresConfirmation: boolean;
  kind: 'info' | 'action';
}

export interface ContractDef {
  source: Source;
  version: string;
  /** true — форматы условные, не сверены с кодом оркестратора. */
  conditional: boolean;
  resultMode: 'text' | 'structured' | 'both';
  errors: {
    rejected: string;
    noStub: string;
    unknownTool: string;
    unknownTask: string;
    timeout: string;
    stopped: string;
  };
  tools: ToolDef[];
  startMessage: { file: string; text: string; hash: string };
  defaults: Record<string, StubDef[]>;
  defaultsSource?: Source;
}

// ---------- Кейс и заглушки ----------

export interface StubResponse {
  result?: { json?: unknown; text?: string; file?: string; fileContent?: unknown };
  error?: string | { message: string; code?: string | number };
  delayMs?: number;
  effect?: Record<string, unknown>;
}

export interface StubDef extends StubResponse {
  id: string;
  tool: string;
  when?: Record<string, unknown>;
  sequence?: StubResponse[];
  origin: 'case' | 'default';
  index: number;
}

export interface LessonDef {
  id: string;
  rule: string;
}

export interface ActionRequirement {
  id: string;
  tool: string;
  before?: string;
  args?: Record<string, unknown>;
  lesson?: string;
  text?: string;
}

export interface Criterion {
  id: string;
  text: string;
  /** Подсказка только для fake-llm при офлайн-разработке; настоящему судье не передаётся. */
  hint?: string;
  lesson?: string;
}

export interface CaseDef {
  id: string;
  title: string;
  topic: string;
  tags: string[];
  situation: string;
  start: Record<string, unknown>;
  facts: string[];
  state: Record<string, unknown>;
  tools: Record<string, StubDef[]>;
  reference: {
    procedure: string[];
    answer: string;
    criteria: Criterion[];
    required: ActionRequirement[];
    forbidden: ActionRequirement[];
    final: string | null;
    lessons: LessonDef[];
  };
  source: Source;
  dataFiles: Source[];
}

// ---------- Решение ----------

export interface Limits {
  maxTurns: number;
  maxDurationSec: number;
  maxOperatorCalls: number;
}

export interface SolutionDef {
  id: string;
  case: string;
  title: string;
  goal: string;
  operator: {
    instruction: string;
    /** Необязательная машинная метка стиля; утверждённого перечня режимов нет. */
    style: string | null;
    seesToolResults: boolean;
    lessons: LessonDef[];
  };
  limits: Partial<Limits>;
  source: Source;
}

// ---------- Корзина ----------

export type BasketType = 'training' | 'checking';

export type BasketItem =
  | { kind: 'solution'; index: number; solution: string; limits: Partial<Limits>; note: string }
  | { kind: 'curator'; index: number; note: string };

export interface CuratorPolicy {
  enabled: boolean;
  /** Каждые N завершённых решений; 0 — без периодических проходов. */
  every: number;
  /** Дополнительный проход в конце неполной пачки. */
  final: boolean;
  /** /reset перед /skill-curator, как в INTEGRATION.md. */
  resetBefore: boolean;
}

export interface BasketDef {
  id: string;
  title: string;
  type: BasketType;
  description: string;
  curator: CuratorPolicy;
  checking: { confirmations: 'approve' | 'operator' };
  items: BasketItem[];
  source: Source;
}

// ---------- Агент ----------

export type InstallerDef =
  | { kind: 'none'; note: string }
  | { kind: 'directory'; root: string; skillsDir: string; pendingDir: string; reportsDir: string }
  | { kind: 'http'; baseUrl: string; headers: Record<string, string> };

export interface AgentDef {
  id: string;
  title: string;
  kind: 'rest';
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
    bodySource: string | null;
    textPath: string | null;
    taskIdHeader: string;
    senderIdHeader: string;
    taskIdScope: 'execution' | 'message';
    timeoutMs: number | null;
  };
  response: {
    mode: 'sync' | 'stream' | 'poll';
    replyPath: string;
    statusPath: string | null;
    errorPath: string | null;
    usage: { inputPath: string | null; outputPath: string | null; totalPath: string | null };
    sample: string | null;
  };
  commands: { reset: string; capture: string; curator: string };
  mcp: { contract: string; protocolVersion: string; taskIdFrom: string[] };
  model: { switch: 'none' | 'request'; path: string | null; fixed: string | null };
  sessions: { max: number };
  skills: InstallerDef;
  healthUrl: string | null;
  build: string | null;
  learningKit: string | null;
  source: Source;
}

// ---------- Модель ----------

export type ModelRole = 'agent' | 'operator' | 'judge';

/** Клиентский сертификат (mTLS): пути к файлам и пароль ключа, обычно ссылками ${env:NAME}. */
export interface ModelTls {
  cert: string | null;
  key: string | null;
  pfx: string | null;
  passphrase: string | null;
  ca: string | null;
}

export type LlmProviderName = 'openai-compatible' | 'anthropic' | 'gigachat-v1' | 'gigachat-v2';

export interface ModelDef {
  id: string;
  title: string;
  roles: ModelRole[];
  provider: LlmProviderName | 'deployment' | 'agent-request';
  baseUrl: string | null;
  /** Путь метода относительно baseUrl; по умолчанию — путь провайдера. */
  path: string | null;
  apiKey: string | null;
  model: string | null;
  headers: Record<string, string>;
  tls: ModelTls | null;
  params: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    retries?: number;
    responseFormat?: 'json_schema' | 'json_object' | 'none';
    effort?: string;
    fallbacks?: 'default' | 'off';
    /** Только для fake-llm: в контекст попадают подсказки критериев (hint). */
    devHints?: boolean;
  };
  description: string;
  source: Source;
}

// ---------- Набор скиллов ----------

export interface SkillFile {
  path: string;
  sha256: string;
  size: number;
  content: string;
}

export interface SkillsetVersion {
  id: string;
  skillset: string;
  createdAt: string | null;
  origin: { kind: 'import' | 'training' | 'manual'; note: string; from: string | null; run: number | null; line: number | null };
  status: 'ready' | 'partial';
  files: SkillFile[];
  checksum: string;
  generated: boolean;
  dir: string;
}

export interface SkillsetDef {
  id: string;
  title: string;
  description: string;
  compatibility: { agent: string | null; learningKit: string | null };
  versions: SkillsetVersion[];
  source: Source;
}

// ---------- Метрика ----------

export const BUILTIN_METRICS = [
  'action-checks',
  'answer-quality',
  'success',
  'corrections',
  'repeated-corrections',
  'rejected-actions',
  'unexpected-tools',
  'turns-duration',
  'tokens',
  'skill-changes',
  'operator-errors',
] as const;
export type BuiltinMetric = (typeof BUILTIN_METRICS)[number];

export interface MetricDef {
  id: string;
  builtin: BuiltinMetric;
  title: string;
  description: string;
  unit: string;
  level: string[];
  needs: string;
  params: Record<string, unknown>;
  version: string;
  source: Source;
}

// ---------- Настройка прогона ----------

export interface RunConfigDef {
  id: string;
  title: string;
  basket: string;
  agent: string;
  models: { agent: string | null; operator: string | null; judge: string | null };
  /** null — без подготовки набора; 'build' — стартовые скиллы сборки агента (промежуточный режим). */
  skillset: { id: string; version: string } | 'build' | null;
  metrics: string[];
  limits: Limits;
  repetitions: number;
  startAt: string | null;
  source: Source;
}

export interface Registry {
  home: string;
  loadedAt: string;
  contract: ContractDef | null;
  cases: Map<string, CaseDef>;
  solutions: Map<string, SolutionDef>;
  baskets: Map<string, BasketDef>;
  agents: Map<string, AgentDef>;
  models: Map<string, ModelDef>;
  skillsets: Map<string, SkillsetDef>;
  metrics: Map<string, MetricDef>;
  runs: Map<string, RunConfigDef>;
  issues: Issue[];
  fileCount: number;
}

export const DEFAULT_LIMITS: Limits = { maxTurns: 20, maxDurationSec: 900, maxOperatorCalls: 30 };
