// fake-agent: упрощённый «Pagurus» для офлайн-разработки ClawGym. Не модель, а сценарий:
// процедуру берёт из прикладных скиллов своей тематики, учится на поправках оператора,
// /case-capture пишет pending-кейс, /skill-curator переносит поправки в SKILL.md.
// Строки результата — по INTEGRATION.md, чтобы проверять их разбор.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ------------------------------------------------------------ разговорник

type Args = Record<string, unknown>;
type Rule = { kind: 'call'; tool: string; args: Args; before?: string } | { kind: 'answer'; text: string } | { kind: 'skip'; tools: string[] };

interface Phrase {
  re: RegExp;
  rule: Rule | 'quote';
}

/**
 * Порядок важен: первая подходящая фраза строки побеждает. Инструменты и аргументы — из tools/list стенда оркестратора;
 * {{ключ}} берётся из фактов: JSON стартового сообщения и ответов инструментов, {{answer}} — текущий ответ клиенту.
 */
export const PHRASEBOOK: Phrase[] = [
  { re: /ответить клиенту.*«([^»]+)»/iu, rule: 'quote' },
  // СберСпасибо
  { re: /основн\S* информаци\S* Спасибо/iu, rule: { kind: 'call', tool: 'get_spasibo_general_info', args: {} } },
  { re: /истори\S* операций (Сбер)?Спасибо/iu, rule: { kind: 'call', tool: 'get_spasibo_history_info', args: { dateFrom: '{{periodFrom}}', dateTo: '{{periodTo}}' }, before: 'get_close_with_answer' } },
  { re: /ожида\S* подтверждени\S* (покупки )?партн/iu, rule: { kind: 'answer', text: 'Бонусы за эту покупку ожидают подтверждения партнёром и будут начислены после него.' } },
  // Карты: оспаривание операции
  { re: /информаци\S* о картах/iu, rule: { kind: 'call', tool: 'get_client_cards', args: {} } },
  { re: /истори\S* операций по карте/iu, rule: { kind: 'call', tool: 'get_card_history', args: { fromDate: '{{operationFrom}}', toDate: '{{operationTo}}', id: '{{cardId}}' }, before: 'create_expertise' } },
  // Запрет из поправки: ветка экспертизы выпадает из плана целиком. Стоит раньше «выставить экспертизу».
  { re: /экспертиз\S* не выставля|не выставля\S* экспертиз/iu, rule: { kind: 'skip', tools: ['get_stages_expertise', 'create_expertise', 'postpone_expertises'] } },
  { re: /этап\S* экспертиз/iu, rule: { kind: 'call', tool: 'get_stages_expertise', args: { pageNumber: 0 } } },
  { re: /выстав\S* экспертиз/iu, rule: { kind: 'call', tool: 'create_expertise', args: { request: { expertiseDescription: 'Клиент не узнаёт операцию по карте и оспаривает её', stageCode: '{{code}}', stageName: '{{name}}' } } } },
  { re: /срок рассмотрения|до 30 дней/iu, rule: { kind: 'answer', text: 'Срок рассмотрения — до 30 дней.' } },
  { re: /отложить кейс до выполнения экспертиз/iu, rule: { kind: 'call', tool: 'postpone_expertises', args: {} } },
  // Уведомления
  { re: /каналы уведомлений по кейсу/iu, rule: { kind: 'call', tool: 'get_channel_cases', args: {} } },
  { re: /уведомления клиента за период/iu, rule: { kind: 'call', tool: 'get_smsbank_notifications', args: { fromDate: '{{notificationsFrom}}', toDate: '{{notificationsTo}}' } } },
  {
    re: /сменить канал уведомлений/iu,
    rule: { kind: 'call', tool: 'change_notifications_channel_for_case', args: { request: { channelCode: 'SMS', commandType: 'UPDATE', contact: '{{newContact}}', previousChannelCode: 'EMAIL', previousContact: '{{oldContact}}' } } },
  },
  // Закрытие с ответом клиенту
  { re: /закрыть кейс с ответом/iu, rule: { kind: 'call', tool: 'get_close_with_answer', args: { request: { shortAnswer: '{{answer}}', extendedAnswer: '{{answer}}' } } } },
];

