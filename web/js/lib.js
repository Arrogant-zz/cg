// Общие помощники интерфейса: безопасная разметка, иконки, форматирование, API и компоненты дизайн-системы.
import { markdown } from './md.js';

class Html {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Html(String(s ?? ''));
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}
/** Шаблон с экранированием подстановок; Html и массивы Html вставляются как есть. */
export function html(strings, ...vals) {
  let s = strings[0];
  for (let i = 0; i < vals.length; i++) s += val(vals[i]) + strings[i + 1];
  return new Html(s);
}

const P = {
  runs: '<path d="M3.5 12h3.8l2.4-6.5 4.6 13 2.4-6.5h3.8"/>',
  play: '<path d="M8 5.8v12.4a.6.6 0 0 0 .9.5l9.6-6.2a.6.6 0 0 0 0-1L8.9 5.3a.6.6 0 0 0-.9.5z"/>',
  chat: '<path d="M5 5.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8.5L6 20v-3.5H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/>',
  compare: '<rect x="3.5" y="5" width="7" height="14" rx="1.5"/><rect x="13.5" y="5" width="7" height="14" rx="1.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.9-3.5 3.6-5.5 7-5.5s6.1 2 7 5.5"/>',
  arrow: '<path d="M4.5 12h15M14 6.5l5.5 5.5-5.5 5.5"/>',
  arrowDown: '<path d="M12 4.5v15M6.5 14l5.5 5.5 5.5-5.5"/>',
  bolt: '<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8v.1"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 4.5V9H9"/>',
  capture: '<path d="M7 4.5h10a.5.5 0 0 1 .5.5v14.5l-5.5-3.6-5.5 3.6V5a.5.5 0 0 1 .5-.5z"/>',
  curator: '<path d="M10 4l1.6 4.4L16 10l-4.4 1.6L10 16l-1.6-4.4L4 10l4.4-1.6z"/><path d="M17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L4.5 16.5a1.4 1.4 0 0 0 2 2l4.9-4.9a4 4 0 0 0 5.3-5.3l-2.4 2.4-2-2z"/>',
  bot: '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4.5V8"/><path d="M9.5 13v1.5M14.5 13v1.5"/>',
  judge: '<path d="M12 4.5v15M8 19.5h8M5.5 7.5h13"/><path d="M5.5 7.5L3 13.5a2.6 2.6 0 0 0 5 0z"/><path d="M18.5 7.5L16 13.5a2.6 2.6 0 0 0 5 0z"/>',
  hidden: '<path d="M3 12s3.3-6 9-6c1.7 0 3.2.5 4.4 1.3M21 12s-3.3 6-9 6c-1.7 0-3.2-.5-4.4-1.3"/><path d="M10 14a3 3 0 0 1 4-4"/><path d="M4.5 19.5l15-15"/>',
  eye: '<path d="M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.8"/>',
  flag: '<path d="M6 20.5v-16"/><path d="M6 5h11l-2 3.5 2 3.5H6"/>',
  file: '<path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13.5 3.5v4h4"/>',
  folder: '<path d="M3.5 7a1 1 0 0 1 1-1h4.8l2 2.3h8.2a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v4.5"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  warn: '<path d="M12 4.2l8.8 15.3H3.2z"/><path d="M12 10v4.2"/><path d="M12 17.1v.1"/>',
  check: '<path d="M5 12.5l4.3 4.3L19 7.2"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  minus: '<path d="M6 12h12"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1"/><path d="M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.5v3.4h-3.4"/><path d="M6.5 20.5v-3.4h3.4"/>',
  chevDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevRight: '<path d="M9.5 6l6 6-6 6"/>',
  download: '<path d="M12 4.5v11M7 11l5 5 5-5"/><path d="M5 19.5h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.2a.7.7 0 0 1 .7-.7h3.6a.7.7 0 0 1 .7.7V7"/><path d="M6.5 7l.9 11.6a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7M10.2 10.5v5.5M13.8 10.5v5.5"/>',
  send: '<path d="M5 12l14.5-7-5 15-3-6z"/><path d="M11.5 14l8-9"/>',
  swap: '<path d="M4.5 9h14M15 5.5L18.5 9 15 12.5"/><path d="M19.5 15h-14M9 11.5L5.5 15 9 18.5"/>',
  layers: '<path d="M12 4l8.5 4.3L12 12.6 3.5 8.3z"/><path d="M3.5 12.2L12 16.5l8.5-4.3"/><path d="M3.5 16L12 20.3l8.5-4.3"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] ?? ''}</svg>`);

// ----------------------------------------------------------------- форматирование

export function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  return withTime ? `${date}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : date;
}
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—');
export function fmtClock(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtDur(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин${s % 60 ? ` ${String(s % 60).padStart(2, '0')} с` : ''}`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
export const since = (iso, until) => (iso ? (until ? Date.parse(until) : Date.now()) - Date.parse(iso) : null);
export function plural(n, one, few, many) {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
export const jsonText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 0));

// ----------------------------------------------------------------- API и события

export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = new Error(data?.error ?? `HTTP ${res.status}`);
    e.status = res.status;
    e.details = data?.details;
    throw e;
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const del = (p) => api('DELETE', p);

const listeners = new Set();
let source = null;
export function onEvent(fn) {
  listeners.add(fn);
  if (!source) {
    source = new EventSource('/api/events');
    const dispatch = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const l of [...listeners]) l(msg);
    };
    for (const t of ['run', 'exec', 'manual', 'stand', 'health', 'config']) source.addEventListener(t, dispatch);
  }
  return () => listeners.delete(fn);
}

