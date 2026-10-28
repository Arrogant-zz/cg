// Фактические входные данные прогона — замечания ревью 1 и 5, решение владельца от 28.10.2026. Один перечень файлов
// и значимых настроек нужен трижды: проверка перед запуском учитывает ошибки каждого файла, снимок хранит их копии,
// сравнение сверяет полный SHA-256 каждого файла и значения настроек. Короткая метка @a91c остаётся для интерфейса.
import YAML, { isPair, isScalar, type Node as YamlNode } from 'yaml';
import type { AgentDef, BasketDef, ContractDef, MetricDef, ModelDef, RunConfigDef, Source } from '../config/types.js';
import type { Env } from '../env.js';
import { resolveEnvRefs } from '../config/loader.js';
import { endpointOf } from '../llm/provider.js';
import {
  ANSWER_JUDGE_PROMPT_VERSION,
  ANSWER_JUDGE_SCHEMA,
  ANSWER_JUDGE_SYSTEM,
  JUDGE_PROMPT_VERSION,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  OPERATOR_PROMPT_VERSION,
  OPERATOR_SCHEMA,
  OPERATOR_SYSTEM,
} from '../operator/prompts.js';
import { isSecretName, maskUrl } from '../util/core.js';
import type { ResolvedItem } from './resolve.js';

/**
 * Строка сравнения, в которую входит файл или настройка. run — файл прогона: до и после обучения он разный по замыслу,
 * поэтому сравниваются его параметры — лимиты, метрики, модели, тестовый оператор.
 */
export type InputGroup = 'run' | 'basket' | 'cases' | 'contract' | 'agent' | 'models' | 'metrics' | 'prompts' | 'stand';

/** Файл входных данных: text — то, что ляжет в снимок; у подключений агента и моделей секреты скрыты. */
export interface InputFile {
  file: string;
  group: InputGroup;
  text: string;
}

/** Значимая настройка после подстановки окружения. Секретов здесь нет: заголовки и ключи сравниваются по файлам подключений. */
export interface InputSetting {
  key: string;
  group: InputGroup;
  value: string;
}

export interface RunInputs {
  files: InputFile[];
  settings: InputSetting[];
}

export interface InputParts {
  config: RunConfigDef;
  basket: BasketDef | null;
  items: ResolvedItem[];
  agent: AgentDef | null;
  contract: ContractDef | null;
  models: { operator: ModelDef | null; judge: ModelDef | null };
  metrics: MetricDef[];
}

/** Поля с секретом в любом месте файла подключения — по имени без регистра, «-» и «_». Не по части имени: иначе скрылся бы maxTokens. */
const SECRET_FIELDS = new Set(['authorization', 'proxyauthorization', 'apikey', 'xapikey', 'token', 'accesstoken', 'password', 'passphrase', 'secret', 'clientsecret', 'cookie']);

/** Файл не разобрался — секреты в нём не найти, поэтому в снимок он не попадает. */
const UNREADABLE = '# Содержимое скрыто: файл не разобран как YAML или JSON, секреты в нём не найти\n';

/** Скрыть значение поля: секретное поле или заголовок с секретным именем — по тем же правилам, что маскирует журнал HTTP. */
function secretPair(key: unknown, path: readonly unknown[]): boolean {
  const name = isScalar(key) ? String(key.value) : '';
  if (SECRET_FIELDS.has(name.toLowerCase().replace(/[-_]/g, ''))) return true;
  const owner = path[path.length - 2];
  return isPair(owner) && isScalar(owner.key) && String(owner.key.value).toLowerCase() === 'headers' && isSecretName(name);
}

/**
 * Секреты в копии файла подключения для снимка. Файл разбирается как YAML — JSON его подмножество, — и значения
 * в исходном тексте заменяются на месте, по позициям узлов. Так остальной текст и SHA-256 файла без секретов не меняются,
 * и сравнение с прежними прогонами не ломается. Ссылка ${env:NAME} остаётся: секрета в ней нет.
 * В адресах скрываются пароль и секретные параметры запроса.
 */
export function redactSecrets(text: string): string {
  const doc = YAML.parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length) return UNREADABLE;
  const spans = new Map<number, { to: number; value: string }>();
  const replace = (node: YAML.Scalar, value: string) => {
    if (!node.range) return;
    const [from, to] = node.range;
    // Блок | и > заканчивается переводом строки: он остаётся, иначе следующая строка прилипнет к значению.
    spans.set(from, { to, value: value + (text.slice(from, to).endsWith('\n') ? '\n' : '') });
  };
  const seen = new Set<YamlNode>();
  const hide = (node: YamlNode | null | undefined) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    YAML.visit(node, {
      Scalar(_k, s) {
        if (s.value !== null && !(typeof s.value === 'string' && s.value.includes('${env:'))) replace(s, '"***"');
      },
      // Значение через алиас скрывается там, где стоит якорь.
      Alias(_k, a) {
        hide(a.resolve(doc));
      },
    });
  };
  YAML.visit(doc, {
    Pair(_k, pair, path) {
      if (!secretPair(pair.key, path)) return;
      hide(pair.value as YamlNode | null);
      return YAML.visit.SKIP;
    },
    Scalar(_k, s) {
      if (typeof s.value !== 'string' || !s.value.includes('://') || s.value.includes('${env:') || seen.has(s)) return;
      const masked = maskUrl(s.value);
      if (masked !== s.value) replace(s, JSON.stringify(masked));
    },
  });
  let out = text;
  for (const [from, { to, value }] of [...spans].sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + value + out.slice(to);
  return out;
}

