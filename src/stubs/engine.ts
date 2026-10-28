// Заглушки инструментов (CASE-02–04): условия на аргументы, последовательности, состояние выполнения.
import vm from 'node:vm';
import YAML from 'yaml';
import type { CaseDef, StubDef, StubResponse, ToolDef } from '../config/types.js';
import { getDotted, setDotted } from '../util/jsonpath.js';
import { deepClone, errorMessage, isPlainObject, stableStringify } from '../util/core.js';
import { renderDeep, type TemplateContext } from '../util/template.js';
import { logger } from '../util/log.js';

const log = logger('stubs');

export interface StubMatch {
  stub: StubDef;
  score: number;
  /** Сколько заглушек подошло — для журнала «выбрана более точная». */
  candidates: number;
}

function scalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** Операторы условия `when`: объект только из этих ключей — проверка, иначе — сравнение вложенного объекта. */
const WHEN_OPS = ['regex', 'in', 'exists', 'not', 'eq'];

/** Выражение `regex` компилируется одинаково при вызове и при проверке файлов: строка и флаг u. */
const whenRegex = (source: unknown): RegExp => new RegExp(String(source), 'u');

/** Сколько может идти одна проверка `regex`: выражение с катастрофическим перебором не должно останавливать стенд. */
export const REGEX_TIMEOUT_MS = 100;
const regexContext = vm.createContext({});
const regexTest = new vm.Script('re.test(s)');

/** Проверка в отдельном контексте: V8 прерывает перебор по таймауту, и тогда условие не выполнено. */
function regexMatches(source: unknown, value: string): boolean {
  const re = whenRegex(source);
  regexContext.re = re;
  regexContext.s = value;
  try {
    return regexTest.runInContext(regexContext, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
    log.warn(`Условие regex «${re.source}» проверялось дольше ${REGEX_TIMEOUT_MS} мс на значении длиной ${value.length}: проверка прервана, условие не выполнено`);
    return false;
  } finally {
    regexContext.re = undefined;
    regexContext.s = undefined;
  }
}

/** Одно условие `when`: равенство, {regex}, {in}, {exists}, {not}. */
export function condMatches(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    const keys = Object.keys(expected);
    if (keys.length && keys.every((k) => WHEN_OPS.includes(k))) {
      if ('exists' in expected && (actual !== undefined) !== Boolean(expected.exists)) return false;
      if ('regex' in expected) {
        if (actual === undefined || actual === null) return false;
        if (!regexMatches(expected.regex, String(actual))) return false;
      }
      if ('in' in expected && !(Array.isArray(expected.in) && expected.in.some((x) => condMatches(actual, x)))) return false;
      if ('not' in expected && condMatches(actual, expected.not)) return false;
      if ('eq' in expected && !condMatches(actual, expected.eq)) return false;
      return true;
    }
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([k, v]) => condMatches((actual as any)[k], v));
  }
  if (scalar(expected) && scalar(actual)) return String(actual) === String(expected);
  return stableStringify(actual) === stableStringify(expected);
}

/**
 * Выражения `regex` условия when, которые не компилируются, — по тем же правилам, что condMatches при вызове.
 * Путь — внутри when: так загрузка справочников показывает поле и строку, а не вызов инструмента падает посреди кейса.
 */
export function whenRegexErrors(when: Record<string, unknown>): { path: (string | number)[]; error: string }[] {
  const out: { path: (string | number)[]; error: string }[] = [];
  const walk = (expected: unknown, path: (string | number)[]): void => {
    if (!isPlainObject(expected)) return;
    const keys = Object.keys(expected);
    if (keys.length && keys.every((k) => WHEN_OPS.includes(k))) {
      if ('regex' in expected) {
        try {
          whenRegex(expected.regex);
        } catch (e) {
          out.push({ path: [...path, 'regex'], error: errorMessage(e) });
        }
      }
      if ('in' in expected && Array.isArray(expected.in)) expected.in.forEach((x: unknown, i: number) => walk(x, [...path, 'in', i]));
      if ('not' in expected) walk(expected.not, [...path, 'not']);
      if ('eq' in expected) walk(expected.eq, [...path, 'eq']);
      return;
    }
    for (const [k, v] of Object.entries(expected)) walk(v, [...path, k]);
  };
  for (const [k, v] of Object.entries(when)) walk(v, [k]);
  return out;
}