/** Подтверждение необратимого действия в модальном окне. По умолчанию фокус на «Отмена»; Esc — отмена. */
export function confirmAction({ title, text, ok = 'Удалить', cancel = 'Отмена' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm';
    d.setAttribute('aria-labelledby', 'confirm-h');
    d.innerHTML = String(html`<form method="dialog" class="col" style="gap: 14px">
<h2 class="h3" id="confirm-h">${title}</h2>
<p class="sm t2">${text}</p>
<div class="row" style="justify-content: flex-end; gap: 8px; margin-top: 6px"><button class="btn ghost" value="cancel" autofocus>${cancel}</button><button class="btn stop" value="ok">${icon('trash')}${ok}</button></div>
</form>`);
    d.addEventListener(
      'close',
      () => {
        resolve(d.returnValue === 'ok');
        d.remove();
      },
      { once: true },
    );
    document.body.appendChild(d);
    d.showModal();
  });
}

/** Удаление прогона после подтверждения; версии скиллов, полученные прогоном, остаются. */
export async function removeRun({ id, title }) {
  const ok = await confirmAction({ title: `Удалить прогон #${id}?`, text: `«${title}». Удалятся журналы кейсов, HTTP-обмены и снимок настроек — восстановить их будет нельзя. Скиллы тестового оператора остаются в агенте: после удаления продолжить на нём можно только в ручном режиме, по x-a2a-sender-id.` });
  if (!ok) return false;
  await del(`/api/runs/${id}`);
  toast(`Прогон #${id} удалён`);
  return true;
}

/** Удаление закрытой ручной сессии после подтверждения. */
export async function removeSession({ id, key, caseId, caseTitle }) {
  const ok = await confirmAction({ title: `Удалить сессию ${key}?`, text: `${caseId} · ${caseTitle}. Удалятся журнал, HTTP-обмены и разметка — восстановить их будет нельзя.` });
  if (!ok) return false;
  await del(`/api/manual/${id}`);
  toast(`Сессия ${key} удалена`);
  return true;
}

export function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

// ----------------------------------------------------------------- компоненты

export const typeBadge = (type, small = false) =>
  type === 'checking'
    ? html`<span class="type check"${raw(small ? ' style="min-height: 22px"' : '')}><span class="ring"></span>Проверяющая</span>`
    : html`<span class="type train"${raw(small ? ' style="min-height: 22px"' : '')}><span class="ball"></span>Обучающая</span>`;

const RUN_STATUS = {
  queued: ['queue', 'В очереди'],
  running: ['live', 'Выполняется'],
  completed: ['done', 'Завершён'],
  stopped: ['stop', 'Остановлен'],
  failed: ['tech', 'Ошибка стенда'],
};
export function runStatus(run, extra = '') {
  const [dot, text] = RUN_STATUS[run.status] ?? ['', run.status];
  return html`<span class="st"><span class="dot ${dot}"></span>${text}${extra ? ` · ${extra}` : ''}</span>`;
}

export const TECH = new Set(['reset_failed', 'agent_busy', 'agent_error', 'agent_timeout', 'operator_error', 'operator_format_error', 'operator_timeout', 'operator_mode_violation', 'stopped', 'internal_error', 'prepare_failed']);
export const STATUS_TITLES = {
  pending: 'Ожидает',
  running: 'Выполняется',
  completed: 'Завершён',
  not_started: 'Не начат',
  limit_turns: 'Лимит ходов',
  limit_duration: 'Лимит времени',
  limit_operator_calls: 'Лимит запросов оператора',
  reset_failed: 'Сбой /reset',
  agent_busy: 'Агент занят прерванным запросом',
  agent_error: 'Сбой агента',
  agent_timeout: 'Таймаут агента',
  operator_error: 'Сбой оператора',
  operator_format_error: 'Ошибка формата оператора',
  operator_timeout: 'Таймаут оператора',
  operator_mode_violation: 'Нарушение режима проверки',
  stopped: 'Остановлен',
  internal_error: 'Сбой стенда',
  prepare_failed: 'Сбой подготовки',
};

/** Итог кейса: красный — только неуспех агента; сбои стенда — фиолетовые; нет оценки — пунктир. */
export function outcomePill(item) {
  if (item.status === 'running') return html`<span class="pill live">Выполняется</span>`;
  if (!item.outcome) return item.status === 'not_started' ? html`<span class="st t3"><span class="dot queue"></span>Не начат</span>` : html`<span class="st t3"><span class="dot queue"></span>Ожидает</span>`;
  if (item.outcome === 'passed') return html`<span class="pill pass">${icon('check')}Пройден</span>`;
  if (item.outcome === 'failed') return html`<span class="pill fail">${icon('x')}Не пройден</span>`;
  if (item.outcome === 'technical') return html`<span class="pill tech">${icon('bolt')}${STATUS_TITLES[item.status] ?? 'Технический сбой'}</span>`;
  return html`<span class="pill na">Не оценено</span>`;
}

export const mk = (state) => {
  if (state === true || state === 'ok') return html`<span class="mk ok">${icon('check')}</span>`;
  if (state === false || state === 'no') return html`<span class="mk no">${icon('x')}</span>`;
  if (state === 'tech') return html`<span class="mk tech">${icon('bolt')}</span>`;
  return html`<span class="mk na">${icon('minus')}</span>`;
};

export const ver = (id, kind = '') => html`<span class="ver ${kind}">${id}</span>`;
export const ref = (text, ic = 'file', href = null) =>
  href ? html`<a class="ref" href="${href}" data-link>${icon(ic)}${text}</a>` : html`<span class="ref">${icon(ic)}${text}</span>`;
export const later = (text = 'следующий этап') => html`<span class="later">${text}</span>`;
export const hint = (text, ic = 'info') => html`<p class="hint">${icon(ic)}<span>${text}</span></p>`;

