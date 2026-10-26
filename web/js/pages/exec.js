// Экран «Разбор кейса»: журнал с ролями, вызовы и заглушки, решения оператора, оценка, режим «что видел агент» (SOL-02–06, RES-01).
import { html, icon, get, typeBadge, outcomePill, fmtDur, fmtClock, ref, hint, feed, legend, checksBlock, mk, STATUS_TITLES, TECH } from '../lib.js';

export const title = (ctx) => `Разбор ${ctx.params[1]}`;

function verdict(item, ex) {
  const o = item?.outcome;
  const big = o === 'passed' ? mk(true) : o === 'failed' ? mk(false) : o === 'technical' ? mk('tech') : mk('na');
  const text = o === 'passed' ? 'Пройден' : o === 'failed' ? 'Не пройден' : o === 'technical' ? STATUS_TITLES[item.status] ?? 'Технический сбой' : o === 'not_evaluated' ? 'Не оценено' : 'Выполняется';
  const lines = [];
  if (o === 'failed') {
    const fc = (item.checks ?? []).filter((c) => c.passed === false).length;
    lines.push(fc ? `Не выполнено проверок действий: ${fc}.` : 'Действия выполнены верно.');
    if (item.steps.judge?.status === 'ok') lines.push(`Ответ прошёл ${item.steps.judge.passed} из ${item.steps.judge.total} критериев.`);
  } else if (o === 'technical') lines.push(`${item.reason}. Это сбой стенда, а не неуспех агента: кейс не оценивается.`);
  else if (o === 'not_evaluated') lines.push(item.reason);
  else if (o === 'passed') lines.push('Все обязательные проверки действий и ответа пройдены.');
  const training = ex.basketType === 'training';
  const cap = item?.steps.capture;
  return html`<section class="verdict" aria-labelledby="v-h">
<div class="row" style="justify-content: space-between"><h2 class="h3" id="v-h">Итог</h2><span class="row cap" style="gap: 6px">${icon('hidden', 's14')}агент не видит</span></div>
<span class="row" style="gap: 10px">${big}<span class="h2">${text}</span></span>
<span class="sm t2">${lines.join(' ')}</span>
<span class="cap">Предложенное правило: итог — все обязательные проверки действий и ответа пройдены; без оценки ответа — «не оценено».</span>
${training && cap ? html`<span class="cap">${cap.status === 'not_sent' ? 'Capture не отправлялся: кейс прерван технически.' : `Capture: ${cap.status === 'ok' ? `кейс сохранён${o === 'failed' ? ' и после неверного решения — так задано для обучающей корзины' : ''}` : cap.status}${cap.signal ? ` · signal ${cap.signal}` : ''}.`}</span>` : ''}
</section>`;
}

