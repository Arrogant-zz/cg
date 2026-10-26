// Представления для интерфейса: собирают из реестра и результатов то, что показывают экраны дизайна.
import type { App } from '../app.js';
import type { CaseDef, Issue, StubDef } from '../config/types.js';
import { resolveEnvRefs } from '../config/loader.js';
import { buildPlan, describePlan } from '../runner/plan.js';
import { resolveRun, type RunOverrides } from '../runner/resolve.js';
import { computeRunMetrics } from '../metrics/builtins.js';
import type { RunRecord } from '../runner/types.js';
import { endpointOf, modelAuth, modelReadiness } from '../llm/provider.js';
import { diffTrees } from '../util/diff.js';
import { HttpError } from '../util/http.js';

export function issueCounts(issues: Issue[]) {
  return { errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length };
}

export function status(app: App) {
  const reg = app.registry;
  const agents = [...reg.agents.values()].map((a) => ({ id: a.id, title: a.title, ...(app.health.get(a.id) ?? { ok: null, note: 'проверка не выполнялась', at: null }) }));
  return {
    version: app.version,
    agents,
    sessions: { used: app.sessions.used, capacity: app.sessions.capacity, queued: app.sessions.queued, owners: app.sessions.owners() },
    config: { loadedAt: reg.loadedAt, files: reg.fileCount, ...issueCounts(reg.issues) },
    contract: reg.contract ? { version: reg.contract.version, conditional: reg.contract.conditional, tools: reg.contract.tools.length } : null,
    stand: app.stand.entries.slice(-30).reverse(),
    env: {
      mcpPath: app.env.mcpPath,
      mcpPort: app.env.mcpPort,
      agentMcpTimeoutMs: app.env.agentMcpTimeoutMs,
      unmatchedMode: app.env.unmatchedMode,
      allowedHosts: app.env.allowedHosts,
      senderPrefix: app.env.senderPrefix,
    },
  };
}

function describeWhen(when?: Record<string, unknown>): string {
  if (!when || !Object.keys(when).length) return '';
  return Object.entries(when)
    .map(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as any;
        if ('regex' in o) return `${k} ~ /${o.regex}/`;
        if ('in' in o) return `${k} ∈ ${JSON.stringify(o.in)}`;
        if ('exists' in o) return o.exists ? `${k} задан` : `${k} не задан`;
        if ('not' in o) return `${k} ≠ ${JSON.stringify(o.not)}`;
      }
      return `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`;
    })
    .join(', ');
}

function summarize(v: unknown): string {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 90 ? s.slice(0, 87) + '…' : s;
}

function stubRows(c: CaseDef) {
  const rows: any[] = [];
  const push = (s: StubDef, r: any, k: number | null) => {
    rows.push({
      tool: s.tool,
      id: s.id,
      when: describeWhen(s.when),
      call: k === null ? null : k + 1,
      kind: r.error !== undefined ? 'error' : 'result',
      summary: r.error !== undefined ? summarize(typeof r.error === 'string' ? r.error : r.error.message) : summarize(r.result?.json ?? r.result?.text ?? (r.result?.file ? `файл ${r.result.file}` : '')),
      delayMs: r.delayMs ?? 0,
      effect: r.effect ? describeWhen(r.effect).replace(/ = /g, ' → ') : '',
    });
  };
  for (const list of Object.values(c.tools)) {
    for (const s of list) {
      if (s.sequence?.length) s.sequence.forEach((r, k) => push(s, r, k));
      else push(s, s, null);
    }
  }
  return rows;
}

function solutionUsage(app: App, solutionId: string) {
  const out: any[] = [];
  for (const b of app.registry.baskets.values()) {
    let pos = 0;
    for (const it of b.items) {
      if (it.kind !== 'solution') continue;
      pos++;
      if (it.solution === solutionId) out.push({ basket: b.id, title: b.title, type: b.type, pos });
    }
  }
  return out;
}

export function cases(app: App) {
  const reg = app.registry;
  const list = [...reg.cases.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      title: c.title,
      topic: c.topic,
      tags: c.tags,
      file: c.source.file,
      solutions: [...reg.solutions.values()].filter((s) => s.case === c.id).length,
      ...issueCounts(reg.issues.filter((i) => i.file === c.source.file)),
    }));
  return { cases: list, solutions: reg.solutions.size, ...issueCounts(reg.issues.filter((i) => i.file.startsWith('cases/') || i.file.startsWith('solutions/') || i.file.startsWith('data/'))) };
}

