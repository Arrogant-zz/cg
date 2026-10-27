// Локальный стенд одной командой: ClawGym + fake-agent + fake-gigachat. npm run demo
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { App } from '../src/app.js';
import { startFakeAgent } from './fake-agent/server.js';
import { startFakeGigaChat } from './fake-gigachat/server.js';

async function main() {
  // Корень репозитория — от расположения скрипта (dist/dev/demo.js): относительные CLAWGYM_CONFIG, CLAWGYM_VAR, CLAWGYM_WEB считаются от него.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const port = Number(process.env.PORT ?? 8080);
  const llm = await startFakeGigaChat({ port: Number(process.env.FAKE_GIGACHAT_PORT ?? 8092) });
  const agent = await startFakeAgent({
    port: Number(process.env.FAKE_AGENT_PORT ?? 8091),
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    workspaces: path.join(repo, '.dev/fake-agent/workspaces'),
    // Стартовые скиллы «сборки» fake-agent: новый тестовый оператор начинает с них.
    buildSkills: process.env.FAKE_AGENT_BUILD_SKILLS ?? path.join(repo, 'dev/fake-agent/build'),
    delayMs: Number(process.env.FAKE_AGENT_DELAY_MS ?? 0),
    slowOn: process.env.FAKE_AGENT_SLOW_ON ?? null,
    slowMs: Number(process.env.FAKE_AGENT_SLOW_MS ?? 0),
  });
  process.env.FAKE_GIGACHAT_URL = llm.url;
  process.env.FAKE_AGENT_URL = agent.url;
  // Окружение — после адресов fake-сервисов: на них ссылаются ${env:…} в agents/ и models/.
  const env = loadEnv({ ...process.env, PORT: String(port), HOST: process.env.HOST ?? '127.0.0.1' }, repo);
  console.log(`ClawGym demo: справочники ${env.configDir} · данные ${env.varDir}`);
  const app = new App(env);
  await app.init();
  await app.listen();
  console.log(`\nClawGym: http://127.0.0.1:${port}\nfake-agent: ${agent.url} · fake-gigachat: ${llm.url}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