export function whenMatches(when: Record<string, unknown> | undefined, args: Record<string, unknown>): boolean {
  if (!when) return true;
  return Object.entries(when).every(([k, v]) => condMatches(getDotted(args, k), v));
}

/** Вызов подходит под пометку terminal инструмента: её условие when — на те же аргументы, что подбор заглушки. */
export function terminalMatches(def: Pick<ToolDef, 'terminal'> | undefined, args: Record<string, unknown>): boolean {
  return !!def?.terminal && whenMatches(def.terminal.when ?? undefined, args);
}

/**
 * Предложенное правило: из подходящих выбирается заглушка с более точным условием
 * (больше условий в `when`), при равенстве — первая по файлу. Сначала кейс, затем умолчания контракта.
 */
export function matchStub(caseStubs: StubDef[] | undefined, defaults: StubDef[] | undefined, args: Record<string, unknown>): StubMatch | null {
  for (const list of [caseStubs, defaults]) {
    if (!list?.length) continue;
    const ok = list.filter((s) => whenMatches(s.when, args));
    if (!ok.length) continue;
    let best = ok[0];
    let bestScore = Object.keys(best.when ?? {}).length;
    for (const s of ok.slice(1)) {
      const sc = Object.keys(s.when ?? {}).length;
      if (sc > bestScore) {
        best = s;
        bestScore = sc;
      }
    }
    return { stub: best, score: bestScore, candidates: ok.length };
  }
  return null;
}

/** Состояние и счётчики принадлежат выполнению, а не файлу кейса (CASE-04). */
export class StubState {
  state: Record<string, unknown>;
  private counters = new Map<string, number>();

  constructor(initial: Record<string, unknown>) {
    this.state = deepClone(initial ?? {});
  }

