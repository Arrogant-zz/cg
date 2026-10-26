// Загрузка и проверка файловых настроек (CFG-01, CFG-02). Ошибка указывает файл, строку, поле и причину.
import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML, { LineCounter, isNode } from 'yaml';
import AjvModule from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import {
  agentSchema,
  basketSchema,
  caseSchema,
  contractSchema,
  metricSchema,
  metricsFileSchema,
  modelSchema,
  runSchema,
  skillsetSchema,
  solutionSchema,
  toolDefaultsSchema,
} from './schemas.js';
import {
  BUILTIN_METRICS,
  DEFAULT_LIMITS,
  type ActionRequirement,
  type AgentDef,
  type BasketDef,
  type BasketItem,
  type CaseDef,
  type ContractDef,
  type Criterion,
  type InstallerDef,
  type Issue,
  type MetricDef,
  type ModelDef,
  type Registry,
  type RunConfigDef,
  type SkillsetDef,
  type SkillsetVersion,
  type SolutionDef,
  type Source,
  type StubDef,
  type StubResponse,
  type ToolDef,
} from './types.js';
import { isPlainObject, shortHash } from '../util/core.js';
import { listDirs, manifestChecksum, readJsonIf, readTree, walkFiles } from '../util/fsx.js';

const Ajv: any = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const compiled = new Map<object, ValidateFunction>();
function validator(schema: object): ValidateFunction {
  let v = compiled.get(schema);
  if (!v) {
    v = ajv.compile(schema) as ValidateFunction;
    compiled.set(schema, v);
  }
  return v;
}

interface Parsed {
  rel: string;
  text: string;
  data: any;
  doc?: YAML.Document.Parsed;
  lc?: LineCounter;
}

export const DEFAULT_ERRORS = {
  rejected: 'Оператор отклонил вызов инструмента {{tool}}.',
  noStub: 'Инструмент {{tool}} вернул ошибку: данные для этих аргументов не найдены.',
  unknownTool: 'Инструмент {{tool}} не найден.',
  unknownTask: 'Вызов не привязан к обращению: неизвестный или отсутствующий x-task-id.',
  timeout: 'Время ожидания решения по вызову {{tool}} истекло.',
  stopped: 'Обращение остановлено на стенде.',
};

export const DEFAULT_COMMANDS = {
  reset: '/reset',
  capture: '/case-capture request_ref={{requestRef}} category={{topic}}',
  curator: '/skill-curator',
};

class Collector {
  issues: Issue[] = [];
  files = 0;
  add(i: Issue) {
    this.issues.push(i);
  }
  error(file: string, reason: string, extra: Partial<Issue> = {}) {
    this.add({ severity: 'error', file, reason, ...extra });
  }
  warn(file: string, reason: string, extra: Partial<Issue> = {}) {
    this.add({ severity: 'warning', file, reason, ...extra });
  }
}

function fieldFromPath(p: (string | number)[]): string {
  let s = '';
  for (const part of p) {
    if (typeof part === 'number' || /^\d+$/.test(String(part))) s += `[${part}]`;
    else s += s ? `.${part}` : String(part);
  }
  return s || '(корень)';
}

function lineOf(parsed: Parsed, p: (string | number)[]): number | undefined {
  if (!parsed.doc || !parsed.lc) return undefined;
  for (let n = p.length; n >= 0; n--) {
    const node = parsed.doc.getIn(p.slice(0, n).map((x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x)), true);
    if (isNode(node) && node.range) return parsed.lc.linePos(node.range[0]).line;
  }
  return undefined;
}

function translate(e: ErrorObject): { reason: string; extraPath?: string; severity: 'error' | 'warning' } {
  const p: any = e.params;
  switch (e.keyword) {
    case 'required':
      return { reason: `Нет обязательного поля «${p.missingProperty}»`, extraPath: p.missingProperty, severity: 'error' };
    case 'additionalProperties':
      return { reason: `Неизвестное поле «${p.additionalProperty}» — будет проигнорировано`, extraPath: p.additionalProperty, severity: 'warning' };
    case 'type':
      return { reason: `Ожидался тип ${p.type}`, severity: 'error' };
    case 'enum':
      return { reason: `Допустимые значения: ${(p.allowedValues ?? []).join(', ')}`, severity: 'error' };
    case 'pattern':
      return { reason: 'Идентификатор может содержать латиницу, цифры и символы . _ / -', severity: 'error' };
    case 'minItems':
      return { reason: `Нужно не меньше ${p.limit} элементов`, severity: 'error' };
    case 'minimum':
      return { reason: `Значение должно быть не меньше ${p.limit}`, severity: 'error' };
    case 'maximum':
      return { reason: `Значение должно быть не больше ${p.limit}`, severity: 'error' };
    case 'anyOf':
      return { reason: 'Значение не подходит ни под один допустимый вариант', severity: 'error' };
    default:
      return { reason: e.message ?? e.keyword, severity: 'error' };
  }
}