export function rulesOf(text: string): Rule[] {
  const out: Rule[] = [];
  for (const raw of text.split(/\r?\n|(?<=[.!])\s+/)) {
    const line = raw.trim();
    if (!line) continue;
    for (const p of PHRASEBOOK) {
      const m = p.re.exec(line);
      if (!m) continue;
      out.push(p.rule === 'quote' ? { kind: 'answer', text: m[1].trim() } : p.rule);
      break;
    }
  }
  return out;
}

type Step = { kind: 'call'; tool: string; args: Args } | { kind: 'answer'; parts: string[] };

export function buildPlan(rules: Rule[]): Step[] {
  // Запрет сильнее процедуры: инструменты выпадают, где бы ни стояли в скилле.
  const skipped = new Set(rules.flatMap((r) => (r.kind === 'skip' ? r.tools : [])));
  const steps: Step[] = [];
  const answer: Step = { kind: 'answer', parts: [] };
  const later: Extract<Rule, { kind: 'call' }>[] = [];
  for (const r of rules) {
    if (r.kind === 'skip' || (r.kind === 'call' && skipped.has(r.tool))) continue;
    if (r.kind === 'answer') {
      if (!answer.parts.includes(r.text)) answer.parts.push(r.text);
      if (!steps.includes(answer)) steps.push(answer);
    } else if (r.before) later.push(r);
    else if (!steps.some((s) => s.kind === 'call' && s.tool === r.tool)) steps.push({ kind: 'call', tool: r.tool, args: r.args });
  }
  for (const r of later) {
    if (steps.some((s) => s.kind === 'call' && s.tool === r.tool)) continue;
    const at = steps.findIndex((s) => s.kind === 'call' && s.tool === r.before);
    const step: Step = { kind: 'call', tool: r.tool, args: r.args };
    if (at >= 0) steps.splice(at, 0, step);
    else {
      const ai = steps.indexOf(answer);
      steps.splice(ai >= 0 ? ai : steps.length, 0, step);
    }
  }
  if (!steps.includes(answer) && answer.parts.length) steps.push(answer);
  return steps;
}

/** Скалярные поля JSON на любой глубине — в факты диалога; overwrite — ответ инструмента обновляет прежние значения. */
function flatten(v: unknown, facts: Record<string, string>, overwrite: boolean): void {
  if (Array.isArray(v)) {
    for (const x of v) flatten(x, facts, overwrite);
    return;
  }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (x !== null && typeof x === 'object') flatten(x, facts, overwrite);
    else if (['string', 'number', 'boolean'].includes(typeof x) && (overwrite || facts[k] === undefined)) facts[k] = String(x);
  }
}

// ------------------------------------------------------------ workspace

