#!/usr/bin/env node
// CLI: проверка настроек и запуск прогона без интерфейса (plan.md, этап 2).
//   clawgym validate
//   clawgym preview <run-config> [--skillset-version V2]
//   clawgym run <run-config> [--skillset-version V2]
import { loadEnv } from './env.js';
import { App } from './app.js';
import { loadRegistry } from './config/loader.js';
import { resolveRun } from './runner/resolve.js';
import type { Issue } from './config/types.js';
import { computeRunMetrics } from './metrics/builtins.js';
import { setLogLevel } from './util/log.js';

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

async function main() {
  const [cmd, target] = process.argv.slice(2);
  const env = loadEnv();
  if (cmd === 'validate') {
    setLogLevel('warn');
    const reg = await loadRegistry(env.home, env.dataDir);
    printIssues(reg.issues);
    const errors = reg.issues.filter((i) => i.severity === 'error').length;
    console.log(`\nФайлов: ${reg.fileCount} · кейсов ${reg.cases.size} · решений ${reg.solutions.size} · корзин ${reg.baskets.size} · прогонов ${reg.runs.size} · ошибок ${errors}`);
    process.exit(errors ? 1 : 0);
  }
  if (cmd === 'preview' && target) {
    setLogLevel('warn');
    const reg = await loadRegistry(env.home, env.dataDir);
    const v = arg('--skillset-version');
    const p = resolveRun(reg, env, target, v ? { skillsetVersion: v } : {});
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
    const v = arg('--skillset-version');
    const run = await app.runs.create(target, v ? { skillsetVersion: v } : {});
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
      if (l.skills.versionNote) console.log(`  ${l.skills.versionNote}`);
      if (l.skills.immutability) console.log(`  Неизменность набора: ${l.skills.immutability.note}`);
    }
    for (const m of computeRunMetrics(r)) console.log(`  ${m.title}: ${m.display}${m.note ? ` · ${m.note}` : ''}${m.reason ? ` (${m.reason})` : ''}`);
    await app.close();
    process.exit(r.status === 'completed' ? 0 : 1);
  }
  console.log('Использование: clawgym validate | preview <run-config> | run <run-config> [--skillset-version V]');
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