/** План команд: /reset → кейс → /case-capture и проходы /skill-curator; прогресс по линии. */
export function planView(plan, progress = null) {
  const parts = [];
  const caseState = (pos) => {
    if (!progress) return '';
    const it = progress.items.find((i) => i.pos === pos);
    if (!it) return 'fu';
    if (it.status === 'running') return 'now';
    if (!it.outcome) return 'fu';
    return '';
  };
  const curState = (pass) => {
    if (!progress) return '';
    const p = progress.passes.find((x) => x.pass === pass);
    if (!p) return 'fu';
    return p.status === 'running' ? 'now' : '';
  };
  for (const s of plan) {
    if (s.kind === 'case') {
      const st = caseState(s.pos);
      const it = progress?.items.find((i) => i.pos === s.pos);
      const resetSt = st === 'fu' ? 'fu' : '';
      const capSt = !progress ? '' : it?.steps?.capture ? (it.steps.capture.status === 'not_sent' ? 'fu' : '') : 'fu';
      parts.push(
        html`<span class="pg"><span class="pb rs ${resetSt}">${icon('reset')}</span><span class="pb cs ${st}">${s.pos}</span>${s.capture ? html`<span class="pb cp ${capSt}">${icon('capture')}</span>` : ''}</span>`,
      );
    } else {
      parts.push(html`<span class="pb cu ${curState(s.pass)}">${icon('curator')}${s.reason === 'final' ? 'финальный' : s.pass}</span>`);
    }
  }
  return html`<div class="plan" role="img" aria-label="План служебных команд">${parts}</div>`;
}

export const planLegend = (training) => html`<div class="row cap" style="gap: 14px">
<span class="row" style="gap: 6px"><span class="pb rs" style="height: 22px; min-width: 20px">${icon('reset')}</span>/reset</span>
<span class="row" style="gap: 6px"><span class="pb cs" style="height: 22px; min-width: 26px; padding: 0 6px">1</span>кейс</span>
${training ? html`<span class="row" style="gap: 6px"><span class="pb cp" style="height: 22px; min-width: 20px">${icon('capture')}</span>/case-capture</span><span class="row" style="gap: 6px"><span class="pb cu" style="height: 22px; min-width: 20px; padding: 0 5px">${icon('curator')}</span>/skill-curator</span>` : ''}
</div>`;

/** Шаги кейса: reset, диалог, проверки, ответ, capture, curator. */
export function stepsView(it, training) {
  const out = [];
  const sp = (cls, ic, text) => html`<span class="sp ${cls}">${ic ? icon(ic) : ''}${text}</span>`;
  const st = it.steps ?? {};
  if (!it.outcome && it.status !== 'running') {
    out.push(sp('fu', null, 'reset'), sp('fu', null, 'диалог'), sp('fu', null, 'действия'), sp('fu', null, 'ответ'));
    if (training) out.push(sp('fu', null, 'capture'));
    return html`<span class="steps">${out}</span>`;
  }
  out.push(st.reset ? sp(st.reset === 'ok' ? '' : 'tech', 'reset', 'reset') : sp('now', null, 'reset'));
  if (it.status === 'running' && !st.dialog) out.push(html`<span class="sp now"><span class="dot live"></span>диалог${it.liveTurns ? ` · ход ${it.liveTurns}` : ''}</span>`);
  else if (st.dialog) out.push(sp(TECH.has(st.dialog) ? 'tech' : '', TECH.has(st.dialog) ? 'bolt' : 'chat', TECH.has(st.dialog) ? STATUS_TITLES[st.dialog] ?? st.dialog : `${it.stats?.turns ?? '—'} ${plural(it.stats?.turns ?? 0, 'ход', 'хода', 'ходов')}`));
  if (st.checks) out.push(sp(st.checks.passed === st.checks.total ? '' : 'no', st.checks.passed === st.checks.total ? 'check' : 'x', `действия ${st.checks.passed}/${st.checks.total}`));
  else if (it.outcome === 'technical') out.push(sp('off', null, 'действия не оценивались'));
  if (st.judge) {
    if (st.judge.status === 'ok') out.push(sp(st.judge.passed === st.judge.total ? '' : 'no', st.judge.passed === st.judge.total ? 'check' : 'x', `ответ ${st.judge.passed}/${st.judge.total}`));
    else if (st.judge.total) out.push(sp('off', null, st.judge.status === 'failed' ? 'ответ: сбой судьи' : 'ответ не оценён'));
  }
  if (training) {
    if (st.capture) {
      if (st.capture.status === 'not_sent') out.push(sp('off', null, 'capture не отправлялся'));
      else out.push(sp(st.capture.status === 'ok' ? '' : st.capture.status === 'skipped' ? 'off' : 'tech', 'capture', st.capture.status === 'ok' ? 'capture' : st.capture.status === 'skipped' ? 'capture пропущен' : 'capture: сбой'));
    } else if (it.status === 'running') out.push(sp('fu', null, 'capture'));
  }
  if (st.curatorPass) out.push(sp('', 'curator', `curator ${st.curatorPass}`));
  return html`<span class="steps">${out}</span>`;
}

export function kpi(m, extraClass = '') {
  if (!m) return '';
  if (m.status === 'na') {
    return html`<div class="kpi dim ${extraClass}"><span class="k">${m.title}</span><span class="v na">нет данных</span><span class="cap">${[m.reason, m.note].filter(Boolean).join(' · ')}</span></div>`;
  }
  const [main, small] = splitDisplay(m.display);
  return html`<div class="kpi ${extraClass}"><span class="k">${m.title}</span><span class="v">${main}${small ? html` <small>${small}</small>` : ''}</span><span class="cap">${m.note}</span></div>`;
}
function splitDisplay(d) {
  const m = /^(\d+) из (\d+)$/.exec(d);
  if (m) return [`${m[1]} из ${m[2]}`, ''];
  const t = /^(\d+ ч \d+) мин$/.exec(d);
  if (t) return [t[1], 'мин'];
  return [d, ''];
}