const fm = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const out: Record<string, string> = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return out;
};

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else if (e.isFile() && !e.name.startsWith('.')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

export class Workspace {
  constructor(
    public dir: string,
    private buildSkills: string | null,
  ) {}

  /** Новый тестовый оператор получает стартовые скиллы сборки (как новая сессия на стенде). */
  async ensure(): Promise<void> {
    if (fs.existsSync(this.dir)) return;
    await fsp.mkdir(path.join(this.dir, 'skills/learned'), { recursive: true });
    if (this.buildSkills && fs.existsSync(this.buildSkills)) {
      for (const rel of await walk(this.buildSkills)) {
        const target = path.join(this.dir, rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(path.join(this.buildSkills, rel), target);
      }
    }
  }

  safe(rel: string): string {
    const t = path.resolve(this.dir, rel);
    if (!t.startsWith(path.resolve(this.dir) + path.sep)) throw new Error(`Путь вне workspace: ${rel}`);
    return t;
  }

  async skills(): Promise<{ path: string; content: string }[]> {
    const base = path.join(this.dir, 'skills/learned');
    const out = [];
    for (const rel of await walk(base)) out.push({ path: `skills/learned/${rel}`, content: await fsp.readFile(path.join(base, rel), 'utf8') });
    return out;
  }

  async pending(): Promise<{ path: string; content: string }[]> {
    const base = path.join(this.dir, 'learning/cases/pending');
    const out = [];
    for (const rel of await walk(base)) out.push({ path: `learning/cases/pending/${rel}`, content: await fsp.readFile(path.join(base, rel), 'utf8') });
    return out;
  }

  async write(rel: string, text: string): Promise<void> {
    const t = this.safe(rel);
    await fsp.mkdir(path.dirname(t), { recursive: true });
    await fsp.writeFile(t, text);
  }

  /** Знания тематики: строки процедур и уточнений из скиллов плюс свежие уроки из pending-кейсов. */
  async knowledge(topic: string): Promise<{ lines: string[]; fresh: number }> {
    const lines: string[] = [];
    for (const s of await this.skills()) {
      if (fm(s.content).topic !== topic) continue;
      for (const l of s.content.split('\n')) if (/^\s*(-|\d+\.)\s+/.test(l)) lines.push(l.replace(/^\s*(-|\d+\.)\s+/, ''));
    }
    let fresh = 0;
    for (const c of await this.pending()) {
      if (fm(c.content).topic !== topic) continue;
      fresh++;
      for (const l of c.content.split('\n')) if (/^\s*-\s+/.test(l)) lines.push(l.replace(/^\s*-\s+/, ''));
    }
    return { lines, fresh };
  }

  async capture(topic: string, ref: string, corrections: string[]): Promise<string> {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const rel = `learning/cases/pending/${stamp}-${ref.replace(/[^\w.-]/g, '_').slice(-16)}-${Math.random().toString(16).slice(2, 6)}.md`;
    const signal = corrections.length ? 'strong' : 'none';
    const body = [`---`, `topic: ${topic}`, `request_ref: ${ref}`, `signal: ${signal}`, `---`, ``, `## Поправки оператора`, ...corrections.map((c) => `- ${c}`), ``].join('\n');
    await this.write(rel, body);
    return `Case captured: ${rel} — signal: ${signal}`;
  }

  async curator(): Promise<string> {
    const pending = (await this.pending()).slice(0, 10);
    if (!pending.length) return 'No pending cases.';
    let updated = 0;
    let created = 0;
    const report: string[] = ['# Отчёт curator (fake-agent)', ''];
    const touched = new Set<string>();
    for (const c of pending) {
      const meta = fm(c.content);
      const lines = c.content.split('\n').filter((l) => /^\s*-\s+/.test(l)).map((l) => l.replace(/^\s*-\s+/, '').trim());
      if (lines.length) {
        const skills = await this.skills();
        let target = skills.find((s) => fm(s.content).topic === meta.topic);
        if (!target) {
          const slug = (meta.topic ?? 'lessons').toLowerCase().replace(/[^a-zа-яё0-9]+/giu, '-').replace(/^-|-$/g, '');
          target = { path: `skills/learned/${slug}-lessons/SKILL.md`, content: `---\nname: ${slug}-lessons\ndescription: Уроки оператора по тематике ${meta.topic}\ntopic: ${meta.topic}\n---\n# Уроки оператора\n\n## Уточнения\n` };
          created++;
        } else if (!touched.has(target.path)) updated++;
        touched.add(target.path);
        let text = target.content;
        if (!/## Уточнения/.test(text)) text = text.trimEnd() + '\n\n## Уточнения\n';
        for (const l of lines) if (!text.toLowerCase().includes(l.toLowerCase())) text = text.trimEnd() + `\n- ${l}\n`;
        await this.write(target.path, text);
        report.push(`- ${c.path}: ${lines.length} поправок → ${target.path}`);
      } else report.push(`- ${c.path}: поправок нет`);
      const processed = c.path.replace('/pending/', '/processed/');
      await this.write(processed, c.content);
      await fsp.rm(this.safe(c.path), { force: true });
    }
    const rel = `learning/reports/curator-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}.md`;
    await this.write(rel, report.join('\n') + '\n');
    const left = (await this.pending()).length;
    return `Curator complete: ${pending.length} processed, ${left} left, ${updated} updated, 0 routing fixes, ${created} created, 0 conflicts. Report: ${rel}`;
  }
}

// ------------------------------------------------------------ MCP-клиент

export class McpClient {
  private session: string | null = null;
  constructor(
    private url: string,
    private timeoutMs: number,
  ) {}

  private async rpc(body: unknown, headers: Record<string, string> = {}): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.session ? { 'Mcp-Session-Id': this.session } : {}), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const json = text.startsWith('event:') ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) : JSON.parse(text);
    if (json.error) throw new Error(`MCP: ${json.error.message}`);
    return json.result;
  }

  async init(): Promise<void> {
    if (this.session) return;
    await this.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '0.1.0' } } });
    await this.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(name: string, args: Record<string, unknown>, taskId: string): Promise<{ isError: boolean; text: string; json: any }> {
    await this.init();
    const r = await this.rpc({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }, { 'x-task-id': taskId });
    const text = (r?.content ?? []).map((c: any) => c.text).join('\n');
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* текстовый ответ */
    }
    return { isError: !!r?.isError, text, json };
  }
}

