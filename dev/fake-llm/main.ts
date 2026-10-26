import { startFakeLlm } from './server.js';

const port = Number(process.env.FAKE_LLM_PORT ?? 8092);
startFakeLlm(port, process.env.HOST ?? '127.0.0.1').then(({ url }) => console.log(`fake-llm: ${url}/chat/completions`));