export function issuesBox(issues, title = 'Прогон не запустится: ошибка в настройках') {
  const errors = issues.filter((i) => i.severity === 'error');
  if (!errors.length) return '';
  return html`<div class="err" role="alert">
<div class="err-h">${icon('warn')}${title}</div>
${errors.slice(0, 8).map(
  (i) => html`<div style="display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 20px; font-size: 14px; line-height: 20px; padding-top: 6px; border-top: 1px solid #F3D6D2">
<span class="t3">Файл</span><span><span class="ref">${i.file}${i.line ? `:${i.line}` : ''}</span></span>
${i.field ? html`<span class="t3">Поле</span><span><span class="ref">${i.field}</span></span>` : ''}
<span class="t3">Причина</span><span>${i.reason}</span>
${i.action ? html`<span class="t3">Что сделать</span><span>${i.action}</span>` : ''}
</div>`,
)}
${errors.length > 8 ? html`<span class="cap">И ещё ${errors.length - 8} ${plural(errors.length - 8, 'ошибка', 'ошибки', 'ошибок')}</span>` : ''}
</div>`;
}

export function warningsList(issues) {
  const w = issues.filter((i) => i.severity === 'warning');
  if (!w.length) return '';
  return html`<div class="col" style="gap: 0">${w.map((i) => html`<div class="okr"><span class="mk na">${icon('minus')}</span><span>${i.reason}</span><span class="cap mono">${i.file}${i.field ? ` · ${i.field}` : ''}</span></div>`)}</div>`;
}

// ----------------------------------------------------------------- журнал выполнения

const OUTCOME_PILL = {
  stub: (e) => html`<span class="pill ${e.isError ? 'fail' : 'pass'}" style="margin-left: auto">${e.isError ? 'ошибка' : 'успех'}${e.durationMs !== null ? ` · ${e.durationMs} мс` : ''}</span>`,
};

export function toolPill(e) {
  const c = e.confirmation;
  if (e.awaiting === 'confirmation') return html`<span class="pill live">Требует подтверждения</span>`;
  if (e.awaiting === 'answer') return html`<span class="pill na">нет заглушки</span>`;
  if (e.outcome === 'rejected') return html`<span class="pill dark" style="margin-left: auto">${icon('x')}Отклонено ${c?.by === 'human' ? 'вами' : 'оператором'}${c?.waitedMs ? ` · ${fmtDur(c.waitedMs)}` : ''}</span>`;
  if (e.outcome === 'timeout') return html`<span class="pill tech" style="margin-left: auto">${icon('clock')}Отклонено по таймауту</span>`;
  if (e.outcome === 'stopped' && e.late) return html`<span class="pill tech" style="margin-left: auto" title="Ход, который стенд перестал ждать: агент сразу получил ошибку">После завершения кейса</span>`;
  if (e.outcome === 'stopped') return html`<span class="pill tech" style="margin-left: auto">Остановлено</span>`;
  if (e.outcome === 'unknown_tool') return html`<span class="pill na" style="margin-left: auto">${e.disabled ? 'выключен в контракте' : 'неизвестный инструмент'}</span>`;
  if (e.outcome === 'no_stub') return html`<span class="pill na" style="margin-left: auto">нет заглушки · ошибка инструмента</span>`;
  if (e.outcome === 'manual') return html`<span class="pill" style="margin-left: auto">${icon('user')}ответ человека${e.durationMs ? ` · ${fmtDur(e.durationMs)}` : ''}</span>`;
  if (e.outcome === 'manual_error') return html`<span class="pill fail" style="margin-left: auto">ошибка от человека</span>`;
  if (c?.decision === 'approve' && e.outcome !== 'pending') {
    const by = c.by === 'human' ? 'вами' : c.by === 'auto' ? 'автоматически' : 'оператором';
    return html`<span class="row" style="margin-left: auto; gap: 6px"><span class="pill">${icon('check')}Разрешено ${by}${c.waitedMs ? ` · ${fmtDur(c.waitedMs)}` : ''}</span>${OUTCOME_PILL.stub(e)}</span>`;
  }
  if (e.outcome === 'pending') return html`<span class="pill live" style="margin-left: auto">выполняется</span>`;
  return OUTCOME_PILL.stub(e);
}

/** Карточка вызова инструмента. full=false — «что видел агент»: без имён заглушек. */
/** Ссылка из события журнала на его HTTP-обмен. */
export const httpLink = (e) => (e.httpId ? html`<a class="ev" href="#http-${e.httpId}" data-action="showHttp" data-http="${e.httpId}" title="Запрос и ответ HTTP">HTTP</a>` : '');

export function toolCard(e, { full = true, actions = null, http = false } = {}) {
  const cls = e.awaiting === 'confirmation' ? 'wait' : e.awaiting === 'answer' || e.outcome === 'no_stub' || e.outcome === 'unknown_tool' ? 'miss' : '';
  const stub = full && e.stub ? html`<span class="cap">заглушка <span class="mono">${e.stub.id}</span>${e.stub.origin === 'default' ? ' · по умолчанию' : ''}${e.stub.candidates > 1 ? ` · из ${e.stub.candidates} подходящих` : ''}${e.effect ? ` · ${Object.entries(e.effect).map(([k, v]) => `${k} → ${v}`).join(', ')}` : ''}</span>` : '';
  const conf = e.requiresConfirmation && !e.awaiting && !e.confirmation ? html`<span class="cap">требует подтверждения</span>` : '';
  const deadline = e.deadline ? html`<span class="row mono t2" style="margin-left: auto; gap: 6px">${icon('clock')}<span data-deadline="${e.deadline}">—</span></span>` : '';
  const body = [`→ ${JSON.stringify(e.args)}`];
  if (e.outcome !== 'pending' && !e.awaiting) body.push(`← ${typeof e.result === 'string' ? e.result : JSON.stringify(e.result)}`);
  return html`<div class="tool ${cls}" id="ev-${e.seq}">
<div class="tool-h">${icon('tool')}<span class="nm">${e.tool}</span>${stub}${conf}${e.awaiting ? toolPill(e) : ''}${deadline}${!e.awaiting ? toolPill(e) : ''}${http ? httpLink(e) : ''}<span class="ev">#${e.seq}</span></div>
<div class="tool-b">${body.join('\n')}</div>
${actions ?? ''}
${full && e.yaml ? html`<details class="raw"><summary>YAML-фрагмент для файла кейса</summary><pre>${e.yaml}</pre></details>` : ''}
</div>`;
}