/** Настройки окружения, от которых зависит ход кейса: ожидание агента, подтверждений и служебных команд, ответ MCP. */
function standSettings(env: Env): [string, string | number][] {
  return [
    ['TURN_TIMEOUT_MS', env.turnTimeoutMs],
    ['AGENT_MCP_TIMEOUT_MS', env.agentMcpTimeoutMs],
    ['OPERATOR_DECISION_MARGIN_MS', env.operatorMarginMs],
    ['RESET_TIMEOUT_MS', env.resetTimeoutMs],
    ['CAPTURE_TIMEOUT_MS', env.captureTimeoutMs],
    ['CURATOR_TIMEOUT_MS', env.curatorTimeoutMs],
    ['AGENT_BUSY_WAIT_MS', env.agentBusyWaitMs],
    ['MCP_RESPONSE_MODE', env.mcpResponseMode],
    ['MCP_TASK_ID_HEADER', env.mcpTaskIdHeader],
  ];
}

/**
 * Перечень входных данных прогона. Файл, который не прочитался, остаётся в перечне с пустым текстом:
 * его ошибка уже записана загрузчиком и по этому пути остановит прогон.
 */
export function runInputs(p: InputParts, env: Env): RunInputs {
  const files = new Map<string, InputFile>();
  const add = (group: InputGroup, file: string | null | undefined, text: string) => {
    if (file && !files.has(file)) files.set(file, { file, group, text });
  };
  const source = (group: InputGroup, s: Source | null | undefined) => {
    if (s) add(group, s.file, group === 'agent' || group === 'models' ? redactSecrets(s.text) : s.text);
  };
  source('run', p.config.source);
  source('basket', p.basket?.source);
  for (const it of p.items) {
    source('cases', it.solution?.source);
    source('cases', it.caseDef?.source);
    for (const d of it.caseDef?.dataFiles ?? []) source('cases', d);
  }
  const c = p.contract;
  if (c) {
    source('contract', c.source);
    add('contract', c.startMessage.file, c.startMessage.text);
    add('contract', c.defaultsFile, c.defaultsSource?.text ?? '');
    for (const d of c.defaultsData) source('contract', d);
  }
  if (p.agent) {
    source('agent', p.agent.source);
    if (p.agent.request.bodyFile) add('agent', p.agent.request.bodyFile.file, redactSecrets(p.agent.request.bodyFile.text));
  }
  for (const m of [p.models.operator, p.models.judge]) source('models', m?.source);
  for (const m of p.metrics) source('metrics', m.source);
  // Подсказки и схемы ответа LLM-оператора и судей — часть кода: в снимок и сравнение они входят полным текстом.
  const prompts: [string, string, object][] = [
    [OPERATOR_PROMPT_VERSION, OPERATOR_SYSTEM, OPERATOR_SCHEMA],
    [JUDGE_PROMPT_VERSION, JUDGE_SYSTEM, JUDGE_SCHEMA],
    [ANSWER_JUDGE_PROMPT_VERSION, ANSWER_JUDGE_SYSTEM, ANSWER_JUDGE_SCHEMA],
  ];
  for (const [version, system, schema] of prompts) {
    add('prompts', `prompts/${version}.txt`, system);
    add('prompts', `prompts/${version}.schema.json`, JSON.stringify(schema, null, 2));
  }

  // Подстановки окружения: файл подключения тот же, а адрес или модель — другие.
  const settings: InputSetting[] = [];
  const put = (group: InputGroup, key: string, value: string | number) => settings.push({ group, key, value: String(value) });
  const resolved = (v: string | null) => (v ? resolveEnvRefs(v, env.raw).value : '');
  if (p.agent) put('agent', 'agent.url', maskUrl(resolved(p.agent.request.url)));
  for (const role of ['operator', 'judge'] as const) {
    const m = p.models[role];
    if (!m) continue;
    put('models', `${role}.model`, resolved(m.model));
    put('models', `${role}.url`, maskUrl(resolved(endpointOf(m))));
  }
  for (const [k, v] of standSettings(env)) put('stand', k, v);
  return { files: [...files.values()], settings };
}
