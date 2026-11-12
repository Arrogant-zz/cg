// Дозапуск прогона после его завершения (решение владельца от 12.11.2026): перезапуск сбойных и не начатых позиций
// проверяющего прогона, продолжение остановленных линий обучающего и переоценка упавших оценок. Здесь — что подходит
// и что мешает. Дозапуск собирается из снимка прогона, а не из текущих справочников; разойтись с ним могут только
// подсказки из кода, настройки стенда и тестовый оператор — тогда дозапуск отказывает с причиной.
import { loadRegistry } from '../config/loader.js';
import type { CuratorPolicy, Issue } from '../config/types.js';
import type { Env } from '../env.js';
import { TECH_STATUSES } from '../execution/events.js';
import { sha256 } from '../util/core.js';
import type { InputGroup } from './inputs.js';
import { resolveRun, type ResolvedRun } from './resolve.js';
import { runStep, stepLabel, type OperatorState } from './operators.js';
import type { ItemRecord, LineRecord, OperatorStep, RunRecord } from './types.js';

/** Позиция линии — L1-P04; так же называется журнал первой попытки. */
export const posKey = (line: number, pos: number): string => `L${line}-P${String(pos).padStart(2, '0')}`;

/** Журнал попытки: первая — L1-P04, следующие — L1-P04-2, L1-P04-3. */
export const attemptName = (line: number, pos: number, n: number): string => (n > 1 ? `${posKey(line, pos)}-${n}` : posKey(line, pos));

/** Позиция по ключу L1-P04: линия и номер. */
export function parsePosKey(key: string): { line: number; pos: number } | null {
  const m = /^L(\d+)-P(\d+)$/.exec(key);
  return m ? { line: Number(m[1]), pos: Number(m[2]) } : null;
}

export interface Availability {
  available: boolean;
  /** Позиции L1-P04, которые подходят по записи прогона, — даже если дозапуск сейчас недоступен. */
  items: string[];
  reasons: string[];
}

export interface ResumeLine {
  line: number;
  /** Элемент корзины, с которого продолжить; null — остался только финальный проход curator. */
  from: number | null;
  /** Позиция первого продолженного кейса; null — кейсов не осталось. */
  pos: number | null;
}

export interface DorunState {
  rerun: Availability;
  resume: Availability & { lines: ResumeLine[] };
  reevaluate: Availability;
  /** Что ClawGym сверить не может: перезапуск пройдёт на текущей сборке агента и модели. */
  note: string;
}

/** Прогон, собранный из снимка, и что у текущего ClawGym разошлось со снимком. */
export interface SnapshotCheck {
  resolved: ResolvedRun | null;
  /** Ошибки сборки прогона из снимка: с ними перезапуск и продолжение невозможны. */
  errors: Issue[];
  /** Различия файлов и настроек со снимком: группа, файл или настройка и строка «что → как». */
  diffs: { group: InputGroup | null; key: string; text: string }[];
  /** Файлы подключений, в копиях которых скрыт секрет: по такой копии не подключиться. */
  hidden: string[];
}

const GROUP_TITLES: Record<InputGroup, string> = {
  run: 'Файл прогона',
  basket: 'Корзина',
  cases: 'Кейсы и решения',
  contract: 'Контракт инструментов',
  agent: 'Агент',
  models: 'Модели оператора и оценки',
  metrics: 'Метрики',
  prompts: 'Подсказки оператора и судьи',
  stand: 'Настройки стенда',
};

/** Подсказки и схемы судей: только они важны для переоценки. Имена — с версией, поэтому сверяются по началу. */
const isJudgePrompt = (file: string) => /^prompts\/(answer-)?judge-/.test(file);

/** Скрытое значение снимка (inputs.ts): секрет, пароль в адресе или файл, который не разобрался. */
const HIDDEN = /\*\*\*|^# Содержимое скрыто/m;

export const NOTE = 'Сборку агента и версию модели ClawGym не видит: дозапуск пройдёт на текущих.';

/**
 * Прогон из копий файлов снимка (results/run-NNNN/snapshot/ повторяет раскладку справочников) и сверка со снимком
 * того, что снимок не замораживает: подсказок в коде и настроек стенда после подстановки окружения.
 * Тестовый оператор берётся из линий записи, поэтому continueFrom файла прогона не разрешается.
 */
