// Шаблоны {{a.b}} в заглушках, стартовом сообщении, командах и теле запроса агенту.
import { getDotted } from './jsonpath.js';
import { isPlainObject } from './core.js';

const RE = /\{\{\s*([\w.$-]+)\s*\}\}/g;
const WHOLE = /^\{\{\s*([\w.$-]+)\s*\}\}$/;

export type TemplateContext = Record<string, unknown>;

function lookup(ctx: TemplateContext, name: string): unknown {
  if (name === 'now') return new Date().toISOString();
  return getDotted(ctx, name);
}

function toText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Строка целиком из одного плейсхолдера сохраняет тип значения (число, объект). */
export function renderValue(s: string, ctx: TemplateContext, missing?: Set<string>): unknown {
  const whole = WHOLE.exec(s);
  if (whole) {
    const v = lookup(ctx, whole[1]);
    if (v === undefined) missing?.add(whole[1]);
    return v === undefined ? '' : v;
  }
  return renderString(s, ctx, missing);
}

export function renderString(s: string, ctx: TemplateContext, missing?: Set<string>): string {
  return s.replace(RE, (_m, name: string) => {
    const v = lookup(ctx, name);
    if (v === undefined) missing?.add(name);
    return toText(v);
  });
}

export function renderDeep<T>(value: T, ctx: TemplateContext, missing?: Set<string>): T {
  if (typeof value === 'string') return renderValue(value, ctx, missing) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx, missing)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, ctx, missing);
    return out as T;
  }
  return value;
}

/**
 * Построчный шаблон: строка, в которой плейсхолдер оказался пустым, выпадает целиком.
 * Так стартовое сообщение не получает строк «Карта: » для кейсов без карты.
 */
export function renderLines(template: string, ctx: TemplateContext, missing?: Set<string>): string {
  const out: string[] = [];
  for (const line of template.split(/\r?\n/)) {
    let empty = false;
    const rendered = line.replace(RE, (_m, name: string) => {
      const t = toText(lookup(ctx, name));
      if (!t.trim()) {
        empty = true;
        missing?.add(name);
      }
      return t;
    });
    if (!empty) out.push(rendered);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function placeholders(s: string): string[] {
  return [...s.matchAll(RE)].map((m) => m[1]);
}
