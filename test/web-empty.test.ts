// Экраны на справочниках без кейсов, корзин и настроек прогонов (web/js/pages): экран называет пустой каталог
// и не предлагает действие, которое без файлов не выполнится.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Модули страниц без DOM на верхнем уровне — загружаются как есть, без сборки; ответы API подменяются через fetch.
const page = (file: string) => import(pathToFileURL(path.resolve('web/js/pages', file)).href);

const realFetch = globalThis.fetch;
const realFormData = globalThis.FormData;
after(() => {
  globalThis.fetch = realFetch;
  globalThis.FormData = realFormData;
});

// Свёрнутые папки списка кейсов страница хранит в localStorage браузера. В тесте его заменяет пустое хранилище:
// результат не зависит от того, есть ли localStorage в этой версии Node.js.
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => undefined }, configurable: true });

/** Ответы API по адресу; адрес без ответа получает 404, как у стенда. Возвращает список запросов. */
function api(data: Record<string, unknown>): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const p = String(input);
    requests.push(`${init?.method ?? 'GET'} ${p}`);
    return p in data ? new Response(JSON.stringify(data[p]), { status: 200 }) : new Response(JSON.stringify({ error: 'Не найдено' }), { status: 404 });
  }) as typeof fetch;
  return requests;
}

const ctx = (state: Record<string, unknown> = {}) => ({ params: [] as string[], state, query: new URLSearchParams() });
const render = async (file: string, state?: Record<string, unknown>) => String(await (await page(file)).render(ctx(state)));

const noCases = { cases: [], solutions: 0, errors: 0, warnings: 0 };
const oneCase = { cases: [{ id: 'card-test', title: 'Тестовый кейс', topic: 'Карты / Тест', tags: [], file: 'cases/card-test.yaml', folder: '', solutions: 0, errors: 0, warnings: 0 }], solutions: 0, errors: 0, warnings: 0 };
const manualApi = { '/api/directory': { agents: [{ id: 'fake-agent', title: 'fake-agent', health: null }], tools: [], models: [] }, '/api/manual': [], '/api/runs': { runs: [], manual: [] } };
const disabledSubmit = /<button[^>]*type="submit"[^>]*\sdisabled/;

test('«Кейсы и решения»: без кейсов экран называет cases/ и что сделать; поиск без совпадений — «Ничего не найдено»', async () => {
  api({ '/api/cases': noCases });
  const empty = await render('cases.js');
  assert.match(empty, /В cases\/ нет кейсов\./);
  assert.match(empty, /Добавьте файл кейса в cases\/ и нажмите «Перечитать файлы»\./);
  assert.doesNotMatch(empty, /Ничего не найдено/, 'пустой каталог — не поиск без совпадений');
  assert.doesNotMatch(empty, /Поиск по кейсам/, 'искать не в чем');
  assert.match(empty, /data-action="reload"/, 'перечитать файлы можно');

  // Кейс есть: его страница в этом тесте не подменена (404), поэтому справа — «Выберите кейс».
  api({ '/api/cases': oneCase });
  const miss = await render('cases.js', { q: 'нет такого' });
  assert.match(miss, /Ничего не найдено/);
  assert.doesNotMatch(miss, /В cases\/ нет кейсов/);
  const found = await render('cases.js');
  assert.match(found, /card-test/);
  assert.match(found, /Выберите кейс\./);
  assert.doesNotMatch(found, /Ничего не найдено|В cases\/ нет кейсов|Добавьте файл кейса/);
});

test('«Ручной режим»: без кейсов на месте выбора кейса причина, «Начать кейс» недоступна и ничего не отправляет; с кейсами — выбор и доступная кнопка', async () => {
  const requests = api({ '/api/cases': noCases, ...manualApi });
  const empty = await render('manual.js');
  assert.match(empty, /В cases\/ нет кейсов\./);
  assert.match(empty, disabledSubmit);
  assert.doesNotMatch(empty, /<select[^>]*name="case"/, 'выбора кейса нет');

  // Отправка формы без кейса ничего не делает: запрос на открытие сессии не уходит.
  globalThis.FormData = class {
    get(): null {
      return null;
    }
  } as unknown as typeof FormData;
  requests.length = 0;
  await (await page('manual.js')).actions.start({}, ctx());
  assert.deepEqual(requests, []);

  api({ '/api/cases': oneCase, ...manualApi });
  const ready = await render('manual.js');
  assert.match(ready, /<select[^>]*name="case"/);
  assert.match(ready, /card-test · Тестовый кейс/);
  assert.doesNotMatch(ready, disabledSubmit);
  assert.doesNotMatch(ready, /В cases\/ нет кейсов/);
});

test('«Запуск прогона» и «Корзины»: без файлов экраны называют runs/ и baskets/, запуск не предлагается', async () => {
  api({ '/api/run-configs': [], '/api/baskets': [] });
  const setup = await render('setup.js');
  assert.match(setup, /В каталоге runs\/ нет файлов прогонов\./);
  assert.doesNotMatch(setup, /Запустить прогон/, 'запуск не предлагается');
  assert.match(await render('baskets.js'), /В baskets\/ нет корзин\./);
});
