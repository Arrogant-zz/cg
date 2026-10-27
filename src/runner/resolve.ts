// Полная конфигурация прогона до запуска (RUN-01, CFG-02, AG-03, MET-02):
// разрешённые ссылки, совместимость агента, моделей и метрик, тестовый оператор, план команд. Ошибка — запуск недоступен.
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
  SolutionDef,
} from '../config/types.js';
import { hasEnvRef, resolveEnvRefs } from '../config/loader.js';
import type { Env } from '../env.js';
import { checkAllowedHost } from '../agent/client.js';
import { modelReadiness } from '../llm/provider.js';
import { plural } from '../util/core.js';
import { buildPlan, describePlan, type PlanStep } from './plan.js';
import type { OperatorStep, RunRecord } from './types.js';

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
  models: { operator: ModelDef | null; judge: ModelDef | null };
  /** Тестовый оператор: новый — стартовые скиллы сборки агента; продолжение — скиллы, полученные в прошлом прогоне. */
  operator: { mode: 'new' } | { mode: 'continue'; source: RunRecord; lines: { senderId: string; history: OperatorStep[] }[] };
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
  /** Номер прогона, на чьём тестовом операторе продолжить, или new — новый оператор; по умолчанию — continueFrom из файла. */
  continueFrom?: number | 'new';
}

const FINISHED = new Set(['completed', 'stopped']);

export function resolveRun(reg: Registry, env: Env, runId: string, overrides: RunOverrides = {}, runs: RunRecord[] = []): RunPreview {
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

  // Модели оператора и оценки (MOD-01). Модель агента задана его сборкой: ClawGym её не переключает.
  const pick = (role: 'operator' | 'judge') => (cfg.models[role] ? reg.models.get(cfg.models[role]!) ?? null : null);
  const models = { operator: pick('operator'), judge: pick('judge') };
  for (const m of Object.values(models)) if (m) files.add(m.source.file);
  if (!cfg.models.operator) err(cfg.source.file, 'Не выбрана модель LLM-оператора: автоматическое решение кейсов невозможно', 'models.operator');
  for (const role of ['operator', 'judge'] as const) {
    const m = models[role];
    if (!m) continue;
    const r = modelReadiness(m, env.raw);
    if (r) err(m.source.file, `Модель ${role === 'operator' ? 'оператора' : 'оценки'} «${m.id}»: ${r}`, 'model', 'Задайте переменные окружения или выберите другую модель');
  }
  if (!cfg.models.judge) warn(cfg.source.file, 'Не выбрана модель оценки: смысл ответа останется «не оценён», итоговый успех не будет посчитан', 'models.judge');

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

  // Тестовый оператор (решение владельца от 27.10.2026). Скиллы живут в агенте у оператора (x-a2a-sender-id) и меняются только
  // сборкой или обучением. Новый оператор начинает со стартовых скиллов сборки; продолжение получает то, чему оператор научился раньше.
  let operator: ResolvedRun['operator'] = { mode: 'new' };
  const want = overrides.continueFrom ?? (cfg.continueFrom ? 'config' : 'new');
  if (want !== 'new') {
    const source =
      want === 'config'
        ? (runs.filter((x) => x.configId === cfg.continueFrom && FINISHED.has(x.status)).sort((a, b) => b.id - a.id)[0] ?? null)
        : (runs.find((x) => x.id === want) ?? null);
    if (!source) {
      if (want === 'config') err(cfg.source.file, `Нет завершённого прогона «${cfg.continueFrom}»: продолжать не на ком`, 'continueFrom', 'Сначала запустите его или выберите при запуске нового тестового оператора');
      else err(cfg.source.file, `Прогон #${want} для продолжения не найден`, 'continueFrom');
    } else {
      const lines = source.lines.slice(0, cfg.repetitions);
      const busy = runs.find((x) => (x.status === 'queued' || x.status === 'running') && x.lines.some((l) => lines.some((s) => s.senderId && s.senderId === l.senderId)));
      if (!FINISHED.has(source.status)) err(cfg.source.file, `Прогон #${source.id} не завершён: продолжить можно только завершённый или остановленный`, 'continueFrom');
      else if (agent && source.settings.agent.id !== agent.id) err(cfg.source.file, `Оператор прогона #${source.id} работал с агентом «${source.settings.agent.id}»: его скиллы остались там`, 'continueFrom');
      else if (source.lines.length < cfg.repetitions) err(cfg.source.file, `В прогоне #${source.id} ${source.lines.length} ${plural(source.lines.length, 'линия', 'линии', 'линий')}, а повторений ${cfg.repetitions}: каждой линии нужен свой оператор`, 'repetitions');
      else if (lines.some((l) => !l.senderId)) err(cfg.source.file, `Линия прогона #${source.id} не начиналась — у неё нет тестового оператора`, 'continueFrom');
      else if (busy) err(cfg.source.file, `Оператор прогона #${source.id} занят прогоном #${busy.id}`, 'continueFrom', 'Дождитесь его завершения');
      else {
        if (source.status === 'stopped') warn(cfg.source.file, `Прогон #${source.id} остановлен: скиллы оператора — на момент остановки`, 'continueFrom');
        const step = (index: number): OperatorStep => ({ run: source.id, title: source.title, type: source.type, line: index });
        operator = { mode: 'continue', source, lines: lines.map((l) => ({ senderId: l.senderId, history: [...(l.history ?? []), step(l.index)] })) };
      }
    }
  }

  // Метрики и доступность их источников (MET-02).
  const all = [...reg.metrics.values()];
  const metrics = cfg.metrics.includes('*') ? all : cfg.metrics.map((id) => reg.metrics.get(id)).filter((m): m is MetricDef => !!m);
  for (const m of metrics) files.add(m.source.file);
  const availability = metrics.map((m) => availabilityOf(m, { basket, agent, models }));

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
          operator,
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
  ctx: { basket: BasketDef | null; agent: AgentDef | null; models: ResolvedRun['models'] },
): MetricAvailability {
  const base = { id: m.id, title: m.title, builtin: m.builtin };
  const checking = ctx.basket?.type === 'checking';
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