function schemaCheck(c: Collector, parsed: Parsed, schema: object): boolean {
  const v = validator(schema);
  if (v(parsed.data)) return true;
  const errs = (v.errors ?? []) as ErrorObject[];
  const anyOfPaths = errs.filter((e) => e.keyword === 'anyOf').map((e) => ({ inst: e.instancePath, schema: e.schemaPath.replace(/\/anyOf$/, '/anyOf') }));
  let fatal = false;
  const seen = new Set<string>();
  for (const e of errs) {
    if (e.keyword !== 'anyOf' && anyOfPaths.some((a) => e.instancePath.startsWith(a.inst) && e.schemaPath.startsWith(a.schema + '/'))) continue;
    const t = translate(e);
    const segs = e.instancePath.split('/').filter(Boolean).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    const full = t.extraPath ? [...segs, t.extraPath] : segs;
    const key = `${t.reason}|${full.join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.severity === 'error') fatal = true;
    c.add({
      severity: t.severity,
      file: parsed.rel,
      field: fieldFromPath(full),
      line: lineOf(parsed, t.extraPath && e.keyword === 'required' ? segs : full),
      reason: t.reason,
      action: t.severity === 'error' ? 'Исправьте файл и нажмите «Проверить файлы снова»' : undefined,
    });
  }
  return !fatal;
}

async function parseFile(c: Collector, home: string, rel: string): Promise<Parsed | null> {
  const abs = path.join(home, rel);
  let text: string;
  try {
    text = await fsp.readFile(abs, 'utf8');
  } catch (e: any) {
    c.error(rel, `Файл не прочитан: ${e?.message ?? e}`);
    return null;
  }
  c.files++;
  if (rel.endsWith('.json')) {
    try {
      return { rel, text, data: JSON.parse(text) };
    } catch (e: any) {
      c.error(rel, `Некорректный JSON: ${e.message}`, { action: 'Исправьте синтаксис файла' });
      return null;
    }
  }
  const lc = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    for (const err of doc.errors) {
      c.error(rel, `Ошибка YAML: ${err.message.split('\n')[0]}`, { line: err.linePos?.[0]?.line, action: 'Исправьте синтаксис файла' });
    }
    return null;
  }
  for (const w of doc.warnings) c.warn(rel, `YAML: ${w.message.split('\n')[0]}`, { line: w.linePos?.[0]?.line });
  const data = doc.toJS({ maxAliasCount: 100 });
  if (!isPlainObject(data)) {
    c.error(rel, 'Ожидался YAML-объект с полями', { line: 1 });
    return null;
  }
  return { rel, text, data, doc, lc };
}

const src = (p: Parsed): Source => ({ file: p.rel, hash: shortHash(p.text), text: p.text });

async function listConfigFiles(home: string, dir: string, recursive = false): Promise<string[]> {
  const base = path.join(home, dir);
  const files = recursive
    ? await walkFiles(base)
    : (await fsp.readdir(base, { withFileTypes: true }).catch(() => [] as any[])).filter((e: any) => e.isFile()).map((e: any) => e.name);
  return files
    .filter((f: string) => /\.(ya?ml|json)$/.test(f) && !f.startsWith('_'))
    .map((f: string) => `${dir}/${f}`)
    .sort();
}

/** `${env:NAME}` в строках подключений: секреты задаются окружением и в снимок не попадают. */
export function resolveEnvRefs(value: string, env: NodeJS.ProcessEnv): { value: string; missing: string[] } {
  const missing: string[] = [];
  const v = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const x = env[name];
    if (x === undefined || x === '') {
      if (def !== undefined) return def;
      missing.push(name);
      return '';
    }
    return x;
  });
  return { value: v, missing };
}

export const hasEnvRef = (s: string | null | undefined): boolean => !!s && /\$\{env:/.test(s);

// ------------------------------------------------------------------ контракт

async function loadContract(c: Collector, home: string): Promise<ContractDef | null> {
  const rel = 'contracts/tools.json';
  const p = await parseFile(c, home, rel);
  if (!p) {
    c.error(rel, 'Нет определений MCP-инструментов', { action: 'Добавьте contracts/tools.json с инструментами из кода оркестратора' });
    return null;
  }
  if (!schemaCheck(c, p, contractSchema)) return null;
  const d = p.data;
  const tools: ToolDef[] = [];
  const names = new Set<string>();
  (d.tools ?? []).forEach((t: any, i: number) => {
    if (names.has(t.name)) c.error(rel, `Инструмент «${t.name}» описан дважды`, { field: `tools[${i}].name` });
    names.add(t.name);
    tools.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      requiresConfirmation: !!t.requiresConfirmation,
      kind: t.kind ?? (t.requiresConfirmation ? 'action' : 'info'),
    });
  });
  const smRel = d.startMessage ?? 'contracts/start-message.txt';
  let smText = '';
  try {
    smText = await fsp.readFile(path.join(home, smRel), 'utf8');
    c.files++;
  } catch {
    c.error(smRel, 'Нет шаблона стартового сообщения', { action: 'Добавьте шаблон по коду оркестратора' });
  }
  if (smText && (!/Тематика:/.test(smText) || !/request_ref:/.test(smText))) {
    c.warn(smRel, 'В шаблоне нет строк «Тематика:» и «request_ref:» из INTEGRATION.md');
  }
  const contract: ContractDef = {
    source: src(p),
    version: d.version ?? 'unversioned',
    conditional: d.conditional !== false,
    resultMode: d.result?.mode ?? 'text',
    errors: { ...DEFAULT_ERRORS, ...(d.errors ?? {}) },
    tools,
    startMessage: { file: smRel, text: smText, hash: shortHash(smText) },
    defaults: {},
  };
  const defRel = 'contracts/tool-defaults.yaml';
  try {
    await fsp.access(path.join(home, defRel));
    const dp = await parseFile(c, home, defRel);
    if (dp && schemaCheck(c, dp, toolDefaultsSchema)) {
      contract.defaultsSource = src(dp);
      contract.defaults = await normalizeStubs(c, home, dp, dp.data.tools ?? {}, 'default', 'tools', []);
    }
  } catch {
    /* файла умолчаний может не быть */
  }
  return contract;
}

async function normalizeStubs(
  c: Collector,
  home: string,
  p: Parsed,
  tools: Record<string, any[]>,
  origin: 'case' | 'default',
  base: string,
  dataFiles: Source[],
): Promise<Record<string, StubDef[]>> {
  const out: Record<string, StubDef[]> = {};
  for (const [tool, list] of Object.entries(tools)) {
    out[tool] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const field = `${base}.${tool}[${i}]`;
      const line = lineOf(p, [base, tool, i]);
      if (!s.result && !s.error && !s.sequence) {
        c.error(p.rel, 'Заглушка без ответа: нужен result, error или sequence', { field, line });
        continue;
      }
      const responses: StubResponse[] = s.sequence ? s.sequence : [s];
      for (let k = 0; k < responses.length; k++) {
        const r = responses[k];
        if (r.result && r.error) c.error(p.rel, 'В одном ответе заданы и result, и error', { field, line });
        if (r.result) {
          const keys = ['json', 'text', 'file'].filter((x) => r.result![x as 'json'] !== undefined);
          if (keys.length !== 1) c.error(p.rel, 'В result нужно ровно одно из json, text, file', { field, line });
          if (r.result.file) {
            const fileRel = `data/${r.result.file}`;
            try {
              const text = await fsp.readFile(path.join(home, fileRel), 'utf8');
              dataFiles.push({ file: fileRel, hash: shortHash(text), text });
              r.result.fileContent = fileRel.endsWith('.json') ? JSON.parse(text) : text;
            } catch (e: any) {
              c.error(p.rel, `Файл ответа ${fileRel} не прочитан: ${e.message}`, { field, line, action: 'Добавьте файл в data/ или исправьте путь' });
            }
          }
        }
      }
      out[tool].push({
        id: s.id ?? `${tool}#${i + 1}`,
        tool,
        when: s.when,
        sequence: s.sequence,
        result: s.result,
        error: s.error,
        delayMs: s.delayMs,
        effect: s.effect,
        origin,
        index: i,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ сущности

async function loadCase(c: Collector, home: string, p: Parsed, contract: ContractDef | null): Promise<CaseDef | null> {
  if (!schemaCheck(c, p, caseSchema)) return null;
  const d = p.data;
  const dataFiles: Source[] = [];
  const tools = await normalizeStubs(c, home, p, d.tools ?? {}, 'case', 'tools', dataFiles);
  const ref = d.reference ?? {};
  const actions = ref.actions ?? {};
  const toAction = (a: any, i: number, prefix: string): ActionRequirement => ({
    id: a.id ?? `${prefix}-${i + 1}`,
    tool: a.tool,
    before: a.before,
    args: a.args,
    lesson: a.lesson,
    text: a.text,
  });
  const criteria: Criterion[] = (ref.criteria ?? []).map((x: any, i: number) => ({ id: x.id ?? `c${i + 1}`, text: x.text, hint: x.hint, lesson: x.lesson }));
  const cd: CaseDef = {
    id: d.id,
    title: d.title,
    topic: d.topic,
    tags: d.tags ?? [],
    situation: d.situation ?? '',
    start: d.start ?? {},
    facts: d.facts ?? [],
    state: d.state ?? {},
    tools,
    reference: {
      procedure: ref.procedure ?? [],
      answer: ref.answer ?? '',
      criteria,
      required: (actions.required ?? []).map((a: any, i: number) => toAction(a, i, 'required')),
      forbidden: (actions.forbidden ?? []).map((a: any, i: number) => toAction(a, i, 'forbidden')),
      final: actions.final ?? null,
      lessons: ref.lessons ?? [],
    },
    source: src(p),
    dataFiles,
  };
  const base = path.basename(p.rel).replace(/\.(ya?ml|json)$/, '');
  if (base !== cd.id) c.warn(p.rel, `Идентификатор «${cd.id}» не совпадает с именем файла`, { field: 'id', line: lineOf(p, ['id']) });
  if (contract) {
    const known = new Set(contract.tools.map((t) => t.name));
    for (const tool of Object.keys(tools)) {
      if (!known.has(tool)) c.warn(p.rel, `Инструмента «${tool}» нет в contracts/tools.json — агент его не увидит`, { field: `tools.${tool}`, line: lineOf(p, ['tools', tool]) });
    }
    const check = (a: ActionRequirement, field: string) => {
      for (const t of [a.tool, a.before].filter(Boolean) as string[]) {
        if (!known.has(t)) c.warn(p.rel, `Инструмента «${t}» нет в контракте`, { field });
      }
    };
    cd.reference.required.forEach((a, i) => check(a, `reference.actions.required[${i}]`));
    cd.reference.forbidden.forEach((a, i) => check(a, `reference.actions.forbidden[${i}]`));
    if (cd.reference.final && !known.has(cd.reference.final)) c.warn(p.rel, `Итоговое действие «${cd.reference.final}» отсутствует в контракте`, { field: 'reference.actions.final' });
  }
  const lessonIds = new Set(cd.reference.lessons.map((l) => l.id));
  for (const [i, a] of [...cd.reference.required, ...cd.reference.forbidden].entries()) {
    if (a.lesson && !lessonIds.has(a.lesson)) c.warn(p.rel, `Урок «${a.lesson}» не описан в reference.lessons`, { field: `reference.actions[${i}].lesson` });
  }
  if (!cd.reference.criteria.length) c.warn(p.rel, 'Нет критериев ответа: LLM-оценке нечего проверять', { field: 'reference.criteria' });
  return cd;
}

function loadSolution(c: Collector, p: Parsed): SolutionDef | null {
  if (!schemaCheck(c, p, solutionSchema)) return null;
  const d = p.data;
  const derived = p.rel.replace(/^solutions\//, '').replace(/\.(ya?ml|json)$/, '');
  return {
    id: d.id ?? derived,
    case: d.case,
    title: d.title ?? derived,
    goal: d.goal ?? '',
    operator: {
      instruction: d.operator.instruction,
      style: d.operator.style ?? null,
      seesToolResults: d.operator.seesToolResults !== false,
      lessons: d.operator.lessons ?? [],
    },
    limits: d.limits ?? {},
    source: src(p),
  };
}

function loadBasket(c: Collector, p: Parsed): BasketDef | null {
  if (!schemaCheck(c, p, basketSchema)) return null;
  const d = p.data;
  const items: BasketItem[] = [];
  (d.items ?? []).forEach((it: any, i: number) => {
    const field = `items[${i}]`;
    if (it.solution && it.curator !== undefined) c.error(p.rel, 'Элемент содержит и solution, и curator', { field, line: lineOf(p, ['items', i]) });
    else if (it.solution) items.push({ kind: 'solution', index: i, solution: it.solution, limits: it.limits ?? {}, note: it.note ?? '' });
    else if (it.curator !== undefined && it.curator !== false) items.push({ kind: 'curator', index: i, note: it.note ?? '' });
    else c.error(p.rel, 'Элемент корзины должен ссылаться на решение (solution) или быть шагом curator', { field, line: lineOf(p, ['items', i]) });
  });
  const cur = d.curator;
  const curator = {
    enabled: cur ? cur.enabled !== false : false,
    every: cur?.every ?? 0,
    final: cur?.final ?? false,
    resetBefore: cur?.resetBefore !== false,
  };
  if (d.type === 'checking') {
    if (cur && curator.enabled && (curator.every > 0 || curator.final)) {
      c.error(p.rel, 'В проверяющей корзине /skill-curator не запускается', { field: 'curator', line: lineOf(p, ['curator']), action: 'Уберите блок curator или смените тип корзины на training' });
    }
    items.forEach((it) => {
      if (it.kind === 'curator') c.error(p.rel, 'Шаг curator недопустим в проверяющей корзине', { field: `items[${it.index}]`, line: lineOf(p, ['items', it.index]) });
    });
    curator.enabled = false;
  }
  if (d.type === 'training' && d.checking) c.warn(p.rel, 'Блок checking действует только в проверяющей корзине', { field: 'checking' });
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    description: d.description ?? '',
    curator,
    checking: { confirmations: d.checking?.confirmations ?? 'approve' },
    items,
    source: src(p),
  };
}

async function loadAgent(c: Collector, home: string, p: Parsed): Promise<AgentDef | null> {
  if (!schemaCheck(c, p, agentSchema)) return null;
  const d = p.data;
  const r = d.request;
  let body: unknown = r.body ?? { text: '{{text}}' };
  let bodySource: string | null = null;
  if (typeof r.body === 'string') {
    bodySource = r.body;
    try {
      body = JSON.parse(await fsp.readFile(path.join(home, r.body), 'utf8'));
      c.files++;
    } catch (e: any) {
      c.error(p.rel, `Шаблон тела ${r.body} не прочитан: ${e.message}`, { field: 'request.body', line: lineOf(p, ['request', 'body']) });
    }
  }
  const sk = d.skills ?? { installer: 'none' };
  let skills: InstallerDef;
  if (sk.installer === 'directory') {
    if (!sk.root) c.error(p.rel, 'Для installer: directory нужен root', { field: 'skills.root' });
    skills = {
      kind: 'directory',
      root: sk.root ?? '',
      skillsDir: sk.skillsDir ?? 'skills/learned',
      pendingDir: sk.pendingDir ?? 'learning/cases/pending',
      reportsDir: sk.reportsDir ?? 'learning/reports',
    };
  } else if (sk.installer === 'http') {
    if (!sk.baseUrl) c.error(p.rel, 'Для installer: http нужен baseUrl', { field: 'skills.baseUrl' });
    skills = { kind: 'http', baseUrl: sk.baseUrl ?? '', headers: stringMap(sk.headers) };
  } else {
    skills = { kind: 'none', note: sk.note ?? 'Установка набора скиллов в агента не поддержана подключением' };
  }
  const mode = d.response.mode ?? 'sync';
  const ag: AgentDef = {
    id: d.id,
    title: d.title,
    kind: 'rest',
    request: {
      url: r.url,
      method: String(r.method ?? 'POST').toUpperCase(),
      headers: stringMap(r.headers),
      body,
      bodySource,
      textPath: r.textPath ?? null,
      taskIdHeader: (r.taskIdHeader ?? 'x-task-id').toLowerCase(),
      senderIdHeader: (r.senderIdHeader ?? 'x-a2a-sender-id').toLowerCase(),
      taskIdScope: r.taskIdScope ?? 'execution',
      timeoutMs: r.timeoutMs ?? null,
    },
    response: {
      mode,
      replyPath: d.response.replyPath,
      statusPath: d.response.statusPath ?? null,
      errorPath: d.response.errorPath ?? null,
      usage: {
        inputPath: d.response.usage?.inputPath ?? null,
        outputPath: d.response.usage?.outputPath ?? null,
        totalPath: d.response.usage?.totalPath ?? null,
      },
      sample: d.response.sample ?? null,
    },
    commands: { ...DEFAULT_COMMANDS, ...(d.commands ?? {}) },
    mcp: {
      contract: d.mcp?.contract ?? 'contracts/tools.json',
      protocolVersion: d.mcp?.protocolVersion ?? '2025-06-18',
      taskIdFrom: d.mcp?.taskIdFrom ?? ['header', 'meta', 'argument'],
    },
    model: { switch: d.model?.switch ?? 'none', path: d.model?.path ?? null, fixed: d.model?.fixed ?? null },
    sessions: { max: d.sessions?.max ?? 3 },
    skills,
    healthUrl: d.healthUrl ?? null,
    build: d.build ?? null,
    learningKit: d.learningKit ?? null,
    source: src(p),
  };
  if (mode !== 'sync') c.error(p.rel, `Тип ответа «${mode}» не поддержан: реализован только синхронный ответ`, { field: 'response.mode', line: lineOf(p, ['response', 'mode']) });
  if (ag.model.switch === 'request' && !ag.model.path) c.error(p.rel, 'Для model.switch: request нужен model.path — куда в теле запроса записать модель', { field: 'model.path' });
  if (!ag.request.textPath && !JSON.stringify(body).includes('{{text}}')) {
    c.error(p.rel, 'Не задано, куда поместить текст реплики: нужен request.textPath или {{text}} в шаблоне тела', { field: 'request.textPath' });
  }
  return ag;
}

function stringMap(v: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) out[k] = String(x);
  return out;
}

function loadModel(c: Collector, p: Parsed): ModelDef | null {
  if (!schemaCheck(c, p, modelSchema)) return null;
  const d = p.data;
  const m: ModelDef = {
    id: d.id,
    title: d.title ?? d.id,
    roles: d.roles,
    provider: d.provider,
    baseUrl: d.baseUrl ?? null,
    path: d.path ?? null,
    apiKey: d.apiKey ?? null,
    model: d.model ?? null,
    headers: stringMap(d.headers),
    tls: d.tls ? { cert: d.tls.cert ?? null, key: d.tls.key ?? null, pfx: d.tls.pfx ?? null, passphrase: d.tls.passphrase ?? null, ca: d.tls.ca ?? null } : null,
    params: d.params ?? {},
    description: d.description ?? '',
    source: src(p),
  };
  const llmRoles = m.roles.filter((r) => r !== 'agent');
  if (llmRoles.length && (m.provider === 'deployment' || m.provider === 'agent-request')) {
    c.error(p.rel, `Провайдер «${m.provider}» описывает модель агента и не подходит для ролей ${llmRoles.join(', ')}`, { field: 'provider' });
  }
  if (m.roles.includes('agent') && m.provider !== 'deployment' && m.provider !== 'agent-request') {
    c.error(p.rel, 'Модель агента задаётся развёртыванием (deployment) или параметром запроса агенту (agent-request)', { field: 'provider' });
  }
  if (m.provider === 'openai-compatible' && (!m.baseUrl || !m.model)) c.error(p.rel, 'Для openai-compatible нужны baseUrl и model', { field: 'baseUrl' });
  if (m.provider === 'anthropic' && !m.model) c.error(p.rel, 'Для anthropic нужно model', { field: 'model' });
  if (m.provider === 'anthropic' && m.params.temperature !== undefined) {
    c.warn(p.rel, 'temperature не передаётся в Anthropic Messages API: параметр больше не принимается', { field: 'params.temperature' });
  }
  if (m.provider === 'agent-request' && !m.model) c.error(p.rel, 'Для agent-request нужно model — значение, которое уйдёт агенту', { field: 'model' });
  const gigachat = m.provider === 'gigachat-v1' || m.provider === 'gigachat-v2';
  if (gigachat) {
    if (!m.baseUrl || !m.model) c.error(p.rel, `Для ${m.provider} нужны baseUrl и model`, { field: 'baseUrl' });
    if (m.params.responseFormat === 'json_object') c.error(p.rel, 'GigaChat не поддерживает json_object: используйте json_schema или none', { field: 'params.responseFormat' });
    if (m.params.temperature === 0) c.error(p.rel, 'GigaChat принимает temperature больше 0: уберите параметр или задайте, например, 0.01', { field: 'params.temperature' });
  }
  if (m.tls) {
    const t = m.tls;
    if (m.provider !== 'openai-compatible' && !gigachat) c.error(p.rel, `Клиентский сертификат поддерживается для openai-compatible и gigachat, а не для ${m.provider}`, { field: 'tls' });
    // Сертификат необязателен; если задан, то целиком. Только tls.ca — для https без клиентского сертификата.
    if (t.pfx && (t.cert || t.key)) c.error(p.rel, 'Укажите либо tls.cert и tls.key, либо tls.pfx', { field: 'tls' });
    else if (!t.pfx && !!t.cert !== !!t.key) c.error(p.rel, 'Для клиентского сертификата нужны оба файла: tls.cert и tls.key', { field: t.cert ? 'tls.key' : 'tls.cert' });
    if (t.passphrase && !hasEnvRef(t.passphrase)) c.warn(p.rel, 'Пароль ключа задайте ссылкой ${env:NAME}: файл настроек попадает в снимок прогона', { field: 'tls.passphrase' });
    const literalCert = [t.cert, t.key, t.pfx].some((x) => x && !hasEnvRef(x));
    if (literalCert && m.baseUrl && !hasEnvRef(m.baseUrl) && !m.baseUrl.startsWith('https://')) c.error(p.rel, 'Клиентский сертификат передаётся только по https', { field: 'baseUrl' });
  }
  if (m.apiKey && !hasEnvRef(m.apiKey)) c.warn(p.rel, 'Ключ задайте ссылкой ${env:NAME}: файл настроек попадает в снимок прогона', { field: 'apiKey' });
  return m;
}

async function loadSkillset(c: Collector, home: string, p: Parsed): Promise<SkillsetDef | null> {
  if (!schemaCheck(c, p, skillsetSchema)) return null;
  const d = p.data;
  const versions: SkillsetVersion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < d.versions.length; i++) {
    const v = d.versions[i];
    if (seen.has(v.id)) c.error(p.rel, `Версия ${v.id} описана дважды`, { field: `versions[${i}].id` });
    seen.add(v.id);
    const dir = path.join(home, 'skillsets', v.path);
    const files = await readTree(dir);
    if (!files.length) {
      c.error(p.rel, `В каталоге skillsets/${v.path} нет файлов скиллов`, { field: `versions[${i}].path`, line: lineOf(p, ['versions', i, 'path']), action: 'Положите файлы версии в каталог или исправьте путь' });
    }
    c.files += files.length;
    versions.push({
      id: v.id,
      skillset: d.id,
      createdAt: v.createdAt ?? null,
      origin: { kind: v.source?.kind ?? 'import', note: v.source?.note ?? '', from: v.source?.from ?? null, run: v.source?.run ?? null, line: null },
      status: 'ready',
      files,
      checksum: manifestChecksum(files),
      generated: false,
      dir,
    });
  }
  return {
    id: d.id,
    title: d.title,
    description: d.description ?? '',
    compatibility: { agent: d.compatibility?.agent ?? null, learningKit: d.compatibility?.learningKit ?? null },
    versions,
    source: src(p),
  };
}

