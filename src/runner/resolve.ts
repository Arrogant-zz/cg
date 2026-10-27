// Полная конфигурация прогона до запуска (RUN-01, CFG-02, AG-03, MOD-02, MET-02):
// разрешённые ссылки, совместимость агента, моделей и метрик, план команд. Ошибка — запуск недоступен.
import type {
  AgentDef,
  BasketDef,
  CaseDef,
  Issue,
  Limits,
  MetricDef,
  ModelDef,
  Registry,
  RunConfigDef,
  SkillsetDef,
  SkillsetVersion,
  SolutionDef,
} from '../config/types.js';
import { hasEnvRef, resolveEnvRefs } from '../config/loader.js';
import type { Env } from '../env.js';
import { checkAllowedHost } from '../agent/client.js';
import { modelReadiness } from '../llm/provider.js';
import { findVersion } from '../skillsets/store.js';
import { buildPlan, describePlan, type PlanStep } from './plan.js';

export interface ResolvedItem {
  index: number;
  kind: 'solution' | 'curator';
  pos: number | null;
  solution: SolutionDef | null;
  caseDef: CaseDef | null;
  limits: Limits;
  note: string;
}

export interface MetricAvailability {
  id: string;
  title: string;
  builtin: string;
  available: boolean;
  source: string;
  reason: string;
}

export interface ResolvedRun {
  config: RunConfigDef;
  basket: BasketDef;
  items: ResolvedItem[];
  agent: AgentDef;
  models: { agent: ModelDef | null; operator: ModelDef | null; judge: ModelDef | null };
  agentModel: { value: string | null; title: string; note: string; switchable: boolean };
  skillset: { set: SkillsetDef; version: SkillsetVersion; requested: string } | 'build' | null;
  metrics: MetricDef[];
  limits: Limits;
  repetitions: number;
  startAt: string | null;
}

export interface RunPreview {
  ok: boolean;
  issues: Issue[];
  resolved: ResolvedRun | null;
  plan: PlanStep[];
  planText: string[];
  metrics: MetricAvailability[];
  involvedFiles: string[];
}

export interface RunOverrides {
  skillsetVersion?: string;
}

