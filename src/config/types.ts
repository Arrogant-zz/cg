// Предметная модель файловых настроек (CFG-01): кейс, решение, корзина, прогон, агент, модель, метрика.

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
  /** Путь относительно каталога справочников (CLAWGYM_CONFIG). */
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
  /** Определение для tools/list: поля MCP из контракта как есть (title, annotations и др.), без полей ClawGym. */
  listed: Record<string, unknown>;
  requiresConfirmation: boolean;
  kind: 'info' | 'action';
  /** false — инструмента нет в tools/list, вызов получает ошибку «не найден»; заглушки кейсов остаются доступны шаблону стартового сообщения. */
  enabled: boolean;
  /** Терминальный инструмент: выполненный вызов закрывает кейс. when — условие на аргументы на языке условий заглушек, null — любой вызов. */
  terminal: { when: Record<string, unknown> | null } | null;
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
    /** Вызов с подтверждением после закрытия кейса терминальным инструментом. */
    closed: string;
  };
  tools: ToolDef[];
  startMessage: { file: string; text: string; hash: string };
  defaults: Record<string, StubDef[]>;
  defaultsSource?: Source;
  /** Путь файла умолчаний, если он есть, даже нечитаемый: его ошибки должны остановить прогон. */
  defaultsFile: string | null;
  /** Файлы ответов data/…, на которые ссылаются заглушки по умолчанию. */
  defaultsData: Source[];
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
  /** Подсказка только для dev/fake-gigachat при офлайн-разработке; настоящему судье не передаётся. */
  hint?: string;
  lesson?: string;
}

/** Классы финального действия (M1 по документу аналитика от 22.10.2026): перечень зафиксирован. */
export const FINAL_CLASSES = ['close_answer', 'expertise', 'request_info', 'operator_instruction'] as const;
export type FinalClass = (typeof FINAL_CLASSES)[number];

/** Инструмент эталона для F1_tools; count — сколько вызовов нужно по эталонному сценарию. */
export interface RefTool {
  tool: string;
  count: number;
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
    /** Эталонный итоговый текст для A_judge: ответ клиенту, описание экспертизы или инструкция оператору. Пусто — берётся answer. */
    finalText: string;
    /** Класс финального действия; null — выводится из actions.final по соответствию в метрике final-action. */
    finalClass: FinalClass | null;
    /** Минимально достаточный набор инструментов для F1_tools; null — эталон не задан. */
    tools: RefTool[] | null;
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

// Модель и стартовые скиллы задаются сборкой агента; ClawGym их не меняет и не выгружает (решение владельца от 27.10.2026).
export interface AgentDef {
  id: string;
  title: string;
  kind: 'rest';
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
    /** Файл шаблона тела (templates/…) с исходным текстом; null — тело задано в самом подключении. */
    bodyFile: Source | null;
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
  /** Где искать x-task-id и какую версию протокола отвечать, решает MCP-сервер стенда для всех агентов (MCP_TASK_ID_HEADER). */
  mcp: { contract: string };
  /** Модель агента — метка из файла подключения: задана сборкой или развёртыванием, в снимке прогона для сравнения. */
  model: string | null;
  sessions: { max: number };
  healthUrl: string | null;
  build: string | null;
  learningKit: string | null;
  source: Source;
}

// ---------- Модель ----------

export type ModelRole = 'operator' | 'judge';

/** Клиентский сертификат (mTLS): пути к файлам и пароль ключа, обычно ссылками ${env:NAME}. */
export interface ModelTls {
  cert: string | null;
  key: string | null;
  pfx: string | null;
  passphrase: string | null;
  ca: string | null;
}

export type LlmProviderName = 'gigachat-v1' | 'gigachat-v2';

export interface ModelDef {
  id: string;
  title: string;
  roles: ModelRole[];
  provider: LlmProviderName;
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
    responseFormat?: 'json_schema' | 'none';
    /** Только для dev/fake-gigachat: в контекст попадают подсказки критериев (hint). */
    devHints?: boolean;
  };
  description: string;
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
  'operator-errors',
  'final-action',
  'tools-f1',
  'answer-match',
  'case-score',
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
  models: { operator: string | null; judge: string | null };
  /** Продолжить на тестовом операторе последнего завершённого прогона этой настройки; null — новый оператор со стартовыми скиллами сборки. */
  continueFrom: string | null;
  metrics: string[];
  limits: Limits;
  repetitions: number;
  startAt: string | null;
  source: Source;
}

export interface Registry {
  /** Каталог справочников (CLAWGYM_CONFIG). */
  configDir: string;
  loadedAt: string;
  contract: ContractDef | null;
  cases: Map<string, CaseDef>;
  solutions: Map<string, SolutionDef>;
  baskets: Map<string, BasketDef>;
  agents: Map<string, AgentDef>;
  models: Map<string, ModelDef>;
  metrics: Map<string, MetricDef>;
  runs: Map<string, RunConfigDef>;
  issues: Issue[];
  fileCount: number;
}

export const DEFAULT_LIMITS: Limits = { maxTurns: 20, maxDurationSec: 900, maxOperatorCalls: 30 };