/** Версии, полученные обучением, лежат в каталоге данных и не перезаписывают файлы настроек. */
async function loadGeneratedVersions(c: Collector, dataDir: string, skillsets: Map<string, SkillsetDef>): Promise<void> {
  const root = path.join(dataDir, 'skillsets');
  for (const sid of await listDirs(root)) {
    const set = skillsets.get(sid);
    for (const vid of await listDirs(path.join(root, sid))) {
      const meta = await readJsonIf<any>(path.join(root, sid, vid, 'version.json'));
      if (!meta) continue;
      if (!set) {
        c.warn(`var/skillsets/${sid}`, `Версия ${vid} относится к набору «${sid}», которого нет в skillsets/`);
        continue;
      }
      if (set.versions.some((v) => v.id === vid)) {
        c.error(`var/skillsets/${sid}/${vid}`, `Версия ${vid} уже описана в ${set.source.file}`);
        continue;
      }
      const dir = path.join(root, sid, vid, 'files');
      const files = await readTree(dir);
      set.versions.push({
        id: vid,
        skillset: sid,
        createdAt: meta.createdAt ?? null,
        origin: { kind: meta.origin?.kind ?? 'training', note: meta.origin?.note ?? '', from: meta.origin?.from ?? null, run: meta.origin?.run ?? null, line: meta.origin?.line ?? null },
        status: meta.status === 'partial' ? 'partial' : 'ready',
        files,
        checksum: manifestChecksum(files),
        generated: true,
        dir,
      });
    }
  }
  for (const s of skillsets.values()) s.versions.sort((a, b) => versionOrder(a.id) - versionOrder(b.id) || a.id.localeCompare(b.id));
}

