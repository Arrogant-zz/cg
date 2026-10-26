// Подготовка выбранного набора скиллов в workspace тестового оператора (SK-03) и выгрузка состояния (SK-04).
// Механизм установки на стенде AEFClaw не подтверждён: здесь адаптеры, а не готовый API агента.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { InstallerDef } from '../config/types.js';
import { resolveEnvRefs } from '../config/loader.js';
import { readTree, safeJoin, walkFiles, writeTree } from '../util/fsx.js';
import { sha256 } from '../util/core.js';
import { renderString } from '../util/template.js';

export interface WsFile {
  path: string;
  content: string;
  sha256: string;
}

export interface Installer {
  kind: InstallerDef['kind'];
  canInstall: boolean;
  canExport: boolean;
  note: string;
  /** Очистка прикладных скиллов и очереди обучения в workspace сессии. */
  prepare(senderId: string): Promise<void>;
  install(senderId: string, files: { path: string; content: string }[]): Promise<void>;
  exportSkills(senderId: string): Promise<WsFile[]>;
  pending(senderId: string): Promise<string[]>;
  readFile(senderId: string, rel: string): Promise<string | null>;
}

class NoInstaller implements Installer {
  kind = 'none' as const;
  canInstall = false;
  canExport = false;
  constructor(public note: string) {}
  async prepare() {
    throw new Error(this.note);
  }
  async install() {
    throw new Error(this.note);
  }
  async exportSkills(): Promise<WsFile[]> {
    throw new Error(this.note);
  }
  async pending(): Promise<string[]> {
    throw new Error(this.note);
  }
  async readFile() {
    return null;
  }
}

class DirectoryInstaller implements Installer {
  kind = 'directory' as const;
  canInstall = true;
  canExport = true;
  note = 'Файлы workspace на общем диске';
  constructor(
    private def: Extract<InstallerDef, { kind: 'directory' }>,
    private env: NodeJS.ProcessEnv,
  ) {}
  private ws(senderId: string): string {
    const root = resolveEnvRefs(this.def.root, this.env);
    if (root.missing.length) throw new Error(`Не заданы переменные окружения: ${root.missing.join(', ')}`);
    const r = renderString(root.value, { senderId });
    return r.includes(senderId) ? r : path.join(r, senderId);
  }
  async prepare(senderId: string) {
    const ws = this.ws(senderId);
    await fsp.rm(path.join(ws, this.def.skillsDir), { recursive: true, force: true });
    await fsp.rm(path.join(ws, this.def.pendingDir), { recursive: true, force: true });
  }
  async install(senderId: string, files: { path: string; content: string }[]) {
    await writeTree(this.ws(senderId), files);
  }
  async exportSkills(senderId: string): Promise<WsFile[]> {
    const ws = this.ws(senderId);
    const tree = await readTree(path.join(ws, this.def.skillsDir));
    return tree.map((f) => ({ path: `${this.def.skillsDir}/${f.path}`, content: f.content, sha256: f.sha256 }));
  }
  async pending(senderId: string): Promise<string[]> {
    return (await walkFiles(path.join(this.ws(senderId), this.def.pendingDir))).map((f) => `${this.def.pendingDir}/${f}`);
  }
  async readFile(senderId: string, rel: string): Promise<string | null> {
    try {
      return await fsp.readFile(safeJoin(this.ws(senderId), rel), 'utf8');
    } catch {
      return null;
    }
  }
}

/** Предложенный контракт установки по HTTP (docs/CONTRACTS.md, раздел «Подготовка знаний»); его реализует dev/fake-agent. */
class HttpInstaller implements Installer {
  kind = 'http' as const;
  canInstall = true;
  canExport = true;
  note = 'HTTP-API workspace (предложенный контракт)';
  constructor(
    private def: Extract<InstallerDef, { kind: 'http' }>,
    private env: NodeJS.ProcessEnv,
  ) {}
  private base(): string {
    const r = resolveEnvRefs(this.def.baseUrl, this.env);
    if (r.missing.length) throw new Error(`Не заданы переменные окружения: ${r.missing.join(', ')}`);
    return r.value.replace(/\/+$/, '');
  }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(this.def.headers)) h[k] = resolveEnvRefs(v, this.env).value;
    return h;
  }
  private async call(method: string, p: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base()}${p}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`Установка набора: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
  async prepare(senderId: string) {
    await this.call('POST', `/workspaces/${encodeURIComponent(senderId)}/prepare`, {});
  }
  async install(senderId: string, files: { path: string; content: string }[]) {
    await this.call('PUT', `/workspaces/${encodeURIComponent(senderId)}/skills`, { files });
  }
  async exportSkills(senderId: string): Promise<WsFile[]> {
    const r = await this.call('GET', `/workspaces/${encodeURIComponent(senderId)}/skills`);
    return (r?.files ?? []).map((f: any) => ({ path: f.path, content: f.content, sha256: sha256(f.content) }));
  }
  async pending(senderId: string): Promise<string[]> {
    const r = await this.call('GET', `/workspaces/${encodeURIComponent(senderId)}/pending`);
    return (r?.cases ?? []).map((c: any) => c.path);
  }
  async readFile(senderId: string, rel: string): Promise<string | null> {
    const r = await this.call('GET', `/workspaces/${encodeURIComponent(senderId)}/file?path=${encodeURIComponent(rel)}`).catch(() => null);
    return r?.content ?? null;
  }
}

export function createInstaller(def: InstallerDef, env: NodeJS.ProcessEnv): Installer {
  if (def.kind === 'directory') return new DirectoryInstaller(def, env);
  if (def.kind === 'http') return new HttpInstaller(def, env);
  return new NoInstaller(def.note);
}
