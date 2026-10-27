// Ручная сессия: чат с заглушками, ответ вместо инструмента, подтверждения, команды, разметка (MAN-02–04, CASE-03).
import { html, icon, get, post, feed, legend, toolPill, checksBlock, exchangesView, mk, fmtDur, hint, toast, plural, removeSession, fmtShare, finalVerdict } from '../lib.js';

export const title = (ctx) => `Ручной кейс ${ctx.params[0]}`;

function toolActions(e, closed) {
  if (closed || !e.awaiting) return null;
  if (e.awaiting === 'confirmation') {
    return html`<div class="tool-f"><button class="btn pri" type="button" data-action="decide" data-call="${e.callId}" data-decision="approve">${icon('check')}Разрешить</button><button class="btn" type="button" data-action="decide" data-call="${e.callId}" data-decision="reject">${icon('x')}Отклонить</button><span class="cap">Без решения вызов отклонится по таймауту агента</span></div>`;
  }
  return html`<div class="tool-f" style="flex-direction: column; align-items: stretch">
<label class="field"><span class="lbl">Ответьте вместо инструмента — агент ждёт этот ответ (JSON или текст)</span><textarea class="input mono" rows="3" id="ans-${e.callId}" data-keep data-enter-mod="answer" data-call="${e.callId}" style="font-size: 12px">{}</textarea></label>
<div class="row"><button class="btn pri" type="button" data-action="answer" data-call="${e.callId}">${icon('send')}Отправить ответ</button><button class="btn" type="button" data-action="toolError" data-call="${e.callId}">Вернуть ошибку</button><span class="cap">Cmd/Ctrl+Enter — отправить ответ. В автоматическом прогоне здесь была бы ошибка инструмента</span></div>
</div>`;
}

function statusOf(s) {
  const pending = s.execution?.pending ?? [];
  if (s.status === 'closed') return html`<span class="st"><span class="dot done"></span>Сессия закрыта</span>`;
  if (pending.some((p) => p.kind === 'confirmation')) return html`<span class="st"><span class="dot live"></span>Ждёт вашего решения</span>`;
  if (pending.some((p) => p.kind === 'answer')) return html`<span class="st"><span class="dot live"></span>Агент ждёт ответ инструмента</span>`;
  if (s.busy) return html`<span class="st"><span class="dot live"></span>${s.busy}</span>`;
  return html`<span class="st"><span class="dot done"></span>Ход агента завершён</span>`;
}

function head(s) {
  const ex = s.execution;
  return html`<div class="col" style="gap: 14px">
<nav class="crumbs" aria-label="Путь"><a href="/manual">Ручной режим</a>${icon('chevRight', 's14')}<span>${s.case.id}</span></nav>
<header class="ph">
<div class="ph-t">
<div class="row" style="gap: 12px"><span class="pill">${icon('user')}Ручной кейс</span>${statusOf(s)}<span class="ref">x-task-id: ${ex?.taskIds?.[ex.taskIds.length - 1] ?? '—'}</span><span class="ref">${s.key}</span></div>
<h1 class="h1"><span class="mono" style="font-size: 28px; letter-spacing: -.02em">${s.case.id}</span> · ${s.case.title}</h1>
<p class="lede">${s.case.solutions ? 'Кейс проходится вручную: LLM-оператор в этой сессии не отправляет реплик.' : 'У кейса нет автоматических решений.'} Реплики, решения по действиям и служебные команды задаёте вы. Агент получает ответы из заглушек кейса.</p>
${s.note ? html`<p class="cap">${s.note}</p>` : ''}
</div>
<div class="ph-a"><a class="btn" href="/manual?case=${s.case.id}">${icon('plus')}Новый ручной кейс</a><a class="btn ghost" href="/api/manual/${s.id}/export" download>${icon('download')}Журнал JSON</a>${s.status === 'closed' ? html`<button class="btn ghost del" type="button" data-action="remove">${icon('trash')}Удалить</button>` : ''}</div>
</header>
<div class="setup">
<button class="pick lock" type="button" disabled><span class="col" style="gap: 2px"><span class="cap">Кейс</span><span class="m5">${s.case.id}</span></span>${icon('lock', 't3')}</button>
<button class="pick lock" type="button" disabled><span class="col" style="gap: 2px"><span class="cap">Агент</span><span class="m5">${s.agent.title}${s.agent.model ? ` · ${s.agent.model}` : ''}</span></span>${icon('lock', 't3')}</button>
<button class="pick lock" type="button" disabled><span class="col" style="gap: 2px"><span class="cap">Тестовый оператор</span><span class="m5">${s.senderMode === 'existing' ? 'существующий · его накопленные скиллы' : 'новый · стартовые скиллы сборки'}</span></span>${icon('lock', 't3')}</button>
</div>
${s.prep?.length ? html`<div class="col" style="gap: 0">${s.prep.map((p) => html`<div class="okr">${mk(p.ok === null ? 'na' : p.ok)}<span>${p.text}${p.note ? html`<span class="cap"> · ${p.note}</span>` : ''}</span><span class="cap mono">${s.senderId}</span></div>`)}</div>` : ''}
</div>`;
}