export function commandLine(e, { http = false } = {}) {
  const titles = { reset: '/reset', capture: '/case-capture', curator: '/skill-curator' };
  let text = '';
  const p = e.parsed;
  if (e.status === 'running') text = 'выполняется…';
  else if (e.name === 'reset') text = e.status === 'ok' ? `контекст сброшен · ${fmtDur(e.durationMs)}` : `сбой: ${e.error ?? e.status}`;
  else if (e.name === 'capture') text = p?.kind === 'captured' ? `кейс сохранён · signal ${p.signal} · ${fmtDur(e.durationMs)}` : p?.kind === 'skipped' ? 'capture пропущен агентом' : p?.kind === 'failed' ? `не сохранён: ${p.reason}` : `строка результата не найдена${e.error ? `: ${e.error}` : ''}`;
  else text = p?.kind === 'complete' ? `обработано ${p.processed}, изменено ${p.updated}, создано ${p.created} · ${fmtDur(e.durationMs)}` : p?.kind === 'empty' ? 'очередь пуста' : p?.kind === 'failed' ? `сбой: ${p.reason}` : `строка результата не найдена${e.error ? `: ${e.error}` : ''}`;
  const bad = e.status === 'failed' || e.status === 'unrecognized';
  return html`<div class="cmd" id="ev-${e.seq}"><span class="ref">${icon(e.name === 'reset' ? 'reset' : e.name === 'capture' ? 'capture' : 'curator')}${titles[e.name]}</span>${bad ? html`<span class="pill tech note">${text}</span>` : html`<span>${text}</span>`}${e.by === 'human' ? html`<span class="cap">вы</span>` : ''}${http ? httpLink(e) : ''}<span class="ev">#${e.seq}</span></div>`;
}

// Текст агента — в Markdown. Разбор кэшируется: ленту перерисовывает каждое обновление по SSE.
const MD_LIMIT = 100_000;
const mdCache = new Map();

/** Текст агента в Markdown: Html или null, если текст слишком длинный или разбор не удался — тогда он показывается как есть. */
function mdHtml(text) {
  const s = String(text ?? '');
  if (s.length > MD_LIMIT) return null;
  let out = mdCache.get(s);
  if (out === undefined) {
    try {
      out = markdown(s);
    } catch {
      out = null;
    }
    if (mdCache.size >= 300) mdCache.delete(mdCache.keys().next().value);
    mdCache.set(s, out);
  }
  return out === null ? null : raw(out);
}

/** Есть ли в разобранном тексте разметка, кроме абзацев и переносов строк. */
const hasMarkup = (h) => /<(?!\/?(?:p|br)>)/.test(h.s);

/** Сообщение агента: с разметкой и, если она есть, исходный текст для переключателя «исходный текст». */
function agentBody(text) {
  const md = mdHtml(text);
  if (!md) return { body: html`<div style="white-space: pre-wrap">${text}</div>`, marked: false };
  const marked = hasMarkup(md);
  return { body: html`<div class="md">${md}</div>${marked ? html`<div class="md-src">${text}</div>` : ''}`, marked };
}

export function messageView(e, { full = true, human = false, http = false } = {}) {
  const hl = http ? httpLink(e) : '';
  const marks = e.marks;
  const kv = [];
  if (full && marks) {
    if (marks.correction) kv.push(html`<span class="lesson">поправка${marks.lessonId ? ` · ${marks.lessonId}` : marks.lessonNote ? ` · ${marks.lessonNote}` : ' · урок не указан'}${marks.repeated ? ' · повторная' : ''}</span>`);
    if (marks.explanation) kv.push(html`<span>объяснение правила</span>`);
    if (marks.approval) kv.push(html`<span>одобрение результата</span>`);
    if (marks.finish) kv.push(html`<span>завершение: да</span>`);
    if (marks.manual && marks.correction) kv.push(html`<span>ручная отметка</span>`);
  }
  if (full && e.queued) kv.push(html`<span>реплика к отклонению — после конца хода</span>`);
  if (e.type === 'start_message') {
    return html`<div class="msg" id="ev-${e.seq}"><span class="who"><span class="av cg"></span>ClawGym · стартовое сообщение${hl}<span class="ev">#${e.seq}</span></span><div class="bub sys" style="white-space: pre-wrap">${e.text}</div></div>`;
  }
  if (e.type === 'agent_message') {
    const { body, marked } = agentBody(e.text);
    const src = marked ? html`<button type="button" class="ev md-sw" data-action="mdSource" aria-pressed="false" title="Показать сообщение так, как его прислал агент">исходный текст</button>` : '';
    return html`<div class="msg" id="ev-${e.seq}"><span class="who"><span class="av ag"></span>Pagurus${e.turn ? ` · ход ${e.turn}` : ''}${e.durationMs ? html` <span class="cap">${fmtDur(e.durationMs)}</span>` : ''}${src}${hl}<span class="ev">#${e.seq}</span></span><div class="bub">${body}</div></div>`;
  }
  const who = e.type === 'human_message' || human ? html`Вы<span class="av hu"></span>` : html`LLM-оператор<span class="av op">${icon('bot')}</span>`;
  return html`<div class="msg r" id="ev-${e.seq}"><span class="who"><span class="ev">#${e.seq}</span>${hl}${who}</span><div class="bub" style="white-space: pre-wrap">${e.text}</div>${kv.length ? html`<div class="kvh" style="justify-content: flex-end">${kv}</div>` : ''}</div>`;
}