export function versionOrder(id: string): number {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function loadMetrics(c: Collector, p: Parsed): MetricDef[] {
  if (!schemaCheck(c, p, metricsFileSchema)) return [];
  const list = p.data.metrics ?? [p.data];
  const out: MetricDef[] = [];
  list.forEach((m: any, i: number) => {
    const v: (x: unknown) => boolean = validator(metricSchema);
    if (!v(m)) return;
    if (!(BUILTIN_METRICS as readonly string[]).includes(m.builtin)) {
      c.error(p.rel, `Встроенного расчёта «${m.builtin}» нет. Доступны: ${BUILTIN_METRICS.join(', ')}`, { field: `metrics[${i}].builtin`, line: lineOf(p, ['metrics', i, 'builtin']) });
      return;
    }
    out.push({
      id: m.id,
      builtin: m.builtin,
      title: m.title ?? m.id,
      description: m.description ?? '',
      unit: m.unit ?? '',
      level: m.level ?? ['кейс'],
      needs: m.needs ?? '',
      params: m.params ?? {},
      version: m.version ?? 'v1',
      source: src(p),
    });
  });
  return out;
}

function loadRun(c: Collector, p: Parsed): RunConfigDef | null {
  if (!schemaCheck(c, p, runSchema)) return null;
  const d = p.data;
  let skillset: RunConfigDef['skillset'] = null;
  if (d.skillset === 'build') skillset = 'build';
  else if (isPlainObject(d.skillset)) skillset = { id: d.skillset.id, version: String(d.skillset.version) };
  if (d.startAt && Number.isNaN(Date.parse(d.startAt))) c.error(p.rel, 'startAt — не дата и время ISO 8601', { field: 'startAt' });
  return {
    id: d.id,
    title: d.title ?? d.id,
    basket: d.basket,
    agent: d.agent,
    models: { agent: d.models.agent ?? null, operator: d.models.operator ?? null, judge: d.models.judge ?? null },
    skillset,
    metrics: d.metrics === 'all' || d.metrics === undefined ? ['*'] : d.metrics,
    limits: { ...DEFAULT_LIMITS, ...(d.limits ?? {}) },
    repetitions: d.repetitions ?? 1,
    startAt: d.startAt ?? null,
    source: src(p),
  };
}

// ------------------------------------------------------------------ сборка

export async function loadRegistry(home: string, dataDir: string): Promise<Registry> {
  const c = new Collector();
  const contract = await loadContract(c, home);
  const reg: Registry = {
    home,
    loadedAt: new Date().toISOString(),
    contract,
    cases: new Map(),
    solutions: new Map(),
    baskets: new Map(),
    agents: new Map(),
    models: new Map(),
    skillsets: new Map(),
    metrics: new Map(),
    runs: new Map(),
    issues: c.issues,
    fileCount: 0,
  };

  const put = <T extends { id: string; source: Source }>(map: Map<string, T>, item: T | null, kind: string) => {
    if (!item) return;
    const prev = map.get(item.id);
    if (prev) {
      c.error(item.source.file, `${kind} с идентификатором «${item.id}» уже есть в ${prev.source.file}`, { field: 'id', action: 'Сделайте идентификаторы уникальными' });
      return;
    }
    map.set(item.id, item);
  };

  for (const rel of await listConfigFiles(home, 'cases')) {
    const p = await parseFile(c, home, rel);
    if (p) put(reg.cases, await loadCase(c, home, p, contract), 'Кейс');
  }
  for (const rel of await listConfigFiles(home, 'solutions', true)) {
    const p = await parseFile(c, home, rel);
    if (p) put(reg.solutions, loadSolution(c, p), 'Решение');
  }
  for (const rel of await listConfigFiles(home, 'baskets')) {
    const p = await parseFile(c, home, rel);
    if (p) put(reg.baskets, loadBasket(c, p), 'Корзина');
  }
  for (const rel of await listConfigFiles(home, 'agents')) {
    const p = await parseFile(c, home, rel);
    if (p) put(reg.agents, await loadAgent(c, home, p), 'Агент');
  }
  for (const rel of await listConfigFiles(home, 'models')) {
    const p = await parseFile(c, home, rel);
    if (p) put(reg.models, loadModel(c, p), 'Модель');
  }
  for (const rel of await listConfigFiles(home, 'skillsets')) {
    const p = await parseFile(c, home, rel);
    if (p) put(reg.skillsets, await loadSkillset(c, home, p), 'Набор скиллов');
  }
  await loadGeneratedVersions(c, dataDir, reg.skillsets);
  for (const rel of await listConfigFiles(home, 'metrics')) {
    const p = await parseFile(c, home, rel);
    if (p) for (const m of loadMetrics(c, p)) put(reg.metrics, m, 'Метрика');
  }
  for (const rel of await listConfigFiles(home, 'runs')) {
    const p = await parseFile(c, home, rel);
    if (p) put(reg.runs, loadRun(c, p), 'Настройка прогона');
  }

  crossCheck(c, reg);
  reg.fileCount = c.files;
  return reg;
}

/** Ссылки между файлами: решение → кейс, корзина → решения, прогон → корзина, агент, модели, набор, метрики. */
function crossCheck(c: Collector, reg: Registry): void {
  for (const s of reg.solutions.values()) {
    if (!reg.cases.has(s.case)) {
      c.error(s.source.file, `Кейс «${s.case}» не найден в cases/`, { field: 'case', action: 'Исправьте ссылку или добавьте файл кейса' });
    }
  }
  for (const b of reg.baskets.values()) {
    for (const it of b.items) {
      if (it.kind === 'solution' && !reg.solutions.has(it.solution)) {
        c.error(b.source.file, `Решение «${it.solution}» не найдено в solutions/`, {
          field: `items[${it.index}].solution`,
          action: 'Исправьте ссылку или добавьте файл решения, затем проверьте файлы снова',
        });
      }
    }
    if (!b.items.some((i) => i.kind === 'solution')) c.error(b.source.file, 'В корзине нет ни одного решения', { field: 'items' });
  }
  for (const r of reg.runs.values()) {
    if (!reg.baskets.has(r.basket)) c.error(r.source.file, `Корзина «${r.basket}» не найдена в baskets/`, { field: 'basket' });
    if (!reg.agents.has(r.agent)) c.error(r.source.file, `Агент «${r.agent}» не найден в agents/`, { field: 'agent' });
    for (const role of ['agent', 'operator', 'judge'] as const) {
      const mid = r.models[role];
      if (!mid) continue;
      const m = reg.models.get(mid);
      if (!m) c.error(r.source.file, `Модель «${mid}» не найдена в models/`, { field: `models.${role}` });
      else if (!m.roles.includes(role)) c.error(r.source.file, `Модель «${mid}» не предназначена для роли «${role}»`, { field: `models.${role}`, action: `Добавьте роль в ${m.source.file} или выберите другую модель` });
    }
    if (r.skillset && r.skillset !== 'build') {
      const want = r.skillset.version;
      const s = reg.skillsets.get(r.skillset.id);
      if (!s) c.error(r.source.file, `Набор скиллов «${r.skillset.id}» не найден в skillsets/`, { field: 'skillset.id' });
      else if (want !== 'latest' && !s.versions.some((v) => v.id === want)) {
        c.error(r.source.file, `Версии ${want} нет в наборе «${s.id}»`, { field: 'skillset.version' });
      }
    }
    for (const mid of r.metrics) {
      if (mid !== '*' && !reg.metrics.has(mid)) c.error(r.source.file, `Метрика «${mid}» не найдена в metrics/`, { field: 'metrics' });
    }
  }
}

export function issuesFor(reg: Registry, files: string[]): Issue[] {
  const set = new Set(files);
  return reg.issues.filter((i) => set.has(i.file));
}