export function caseDetail(app: App, id: string) {
  const reg = app.registry;
  const c = reg.cases.get(id);
  if (!c) throw new HttpError(404, `Кейс «${id}» не найден`);
  const solutions = [...reg.solutions.values()]
    .filter((s) => s.case === id)
    .map((s) => ({ id: s.id, title: s.title, goal: s.goal, instruction: s.operator.instruction, style: s.operator.style, seesToolResults: s.operator.seesToolResults, file: s.source.file, usage: solutionUsage(app, s.id), issues: reg.issues.filter((i) => i.file === s.source.file) }));
  const toolNames = new Set(reg.contract?.tools.map((t) => t.name) ?? []);
  return {
    id: c.id,
    title: c.title,
    topic: c.topic,
    tags: c.tags,
    situation: c.situation,
    start: c.start,
    facts: c.facts,
    state: c.state,
    file: c.source.file,
    hash: c.source.hash,
    stubs: stubRows(c),
    unknownStubTools: Object.keys(c.tools).filter((t) => !toolNames.has(t)),
    reference: {
      procedure: c.reference.procedure,
      answer: c.reference.answer,
      criteria: c.reference.criteria.map((x) => ({ id: x.id, text: x.text, lesson: x.lesson ?? null })),
      required: c.reference.required,
      forbidden: c.reference.forbidden,
      final: c.reference.final,
      lessons: c.reference.lessons,
    },
    solutions,
    issues: reg.issues.filter((i) => i.file === c.source.file || c.dataFiles.some((d) => d.file === i.file)),
    unmatchedMode: app.env.unmatchedMode,
  };
}