export function resolveRun(reg: Registry, env: Env, runId: string, overrides: RunOverrides = {}): RunPreview {
  const issues: Issue[] = [];
  const cfg = reg.runs.get(runId);
  const empty: RunPreview = { ok: false, issues, resolved: null, plan: [], planText: [], metrics: [], involvedFiles: [] };
  if (!cfg) {
    issues.push({ severity: 'error', file: `runs/${runId}.yaml`, reason: `Настройка прогона «${runId}» не найдена или не загрузилась`, action: 'Проверьте файл в runs/' });
    return empty;
  }
  const err = (file: string, reason: string, field?: string, action?: string) => issues.push({ severity: 'error', file, reason, field, action });
  const warn = (file: string, reason: string, field?: string) => issues.push({ severity: 'warning', file, reason, field });
  const files = new Set<string>([cfg.source.file]);
  if (reg.contract) files.add(reg.contract.source.file);
  if (!reg.contract) err('contracts/tools.json', 'Контракт инструментов не загружен — агенту нечего отдать как MCP-сервер');

  const basket = reg.baskets.get(cfg.basket) ?? null;
  const agent = reg.agents.get(cfg.agent) ?? null;
  if (basket) files.add(basket.source.file);
  if (agent) {
    files.add(agent.source.file);
    if (agent.request.bodySource) files.add(agent.request.bodySource);
  }

  // Элементы корзины с решениями и кейсами.
  const items: ResolvedItem[] = [];
  let pos = 0;
  for (const it of basket?.items ?? []) {
    if (it.kind === 'curator') {
      items.push({ index: it.index, kind: 'curator', pos: null, solution: null, caseDef: null, limits: cfg.limits, note: it.note });
      continue;
    }
    pos++;
    const solution = reg.solutions.get(it.solution) ?? null;
    const caseDef = solution ? reg.cases.get(solution.case) ?? null : null;
    if (solution) files.add(solution.source.file);
    if (caseDef) {
      files.add(caseDef.source.file);
      for (const d of caseDef.dataFiles) files.add(d.file);
    }
    items.push({
      index: it.index,
      kind: 'solution',
      pos,
      solution,
      caseDef,
      limits: { ...cfg.limits, ...(solution?.limits ?? {}), ...it.limits },
      note: it.note,
    });
  }

  // Модели по ролям (MOD-01) и реальное переключение модели агента (MOD-02).
  const pick = (role: 'agent' | 'operator' | 'judge') => (cfg.models[role] ? reg.models.get(cfg.models[role]!) ?? null : null);
  const models = { agent: pick('agent'), operator: pick('operator'), judge: pick('judge') };
  for (const m of Object.values(models)) if (m) files.add(m.source.file);
  if (!cfg.models.operator) err(cfg.source.file, 'Не выбрана модель LLM-оператора: автоматическое решение кейсов невозможно', 'models.operator');
  for (const role of ['operator', 'judge'] as const) {
    const m = models[role];
    if (!m) continue;
    const r = modelReadiness(m, env.raw);
    if (r) err(m.source.file, `Модель ${role === 'operator' ? 'оператора' : 'оценки'} «${m.id}»: ${r}`, 'model', 'Задайте переменные окружения или выберите другую модель');
  }
  if (!cfg.models.judge) warn(cfg.source.file, 'Не выбрана модель оценки: смысл ответа останется «не оценён», итоговый успех не будет посчитан', 'models.judge');

  let agentModel = { value: null as string | null, title: '—', note: '', switchable: false };
  if (agent) {
    if (agent.model.switch === 'none') {
      const fixed = agent.model.fixed;
      agentModel = { value: null, title: fixed ?? 'задана развёртыванием', note: 'Стенд не переключает модель агента запросом, выбор недоступен', switchable: false };
      if (models.agent) {
        if (models.agent.provider !== 'deployment' || (fixed && models.agent.id !== fixed && models.agent.model !== fixed)) {
          err(cfg.source.file, `Подключение «${agent.id}» не переключает модель агента: выбор «${models.agent.id}» не повлияет на вызов`, 'models.agent', 'Уберите models.agent или укажите модель развёртывания');
        } else agentModel.title = models.agent.title;
      }
    } else {
      if (!models.agent) err(cfg.source.file, 'Подключение переключает модель параметром запроса: выберите models.agent', 'models.agent');
      else if (models.agent.provider !== 'agent-request') err(models.agent.source.file, 'Для переключения запросом нужна модель с provider: agent-request', 'provider');
      else agentModel = { value: models.agent.model, title: models.agent.title, note: `значение «${models.agent.model}» в ${agent.model.path}`, switchable: true };
    }
  }

  // Подключение агента: адрес, хост, команды, контракт (AG-01–03).
  if (agent) {
    const url = resolveEnvRefs(agent.request.url, env.raw);
    if (url.missing.length) err(agent.source.file, `Не заданы переменные окружения адреса агента: ${url.missing.join(', ')}`, 'request.url', 'Задайте переменные окружения стенда');
    else {
      const h = checkAllowedHost(url.value, env.allowedHosts);
      if (h) err(agent.source.file, h, 'request.url', 'Добавьте хост стенда в AGENT_ALLOWED_HOSTS');
    }
    for (const [k, v] of Object.entries(agent.request.headers)) {
      if (hasEnvRef(v) && resolveEnvRefs(v, env.raw).missing.length) err(agent.source.file, `Не задан секрет для заголовка ${k}`, `request.headers.${k}`, 'Задайте переменную окружения');
    }
    if (agent.response.mode !== 'sync') err(agent.source.file, `Тип ответа «${agent.response.mode}» не поддержан`, 'response.mode');
    if (basket?.type === 'training') {
      if (!agent.commands.capture.trim()) err(agent.source.file, 'Подключение не поддерживает /case-capture, а корзина обучающая', 'commands.capture');
      if (basket.curator.enabled && !agent.commands.curator.trim()) err(agent.source.file, 'Подключение не поддерживает /skill-curator, а корзина его запускает', 'commands.curator');
    }
    if (!agent.commands.reset.trim()) err(agent.source.file, '/reset обязателен перед каждым кейсом, а команда не задана', 'commands.reset');
    if (agent.mcp.contract !== reg.contract?.source.file) err(agent.source.file, `Подключение ожидает контракт ${agent.mcp.contract}, загружен ${reg.contract?.source.file ?? '—'}`, 'mcp.contract');
    if (cfg.repetitions > agent.sessions.max) warn(cfg.source.file, `Повторений ${cfg.repetitions}, а агент выдерживает ${agent.sessions.max} сессии: часть пойдёт по очереди`, 'repetitions');
  }

  // Набор скиллов (SK-03): выбранная версия либо стартовые скиллы сборки.
  let skillset: ResolvedRun['skillset'] = null;
  const ss = cfg.skillset;
  if (ss === 'build') {
    skillset = 'build';
    warn(cfg.source.file, 'Стартовые скиллы сборки агента: промежуточный режим, выбор знаний не выполняется', 'skillset');
  } else if (ss) {
    const want = overrides.skillsetVersion ?? ss.version;
    const found = findVersion(reg, ss.id, want);
    if (!found) err(cfg.source.file, `Версия ${want} набора «${ss.id}» не найдена`, 'skillset');
    else {
      files.add(found.set.source.file);
      skillset = { set: found.set, version: found.version, requested: want };
      if (found.version.status !== 'ready') err(cfg.source.file, `Версия ${found.version.id} сохранена как частичная и не годится для прогона`, 'skillset.version');
      if (agent && agent.skills.kind === 'none') err(agent.source.file, `Агент не умеет устанавливать набор скиллов: ${agent.skills.note}`, 'skills.installer', 'Выберите skillset: build или подключение с установкой набора');
      if (found.set.compatibility.agent && agent && found.set.compatibility.agent !== agent.id) warn(found.set.source.file, `Набор помечен совместимым с агентом «${found.set.compatibility.agent}»`, 'compatibility.agent');
    }
  }

  // Метрики и доступность их источников (MET-02).
  const all = [...reg.metrics.values()];
  const metrics = cfg.metrics.includes('*') ? all : cfg.metrics.map((id) => reg.metrics.get(id)).filter((m): m is MetricDef => !!m);
  for (const m of metrics) files.add(m.source.file);
  const availability = metrics.map((m) => availabilityOf(m, { basket, agent, models, skillset }));

  // Кейсы и решения корзины.
  for (const it of items) {
    if (it.kind !== 'solution') continue;
    if (!it.solution) continue;
    if (!it.caseDef) continue;
    if (!it.caseDef.reference.criteria.length && cfg.models.judge) warn(it.caseDef.source.file, 'У кейса нет критериев ответа — LLM-оценка пропускается', 'reference.criteria');
  }

  // Ошибки самих файлов, участвующих в прогоне.
  for (const i of reg.issues) if (files.has(i.file) && !issues.some((x) => x.file === i.file && x.reason === i.reason && x.field === i.field)) issues.push(i);

  const plan = basket ? buildPlan(basket) : [];
  const ok = !issues.some((i) => i.severity === 'error') && !!basket && !!agent && items.every((i) => i.kind === 'curator' || (i.solution && i.caseDef));
  const resolved: ResolvedRun | null =
    basket && agent
      ? {
          config: cfg,
          basket,
          items,
          agent,
          models,
          agentModel,
          skillset,
          metrics,
          limits: cfg.limits,
          repetitions: cfg.repetitions,
          startAt: cfg.startAt,
        }
      : null;
  return { ok, issues, resolved, plan, planText: basket ? describePlan(basket, plan) : [], metrics: availability, involvedFiles: [...files].sort() };
}

