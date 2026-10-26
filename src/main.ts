// Точка входа сервиса: node dist/src/main.js. Конфигурация — переменные окружения (README).
import { loadEnv } from './env.js';
import { App } from './app.js';
import { logger } from './util/log.js';

const log = logger('main');

async function main() {
  const env = loadEnv();
  const app = new App(env);
  await app.init();
  const { port, mcpPort } = await app.listen();
  log.info(`ClawGym ${app.version} слушает http://${env.host}:${port} · MCP ${env.mcpPath}${mcpPort ? ` и порт ${mcpPort}` : ''}`);
  log.info(`Настройки: ${env.home} · данные: ${env.dataDir}`);
  const stop = async (sig: string) => {
    log.info(`Получен ${sig}, останавливаюсь`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