function composer(s, lessons) {
  const closed = s.status === 'closed';
  const busy = closed || !!s.busy || (s.execution?.pending ?? []).length > 0;
  const placeholder = closed ? 'Сессия закрыта' : s.busy ? `${s.busy} — реплика уйдёт после конца хода` : 'Например: срок возврата в данных не указан, не обещайте его клиенту';
  return html`<div class="composer ${busy ? 'busy' : ''}">
<label class="field"><span class="lbl">Сообщение агенту</span><textarea class="input" rows="2" id="msg-text" data-keep data-enter="send" placeholder="${placeholder}" ${busy ? 'disabled' : ''}></textarea></label>
<div class="row" style="gap: 16px">
<label class="chk" style="min-height: 0; padding: 0"><input type="checkbox" id="msg-corr" data-keep ${busy ? 'disabled' : ''}><span class="sm">Это поправка</span></label>
<select class="input" id="msg-lesson" data-keep style="width: auto; min-height: 36px; padding-top: 6px; padding-bottom: 6px" ${busy ? 'disabled' : ''}><option value="">урок не указан</option>${lessons.map((l) => html`<option value="${l.id}">${l.id} · ${l.rule.slice(0, 60)}</option>`)}</select>
</div>
<div class="row" style="justify-content: space-between; gap: 12px">
<div class="row" style="gap: 6px">
<button class="btn ${busy ? 'off' : ''}" type="button" data-action="cmd" data-name="reset" ${busy ? 'disabled' : ''}>${icon('reset')}/reset</button>
<button class="btn ${busy ? 'off' : ''}" type="button" data-action="cmd" data-name="capture" ${busy ? 'disabled' : ''}>${icon('capture')}/case-capture</button>
<button class="btn ${busy ? 'off' : ''}" type="button" data-action="cmd" data-name="curator" ${busy ? 'disabled' : ''}>${icon('curator')}/skill-curator</button>
</div>
<button class="btn ${busy ? 'off' : 'pri'}" type="button" data-action="send" ${busy ? 'disabled' : ''}>${icon('send')}Отправить</button>
</div>
<span class="cap">${busy && !closed ? 'Реплики и команды доступны после конца хода агента: в одной сессии один ход за раз.' : 'Enter — отправить, Shift+Enter — новая строка. Команда и её ответ сохранятся в истории; после /reset кейс начнётся заново с теми же заглушками.'}</span>
</div>`;
}

