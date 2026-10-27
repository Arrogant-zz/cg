import { startFakeGigaChat } from './server.js';

const port = Number(process.env.FAKE_GIGACHAT_PORT ?? 8092);
startFakeGigaChat({ port, host: process.env.HOST ?? '127.0.0.1' }).then(({ url }) => console.log(`fake-gigachat: ${url}/v1/chat/completions и ${url}/v2/chat/completions`));
