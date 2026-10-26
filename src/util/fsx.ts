// Файлы: чтение, атомарная запись JSON, обход каталогов, контрольные суммы.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './core.js';

export const exists = (p: string): boolean => fs.existsSync(p);

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function readJson<T = any>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

export async function readJsonIf<T = any>(file: string): Promise<T | undefined> {
  try {
    return await readJson<T>(file);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return undefined;
    throw e;
  }
}

const writeChains = new Map<string, Promise<void>>();

/** Атомарная запись (tmp + rename), записи в один файл выстраиваются в очередь. */
export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await ensureDir(path.dirname(file));
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    });
  writeChains.set(file, next);
  next.finally(() => {
    if (writeChains.get(file) === next) writeChains.delete(file);
  }).catch(() => undefined);
  return next;
}

export async function writeText(file: string, text: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, text);
}

/** Относительные пути всех файлов каталога, отсортированные; скрытые служебные файлы пропускаются. */
export async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, rel: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (e: any) {
      if (e?.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      if (e.name === '.DS_Store' || e.name.endsWith('.tmp')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  }
  await walk(dir, '');
  return out.sort();
}

export interface FileEntry {
  path: string;
  sha256: string;
  size: number;
  content: string;
}

export async function readTree(dir: string): Promise<FileEntry[]> {
  const files = await walkFiles(dir);
  const out: FileEntry[] = [];
  for (const rel of files) {
    const buf = await fsp.readFile(path.join(dir, rel));
    out.push({ path: rel, sha256: sha256(buf), size: buf.length, content: buf.toString('utf8') });
  }
  return out;
}

export async function writeTree(dir: string, files: { path: string; content: string }[]): Promise<void> {
  for (const f of files) {
    const target = safeJoin(dir, f.path);
    await writeText(target, f.content);
  }
}

/** Путь внутри каталога; выход за его пределы — ошибка. */
export function safeJoin(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Путь вне каталога: ${rel}`);
  return target;
}

/** Контрольная сумма набора файлов: sha256 строк «путь:sha» в порядке путей. */
export function manifestChecksum(files: { path: string; sha256: string }[]): string {
  return sha256(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => `${f.path}:${f.sha256}`)
      .join('\n'),
  );
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}
