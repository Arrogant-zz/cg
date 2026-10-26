// Локальный стенд одной командой: ClawGym + fake-agent + fake-llm. npm run demo
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { App } from '../src/app.js';
import { startFakeAgent } from './fake-agent/server.js';
import { startFakeLlm } from './fake-llm/server.js';

async function main() {
  // Корень репозитория — от расположения скрипта (dist/dev/demo.js), если CLAWGYM_HOME не задан.
  const home = path.resolve(process.env.CLAWGYM_HOME ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  console.log(`ClawGym demo: настройки ${home}`);
  const port = Number(process.env.PORT ?? 8080);
  const llm = await startFakeLlm(Number(process.env.FAKE_LLM_PORT ?? 8092));
  const agent = await startFakeAgent({
    port: Number(process.env.FAKE_AGENT_PORT ?? 8091),
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    workspaces: path.join(home, '.dev/fake-agent/workspaces'),
    buildSkills: path.join(home, 'skillsets/cards/V1'),
    delayMs: Number(process.env.FAKE_AGENT_DELAY_MS ?? 0),
  });
  process.env.FAKE_LLM_URL = llm.url;
  process.env.FAKE_AGENT_URL = agent.url;
  const app = new App(loadEnv({ ...process.env, PORT: String(port), HOST: process.env.HOST ?? '127.0.0.1' }, home));
  await app.init();
  await app.listen();
  console.log(`\nClawGym: http://127.0.0.1:${port}\nfake-agent: ${agent.url} · fake-llm: ${llm.url}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