function stats(ex, item) {
  const st = item?.stats;
  const judge = ex.events.filter((e) => e.type === 'judge').pop();
  const decisions = ex.events.filter((e) => e.type === 'operator_decision' && !e.forced);
  const corr = st ? st.lessons.map((l) => html`<span class="lesson">${l}${item.repeated?.includes(l) ? ' · повтор' : ''}</span>`) : [];
  return html`
<section class="sec" aria-labelledby="act-h" style="gap: 6px">
<div class="sec-h" style="padding-bottom: 6px"><h2 class="h3" id="act-h">Проверки действий</h2>${item?.steps.checks ? html`<span class="pill ${item.steps.checks.passed === item.steps.checks.total ? 'pass' : 'fail'}">${item.steps.checks.passed} из ${item.steps.checks.total}</span>` : html`<span class="pill na">нет</span>`}</div>
${item?.checks ? checksBlock(item.checks) : html`<span class="cap">Проверки не выполнялись${item?.outcome === 'technical' ? ': кейс прерван технически' : ''}</span>`}
<span class="cap" style="padding-top: 6px">Разрешение оператора на вызов — ещё не успех: проверяется фактически выполненное действие.</span>
</section>
<section class="sec" aria-labelledby="ans-h" style="gap: 6px">
<div class="sec-h" style="padding-bottom: 6px"><h2 class="h3" id="ans-h">Ответ · LLM-оценка</h2>${judge?.status === 'ok' ? html`<span class="pill ${judge.criteria.every((c) => c.passed) ? 'pass' : 'fail'}">${judge.criteria.filter((c) => c.passed).length} из ${judge.criteria.length}</span>` : html`<span class="pill na">не оценено</span>`}</div>
<div class="mt"><span>Модель и вызов</span><span class="t2">${judge?.model ?? '—'} · отдельный контекст</span></div>
${judge?.status === 'ok' ? html`<div class="mt"><span>Непройденные критерии</span><span class="t2">${judge.criteria.filter((c) => !c.passed).map((c) => c.text).join('; ') || 'нет'}</span></div><div class="mt"><span>Обоснование</span><span class="t2"><a href="#ev-${judge.seq}">событие #${judge.seq}</a></span></div>` : html`<div class="mt"><span>Причина</span><span class="t2">${judge?.error ?? 'оценка не запускалась'}</span></div>`}
</section>
${ex.mode === 'auto'
    ? html`<section class="sec" aria-labelledby="op-h" style="gap: 6px">
<h2 class="h3" id="op-h" style="padding-bottom: 6px">LLM-оператор</h2>
<div class="mt"><span>Модель</span><span class="t2">${decisions[0]?.model ?? '—'}</span></div>
<div class="mt"><span>Решения · реплики</span><span class="num t2">${decisions.length} · ${st?.operator.replies ?? 0}</span></div>
<div class="mt"><span>Поправки</span><span class="t2">${corr.length ? html`<span class="row" style="gap: 6px; justify-content: flex-end">${corr}</span>` : st?.corrections ? `${st.corrections} без урока` : '0'}</span></div>
<div class="mt"><span>Отклонения действий</span><span class="num t2">${st ? st.rejected.operator : '—'}${st?.rejected.timeout ? ` · по таймауту ${st.rejected.timeout}` : ''}</span></div>
<div class="mt"><span>Ошибки формата и LLM</span><span class="num t2">${st ? st.operator.failedAttempts : '—'}${st?.operator.modeViolations ? ` · нарушений режима ${st.operator.modeViolations}` : ''}</span></div>
</section>`
    : ''}
<section class="sec" aria-labelledby="km-h" style="gap: 6px">
<h2 class="h3" id="km-h" style="padding-bottom: 6px">Метрики кейса</h2>
<div class="mt"><span>Длительность</span><span class="num t2">${st ? fmtClock(st.durationMs) : '—'}</span></div>
${st ? html`<div class="mt"><span class="cap" style="grid-column: 1 / -1">агент ${fmtClock(st.time.agent)} · оператор ${fmtClock(st.time.operator)} · судья ${fmtClock(st.time.judge)} · команды ${fmtClock(st.time.commands)}</span></div>` : ''}
<div class="mt"><span>Токены агента</span>${st?.tokens.agent ? html`<span class="num t2">${(st.tokens.agent.input ?? 0) + (st.tokens.agent.output ?? 0)}</span>` : html`<span class="t3">нет данных</span>`}</div>
<div class="mt"><span>Токены оператора и судьи</span><span class="num t2">${st?.tokens.operator ? (st.tokens.operator.input ?? 0) + (st.tokens.operator.output ?? 0) : 'нет данных'} · ${st?.tokens.judge ? (st.tokens.judge.input ?? 0) + (st.tokens.judge.output ?? 0) : 'нет данных'}</span></div>
<div class="mt"><span>Неожиданные инструменты</span><span class="num t2">${st ? st.unexpected.length : '—'}${st?.unexpected.length ? ` · ${st.unexpected.map((u) => u.tool).join(', ')}` : ''}</span></div>
</section>
<section class="sec" aria-labelledby="f-h" style="gap: 10px">
<h2 class="h3" id="f-h">Файлы из снимка</h2>
<div class="col" style="gap: 8px; align-items: flex-start">
${ref(`${ex.case.file} @${ex.case.hash}`, 'file', `/cases/${ex.case.id}`)}
${ex.solution ? ref(`${ex.solution.file} @${ex.solution.hash}`, 'file', `/cases/${ex.case.id}`) : ''}
${item?.steps.capture?.path ? ref(`capture: ${item.steps.capture.path.split('/').pop()}`, 'capture') : ''}
</div>
</section>`;
}

export async function render(ctx) {
  const [id, name] = ctx.params;
  const [ex, run] = await Promise.all([get(`/api/runs/${id}/executions/${name}`), get(`/api/runs/${id}`)]);
  const item = ex.item;
  const full = ctx.state.view !== 'agent';
  const cases = run.lines.flatMap((l) => l.items).filter((i) => i.kind === 'case' && i.execName);
  const idx = cases.findIndex((i) => i.execName === name);
  const prev = cases[idx - 1];
  const next = cases[idx + 1];
  const st = item?.stats;
  return html`<div class="col" style="gap: 14px">
<nav class="crumbs" aria-label="Путь"><a href="/">Прогоны</a>${icon('chevRight', 's14')}<a href="/runs/${id}">#${id} ${run.title}</a>${icon('chevRight', 's14')}<span>Позиция ${item?.pos ?? '—'}</span></nav>
<header class="ph">
<div class="ph-t">
<div class="row" style="gap: 12px">${ex.basketType ? typeBadge(ex.basketType) : ''}${item ? outcomePill(item) : ''}${st ? html`<span class="cap num">${fmtDur(st.durationMs)} · ${st.turns} ${st.turns === 1 ? 'ход' : st.turns < 5 ? 'хода' : 'ходов'}</span>` : ''}<span class="ref">x-task-id: ${ex.taskIds[ex.taskIds.length - 1]}</span>${ex.live ? html`<span class="pill live">идёт</span>` : ''}</div>
<h1 class="h1"><span class="mono" style="font-size: 28px; letter-spacing: -.02em">${ex.case.id}</span>${ex.solution ? ` · ${ex.solution.title}` : ''}</h1>
<p class="lede">${ex.case.title}. ${TECH.has(ex.status) ? `Статус выполнения: ${STATUS_TITLES[ex.status] ?? ex.status}.` : ''}</p>
</div>
<div class="ph-a">${prev ? html`<a class="btn ghost" href="/runs/${id}/cases/${prev.execName}">Позиция ${prev.pos}</a>` : ''}${next ? html`<a class="btn" href="/runs/${id}/cases/${next.execName}">Позиция ${next.pos}${icon('chevRight')}</a>` : ''}</div>
</header>
</div>
<div class="split">
<section class="mn" aria-label="Журнал выполнения" style="gap: 24px">
<div class="row" style="justify-content: space-between; gap: 16px">
<div class="seg" role="group" aria-label="Вид журнала">
<button type="button" class="${full ? 'on' : ''}" data-action="view" data-view="full" aria-pressed="${full}">${icon('eye')}Полный журнал</button>
<button type="button" class="${full ? '' : 'on'}" data-action="view" data-view="agent" aria-pressed="${!full}">${icon('hidden')}Что видел агент</button>
</div>
${legend()}
</div>
${full ? '' : hint('Так диалог выглядел для агента: без инструкции и решений оператора, разметки поправок, имён заглушек и оценки. Эталон кейса в запрос агенту не подмешивается.', 'hidden')}
${feed(ex.events, { full })}
</section>
<aside class="sd" style="gap: 32px">
${verdict(item, ex)}
${stats(ex, item)}
</aside>
</div>`;
}

export const refreshOn = (msg, ctx) => msg.topic === `run:${ctx.params[0]}` && msg.type === 'exec' && msg.data?.name === ctx.params[1];

export const actions = {
  view(el, ctx) {
    ctx.state.view = el.dataset.view;
    return ctx.rerender();
  },
};
