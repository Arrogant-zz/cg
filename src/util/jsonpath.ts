// Подмножество JSONPath для настроек REST-подключения: $, .key, ['key'], [n], [*].

export type PathToken = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wild' };

export class PathError extends Error {}

/** Служебные имена объектов: запись по ним меняет прототипы всех объектов процесса, а чтение находит унаследованное. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const isForbiddenKey = (key: string): boolean => FORBIDDEN_KEYS.has(key);

/** Собственное поле значения: унаследованные поля и методы — не данные. */
const hasOwn = (v: unknown, key: string | number): boolean => v !== null && v !== undefined && Object.hasOwn(v, key);

export function parsePath(path: string): PathToken[] {
  let s = path.trim();
  if (!s.startsWith('$')) throw new PathError(`Путь должен начинаться с $: ${path}`);
  s = s.slice(1);
  const tokens: PathToken[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      i++;
      if (s[i] === '*') {
        tokens.push({ kind: 'wild' });
        i++;
        continue;
      }
      let j = i;
      while (j < s.length && /[^.[\]]/.test(s[j])) j++;
      if (j === i) throw new PathError(`Пустое имя поля в пути ${path}`);
      tokens.push({ kind: 'key', key: s.slice(i, j) });
      i = j;
    } else if (c === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw new PathError(`Нет закрывающей скобки в пути ${path}`);
      const inner = s.slice(i + 1, end).trim();
      if (inner === '*') tokens.push({ kind: 'wild' });
      else if (/^-?\d+$/.test(inner)) tokens.push({ kind: 'index', index: Number(inner) });
      else if (/^'.*'$|^".*"$/.test(inner)) tokens.push({ kind: 'key', key: inner.slice(1, -1) });
      else throw new PathError(`Непонятный фрагмент [${inner}] в пути ${path}`);
      i = end + 1;
    } else {
      throw new PathError(`Непонятный символ «${c}» в пути ${path}`);
    }
  }
  return tokens;
}

/** Все значения по пути; пустой массив — путь не найден. */
export function queryPath(obj: unknown, path: string): unknown[] {
  let cur: unknown[] = [obj];
  for (const t of parsePath(path)) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v === null || v === undefined) continue;
      if (t.kind === 'key') {
        if (typeof v === 'object' && hasOwn(v, t.key)) next.push((v as any)[t.key]);
      } else if (t.kind === 'index') {
        if (Array.isArray(v)) {
          const idx = t.index < 0 ? v.length + t.index : t.index;
          if (idx >= 0 && idx < v.length) next.push(v[idx]);
        }
      } else {
        if (Array.isArray(v)) next.push(...v);
        else if (typeof v === 'object') next.push(...Object.values(v as any));
      }
    }
    cur = next;
  }
  return cur;
}

/** Запись по пути без подстановочных знаков; недостающие объекты и массивы создаются. */
export function setPath(obj: any, path: string, value: unknown): void {
  const tokens = parsePath(path);
  if (!tokens.length) throw new PathError('Нельзя записать в корень $');
  let cur = obj;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const last = i === tokens.length - 1;
    if (t.kind === 'wild') throw new PathError(`Запись по пути с [*] невозможна: ${path}`);
    if (t.kind === 'key' && isForbiddenKey(t.key)) throw new PathError(`Имя «${t.key}» недопустимо в пути записи ${path}`);
    const key: string | number = t.kind === 'key' ? t.key : t.index;
    if (last) {
      cur[key] = value;
      return;
    }
    if (!hasOwn(cur, key) || cur[key] === undefined || cur[key] === null) {
      const nt = tokens[i + 1];
      cur[key] = nt.kind === 'index' ? [] : {};
    }
    cur = cur[key];
  }
}

/** Доступ по точечному пути аргументов заглушки: `client.id`, `items.0.sku`. */
export function getDotted(obj: unknown, dotted: string): unknown {
  let cur: any = obj;
  for (const part of dotted.split('.')) {
    if (!hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setDotted(obj: Record<string, any>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  const bad = parts.find(isForbiddenKey);
  if (bad) throw new PathError(`Имя «${bad}» недопустимо в пути ${dotted}`);
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!hasOwn(cur, parts[i]) || typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