export function decisionBlock(e, { http = false } = {}) {
  const d = e.decision ?? {};
  const kv = [];
  if (e.event === 'confirmation') kv.push(html`<span>подтверждение: ${d.confirmation === 'approve' ? 'разрешить' : d.confirmation === 'reject' ? 'отклонить' : '—'}</span>`);
  if ('correction' in d) kv.push(html`<span>поправка: ${d.correction ? 'да' : 'нет'}</span>`);
  if (d.lessonId) kv.push(html`<span class="lesson">урок: ${d.lessonId}</span>`);
  if (d.lessonNote && !d.lessonId) kv.push(html`<span>урок вне каталога: ${d.lessonNote}</span>`);
  if ('finish' in d) kv.push(html`<span>завершение: ${d.finish ? 'да' : 'нет'}</span>`);
  if (d.approval) kv.push(html`<span>одобрение</span>`);
  const meta = e.forced ? e.forced : `${e.model}${e.durationMs ? ` · ${fmtDur(e.durationMs)}` : ''}${e.attempts?.length > 1 ? ` · попыток ${e.attempts.length}` : ''}`;
  return html`<div class="hid" id="ev-${e.seq}"><div class="hid-h">${icon('hidden')}Решение оператора · скрыто от агента<span class="cap">${meta}</span><span class="ev" style="margin-left: auto">#${e.seq}</span>${http ? httpLink(e) : ''}</div>
${e.error ? html`<span class="pill tech" style="align-self: flex-start">${e.error}</span>` : ''}
${kv.length ? html`<div class="kvh">${kv}</div>` : ''}
${d.reason ? html`<span>${d.reason}</span>` : ''}
${e.attempts?.some((a) => !a.ok) ? html`<span class="cap">${e.attempts.filter((a) => !a.ok).map((a) => `попытка ${a.n}: ${a.kind === 'format' ? 'ошибка формата' : 'ошибка LLM'} — ${a.error}`).join(' · ')}</span>` : ''}
</div>`;
}

export function judgeBlock(e, { http = false } = {}) {
  if (e.status !== 'ok') {
    return html`<div class="hid" id="ev-${e.seq}" style="gap: 12px"><div class="hid-h">${icon('hidden')}LLM-оценка ответа · скрыто от агента<span class="ev" style="margin-left: auto">#${e.seq}</span>${http ? httpLink(e) : ''}</div><div class="chki" style="border-top: 0">${mk('na')}<span class="col" style="gap: 2px"><span class="m5">Ответ не оценён</span><span class="t2">${e.error ?? ''}</span></span></div></div>`;
  }
  return html`<div class="hid" id="ev-${e.seq}" style="gap: 12px"><div class="hid-h">${icon('hidden')}LLM-оценка ответа · ${e.model}${e.durationMs ? ` · ${fmtDur(e.durationMs)}` : ''} · скрыто от агента<span class="ev" style="margin-left: auto">#${e.seq}</span>${http ? httpLink(e) : ''}</div>
<div class="chkl">${e.criteria.map((c) => html`<div class="chki">${mk(c.passed)}<span class="col" style="gap: 2px"><span class="${c.passed ? '' : 'm5'}">${c.text}</span>${c.reason ? html`<span class="t2">${c.reason}</span>` : ''}</span></div>`)}</div>
${e.summary ? html`<span class="cap">${e.summary}</span>` : ''}
</div>`;
}

export function checksBlock(items) {
  return html`<div class="chkl">${items.map(
    (c) => html`<div class="chki">${mk(c.passed === null ? 'na' : c.passed)}<span class="col" style="gap: 2px"><span>${c.text}</span><span class="ev">${c.evidence?.length ? c.evidence.map((s) => html`<a href="#ev-${s}">событие #${s}</a>`).reduce((a, b) => html`${a} · ${b}`) : c.note}</span>${c.evidence?.length && c.note && !/^событие #\d+$/.test(c.note) ? html`<span class="cap">${c.note}</span>` : ''}</span></div>`,
  )}</div>`;
}

// ----------------------------------------------------------------- метрики аналитика (M1, M2)

export const FINAL_CLASS_TITLES = { close_answer: 'Ответ клиенту и закрытие', expertise: 'Экспертиза', request_info: 'Запрос информации у клиента', operator_instruction: 'Инструкция оператору' };
export const fmtShare = (x) => (x === null || x === undefined ? '—' : x.toFixed(2).replace('.', ','));
/** A_judge элемента прогона как доля прогонов судьи: «2 из 3» — так видна градация 0, ⅓, ⅔, 1. */
export const fmtRuns = (a) => (a?.runs ? `${a.matched} из ${a.runs}` : '');
const clsTitle = (c) => (c ? FINAL_CLASS_TITLES[c] ?? c : 'не завершено');

/** Строка про финальное действие: класс агента и эталон. */
export function finalVerdict(f) {
  if (!f) return '';
  if (f.incomplete) return html`<span class="pill na">не завершён</span>`;
  const pill = html`<span class="pill ${f.correct === true ? 'pass' : f.correct === false ? 'fail' : ''}">${f.correct === true ? icon('check') : f.correct === false ? icon('x') : ''}${clsTitle(f.predicted)}</span>`;
  return f.correct === false ? html`${pill}<span class="cap">эталон — ${clsTitle(f.expected)}</span>` : pill;
}

export function scoresBlock(e, { http = false } = {}) {
  const f = e.final;
  const t = e.tools;
  const a = e.answer;
  const w = e.weights;
  const num = (x) => String(x).replace('.', ',');
  const finalText = f.text ? mdHtml(f.text) : null;
  return html`<div class="hid" id="ev-${e.seq}" style="gap: 12px"><div class="hid-h">${icon('hidden')}Метрики аналитика · M1 и M2 · скрыто от агента<span class="ev" style="margin-left: auto">#${e.seq}</span>${http ? httpLink(e) : ''}</div>