export async function checkSnapshot(run: RunRecord, dir: string, env: Env): Promise<SnapshotCheck> {
  if (!run.snapshot.settings) {
    return { resolved: null, errors: [{ severity: 'error', file: run.configFile, reason: 'в записи нет полного перечня входных данных: прогон сделан до 28.10.2026, собрать его из снимка нельзя' }], diffs: [], hidden: [] };
  }
  const reg = await loadRegistry(dir);
  const cfg = reg.runs.get(run.configId);
  if (cfg) {
    cfg.continueFrom = null;
    reg.issues = reg.issues.filter((i) => !(i.file === cfg.source.file && i.field === 'continueFrom'));
  }
  const p = resolveRun(reg, env, run.configId, { continueFrom: 'new' });
  const errors = p.issues.filter((i) => i.severity === 'error');
  if (!p.resolved) return { resolved: null, errors, diffs: [], hidden: [] };

  const diffs: SnapshotCheck['diffs'] = [];
  const was = new Map(run.snapshot.files.map((f) => [f.file, f]));
  const now = new Map(p.inputs.files.map((f) => [f.file, { group: f.group, sha: sha256(f.text) }]));
  for (const file of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(file);
    const b = now.get(file);
    if (a && b && a.sha256 === b.sha) continue;
    const text = !a ? `${file} — нет в снимке` : !b ? `${file} — нет у текущего ClawGym` : `${file} отличается от снимка`;
    diffs.push({ group: b?.group ?? a?.group ?? null, key: file, text });
  }
  const before = new Map(run.snapshot.settings.map((s) => [s.key, s]));
  const after = new Map(p.inputs.settings.map((s) => [s.key, s]));
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if (a?.value === b?.value) continue;
    diffs.push({ group: b?.group ?? a?.group ?? null, key, text: `${key}: ${a?.value ?? '—'} → ${b?.value ?? '—'}` });
  }
  const hidden = p.inputs.files.filter((f) => (f.group === 'agent' || f.group === 'models') && HIDDEN.test(f.text)).map((f) => f.file);
  return { resolved: p.resolved, errors, diffs, hidden };
}

/** Причины отказа по снимку для вида дозапуска: переоценке важны только судья, его подсказки и настройки. */
export function snapshotReasons(c: SnapshotCheck, kind: 'rerun' | 'resume' | 'reevaluate'): string[] {
  const diff = (d: SnapshotCheck['diffs'][number]) => `${d.group ? GROUP_TITLES[d.group] : 'Снимок'}: ${d.text}`;
  const secret = (f: string) => `В снимке скрыт секрет или адрес ${f}: задайте его ссылкой \${env:…} — по такой копии не подключиться`;
  if (kind !== 'reevaluate') return [...c.errors.map((i) => `${i.file}: ${i.reason}`), ...c.hidden.map(secret), ...c.diffs.map(diff)];
  const judge = c.resolved?.models.judge ?? null;
  if (!c.resolved) return c.errors.map((i) => `${i.file}: ${i.reason}`);
  if (!judge) return ['В прогоне нет модели оценки'];
  return [
    ...c.errors.filter((i) => i.file === judge.source.file).map((i) => `${i.file}: ${i.reason}`),
    ...c.hidden.filter((f) => f === judge.source.file).map(secret),
    ...c.diffs.filter((d) => isJudgePrompt(d.key) || d.key.startsWith('judge.')).map(diff),
  ];
}

const notStarted = (i: ItemRecord) => !i.outcome && ['pending', 'not_started'].includes(i.status);
/** Технический итог итоговой попытки; у записей до 12.11.2026 после перезапуска ClawGym итог мог остаться пустым при статусе сбоя. */
const technical = (i: ItemRecord) => i.outcome === 'technical' || (!i.outcome && TECH_STATUSES.has(i.status));

/** Позиции проверяющего прогона, которые можно перезапустить: итоговая попытка — технический сбой, или позиция не начата. */
export function rerunItems(run: RunRecord): string[] {
  if (run.type !== 'checking') return [];
  return run.lines.flatMap((l) => l.items.filter((i) => i.kind === 'case' && i.pos !== null && (technical(i) || notStarted(i))).map((i) => posKey(l.index, i.pos!)));
}

