// Оболочка интерфейса: маршруты, навигация, обновления по SSE, обратный отсчёт.
import { get, html, onEvent, toast, fmtTime, fmtClock } from './lib.js';

const routes = [
  [/^\/$/, 'runs', () => import('./pages/runs.js')],
  [/^\/runs\/new$/, 'setup', () => import('./pages/setup.js')],
  [/^\/runs\/(\d+)$/, 'runs', () => import('./pages/run.js')],
  [/^\/runs\/(\d+)\/cases\/([^/]+)$/, 'runs', () => import('./pages/exec.js')],
  [/^\/compare$/, 'compare', () => import('./pages/compare.js')],
  [/^\/manual$/, 'manual', () => import('./pages/manual.js')],
  [/^\/manual\/(\d+)$/, 'manual', () => import('./pages/session.js')],
  [/^\/cases(?:\/([^/]+))?$/, 'cases', () => import('./pages/cases.js')],
  [/^\/baskets(?:\/([^/]+))?$/, 'baskets', () => import('./pages/baskets.js')],
  [/^\/skillsets(?:\/([^/]+))?$/, 'skillsets', () => import('./pages/skillsets.js')],
  [/^\/directory$/, 'directory', () => import('./pages/directory.js')],
];

const main = document.getElementById('main');
let current = null;
let token = 0;

function setNav(name) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    const on = a.dataset.nav === name;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

export function navigate(url, replace = false) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  route();
}

async function route() {
  const url = new URL(location.href);
  const found = routes.find(([re]) => re.test(url.pathname));
  const my = ++token;
  if (!found) {
    main.innerHTML = '<h1 class="h1">Страница не найдена</h1><p class="lede"><a href="/" data-link>К прогонам</a></p>';
    return;
  }
  const [re, nav, load] = found;
  setNav(nav);
  const mod = await load();
  if (my !== token) return;
  current?.cleanup?.();
  const ctx = {
    params: re.exec(url.pathname).slice(1).map((x) => (x === undefined ? undefined : decodeURIComponent(x))),
    query: url.searchParams,
    state: {},
    navigate,
    rerender: () => render(ctx, mod, my, true),
  };
  current = { ctx, mod, cleanup: null };
  main.innerHTML = '<p class="loading">Загрузка…</p>';
  await render(ctx, mod, my, false);
  if (my !== token) return;
  if (mod.title) document.title = `${typeof mod.title === 'function' ? mod.title(ctx) : mod.title} · ClawGym`;
  const off = onEvent((msg) => {
    if (mod.refreshOn?.(msg, ctx)) schedule(ctx, mod, my);
  });
  const stop = mod.mount?.(main, ctx);
  current.cleanup = () => {
    off();
    stop?.();
  };
  if (!replaceScroll) window.scrollTo(0, 0);
  if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView();
}
let replaceScroll = false;

let timer = null;
function schedule(ctx, mod, my) {
  clearTimeout(timer);
  timer = setTimeout(() => render(ctx, mod, my, true), 350);
}

async function render(ctx, mod, my, keepScroll) {
  try {
    const out = await mod.render(ctx);
    if (my !== token) return;
    const y = window.scrollY;
    if (mod.patch && keepScroll) mod.patch(main, out, ctx);
    else main.innerHTML = String(out);
    if (keepScroll) window.scrollTo(0, y);
    // Раскрытые блоки остаются раскрытыми после обновления по SSE.
    for (const id of ctx.state.openIds ?? []) {
      const d = document.getElementById(id);
      if (d && d.tagName === 'DETAILS') d.open = true;
    }
    // Переход к событию или обмену, запрошенный действием страницы.
    if (ctx.state.focus) {
      const el = document.getElementById(ctx.state.focus);
      ctx.state.focus = null;
      if (el) {
        if (el.tagName === 'DETAILS') el.open = true;
        el.scrollIntoView({ block: 'center' });
      }
    }
    tick();
  } catch (e) {
    if (my !== token) return;
    if (!keepScroll) main.innerHTML = String(html`<h1 class="h1">Не удалось открыть страницу</h1><p class="lede">${e.message}</p>`);
    else toast(e.message, true);
  }
}

// Ссылки внутри приложения без перезагрузки.
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href]');
  if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('http') || href.startsWith('/api/') || href.startsWith('/static/')) return;
  if (href.startsWith('#')) {
    ev.preventDefault();
    document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  ev.preventDefault();
  navigate(href);
});

