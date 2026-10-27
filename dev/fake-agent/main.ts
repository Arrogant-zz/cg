import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeAgent } from './server.js';

// Стартовые скиллы «сборки» fake-agent лежат рядом с исходниками: dist/dev/fake-agent/main.js → dev/fake-agent/build.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
startFakeAgent({
  port: Number(process.env.FAKE_AGENT_PORT ?? 8091),
  host: process.env.HOST ?? '127.0.0.1',
  mcpUrl: process.env.CLAWGYM_MCP_URL ?? 'http://127.0.0.1:8080/mcp',
  workspaces: path.resolve(process.env.FAKE_AGENT_WORKSPACES ?? '.dev/fake-agent/workspaces'),
  buildSkills: path.resolve(process.env.FAKE_AGENT_BUILD_SKILLS ?? path.join(repo, 'dev/fake-agent/build')),
  failOn: process.env.FAKE_AGENT_FAIL_ON ?? null,
  delayMs: Number(process.env.FAKE_AGENT_DELAY_MS ?? 0),
  slowOn: process.env.FAKE_AGENT_SLOW_ON ?? null,
  slowMs: Number(process.env.FAKE_AGENT_SLOW_MS ?? 0),
}).then(({ url }) => console.log(`fake-agent: ${url}/a2a`));