function side(s, judges) {
  const ev = s.execution?.events ?? [];
  const calls = ev.filter((e) => e.type === 'tool_call');
  const human = ev.filter((e) => e.type === 'human_message');
  const corrections = human.filter((e) => e.marks?.correction).length;
  const rejected = calls.filter((c) => c.confirmation?.decision === 'reject' && c.confirmation.by === 'human').length;
  const agentMsgs = ev.filter((e) => e.type === 'agent_message');
  const tokens = agentMsgs.reduce((a, m) => (m.usage ? (a ?? 0) + (m.usage.input ?? 0) + (m.usage.output ?? 0) : a), null);
  const evaln = s.evaluation;
  return html`
<section class="sec" aria-labelledby="log-h" style="gap: 4px">
<h2 class="h3" id="log-h" style="padding-bottom: 8px">Вызовы инструментов</h2>
${calls.length ? calls.map((c) => html`<div class="log"><a class="mono" href="#ev-${c.seq}" style="text-decoration: none">${c.tool}</a>${toolPill({ ...c, durationMs: null })}</div>`) : html`<span class="cap">Вызовов пока нет</span>`}
<span class="cap" style="padding-top: 8px">Видно, что агент вызвал и что получил. У ожидания — понятный срок.</span>
</section>
<section class="sec" aria-labelledby="mark-h" style="gap: 10px">
<h2 class="h3" id="mark-h">Разметка</h2>
<div class="log" style="border-top: 0; padding-top: 0"><span>Поправки</span><span class="num t2">${corrections}</span></div>
<div class="log"><span>Отклонённые действия</span><span class="num t2">${rejected}</span></div>
${human.length ? html`<div class="col" style="gap: 6px">${human.map((h) => html`<label class="chk" style="min-height: 0; padding: 4px 0"><input type="checkbox" data-change="mark" data-seq="${h.seq}" ${h.marks?.correction ? 'checked' : ''}><span class="sm">#${h.seq} — поправка${h.marks?.lessonId ? ` · ${h.marks.lessonId}` : ''}</span></label>`)}</div>` : ''}
<span class="cap">Ручные отметки хранятся отдельно от автоматических оценок и разбираются по тем же событиям.</span>
</section>
<section class="sec" aria-labelledby="sv-h" style="gap: 10px">
<h2 class="h3" id="sv-h">Результат</h2>
<div class="log" style="border-top: 0; padding-top: 0"><span>Ходы · вызовы</span><span class="num t2">${s.execution?.turns ?? 0} · ${calls.length}</span></div>
<div class="log"><span>Токены агента</span>${tokens === null ? html`<span class="t3">нет данных</span>` : html`<span class="num t2">${tokens}</span>`}</div>
${evaln
    ? html`<div class="log"><span>Итог</span><span>${evaln.outcome === 'passed' ? html`<span class="pill pass">Пройден</span>` : evaln.outcome === 'failed' ? html`<span class="pill fail">Не пройден</span>` : html`<span class="pill na">Не оценено</span>`}</span></div>
${evaln.checks ? checksBlock(evaln.checks) : ''}
${evaln.judge ? html`<div class="log"><span>Ответ · LLM-оценка</span><span class="t2">${evaln.judge.status === 'ok' ? `${evaln.judge.passed} из ${evaln.judge.total}` : evaln.judge.error ?? 'не оценён'}</span></div>` : ''}
${evaln.scores
    ? html`<div class="log"><span>Финальное действие · M1</span><span class="row" style="gap: 6px; justify-content: flex-end">${finalVerdict(evaln.scores.final)}</span></div>
<div class="log"><span>case_score · M2</span><span class="num t2">${fmtShare(evaln.scores.caseScore)} · F1 ${fmtShare(evaln.scores.tools.f1)} · A ${evaln.scores.answer.status === 'ok' ? fmtShare(evaln.scores.answer.score) : evaln.scores.answer.status === 'failed' ? 'сбой' : '—'}</span></div>`
    : ''}
<span class="cap">${evaln.reason}</span>`
    : s.status === 'active'
      ? html`<label class="field"><span class="lbl">LLM-оценка ответа при завершении</span><select class="input" id="fin-judge"><option value="">без LLM-оценки</option>${judges.map((j) => html`<option value="${j.id}" ${j.readiness ? 'disabled' : ''}>${j.title}${j.readiness ? ` · ${j.readiness}` : ''}</option>`)}</select></label>
<button class="btn" type="button" data-action="finish">${icon('download')}Завершить и сохранить</button>
<span class="cap">Проверки действий посчитаются автоматически по журналу инструментов.</span>`
      : ''}
</section>`;
}

export async function render(ctx) {
  const id = ctx.params[0];
  const [s, dir] = await Promise.all([get(`/api/manual/${id}`), ctx.state.dir ? Promise.resolve(ctx.state.dir) : get('/api/directory')]);
  ctx.state.dir = dir;
  if (!ctx.state.lessons) {
    const c = await get(`/api/cases/${encodeURIComponent(s.case.id)}`).catch(() => null);
    ctx.state.lessons = c?.reference.lessons ?? [];
  }
  const judges = dir.models.filter((m) => m.roles.includes('judge'));
  const closed = s.status === 'closed';
  const view = ctx.state.view ?? 'chat';
  const http = view === 'http' ? await get(`/api/manual/${id}/http`) : null;
  const n = s.execution?.httpCount;
  const body = view === 'http'
    ? exchangesView(http, {
        filter: ctx.state.httpFilter ?? 'all',
        download: `/api/manual/${id}/http?download=1`,
        empty: s.execution && n === undefined ? 'Обмены этой сессии не записаны: она прошла до того, как стенд начал сохранять HTTP-обмены.' : 'HTTP-обменов пока нет.',
        note: 'Каждый запрос ClawGym к агенту и каждый запрос агента к MCP-серверу ClawGym в этой сессии: заголовки (авторизация скрыта), тело, статус и время. Висящий вызов MCP виден сразу, ответ появляется после вашего решения.',
      })
    : s.execution
      ? feed(s.execution.events, { full: true, toolActions: (e) => toolActions(e, closed), httpLinks: true })
      : html`<p class="loading">Подготовка…</p>`;
  return html`<div id="m-head">${head(s)}</div>
<div class="split">
<section class="mn" aria-label="Диалог с агентом" style="gap: 20px">
<div id="m-tabs" class="row" style="justify-content: space-between; gap: 12px"><div class="seg" role="group" aria-label="Вид"><button type="button" class="${view === 'chat' ? 'on' : ''}" data-action="view" data-view="chat" aria-pressed="${view === 'chat'}">${icon('chat')}Диалог</button><button type="button" class="${view === 'http' ? 'on' : ''}" data-action="view" data-view="http" aria-pressed="${view === 'http'}">${icon('plug')}HTTP-обмены${n === undefined ? '' : ` · ${n}`}</button></div>${view === 'chat' ? legend() : ''}</div>
<div id="m-feed">${body}</div>
<div id="m-composer">${composer(s, ctx.state.lessons)}</div>
${hint('Если для вызова нет заглушки, он ждёт вашего ответа. Для введённого ответа доступен YAML-фрагмент, который можно добавить в файл кейса.', 'tool')}
</section>
<aside class="sd" id="m-side" style="gap: 28px">${side(s, judges)}</aside>
</div>`;
}