main.addEventListener(
  'toggle',
  (ev) => {
    const d = ev.target;
    if (!current || d.tagName !== 'DETAILS' || !d.id) return;
    const set = (current.ctx.state.openIds ??= new Set());
    if (d.open) set.add(d.id);
    else set.delete(d.id);
  },
  true,
);

// Копирование тела запроса или ответа.
async function copyFrom(el) {
  const target = document.getElementById(el.dataset.target);
  if (!target) return;
  try {
    await navigator.clipboard.writeText(target.textContent ?? '');
    toast('Скопировано');
  } catch {
    const r = document.createRange();
    r.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    toast('Текст выделен — скопируйте его сочетанием клавиш');
  }
}

// Enter отправляет: data-enter — по Enter (Shift+Enter — перенос строки), data-enter-mod — по Cmd/Ctrl+Enter.
main.addEventListener('keydown', async (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229 || !current) return;
  const el = ev.target.closest('[data-enter],[data-enter-mod]');
  if (!el || el.disabled) return;
  const mod = ev.metaKey || ev.ctrlKey;
  let name = null;
  if (el.dataset.enter && !ev.shiftKey && !ev.altKey) name = el.dataset.enter;
  else if (el.dataset.enterMod && mod) name = el.dataset.enterMod;
  if (!name) return;
  const fn = current.mod.actions?.[name];
  if (!fn) return;
  ev.preventDefault();
  try {
    await fn(el, current.ctx, ev);
  } catch (e) {
    toast(e.message, true);
  }
});

// Действия страниц: data-action на кнопках, data-change на полях, data-submit на формах.
main.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || !current) return;
  if (el.dataset.action === 'copy') {
    ev.preventDefault();
    ev.stopPropagation();
    return copyFrom(el);
  }
  const fn = current.mod.actions?.[el.dataset.action];
  if (!fn) return;
  ev.preventDefault();
  if (el.tagName === 'BUTTON') el.setAttribute('aria-busy', 'true');
  try {
    await fn(el, current.ctx, ev);
  } catch (e) {
    toast(e.message, true);
  } finally {
    el.removeAttribute('aria-busy');
  }
});
main.addEventListener('change', async (ev) => {
  const el = ev.target.closest('[data-change]');
  if (!el || !current) return;
  try {
    await current.mod.actions?.[el.dataset.change]?.(el, current.ctx, ev);
  } catch (e) {
    toast(e.message, true);
  }
});
main.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-submit]');
  if (!form || !current) return;
  ev.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  btn?.setAttribute('aria-busy', 'true');
  try {
    await current.mod.actions?.[form.dataset.submit]?.(form, current.ctx, ev);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn?.removeAttribute('aria-busy');
  }
});

// Обратный отсчёт удерживаемых вызовов и длительность выполняющихся шагов.
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-deadline]')) {
    const left = Date.parse(el.dataset.deadline) - now;
    el.textContent = left > 0 ? fmtClock(left) : '0:00';
  }
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmtClock(now - Date.parse(el.dataset.since));
}
setInterval(tick, 1000);

// Подвал меню: доступность агента, сессии, проверка файлов.
async function foot() {
  try {
    const s = await get('/api/status');
    const el = document.getElementById('side-foot');
    const agents = s.agents.map((a) => `<div class="row"><span class="dot ${a.ok === true ? 'ok' : a.ok === false ? 'bad' : ''}"></span><span>${escapeHtml(a.title)} · ${escapeHtml(a.ok === true ? 'доступен' : a.note || 'не проверялся')}</span></div>`);
    el.innerHTML = [
      ...agents,
      `<div class="row"><span class="dot done"></span><span>Сессии агента: ${s.sessions.used} из ${s.sessions.capacity}</span></div>`,
      `<div class="row"><span class="dot ${s.config.errors ? 'bad' : 'ok'}"></span><span>${s.config.errors ? `Ошибок в файлах: ${s.config.errors}` : `Файлы проверены в ${fmtTime(s.config.loadedAt)}`}</span></div>`,
      s.contract?.conditional ? '<div class="row"><span class="dot"></span><span>Контракт инструментов условный</span></div>' : '',
    ].join('');
  } catch {
    /* сервер недоступен — подвал останется прежним */
  }
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let footTimer = null;
onEvent((msg) => {
  if (['stand', 'health', 'config', 'run', 'manual'].includes(msg.type)) {
    clearTimeout(footTimer);
    footTimer = setTimeout(foot, 500);
  }
});
setInterval(foot, 30000);
foot();

window.addEventListener('popstate', route);
route();