<div class="chkl">
<div class="chki">${mk(f.correct === null ? 'na' : f.correct)}<span class="col" style="gap: 2px"><span class="m5">Финальное действие: ${clsTitle(f.predicted)}</span><span class="t2">${f.expected ? `эталон — ${clsTitle(f.expected)}${f.expectedFrom === 'actions.final' ? ', выведен из reference.actions.final' : ''}` : 'эталонного класса нет — в M1 не входит'}</span><span class="cap">${f.seq ? html`<a href="#ev-${f.seq}">событие #${f.seq}</a> · ` : ''}${f.note}</span></span></div>
<div class="chki">${mk(t.f1 === null ? 'na' : t.f1 === 1)}<span class="col" style="gap: 2px"><span class="m5">F1 инструментов: ${fmtShare(t.f1)}${t.f1 !== null ? html`<span class="t2" style="font-weight: 400"> · TP ${t.tp} · FP ${t.fp} · FN ${t.fn}</span>` : ''}</span>
${t.f1 === null ? html`<span class="t2">${t.reason}</span>` : t.rows.map((r) => html`<span class="t2"><span class="mono">${r.tool}</span> · ${r.ref ? `в эталоне${r.ref > 1 ? ` ×${r.ref}` : ''}` : 'вне эталона'} · ${r.calls ? `вызовов ${r.calls}${r.counted !== r.calls ? `, засчитано ${r.counted}` : ''}` : 'не вызывался'}${r.fp ? ` · FP ${r.fp}` : ''}${r.fn ? ` · FN ${r.fn}` : ''}</span>`)}
<span class="cap">${t.rule}</span></span></div>
<div class="chki">${mk(a.status !== 'ok' ? 'na' : a.score === 1)}<span class="col" style="gap: 2px"><span class="m5">A_judge: ${a.status === 'ok' ? html`${fmtShare(a.score)}${a.runs.length ? html`<span class="t2" style="font-weight: 400"> · соответствует в ${a.runs.filter((r) => r.match).length} из ${a.runs.length} прогонов${a.model ? ` · ${a.model}` : ''}</span>` : ''}` : a.status === 'failed' ? 'сбой судьи' : 'не оценено'}</span>
${a.runs.map((r) => html`<span class="t2">прогон ${r.n}: ${r.error ? `сбой — ${r.error}` : r.match ? 'соответствует' : 'не соответствует'}${r.reason ? ` — ${r.reason}` : ''}</span>`)}
${a.reason ? html`<span class="t2">${a.reason}</span>` : ''}
${f.text || a.reference ? html`<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 8px 16px; padding-top: 6px">
<div class="col" style="gap: 4px; min-width: 0"><span class="lbl">Итоговый текст агента${f.textFrom ? html` · <span class="mono">${f.textFrom}</span>` : ''}</span>${finalText ? html`<div class="quote md">${finalText}</div>` : html`<div class="quote">${f.text || '—'}</div>`}</div>
<div class="col" style="gap: 4px; min-width: 0"><span class="lbl">Эталонный текст</span><div class="quote">${a.reference || '—'}</div></div></div>` : ''}</span></div>
</div>
<div class="kvh"><span>case_score: ${e.caseScore === null ? 'нет — не хватает одной из частей' : fmtShare(e.caseScore)}</span><span>${num(w.tools)} · F1 + ${num(w.answer)} · A</span></div>
</div>`;
}

/** Лента событий выполнения. full=false — только то, что видел агент. */
export function feed(events, { full = true, toolActions = null, httpLinks = false } = {}) {
  const out = [];
  const http = full && httpLinks;
  for (const e of events) {
    if (e.hidden && !full) continue;
    switch (e.type) {
      case 'command':
        out.push(commandLine(e, { http }));
        break;
      case 'start_message':
      case 'agent_message':
      case 'operator_message':
      case 'human_message':
        out.push(messageView(e, { full, http }));
        break;
      case 'tool_call':
        out.push(toolCard(e, { full, actions: toolActions ? toolActions(e) : null, http }));
        break;
      case 'operator_decision':
        out.push(decisionBlock(e, { http }));
        break;
      case 'judge':
        out.push(judgeBlock(e, { http }));
        break;
      case 'checks':
        out.push(html`<div class="hid" id="ev-${e.seq}"><div class="hid-h">${icon('hidden')}Автоматические проверки действий · скрыто от агента<span class="ev" style="margin-left: auto">#${e.seq}</span></div>${checksBlock(e.items)}</div>`);
        break;
      case 'scores':
        out.push(scoresBlock(e, { http }));
        break;
      case 'status':
        if (full) out.push(html`<div class="cmd" id="ev-${e.seq}"><span class="ref">${icon(TECH.has(e.status) ? 'bolt' : 'check')}${TECH.has(e.status) ? STATUS_TITLES[e.status] ?? e.status : 'кейс завершён'}</span><span>${e.reason}${TECH.has(e.status) ? '' : ' · результат зафиксирован до служебных команд'}</span><span class="ev">#${e.seq}</span></div>`);
        break;
      case 'mode_violation':
        out.push(html`<div class="hid" id="ev-${e.seq}"><div class="hid-h">${icon('warn')}Нарушение режима проверки · скрыто от агента</div><span>${e.text}</span></div>`);
        break;
      case 'note':
        out.push(html`<div class="cmd" id="ev-${e.seq}"><span class="pill tech note">${icon('bolt')}${e.text}</span>${http ? httpLink(e) : ''}</div>`);
        break;
    }
  }
  return html`<div class="feed">${out}</div>`;
}

export function legend() {
  return html`<div class="legend"><span><span class="av ag"></span>Pagurus</span><span><span class="av op"></span>LLM-оператор</span><span><span class="av hu"></span>Человек</span><span><span class="av cg"></span>ClawGym</span><span><span class="sw-hid"></span>скрыто от агента</span></div>`;
}

export function changesList(changes, limit = 20) {
  if (!changes?.length) return html`<span class="cap">Изменений нет</span>`;
  return html`${changes.slice(0, limit).map((c) => {
    const name = c.path.replace(/^skills\/learned\//, '').replace(/\/SKILL\.md$/, '');
    if (c.kind === 'added') return html`<div class="chg"><span class="s add">+</span><span class="mono" style="font-size: 12px">${name}</span><span class="cap">создан</span></div>`;
    if (c.kind === 'removed') return html`<div class="chg"><span class="s del">−</span><span class="mono" style="font-size: 12px">${name}</span><span class="cap">удалён</span></div>`;
    return html`<div class="chg"><span class="s mod">~</span><span class="mono" style="font-size: 12px">${name}</span><span class="dl"><span class="p">+${c.added}</span> <span class="m">−${c.removed}</span></span></div>`;
  })}${changes.length > limit ? html`<span class="cap">И ещё ${changes.length - limit}</span>` : ''}`;
}

