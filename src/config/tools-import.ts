// Импорт и сверка контракта инструментов с tools/list настоящего MCP-сервера оркестратора (AG-03, drift-check).
// Поля MCP берутся из ответа как есть; пометки ClawGym (requiresConfirmation, kind, enabled, terminal) переносятся из текущего контракта.
import fsp from 'node:fs/promises';
import { stableStringify } from '../util/core.js';

/** Пометки ClawGym в определении инструмента: агенту не отдаются, import-tools переносит их из текущего контракта. */
export const CLAWGYM_TOOL_FIELDS = ['requiresConfirmation', 'kind', 'enabled', 'terminal'] as const;

type Tool = Record<string, any>;

/** Часть определения, которую видит агент: всё, кроме пометок ClawGym. */
export function mcpPart(t: Tool): Tool {
  const out: Tool = {};
  for (const [k, v] of Object.entries(t)) if (!(CLAWGYM_TOOL_FIELDS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

/** Список инструментов из ответа JSON-RPC, объекта { tools } или массива. */
export function toolsFromJson(data: any): Tool[] {
  const list = Array.isArray(data) ? data : Array.isArray(data?.tools) ? data.tools : data?.result?.tools;
  if (!Array.isArray(list)) throw new Error('В ответе нет списка инструментов: ожидается result.tools, tools или массив');
  for (const [i, t] of list.entries()) if (typeof t?.name !== 'string') throw new Error(`Инструмент №${i + 1} без name`);
  return list;
}

function parseRpc(text: string): any {
  // Streamable HTTP может ответить потоком SSE: берётся первое событие с data.
  const body = text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text;
  const json = JSON.parse(body);
  if (json.error) throw new Error(`MCP: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

/** initialize → notifications/initialized → tools/list с постраничным nextCursor. Сервер без сессий (STATELESS) тоже подходит. */
export async function fetchToolsList(url: string, headers: Record<string, string>, timeoutMs = 30_000): Promise<Tool[]> {
  let session: string | null = null;
  const rpc = async (body: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    if (res.status === 202 || !text) return null;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    return parseRpc(text);
  };
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'clawgym-import-tools', version: '0.1.0' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await rpc({ jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor ? { cursor } : {} });
    tools.push(...toolsFromJson(r));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

export async function readToolsFile(file: string): Promise<Tool[]> {
  return toolsFromJson(JSON.parse(await fsp.readFile(file, 'utf8')));
}

export interface ToolsDiff {
  tools: Tool[];
  added: string[];
  removed: string[];
  changed: { name: string; fields: string[] }[];
}

/**
 * Новый список в порядке оркестратора: поля MCP — из ответа, пометки ClawGym — из текущего контракта.
 * Новые инструменты без пометок: информационные, без подтверждения, не терминальные.
 */
export function mergeTools(current: Tool[], incoming: Tool[]): ToolsDiff {
  const byName = new Map(current.map((t) => [t.name, t]));
  const incomingNames = new Set(incoming.map((t) => t.name));
  const added: string[] = [];
  const changed: { name: string; fields: string[] }[] = [];
  const tools = incoming.map((t) => {
    const mine = byName.get(t.name);
    const next: Tool = { ...mcpPart(t) };
    if (!mine) {
      added.push(t.name);
      return next;
    }
    const a = mcpPart(mine);
    const b = mcpPart(t);
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stableStringify(a[k]) !== stableStringify(b[k]));
    if (fields.length) changed.push({ name: t.name, fields });
    for (const k of CLAWGYM_TOOL_FIELDS) if (mine[k] !== undefined) next[k] = mine[k];
    return next;
  });
  const removed = current.map((t) => t.name).filter((n) => !incomingNames.has(n));
  return { tools, added, removed, changed };
}
