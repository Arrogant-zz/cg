import path from 'node:path';
import { startFakeAgent } from './server.js';

const home = path.resolve(process.env.CLAWGYM_HOME ?? '.');
startFakeAgent({
  port: Number(process.env.FAKE_AGENT_PORT ?? 8091),
  host: process.env.HOST ?? '127.0.0.1',
  mcpUrl: process.env.CLAWGYM_MCP_URL ?? 'http://127.0.0.1:8080/mcp',
  workspaces: path.resolve(process.env.FAKE_AGENT_WORKSPACES ?? path.join(home, '.dev/fake-agent/workspaces')),
  buildSkills: path.resolve(process.env.FAKE_AGENT_BUILD_SKILLS ?? path.join(home, 'skillsets/second-line/V1')),
  failOn: process.env.FAKE_AGENT_FAIL_ON ?? null,
  delayMs: Number(process.env.FAKE_AGENT_DELAY_MS ?? 0),
}).then(({ url }) => console.log(`fake-agent: ${url}/a2a · workspace API ${url}/admin`));
