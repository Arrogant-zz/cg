// Каталоги офлайн-демо по умолчанию: демонстрационный набор справочников и свои данные рядом с рабочими папками fake-agent.

/** Справочники демо — демонстрационный набор. Относительный путь считается от корня репозитория. */
export const DEMO_CONFIG = 'dev/config';
/** Данные демо: прогоны и ручные сессии лежат рядом со скиллами их операторов в .dev/fake-agent/workspaces. */
export const DEMO_VAR = '.dev/var';

/**
 * Окружение демо: CLAWGYM_CONFIG и CLAWGYM_VAR получают значения по умолчанию, если не заданы; пустая строка — «не задано», как в loadEnv.
 * Заданные значения сильнее: CLAWGYM_CONFIG=config запускает fake-agent на своих справочниках.
 */
export function demoEnv(e: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...e, CLAWGYM_CONFIG: e.CLAWGYM_CONFIG || DEMO_CONFIG, CLAWGYM_VAR: e.CLAWGYM_VAR || DEMO_VAR };
}