export function baskets(app: App) {
  const reg = app.registry;
  return [...reg.baskets.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((b) => ({ id: b.id, title: b.title, type: b.type, file: b.source.file, items: b.items.filter((i) => i.kind === 'solution').length, ...issueCounts(reg.issues.filter((i) => i.file === b.source.file)), firstError: reg.issues.find((i) => i.file === b.source.file && i.severity === 'error') ?? null }));
}

export function basketDetail(app: App, id: string) {
  const reg = app.registry;
  const b = reg.baskets.get(id);
  if (!b) throw new HttpError(404, `Корзина «${id}» не найдена`);
  const plan = buildPlan(b);
  let pos = 0;
  const items = b.items.map((it) => {
    if (it.kind === 'curator') return { kind: 'curator', index: it.index, note: it.note };
    pos++;
    const s = reg.solutions.get(it.solution);
    const after = plan.filter((p) => p.kind === 'curator' && p.afterPos === pos && p.reason !== 'explicit').map((p) => (p as any).reason);
    return { kind: 'solution', index: it.index, pos, solution: it.solution, title: s?.title ?? null, case: s?.case ?? null, missing: !s, capture: b.type === 'training', curatorAfter: after, note: it.note };
  });
  const runsUsing = [...reg.runs.values()].filter((r) => r.basket === id).map((r) => ({ id: r.id, file: r.source.file }));
  const lastRun = app.runs.list().find((r) => r.settings.basket.id === id) ?? null;
  return {
    id: b.id,
    title: b.title,
    type: b.type,
    description: b.description,
    file: b.source.file,
    curator: b.curator,
    checking: b.checking,
    plan,
    planText: describePlan(b, plan),
    items,
    runsUsing,
    lastRun: lastRun ? { id: lastRun.id, title: lastRun.title, status: lastRun.status } : null,
    issues: reg.issues.filter((i) => i.file === b.source.file),
  };
}

export function skillsets(app: App) {
  return [...app.registry.skillsets.values()].map((s) => ({
    id: s.id,
    title: s.title,
    file: s.source.file,
    versions: s.versions.map((v) => ({ id: v.id, generated: v.generated, status: v.status, origin: v.origin })),
    inRuns: app.runs
      .list()
      .filter((r) => r.status === 'running' && r.settings.skillset && r.settings.skillset !== 'build' && r.settings.skillset.id === s.id)
      .map((r) => ({ id: r.id, version: (r.settings.skillset as any).version })),
  }));
}

export function skillsetDetail(app: App, id: string) {
  const s = app.registry.skillsets.get(id);
  if (!s) throw new HttpError(404, `Набор «${id}» не найден`);
  const runs = app.runs.list().filter((r) => r.settings.skillset && r.settings.skillset !== 'build' && r.settings.skillset.id === id);
  const versions = s.versions.map((v) => {
    const from = v.origin.from ? s.versions.find((x) => x.id === v.origin.from) : null;
    const changes = from ? diffTrees(from.files, v.files, false) : null;
    return {
      id: v.id,
      generated: v.generated,
      status: v.status,
      createdAt: v.createdAt,
      origin: v.origin,
      checksum: v.checksum,
      files: v.files.map((f) => {
        const ch = changes?.find((c) => c.path === f.path) ?? null;
        return { path: f.path, sha256: f.sha256, size: f.size, change: ch ? { kind: ch.kind, added: ch.added, removed: ch.removed } : null };
      }),
      removed: changes?.filter((c) => c.kind === 'removed').map((c) => c.path) ?? [],
      checks: runs
        .filter((r) => r.type === 'checking' && (r.settings.skillset as any).version === v.id)
        .map((r) => ({ id: r.id, status: r.status, success: successOf(r) })),
      trainings: runs.filter((r) => r.type === 'training' && (r.settings.skillset as any).version === v.id).map((r) => ({ id: r.id, status: r.status, produced: r.lines.map((l) => l.skills.newVersion?.id).filter(Boolean) })),
    };
  });
  return { id: s.id, title: s.title, description: s.description, file: s.source.file, compatibility: s.compatibility, versions, issues: app.registry.issues.filter((i) => i.file === s.source.file) };
}

export function directory(app: App) {
  const reg = app.registry;
  const env = app.env.raw;
  const agents = [...reg.agents.values()].map((a) => {
    const url = resolveEnvRefs(a.request.url, env);
    return {
      id: a.id,
      title: a.title,
      file: a.source.file,
      request: {
        method: a.request.method,
        url: a.request.url,
        urlResolved: url.missing.length ? null : url.value,
        missing: url.missing,
        headers: Object.entries(a.request.headers).map(([k, v]) => ({ name: k, value: /\$\{env:/.test(v) ? v : /authorization|key|token/i.test(k) ? '***' : v })),
        body: a.request.bodySource ?? 'встроенный шаблон',
        textPath: a.request.textPath ?? '{{text}} в шаблоне',
        taskIdHeader: a.request.taskIdHeader,
        senderIdHeader: a.request.senderIdHeader,
        taskIdScope: a.request.taskIdScope,
      },
      response: a.response,
      commands: a.commands,
      mcp: a.mcp,
      model: a.model,
      sessions: a.sessions,
      skills: a.skills.kind === 'http' ? { kind: 'http', baseUrl: a.skills.baseUrl } : a.skills.kind === 'directory' ? { kind: 'directory', root: a.skills.root, skillsDir: a.skills.skillsDir } : { kind: 'none', note: a.skills.note },
      build: a.build,
      learningKit: a.learningKit,
      health: app.health.get(a.id) ?? null,
      issues: reg.issues.filter((i) => i.file === a.source.file),
      contractConditional: reg.contract?.conditional ?? true,
    };
  });
  const models = [...reg.models.values()].map((m) => ({
    id: m.id,
    title: m.title,
    roles: m.roles,
    provider: m.provider,
    model: m.model,
    baseUrl: m.baseUrl,
    endpoint: endpointOf(m),
    auth: modelAuth(m, env),
    params: m.params,
    description: m.description,
    file: m.source.file,
    readiness: modelReadiness(m, env),
    switching:
      m.provider === 'deployment' ? 'задаётся развёртыванием агента' : m.provider === 'agent-request' ? 'параметр запроса агенту' : 'параметр вызова ClawGym',
    issues: reg.issues.filter((i) => i.file === m.source.file),
  }));
  const metrics = [...reg.metrics.values()].map((m) => ({ id: m.id, builtin: m.builtin, title: m.title, description: m.description, unit: m.unit, level: m.level, needs: m.needs, params: m.params, version: m.version, file: m.source.file }));
  return { agents, models, metrics, tools: reg.contract?.tools ?? [], contract: reg.contract ? { file: reg.contract.source.file, version: reg.contract.version, conditional: reg.contract.conditional, errors: reg.contract.errors, startMessage: reg.contract.startMessage } : null };
}

export function runConfigs(app: App) {
  const reg = app.registry;
  return [...reg.runs.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => {
      const p = resolveRun(reg, app.env, r.id);
      const b = reg.baskets.get(r.basket);
      const last = app.runs.list().find((x) => x.configId === r.id) ?? null;
      const ss = r.skillset;
      return {
        id: r.id,
        title: r.title,
        file: r.source.file,
        basket: b ? { id: b.id, title: b.title, type: b.type, items: b.items.filter((i) => i.kind === 'solution').length } : { id: r.basket, title: r.basket, type: null, items: 0 },
        skillset: ss === 'build' ? 'стартовые скиллы сборки' : ss ? `${reg.skillsets.get(ss.id)?.title ?? ss.id} · ${ss.version}` : 'без набора',
        ok: p.ok,
        ...issueCounts(p.issues),
        lastRun: last ? { id: last.id, createdAt: last.createdAt, status: last.status } : null,
      };
    });
}

export function preview(app: App, id: string, overrides: RunOverrides) {
  const p = resolveRun(app.registry, app.env, id, overrides);
  const r = p.resolved;
  const queued = app.runs.list().filter((x) => x.status === 'queued' || x.status === 'running');
  return {
    ok: p.ok,
    issues: p.issues,
    plan: p.plan,
    planText: p.planText,
    metrics: p.metrics,
    files: p.involvedFiles.length,
    queueAhead: queued.map((x) => ({ id: x.id, title: x.title, status: x.status })),
    sessions: { used: app.sessions.used, capacity: app.sessions.capacity },
    overrides,
    resolved: r
      ? {
          title: r.config.title,
          file: r.config.source.file,
          basket: { id: r.basket.id, title: r.basket.title, type: r.basket.type, file: r.basket.source.file, items: r.items.filter((i) => i.kind === 'solution').length, cases: new Set(r.items.map((i) => i.caseDef?.id).filter(Boolean)).size },
          agent: { id: r.agent.id, title: r.agent.title, file: r.agent.source.file, commands: r.agent.commands, installer: r.agent.skills.kind },
          agentModel: r.agentModel,
          operator: r.models.operator ? { id: r.models.operator.id, title: r.models.operator.title, provider: r.models.operator.provider } : null,
          judge: r.models.judge ? { id: r.models.judge.id, title: r.models.judge.title, provider: r.models.judge.provider } : null,
          skillset:
            r.skillset === 'build'
              ? 'build'
              : r.skillset
                ? { id: r.skillset.set.id, title: r.skillset.set.title, version: r.skillset.version.id, requested: r.skillset.requested, files: r.skillset.version.files.length, nextVersion: null }
                : null,
          items: r.items.map((i) => ({ index: i.index, kind: i.kind, pos: i.pos, solution: i.solution?.id ?? null, title: i.solution?.title ?? null, case: i.caseDef?.id ?? null })),
          limits: r.limits,
          repetitions: r.repetitions,
          startAt: r.startAt,
        }
      : null,
  };
}

function successOf(r: RunRecord) {
  const items = r.lines.flatMap((l) => l.items.filter((i) => i.kind === 'case'));
  const ev = items.filter((i) => i.outcome === 'passed' || i.outcome === 'failed');
  return { passed: ev.filter((i) => i.outcome === 'passed').length, evaluated: ev.length };
}

export function runListItem(r: RunRecord) {
  const items = r.lines.flatMap((l) => l.items.filter((i) => i.kind === 'case'));
  const line = r.lines.find((l) => l.status === 'running') ?? r.lines[0];
  const cur = line?.current;
  const curItem = cur ? line.items.find((i) => i.index === cur.index) : null;
  const total = line ? line.items.filter((i) => i.kind === 'case').length : 0;
  const done = line ? line.items.filter((i) => i.kind === 'case' && i.outcome).length : 0;
  const ss = r.settings.skillset;
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    error: r.error,
    configId: r.configId,
    configFile: r.configFile,
    createdAt: r.createdAt,
    startAt: r.startAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    skillset: ss === 'build' ? { label: 'стартовые скиллы сборки', version: null } : ss ? { label: ss.title, version: ss.version } : null,
    newVersions: r.lines.map((l) => l.skills.newVersion).filter(Boolean),
    models: { agent: r.settings.agentModel.title, operator: r.settings.operator?.id ?? null, judge: r.settings.judge?.id ?? null },
    bar: (line?.items ?? []).filter((i) => i.kind === 'case').map((i) => (i.status === 'running' ? 'live' : i.outcome === 'passed' ? 'ok' : i.outcome === 'failed' ? 'no' : i.outcome === 'technical' ? 'tech' : i.outcome === 'not_evaluated' ? 'na' : '')),
    progress: { done, total, phase: cur?.phase ?? null, pos: curItem?.pos ?? null, turns: null as number | null },
    success: successOf(r),
    tech: items.filter((i) => i.outcome === 'technical').length,
    notEvaluated: items.filter((i) => i.outcome === 'not_evaluated').length,
    notStarted: items.filter((i) => i.status === 'not_started').length,
    repetitions: r.lines.length,
  };
}

export function runDetail(r: RunRecord) {
  return { ...r, summary: r.status === 'running' || !r.summary ? computeRunMetrics(r) : r.summary };
}