function availabilityOf(
  m: MetricDef,
  ctx: { basket: BasketDef | null; agent: AgentDef | null; models: ResolvedRun['models']; skillset: ResolvedRun['skillset'] },
): MetricAvailability {
  const base = { id: m.id, title: m.title, builtin: m.builtin };
  const checking = ctx.basket?.type === 'checking';
  const canExport = !!ctx.agent && ctx.agent.skills.kind !== 'none';
  switch (m.builtin) {
    case 'action-checks':
      return { ...base, available: true, source: 'журнал инструментов', reason: '' };
    case 'answer-quality':
      return ctx.models.judge ? { ...base, available: true, source: 'LLM-оценка', reason: '' } : { ...base, available: false, source: 'LLM-оценка', reason: 'не выбрана модель оценки' };
    case 'success':
      return { ...base, available: true, source: 'обе проверки', reason: ctx.models.judge ? '' : 'без модели оценки кейсы останутся «не оценены»' };
    case 'corrections':
    case 'repeated-corrections':
      return checking ? { ...base, available: false, source: 'разметка оператора', reason: 'в проверке поправок нет' } : { ...base, available: true, source: 'разметка оператора', reason: '' };
    case 'rejected-actions':
      return { ...base, available: true, source: 'подтверждения', reason: '' };
    case 'unexpected-tools':
      return { ...base, available: true, source: 'вызовы без заглушки', reason: '' };
    case 'turns-duration':
      return { ...base, available: true, source: 'метки времени по ролям', reason: '' };
    case 'tokens': {
      const u = ctx.agent?.response.usage;
      const agentHas = !!(u && (u.inputPath || u.outputPath || u.totalPath));
      return agentHas
        ? { ...base, available: true, source: 'usage в ответах', reason: '' }
        : { ...base, available: false, source: 'usage в ответах', reason: 'у агента нет usage в ответе; токены оператора и судьи — если их отдаёт провайдер' };
    }
    case 'skill-changes':
      if (!canExport) return { ...base, available: false, source: 'файлы набора', reason: 'подключение не выгружает файлы скиллов' };
      if (checking) return { ...base, available: true, source: 'файлы набора до и после', reason: 'в проверке — контроль неизменности' };
      return { ...base, available: true, source: 'после каждого curator', reason: '' };
    case 'operator-errors':
      return { ...base, available: true, source: 'вызовы LLM-оператора', reason: '' };
    case 'final-action':
      return { ...base, available: true, source: 'журнал инструментов и эталонный класс', reason: '' };
    case 'tools-f1':
      return { ...base, available: true, source: 'журнал инструментов и эталонный набор', reason: '' };
    case 'answer-match':
    case 'case-score':
      return ctx.models.judge
        ? { ...base, available: true, source: 'LLM-оценка по эталонному тексту', reason: '' }
        : { ...base, available: false, source: 'LLM-оценка по эталонному тексту', reason: 'не выбрана модель оценки' };
  }
}
