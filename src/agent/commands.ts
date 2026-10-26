// Служебные команды и разбор строки результата по INTEGRATION.md («Разбор ответа агента и сверка с журналом»).
import type { AgentDef } from '../config/types.js';
import { renderString } from '../util/template.js';

export type CommandName = 'reset' | 'capture' | 'curator';

export const COMMAND_TITLES: Record<CommandName, string> = {
  reset: '/reset',
  capture: '/case-capture',
  curator: '/skill-curator',
};

export function renderCommand(agent: AgentDef, name: CommandName, vars: { requestRef?: string; topic?: string }): string {
  return renderString(agent.commands[name], { requestRef: vars.requestRef ?? '', topic: vars.topic ?? '' }).trim();
}

/** Края строки: пробелы и ` " ' « » * — модель может обернуть строку скрипта. */
function clean(line: string): string {
  return line.trim().replace(/^[\s`"'«»*]+|[\s`"'«»*]+$/g, '');
}

function lastMatch(text: string, res: RegExp[]): { re: number; m: RegExpExecArray; line: string } | null {
  let found: { re: number; m: RegExpExecArray; line: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw);
    for (let i = 0; i < res.length; i++) {
      const m = res[i].exec(line);
      if (m) found = { re: i, m, line };
    }
  }
  return found;
}

const CAPTURE = [/^Case captured: (\S+) — signal: (strong|medium|weak|none)$/, /^Case capture skipped: .*$/, /^Case capture failed: (.*)$/];

export type CaptureResult =
  | { kind: 'captured'; path: string; signal: string; line: string }
  | { kind: 'skipped'; line: string }
  | { kind: 'failed'; reason: string; line: string }
  | { kind: 'unrecognized' };

export function parseCapture(text: string): CaptureResult {
  const f = lastMatch(text, CAPTURE);
  if (!f) return { kind: 'unrecognized' };
  if (f.re === 0) return { kind: 'captured', path: f.m[1], signal: f.m[2], line: f.line };
  if (f.re === 1) return { kind: 'skipped', line: f.line };
  return { kind: 'failed', reason: f.m[1], line: f.line };
}

const CURATOR = [
  /^Curator complete: (\d+) processed, (\d+|\?) left, (\d+) updated, (\d+) routing fixes, (\d+) created, (\d+) conflicts\. Report: (\S+)$/,
  /^No pending cases\.$/,
  /^Curator failed: (.*)$/,
];

export type CuratorResult =
  | { kind: 'complete'; processed: number; left: number | null; updated: number; routing: number; created: number; conflicts: number; report: string; line: string }
  | { kind: 'empty'; line: string }
  | { kind: 'failed'; reason: string; line: string }
  | { kind: 'unrecognized' };

export function parseCurator(text: string): CuratorResult {
  const f = lastMatch(text, CURATOR);
  if (!f) return { kind: 'unrecognized' };
  if (f.re === 0) {
    const m = f.m;
    return {
      kind: 'complete',
      processed: Number(m[1]),
      left: m[2] === '?' ? null : Number(m[2]),
      updated: Number(m[3]),
      routing: Number(m[4]),
      created: Number(m[5]),
      conflicts: Number(m[6]),
      report: m[7],
      line: f.line,
    };
  }
  if (f.re === 1) return { kind: 'empty', line: f.line };
  return { kind: 'failed', reason: f.m[1], line: f.line };
}