// ------------------------------------------------------------ диалог

interface Dialog {
  topic: string;
  ref: string;
  facts: Record<string, string>;
  base: string[];
  corrections: string[];
  plan: Step[];
  done: Set<string>;
  answered: boolean;
  awaiting: null | { kind: 'correction'; tool: string } | { kind: 'fact'; key: string } | { kind: 'close' };
  questions: number;
  captured: boolean;
  fresh: number;
}

export class FakeAgent {
  dialog: Dialog | null = null;
  lastDialog: Dialog | null = null;

  constructor(
    public ws: Workspace,
    private mcp: McpClient,
  ) {}

  /** {{ключ}} из фактов диалога, в том числе во вложенных объектах (request у инструментов оркестратора). */
  private resolveArgs(args: Args): { args: Args; missing: string | null } {
    const d = this.dialog!;
    const out: Args = {};
    for (const [k, v] of Object.entries(args)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = this.resolveArgs(v as Args);
        if (inner.missing) return { args: out, missing: inner.missing };
        out[k] = inner.args;
        continue;
      }
      const m = typeof v === 'string' ? /^\{\{(.+)\}\}$/.exec(v) : null;
      if (!m) {
        out[k] = v;
        continue;
      }
      const val = d.facts[m[1]];
      if (val === undefined || val === '') return { args: out, missing: m[1] };
      out[k] = val;
    }
    return { args: out, missing: null };
  }

  private rebuild() {
    const d = this.dialog!;
    d.plan = buildPlan([...rulesOf(d.base.join('\n')), ...rulesOf(d.corrections.join('\n'))]);
  }

  async handle(text: string, taskId: string): Promise<string> {
    const t = text.trim();
    if (t === '/reset' || t.startsWith('/reset ')) {
      if (this.dialog) this.lastDialog = this.dialog;
      this.dialog = null;
      return 'Контекст сброшен. Готов к новому обращению.';
    }
    if (t.startsWith('/case-capture')) {
      const d = this.dialog ?? this.lastDialog;
      if (!d || d.captured) return 'Case capture skipped: в диалоге не было обращения';
      const ref = /request_ref=(\S+)/.exec(t)?.[1] ?? d.ref;
      const line = await this.ws.capture(d.topic, ref, d.corrections);
      d.captured = true;
      return `Сохраняю обращение для обучения.\n\`${line}\``;
    }
    if (t.startsWith('/skill-curator')) {
      const line = await this.ws.curator();
      return `Проход curator выполнен.\n${line}`;
    }
    // Строки могут быть с отступом — как в блоке кода стартового сообщения оркестратора.
    if (/^\s*Тематика:/m.test(t) && /^\s*request_ref:/m.test(t)) return this.start(t, taskId);
    if (!this.dialog) return 'Я не веду обращение. Отправьте стартовое сообщение.';
    return this.onOperator(t, taskId);
  }

  private async start(text: string, taskId: string): Promise<string> {
    const facts: Record<string, string> = {};
    for (const line of text.split('\n')) {
      // Результаты инструментов, встроенные оркестратором: «название»{JSON}.
      const json = /»(\{.*\})\.?\s*$/.exec(line);
      if (json) {
        try {
          flatten(JSON.parse(json[1]), facts, false);
        } catch {
          /* не JSON */
        }
        continue;
      }
      const i = line.indexOf(':');
      if (i > 0) facts[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const topic = facts['Тематика'] ?? '';
    const k = await this.ws.knowledge(topic);
    this.dialog = {
      topic,
      ref: facts['request_ref'] ?? '',
      facts,
      base: k.lines,
      corrections: [],
      plan: [],
      done: new Set(),
      answered: false,
      awaiting: null,
      questions: 0,
      captured: false,
      fresh: k.fresh,
    };
    this.rebuild();
    if (!this.dialog.plan.length) return `По тематике «${topic}» у меня нет процедуры. Подскажите, что сделать?`;
    return this.advance(taskId, k.fresh ? `Учитываю свежие уроки: ${k.fresh}. ` : '');
  }

  private async advance(taskId: string, prefix = ''): Promise<string> {
    const d = this.dialog!;
    const notes: string[] = [];
    for (const step of d.plan) {
      if (step.kind === 'call') {
        if (d.done.has(step.tool)) continue;
        const { args, missing } = this.resolveArgs(step.args);
        if (missing) {
          d.awaiting = { kind: 'fact', key: missing };
          return `${prefix}Уточните, пожалуйста: ${missing}.`;
        }
        const r = await this.mcp.call(step.tool, args, taskId);
        if (r.isError) {
          if (/отклон/i.test(r.text)) {
            d.awaiting = { kind: 'correction', tool: step.tool };
            return `${prefix}Понял, не выполняю \`${step.tool}\`. Что нужно сделать иначе?`;
          }
          notes.push(`\`${step.tool}\`: ${r.text}`);
          d.done.add(step.tool);
          continue;
        }
        d.done.add(step.tool);
        if (r.json && typeof r.json === 'object') flatten(r.json, d.facts, true);
        notes.push(`\`${step.tool}\` выполнен`);
      } else if (!d.answered) {
        d.answered = true;
        d.awaiting = { kind: 'close' };
        d.facts.answer = step.parts.join(' ');
        // Ответ хода — в Markdown, как его показывает интерфейс: проверки списком, ответ клиенту выделен.
        const checked = notes.length ? `Проверил:\n${notes.map((n) => `- ${n}`).join('\n')}\n\n` : '';
        return `${prefix}${checked}**Ответ клиенту:** «${step.parts.join(' ')}»\n\nМожно закрывать обращение?`;
      }
    }
    d.awaiting = null;
    return `${prefix}${notes.length ? `${notes.join('; ')}. ` : ''}Обращение обработано.`;
  }

  private async onOperator(text: string, taskId: string): Promise<string> {
    const d = this.dialog!;
    const rules = rulesOf(text);
    if (rules.length) {
      d.corrections.push(text.replace(/\s+/g, ' ').trim());
      const hadAnswer = d.answered;
      this.rebuild();
      if (rules.some((r) => r.kind === 'answer') && hadAnswer) d.answered = false;
      d.awaiting = null;
      d.questions = 0;
      return this.advance(taskId, 'Понял, учту. ');
    }
    const aw = d.awaiting;
    if (aw?.kind === 'fact') {
      d.facts[aw.key] = text.trim();
      d.awaiting = null;
      return this.advance(taskId);
    }
    if (aw?.kind === 'close' && /можно закрывать|закрывайте|закрыть можно|верно|да,? закр/i.test(text)) {
      d.awaiting = null;
      return this.advance(taskId);
    }
    if (aw && d.questions < 2) {
      d.questions++;
      return aw.kind === 'correction' ? `Какую проверку нужно выполнить перед \`${aw.tool}\`?` : 'Что нужно изменить в ответе клиенту?';
    }
    if (aw?.kind === 'close') {
      d.awaiting = null;
      return this.advance(taskId, 'Хорошо. ');
    }
    d.awaiting = null;
    return this.advance(taskId, 'Хорошо. ');
  }
}