  /** Ответ для очередного вызова заглушки: элемент последовательности, последний повторяется. */
  next(stub: StubDef): { response: StubResponse; call: number } {
    const key = `${stub.origin}:${stub.tool}:${stub.index}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    if (stub.sequence?.length) return { response: stub.sequence[Math.min(n, stub.sequence.length) - 1], call: n };
    return { response: stub, call: n };
  }

  applyEffect(effect: Record<string, unknown> | undefined, ctx: TemplateContext): Record<string, unknown> | null {
    if (!effect) return null;
    const rendered = renderDeep(effect, ctx);
    this.apply(rendered);
    return rendered;
  }

  /** Уже отрисованный эффект — в состояние выполнения. */
  apply(rendered: Record<string, unknown> | null): void {
    for (const [k, v] of Object.entries(rendered ?? {})) setDotted(this.state, k, v);
  }

  snapshot(): Record<string, unknown> {
    return deepClone(this.state);
  }
}

export interface RenderedResponse {
  isError: boolean;
  /** Значение для агента: объект для json, строка для text и error. */
  value: unknown;
  text: string;
  errorCode?: string | number;
  delayMs: number;
  effect: Record<string, unknown> | null;
}

export function templateContext(c: CaseDef, args: Record<string, unknown>, state: Record<string, unknown>, execution: Record<string, unknown>): TemplateContext {
  return { case: { id: c.id, title: c.title, topic: c.topic, tags: c.tags }, start: c.start, args, state, execution };
}

/**
 * Ответ заглушки без изменения состояния: значение и отрисованный эффект. Эффект применяет выполнение, когда ответ уходит
 * агенту, — после delayMs: вызов, остановленный во время задержки, не выполнен и состояние не меняет.
 */
export function renderStub(response: StubResponse, ctx: TemplateContext): RenderedResponse {
  const delayMs = response.delayMs ?? 0;
  // Эффект есть и у ошибки: например, повторный вызов фиксирует попытку.
  const effect = response.effect ? renderDeep(response.effect, ctx) : null;
  if (response.error !== undefined) {
    const err = typeof response.error === 'string' ? { message: response.error } : response.error;
    const message = String(renderDeep(err.message, ctx));
    return { isError: true, value: message, text: message, errorCode: err.code, delayMs, effect };
  }
  const r = response.result ?? {};
  let value: unknown;
  if (r.json !== undefined) value = renderDeep(deepClone(r.json), ctx);
  else if (r.text !== undefined) value = String(renderDeep(r.text, ctx));
  else if (r.fileContent !== undefined) value = renderDeep(deepClone(r.fileContent), ctx);
  else value = {};
  return { isError: false, value, text: typeof value === 'string' ? value : JSON.stringify(value), delayMs, effect };
}

/** Ответ заглушки с эффектом сразу — когда задержки ждать не нужно. */
export function renderResponse(response: StubResponse, ctx: TemplateContext, stubState: StubState): RenderedResponse {
  const rendered = renderStub(response, ctx);
  stubState.apply(rendered.effect);
  return rendered;
}

/**
 * Ответ заглушки для шаблона стартового сообщения ({{tools.<инструмент>}}): заглушка выбирается как для вызова
 * без аргументов, берётся первый ответ последовательности, эффект не применяется — счётчики и состояние выполнения
 * не меняются, и агент при своём вызове получит тот же ответ. Ошибка или отсутствие заглушки — значения нет.
 */
export function previewStub(c: CaseDef, defaults: StubDef[] | undefined, tool: string, state: Record<string, unknown>, execution: Record<string, unknown>): unknown {
  const match = matchStub(c.tools[tool], defaults, {});
  if (!match) return undefined;
  const response = match.stub.sequence?.length ? match.stub.sequence[0] : match.stub;
  if (response.error !== undefined) return undefined;
  return renderStub({ ...response, effect: undefined }, templateContext(c, {}, state, execution)).value;
}

/** YAML-фрагмент для файла кейса по ответу, введённому человеком (plan_start.md, п. 6). */
export function yamlSnippet(tool: string, args: Record<string, unknown>, answer: { json?: unknown; text?: string; error?: string }): string {
  const ind = (s: string, n: number) => s.split('\n').map((l) => ' '.repeat(n) + l).join('\n');
  const toYaml = (v: unknown): string => JSON.stringify(v);
  const snippet = (result: string[]) => `tools:\n${[`  ${tool}:`, `    - when: ${toYaml(args)}`, ...result].join('\n')}\n`;
  if (answer.error !== undefined) return snippet([`      error: ${toYaml(answer.error)}`]);
  if (answer.json !== undefined) return snippet([`      result:`, `        json: ${toYaml(answer.json)}`]);
  // Текст — блоком, как его удобно читать в кейсе. Индикатор сохраняет концевые переводы строк: |- — ни одного, | — один,
  // |+ — несколько; отступ задаётся явно, если текст начинается с пробела или табуляции.
  const text = answer.text ?? '';
  const chomp = !text.endsWith('\n') ? '-' : text === '\n' || text.endsWith('\n\n') ? '+' : '';
  const indent = /^\n*[ \t]/.test(text) ? '2' : '';
  const block = snippet([`      result:`, `        text: |${indent}${chomp}`, ind(chomp === '-' ? text : text.slice(0, -1), 10)]);
  // Чего блок не сохраняет — \r, непечатные символы, — пишется строкой JSON: в YAML это строка в кавычках.
  let exact = false;
  try {
    exact = YAML.parse(block)?.tools?.[tool]?.[0]?.result?.text === text;
  } catch {
    exact = false;
  }
  return exact ? block : snippet([`      result:`, `        text: ${toYaml(text)}`]);
}
