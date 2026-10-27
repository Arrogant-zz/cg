#!/usr/bin/env node
// CLI: проверка настроек и запуск прогона без интерфейса (plan.md, этап 2).
//   clawgym validate
//   clawgym preview <run-config> [--continue <номер прогона> | --continue new]
//   clawgym run <run-config> [--continue <номер прогона> | --continue new]
//   clawgym import-tools (--url <MCP оркестратора> | --file <ответ tools/list>) [--header "Имя: значение"]... [--check]
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from './env.js';
import { App } from './app.js';
import { loadRegistry } from './config/loader.js';
import { resolveRun, type RunOverrides } from './runner/resolve.js';
import { ResultsStore } from './results/store.js';
import type { RunRecord } from './runner/types.js';
import type { Issue } from './config/types.js';
import { computeRunMetrics } from './metrics/builtins.js';
import { setLogLevel } from './util/log.js';
import { fetchToolsList, mergeTools, readToolsFile } from './config/tools-import.js';

/** --continue N — продолжить на тестовом операторе прогона N; --continue new — новый оператор; без ключа — как в файле прогона. */
function continueArg(): RunOverrides {
  const v = arg('--continue');
  if (!v) return {};
  if (v === 'new') return { continueFrom: 'new' };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error('--continue: номер прогона или new');
  return { continueFrom: n };
}

function printIssues(issues: Issue[]) {
  for (const i of issues) {
    const where = `${i.file}${i.line ? `:${i.line}` : ''}${i.field ? ` · ${i.field}` : ''}`;
    console.log(`${i.severity === 'error' ? 'ОШИБКА ' : 'внимание'} ${where}\n         ${i.reason}${i.action ? `\n         → ${i.action}` : ''}`);
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]] : []));
}

/** Контракт из tools/list оркестратора: записать (по умолчанию) или только сверить (--check, код выхода 1 при расхождении). */
async function importTools(configDir: string): Promise<number> {
  const url = arg('--url');
  const file = arg('--file');
  if (!url === !file) {
    console.log('Укажите --url <адрес MCP оркестратора> или --file <сохранённый ответ tools/list>');
    return 2;
  }
  const headers: Record<string, string> = {};
  for (const h of args('--header')) {
    const i = h.indexOf(':');
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const incoming = url ? await fetchToolsList(url, headers) : await readToolsFile(path.resolve(file!));
  const target = path.join(configDir, 'contracts/tools.json');
  const contract = JSON.parse(await fsp.readFile(target, 'utf8'));
  const diff = mergeTools(contract.tools ?? [], incoming);
  console.log(`Инструментов у оркестратора: ${incoming.length}, в контракте: ${(contract.tools ?? []).length}`);
  for (const n of diff.added) console.log(`  + ${n} — новый: информационный, без подтверждения; проверьте пометки`);
  for (const n of diff.removed) console.log(`  − ${n} — нет у оркестратора`);
  for (const c of diff.changed) console.log(`  ~ ${c.name}: ${c.fields.join(', ')}`);
  const same = !diff.added.length && !diff.removed.length && !diff.changed.length;
  if (process.argv.includes('--check')) {
    console.log(same ? 'Контракт совпадает с оркестратором.' : 'Контракт расходится с оркестратором.');
    return same ? 0 : 1;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  contract.version = `imported-${stamp}`;
  contract.note = `Инструменты сняты из tools/list ${url ?? path.basename(file!)} ${stamp} командой import-tools. Пометки requiresConfirmation, kind и enabled — ClawGym.`;
  contract.tools = diff.tools;
  await fsp.writeFile(target, JSON.stringify(contract, null, 2) + '\n', 'utf8');
  console.log(`${same ? 'Изменений нет. ' : ''}Записано: ${target}`);
  return 0;
}

async function main() {
  const [cmd, target] = process.argv.slice(2);
  const env = loadEnv();
  if (cmd === 'validate') {
    setLogLevel('warn');
    const reg = await loadRegistry(env.configDir);
    printIssues(reg.issues);
    const errors = reg.issues.filter((i) => i.severity === 'error').length;
    console.log(`\nФайлов: ${reg.fileCount} · кейсов ${reg.cases.size} · решений ${reg.solutions.size} · корзин ${reg.baskets.size} · прогонов ${reg.runs.size} · ошибок ${errors}`);
    process.exit(errors ? 1 : 0);
  }
  if (cmd === 'preview' && target) {
    setLogLevel('warn');
    const reg = await loadRegistry(env.configDir);
    const runs = (await new ResultsStore(env.varDir).loadRuns()) as RunRecord[];
    const p = resolveRun(reg, env, target, continueArg(), runs);
    printIssues(p.issues);
    console.log('\nПлан команд:');
    for (const s of p.plan) console.log(s.kind === 'case' ? `  /reset → кейс ${s.pos} (${s.solution})${s.capture ? ' → /case-capture' : ''}` : `  /skill-curator ${s.pass}${s.reason === 'final' ? ' (финальный)' : ''}`);
    for (const t of p.planText) console.log(`  · ${t}`);
    console.log('\nМетрики:');
    for (const m of p.metrics) console.log(`  ${m.available ? '✓' : '–'} ${m.title}${m.reason ? ` — ${m.reason}` : ''}`);
    console.log(p.ok ? '\nПрогон можно запустить.' : '\nПрогон не запустится: исправьте ошибки.');
    process.exit(p.ok ? 0 : 1);
  }
  if (cmd === 'run' && target) {
    const app = new App(env);
    await app.init();
    await app.listen();
    const run = await app.runs.create(target, continueArg());
    console.log(`Прогон #${run.id} поставлен в очередь`);
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        const r = app.runs.get(run.id);
        if (['completed', 'stopped', 'failed'].includes(r.status)) {
          clearInterval(t);
          resolve();
        }
      }, 1000);
    });
    const r = app.runs.get(run.id);
    console.log(`\nПрогон #${r.id}: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
    for (const l of r.lines) {
      for (const i of l.items.filter((x) => x.kind === 'case')) console.log(`  ${i.pos}. ${i.case?.id} · ${i.solution?.title}: ${i.outcome ?? i.status} — ${i.reason}`);
      console.log(`  Тестовый оператор: x-a2a-sender-id = ${l.senderId} — на нём можно продолжить: --continue ${r.id}`);
    }
    for (const m of computeRunMetrics(r)) console.log(`  ${m.title}: ${m.display}${m.note ? ` · ${m.note}` : ''}${m.reason ? ` (${m.reason})` : ''}`);
    await app.close();
    process.exit(r.status === 'completed' ? 0 : 1);
  }
  if (cmd === 'import-tools') process.exit(await importTools(env.configDir));
  console.log('Использование: clawgym validate | preview <run-config> | run <run-config> [--continue N|new] | import-tools (--url U | --file F) [--header H] [--check]');
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