/** Обновление без потери введённого текста: заменяются только области, значения полей сохраняются. */
export function patch(root, out) {
  const keep = new Map();
  for (const el of root.querySelectorAll('[data-keep]')) keep.set(el.id, el.type === 'checkbox' ? el.checked : el.value);
  const focused = document.activeElement?.id;
  const tpl = document.createElement('template');
  tpl.innerHTML = String(out);
  for (const id of ['m-head', 'm-tabs', 'm-feed', 'm-composer', 'm-side']) {
    const fresh = tpl.content.getElementById(id);
    const cur = root.querySelector(`#${id}`);
    if (fresh && cur) cur.innerHTML = fresh.innerHTML;
  }
  for (const [id, v] of keep) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = v;
    else el.value = v;
  }
  if (focused) root.querySelector(`#${CSS.escape(focused)}`)?.focus();
}

export const refreshOn = (msg, ctx) => msg.type === 'manual' && msg.topic === `manual:${ctx.params[0]}`;

export const actions = {
  async remove(el, ctx) {
    const s = await get(`/api/manual/${ctx.params[0]}`);
    if (await removeSession({ id: s.id, key: s.key, caseId: s.case.id, caseTitle: s.case.title })) ctx.navigate('/manual');
  },
  view(el, ctx) {
    ctx.state.view = el.dataset.view;
    return ctx.rerender();
  },
  showHttp(el, ctx) {
    ctx.state.view = 'http';
    ctx.state.focus = `http-${el.dataset.http}`;
    return ctx.rerender();
  },
  toEvent(el, ctx) {
    ctx.state.view = 'chat';
    ctx.state.focus = `ev-${el.dataset.seq}`;
    return ctx.rerender();
  },
  httpFilter(el, ctx) {
    ctx.state.httpFilter = el.dataset.filter;
    return ctx.rerender();
  },
  async decide(el, ctx) {
    await post(`/api/manual/${ctx.params[0]}/tool/${el.dataset.call}`, { action: el.dataset.decision });
  },
  async answer(el, ctx) {
    const text = document.getElementById(`ans-${el.dataset.call}`)?.value ?? '';
    await post(`/api/manual/${ctx.params[0]}/tool/${el.dataset.call}`, { action: 'answer', text });
  },
  async toolError(el, ctx) {
    const text = document.getElementById(`ans-${el.dataset.call}`)?.value ?? '';
    const message = text && text !== '{}' ? text : 'Ошибка инструмента';
    await post(`/api/manual/${ctx.params[0]}/tool/${el.dataset.call}`, { action: 'error', message });
  },
  async send(el, ctx) {
    const ta = document.getElementById('msg-text');
    if (!ta || ta.disabled || ctx.state.sending) return;
    const text = ta.value.trim();
    if (!text) return toast('Введите сообщение', true);
    const correction = document.getElementById('msg-corr').checked;
    const lessonId = document.getElementById('msg-lesson').value || null;
    ctx.state.sending = true;
    try {
      await post(`/api/manual/${ctx.params[0]}/message`, { text, correction, lessonId });
    } finally {
      ctx.state.sending = false;
    }
    ta.value = '';
    document.getElementById('msg-corr').checked = false;
    return ctx.rerender();
  },
  async cmd(el, ctx) {
    await post(`/api/manual/${ctx.params[0]}/command`, { name: el.dataset.name });
    return ctx.rerender();
  },
  async mark(el, ctx) {
    await post(`/api/manual/${ctx.params[0]}/mark`, { seq: Number(el.dataset.seq), correction: el.checked, lessonId: document.getElementById('msg-lesson')?.value || null });
    return ctx.rerender();
  },
  async finish(el, ctx) {
    const judge = document.getElementById('fin-judge')?.value || null;
    await post(`/api/manual/${ctx.params[0]}/finish`, { judge });
    toast('Сессия завершена и сохранена');
    return ctx.rerender();
  },
};
void fmtDur;
void plural;