/**
 * Откуда продолжить обучающую линию. Хвост корзины не начинался; позиция остановки — технический сбой прямо перед ним:
 * после него оператор ничему не учился, capture не было. Если после позиции остановки прошёл curator — например,
 * финальный проход у линии, которая дошла до конца, — оператор уже не тот, и продолжения нет: сбой остаётся пропуском.
 * Все позиции завершены — продолжать можно только невыполненный финальный проход.
 */
export function resumePoint(l: LineRecord, cur: CuratorPolicy): Omit<ResumeLine, 'line'> | null {
  const items = [...l.items].sort((a, b) => a.index - b.index);
  let k = items.length;
  while (k > 0 && notStarted(items[k - 1])) k--;
  if (k > 0 && items[k - 1].kind === 'case' && technical(items[k - 1])) k--;
  if (k < items.length) {
    const first = items[k];
    const pos = items.slice(k).find((i) => i.kind === 'case')?.pos ?? null;
    const lastBefore = items.slice(0, k).reverse().find((i) => i.kind === 'case')?.pos ?? 0;
    if (l.curatorPasses.some((p) => p.afterPos > lastBefore && p.status !== 'failed')) return null;
    return { from: first.index, pos };
  }
  const finalOk = l.curatorPasses.some((p) => p.reason === 'final' && p.status === 'ok');
  const finalTried = l.curatorPasses.some((p) => p.reason === 'final');
  if (cur.enabled && cur.final && !finalOk && (l.counter > 0 || finalTried)) return { from: null, pos: null };
  return null;
}

/** Линии обучающего прогона, которые можно продолжить. */
export function resumeLines(run: RunRecord): ResumeLine[] {
  if (run.type !== 'training') return [];
  return run.lines.flatMap((l) => {
    const p = resumePoint(l, run.settings.basket.curator);
    return p ? [{ line: l.index, ...p }] : [];
  });
}

/** Позиции, у итоговой попытки которых упала оценка: судья по критериям или прогон судьи по эталонному тексту. */
export function reevaluateItems(run: RunRecord): string[] {
  return run.lines.flatMap((l) =>
    l.items
      .filter((i) => i.kind === 'case' && i.pos !== null && i.execName && i.outcome && i.outcome !== 'technical' && (i.steps.judge?.status === 'failed' || i.scores?.answer.status === 'failed'))
      .map((i) => posKey(l.index, i.pos!)),
  );
}

const stepKey = (s: OperatorStep) => (s.kind === 'run' ? `run:${s.run}:${s.line}` : `manual:${s.session}`);

/** Через что оператор линии прошёл, кроме истории, с которой начался прогон, и самого прогона. */
export function laterSteps(run: RunRecord, l: LineRecord, operators: OperatorState): OperatorStep[] {
  const known = new Set([...l.history, runStep(run, l.index)].map(stepKey));
  return operators.history(l.senderId).filter((s) => !known.has(stepKey(s)));
}

/**
 * Тестовые операторы линий дозапуска: занятый оператор ждёт, а оператор, который после прогона прошёл обучение или
 * ручную сессию (там можно отправить /case-capture и /skill-curator), уже со своими скиллами — с ним условия не те.
 * Проверяющие прогоны скиллы не меняют и не мешают. Линия без оператора получит нового при старте, как в прогоне.
 */
export function operatorReasons(run: RunRecord, lines: number[], operators: OperatorState): string[] {
  const out: string[] = [];
  for (const l of run.lines.filter((x) => lines.includes(x.index) && x.senderId)) {
    const who = run.lines.length > 1 ? `Тестовый оператор линии ${l.index}` : 'Тестовый оператор';
    const busy = operators.holder(l.senderId);
    if (busy) out.push(`${who} занят ${busy}`);
    const later = laterSteps(run, l, operators).filter((s) => s.kind === 'manual' || s.type === 'training');
    if (later.length) out.push(`${who} после прогона прошёл ${later.map(stepLabel).join(', ')}: его скиллы уже другие`);
  }
  return out;
}

/** Линии, которых касаются позиции L1-P04. */
export const linesOf = (items: string[]): number[] => [...new Set(items.map((k) => parsePosKey(k)?.line).filter((x): x is number => x !== undefined))];