export function diffView(unified) {
  if (!unified) return '';
  const lines = unified.split('\n').map((l) => (l.startsWith('+') ? html`<span class="p">${l}</span>` : l.startsWith('-') ? html`<span class="m">${l}</span>` : l === '@@' ? html`<span class="g">⋯</span>` : html`${l}`));
  return html`<pre class="diff">${lines.reduce((a, b) => html`${a}\n${b}`)}</pre>`;
}

// ----------------------------------------------------------------- HTTP-обмены

function prettyBody(body) {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function headersList(h) {
  const entries = Object.entries(h ?? {});
  if (!entries.length) return html`<span class="cap">нет заголовков</span>`;
  return html`<dl class="hdrs">${entries.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} КБ` : `${n} Б`);

function httpPart(id, title, line, part) {
  const body = prettyBody(part.body);
  return html`<div class="xch-part">
<div class="row" style="justify-content: space-between; gap: 8px"><span class="lbl">${title}</span>${body ? html`<button class="btn ghost" type="button" data-action="copy" data-target="${id}" style="min-height: 32px; padding: 0 10px">Копировать тело</button>` : ''}</div>
${line ? html`<span class="mono sm" style="word-break: break-all">${line}</span>` : ''}
${headersList(part.headers)}
${body ? html`<pre class="tool-b" id="${id}">${body}</pre>` : html`<span class="cap">тело пустое</span>`}
${part.truncated ? html`<span class="cap">Показаны первые ${kb(part.body.length)} из ${kb(part.bytes)}: тело обрезано при записи</span>` : ''}
</div>`;
}

/** Обмен целиком: кто кого вызвал, запрос и ответ с заголовками и телом. */
export function exchangeCard(x) {
  const out = x.kind !== 'mcp';
  const dir =
    x.kind === 'llm'
      ? html`<span class="pill live">${icon('judge')}ClawGym → LLM</span>`
      : out
        ? html`<span class="pill">${icon('arrow')}ClawGym → агент</span>`
        : html`<span class="pill dark">${icon('tool')}агент → MCP</span>`;
  let path = x.request.url;
  try {
    const u = new URL(x.request.url, 'http://clawgym');
    path = u.pathname + u.search;
  } catch {
    /* оставить как есть */
  }
  const status = x.response
    ? html`<span class="pill ${x.response.status < 400 ? 'pass' : 'tech'}">HTTP ${x.response.status}</span>`
    : x.error
      ? html`<span class="pill tech">${icon('bolt')}${x.error}</span>`
      : html`<span class="pill live">${icon('clock')}ждёт ответа</span>`;
  const links = [x.eventSeq ? html`<a class="ev" href="#ev-${x.eventSeq}" data-action="toEvent" data-seq="${x.eventSeq}">#${x.eventSeq}</a>` : '', x.replySeq ? html`<a class="ev" href="#ev-${x.replySeq}" data-action="toEvent" data-seq="${x.replySeq}">ответ #${x.replySeq}</a>` : ''];
  return html`<details class="tool xch" id="http-${x.id}">
<summary class="tool-h">${dir}<span class="nm">${x.request.method} ${path}</span><span class="cap">${x.label}</span>${status}<span class="cap num">${x.durationMs === null ? '' : x.durationMs < 1000 ? `${x.durationMs} мс` : fmtDur(x.durationMs)}</span><span class="row" style="gap: 8px; margin-left: auto">${links}</span></summary>
<div class="xch-meta cap">${fmtDate(x.startedAt)} · ${[x.kind === 'llm' ? 'вызов модели: агент его не видит' : '', x.taskId ? `x-task-id ${x.taskId}` : out ? '' : 'без x-task-id', x.senderId ? `x-a2a-sender-id ${x.senderId}` : '', x.mcpSessionId ? `Mcp-Session-Id ${x.mcpSessionId.slice(0, 8)}…` : ''].filter(Boolean).join(' · ')}</div>
<div class="xch-b">
${httpPart(`http-${x.id}-req`, 'Запрос', `${x.request.method} ${x.request.url}`, x.request)}
${x.response ? httpPart(`http-${x.id}-res`, `Ответ · HTTP ${x.response.status}`, '', x.response) : html`<div class="xch-part"><span class="lbl">Ответ</span><span class="cap">${x.error ?? 'Ещё не получен: соединение удерживается'}</span></div>`}
</div>
</details>`;
}

/** Список обменов с фильтром по направлению. */
export function exchangesView(list, { filter = 'all', download = null, note = '', empty = 'HTTP-обменов пока нет.' } = {}) {
  const shown = list.filter((x) => filter === 'all' || x.kind === filter).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const n = (k) => list.filter((x) => k === 'all' || x.kind === k).length;
  const seg = (k, label) => html`<button type="button" class="${filter === k ? 'on' : ''}" data-action="httpFilter" data-filter="${k}" aria-pressed="${filter === k}">${label} · ${n(k)}</button>`;
  return html`<div class="col" style="gap: 14px">
<div class="row" style="justify-content: space-between; gap: 12px"><div class="seg" role="group" aria-label="Направление">${seg('all', 'Все')}${seg('agent', 'ClawGym → агент')}${seg('mcp', 'Агент → MCP')}${seg('llm', 'ClawGym → LLM')}</div>${download && list.length ? html`<a class="btn ghost" href="${download}" download>${icon('download')}Скачать JSON</a>` : ''}</div>
${note ? html`<p class="hint">${icon('info')}<span>${note}</span></p>` : ''}
${shown.length ? html`<div class="col" style="gap: 10px">${shown.map(exchangeCard)}</div>` : html`<div class="empty">${list.length ? 'В этом направлении обменов нет.' : empty}</div>`}
</div>`;
}
