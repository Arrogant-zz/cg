// Версии прикладных наборов (SK-01, SK-05): исходные — из skillsets/, полученные обучением — в каталоге данных.
// Версия неизменяема: новая версия получает следующий номер и ссылки на исходную версию и прогон.
import path from 'node:path';
import type { Registry, SkillsetDef, SkillsetVersion } from '../config/types.js';
import { versionOrder } from '../config/loader.js';
import { manifestChecksum, writeJsonAtomic, writeTree } from '../util/fsx.js';
import { nowIso, sha256 } from '../util/core.js';

export function findVersion(reg: Registry, skillsetId: string, versionId: string): { set: SkillsetDef; version: SkillsetVersion } | null {
  const set = reg.skillsets.get(skillsetId);
  if (!set) return null;
  const version = versionId === 'latest' ? latestVersion(set) : set.versions.find((v) => v.id === versionId);
  return version ? { set, version } : null;
}

export function latestVersion(set: SkillsetDef): SkillsetVersion | undefined {
  const ready = [...set.versions.filter((v) => v.status === 'ready')].sort((a, b) => versionOrder(a.id) - versionOrder(b.id));
  return ready[ready.length - 1];
}

export function nextVersionId(set: SkillsetDef, taken: Set<string> = new Set()): string {
  let n = Math.max(0, ...set.versions.map((v) => versionOrder(v.id))) + 1;
  while (set.versions.some((v) => v.id === `V${n}`) || taken.has(`V${n}`)) n++;
  return `V${n}`;
}

const reserved = new Map<string, Set<string>>();

export async function registerVersion(
  dataDir: string,
  set: SkillsetDef,
  files: { path: string; content: string }[],
  origin: { from: string; run: number; line: number; note: string },
  status: 'ready' | 'partial',
): Promise<string> {
  const taken = reserved.get(set.id) ?? new Set<string>();
  reserved.set(set.id, taken);
  const id = nextVersionId(set, taken);
  taken.add(id);
  const dir = path.join(dataDir, 'skillsets', set.id, id);
  const createdAt = nowIso();
  await writeTree(path.join(dir, 'files'), files);
  await writeJsonAtomic(path.join(dir, 'version.json'), {
    id,
    skillset: set.id,
    createdAt,
    status,
    origin: { kind: 'training', from: origin.from, run: origin.run, line: origin.line, note: origin.note },
  });
  const entries = files.map((f) => ({ path: f.path, content: f.content, sha256: sha256(f.content), size: Buffer.byteLength(f.content) }));
  set.versions.push({
    id,
    skillset: set.id,
    createdAt,
    origin: { kind: 'training', note: origin.note, from: origin.from, run: origin.run, line: origin.line },
    status,
    files: entries,
    checksum: manifestChecksum(entries),
    generated: true,
    dir: path.join(dir, 'files'),
  });
  return id;
}
