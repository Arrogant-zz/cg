// Экран «Кейсы и решения»: ситуация, стартовые данные, заглушки, эталон, решения со своими инструкциями (CASE-01–04, SOL-01).
import { html, icon, get, post, typeBadge, mk, ref, hint, later, plural, issuesBox, warningsList, toast } from '../lib.js';

export const title = 'Кейсы и решения';

function kvsOf(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...kvsOf(v, `${prefix}${k}.`));
    else out.push(html`<dt class="mono" style="font-size: 12px">${prefix}${k}</dt><dd>${Array.isArray(v) ? v.join(', ') : String(v)}</dd>`);
  }
  return out;
}

function stubTable(c) {
  if (!c.stubs.length) return html`<div class="empty">У кейса нет заглушек: в ручном режиме отвечает человек, в автоматическом агент получает ошибку инструмента.</div>`;
  return html`<div class="tw"><table class="tbl">
<thead><tr><th>Инструмент</th><th>Заглушка</th><th>Условие на аргументы</th><th>Ответ</th><th>Меняет состояние</th></tr></thead>
<tbody>${c.stubs.map(
    (s) => html`<tr>
<td class="mono m5">${s.tool}</td>
<td class="mono sm">${s.id}${s.call ? html` <span class="cap">· вызов ${s.call}</span>` : ''}</td>
<td class="${s.when ? 'mono sm' : 'sm t2'}">${s.when || 'любые'}</td>
<td>${s.delayMs ? html`<span class="pill">задержка ${(s.delayMs / 1000).toLocaleString('ru-RU')} с</span> ` : ''}<span class="pill ${s.kind === 'error' ? 'fail' : 'pass'}">${s.kind === 'error' ? 'ошибка' : 'успех'}</span> <span class="sm t2 mono">${s.summary}</span></td>
<td class="${s.effect ? 'mono sm' : 't3'}">${s.effect || '—'}</td>
</tr>`,
  )}</tbody></table></div>`;
}

function reference(c) {
  const r = c.reference;
  const lessons = new Map(r.lessons.map((l) => [l.id, l.rule]));
  return html`<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 28px 40px">
<div class="col" style="gap: 12px">
<span class="lbl">Процедура</span>
<ol class="steps-ol">${r.procedure.map((p, i) => html`<li><span>${i + 1}</span><span>${p}</span></li>`)}</ol>
${r.answer ? html`<span class="lbl" style="padding-top: 8px">Правильный ответ</span><div class="quote">${r.answer}</div>` : ''}
</div>
<div class="col" style="gap: 16px">
<div class="col" style="gap: 8px"><span class="lbl">Критерии ответа · для LLM-оценки</span>${r.criteria.length ? r.criteria.map((x) => html`<span class="sm">${x.text}${x.lesson ? html` <span class="lesson">${x.lesson}</span>` : ''}</span>`) : html`<span class="cap">нет критериев — LLM-оценка пропускается</span>`}</div>
<div class="col" style="gap: 8px"><span class="lbl">Действия · для автоматической проверки</span>
${r.required.map((a) => html`<span class="row sm" style="gap: 8px; flex-wrap: nowrap; align-items: flex-start"><span class="pill pass">обязательно</span><span><span class="mono">${a.tool}</span>${a.before ? html` до <span class="mono">${a.before}</span>` : ''}${a.lesson ? html` <span class="lesson">${a.lesson}</span>` : ''}</span></span>`)}
${r.final ? html`<span class="row sm" style="gap: 8px"><span class="pill pass">итог</span><span class="mono">${r.final}</span></span>` : ''}
${r.forbidden.map((a) => html`<span class="row sm" style="gap: 8px"><span class="pill fail">запрещено</span><span class="mono">${a.tool}</span>${a.lesson ? html`<span class="lesson">${a.lesson}</span>` : ''}</span>`)}
</div>
${r.lessons.length ? html`<div class="col" style="gap: 8px"><span class="lbl">Каталог уроков кейса</span>${r.lessons.map((l) => html`<span class="sm"><span class="lesson">${l.id}</span> ${l.rule}</span>`)}</div>` : ''}
</div>
</div>`;
  void lessons;
}

function solutionCard(s) {
  return html`<div class="sol">
<span class="h3">${s.title}</span>
<span class="cap mono">${s.file}</span>
${s.goal ? html`<span class="sm t2">Цель: ${s.goal}</span>` : ''}
<div class="quote">${s.instruction}</div>
<span class="row cap" style="gap: 6px">${s.usage.length ? s.usage.map((u) => html`<a href="/baskets/${u.basket}" style="text-decoration: none">${typeBadge(u.type, true)}</a><span>${u.basket} · позиция ${u.pos}</span>`) : 'не входит в корзины'}</span>
${s.seesToolResults ? '' : html`<span class="cap">Оператор не видит результаты инструментов</span>`}
${s.issues.length ? warningsList(s.issues) : ''}
</div>`;
}

export async function render(ctx) {
  const list = await get('/api/cases');
  const sel = ctx.params[0] ?? list.cases[0]?.id;
  const q = (ctx.state.q ?? '').toLowerCase();
  const filtered = list.cases.filter((c) => !q || `${c.id} ${c.title} ${c.topic} ${c.tags.join(' ')}`.toLowerCase().includes(q));
  const c = sel ? await get(`/api/cases/${encodeURIComponent(sel)}`).catch(() => null) : null;
  const ok = !list.errors;
  return html`<header class="ph">
<div class="ph-t"><h1 class="h1">Кейсы и решения</h1><p class="lede">Кейс хранит ситуацию, заглушки и общий эталон. Решение — сценарий LLM-оператора для этого кейса: заглушки и эталон в него не копируются.</p></div>
<div class="ph-a"><span class="row cap" style="gap: 8px">${mk(ok ? true : false)}${list.cases.length} ${plural(list.cases.length, 'кейс', 'кейса', 'кейсов')} · ${list.solutions} ${plural(list.solutions, 'решение', 'решения', 'решений')} · ${ok ? 'ошибок нет' : `${list.errors} ${plural(list.errors, 'ошибка', 'ошибки', 'ошибок')}`}</span><button class="btn" type="button" data-action="reload">${icon('refresh')}Перечитать файлы</button></div>
</header>
<div class="split">
<div class="lst">
<label class="field" style="padding-bottom: 8px"><span class="lbl">Поиск по кейсам</span><input class="input" type="search" placeholder="Название, тема или тег" value="${ctx.state.q ?? ''}" data-change="search"></label>
${filtered.map(
    (x) => html`<a class="li ${x.id === sel ? 'on' : ''}" href="/cases/${x.id}" ${x.id === sel ? 'aria-current="true"' : ''}><span class="mono sm m5">${x.id}</span><span class="sm">${x.title}</span><span class="row cap" style="gap: 6px">${x.topic} · ${x.solutions ? `${x.solutions} ${plural(x.solutions, 'решение', 'решения', 'решений')}` : html`<span class="pill na" style="min-height: 20px">только вручную</span>`}${x.errors ? html`<span class="pill fail" style="min-height: 20px">ошибка</span>` : ''}</span></a>`,
  )}
${filtered.length ? '' : html`<span class="cap" style="padding: 8px 16px">Ничего не найдено</span>`}
</div>
${c
    ? html`<article class="det" aria-labelledby="case-h">
<div class="col" style="gap: 12px">
<div class="row" style="gap: 8px">${ref(c.file)}<span class="pill">${c.topic}</span>${c.tags.map((t) => html`<span class="pill">${t}</span>`)}</div>
<div class="row" style="justify-content: space-between; gap: 16px; align-items: flex-end">
<div class="col" style="gap: 4px"><h2 class="h1" id="case-h" style="font-size: 26px; line-height: 34px">${c.title}</h2><span class="mono t3">${c.id} @${c.hash}</span></div>
<div class="row"><a class="btn" href="/manual?case=${c.id}">${icon('chat')}Пройти вручную</a></div>
</div>
${c.issues.length ? html`${issuesBox(c.issues, 'Ошибки в файле кейса')}${warningsList(c.issues)}` : ''}
</div>
<section class="sec" aria-labelledby="sit-h" style="gap: 12px">
<h3 class="h2" id="sit-h">Ситуация и стартовые данные</h3>
${c.situation ? html`<p class="lede" style="font-size: 14px; line-height: 22px">${c.situation}</p>` : ''}
<dl class="kvs">${kvsOf(c.start)}</dl>
${c.facts.length ? html`<div class="col" style="gap: 6px"><span class="lbl">Факты для ответов оператора</span>${c.facts.map((f) => html`<span class="sm">· ${f}</span>`)}</div>` : ''}
${Object.keys(c.state).length ? html`<div class="row cap" style="gap: 6px">Начальное состояние выполнения: ${Object.entries(c.state).map(([k, v]) => html`<span class="ref">${k} = ${String(v)}</span>`)}</div>` : ''}
<span class="cap">Номер обращения выдаётся на выполнение и остаётся тем же в его capture. Поля стартового сообщения — по шаблону contracts/start-message.txt, сейчас условному.</span>
${c.startPreview
    ? html`<details class="raw" id="start-preview"><summary>Стартовое сообщение — как его получит агент</summary><pre>${c.startPreview.text}</pre><p class="cap" style="padding-bottom: 8px">x-task-id, номер обращения и request_ref подставляются на выполнении. Шаблон — ${c.startPreview.file}${c.startPreview.missing.length ? `. Без значения в этом кейсе, строки выпадают: ${c.startPreview.missing.join(', ')}` : ''}.</p></details>`
    : ''}
</section>
<section class="sec" aria-labelledby="stub-h">
<div class="sec-h"><h3 class="h2" id="stub-h">Заглушки инструментов</h3><span class="cap">Состояние и счётчики — свои у каждого выполнения</span></div>
${stubTable(c)}
${c.unknownStubTools.length ? html`<p class="hint">${icon('warn')}<span>Инструментов ${c.unknownStubTools.join(', ')} нет в contracts/tools.json: агент их не увидит.</span></p>` : ''}
${c.disabledStubTools.length ? html`<p class="hint">${icon('info')}<span>${c.disabledStubTools.join(', ')} ${c.disabledStubTools.length > 1 ? 'выключены' : 'выключен'} в контракте (enabled: false): агент не видит ${c.disabledStubTools.length > 1 ? 'их' : 'его'} в tools/list. Заглушки доступны шаблону стартового сообщения как {{tools.<имя>}}.</span></p>` : ''}
<div class="col" style="gap: 8px">
${hint(`Нет подходящей заглушки: в ручном режиме ${c.unmatchedMode === 'manual' ? 'отвечает человек' : 'агент получает ошибку'}, в автоматическом агент получает ошибку инструмента, а вызов попадает в «неожиданные». Порядок поиска: кейс → contracts/tool-defaults.yaml.`, 'tool')}
${hint('Подходят несколько заглушек — выбирается заглушка с более точным условием; при равенстве — первая в файле.')}
</div>
</section>
<section class="sec" aria-labelledby="ref-h">
<div class="sec-h"><h3 class="h2" id="ref-h">Эталон</h3><span class="row cap" style="gap: 6px">${icon('hidden', 's14')}агенту не передаётся</span></div>
${reference(c)}
</section>
<section class="sec" aria-labelledby="sol-h">
<div class="sec-h"><h3 class="h2" id="sol-h">Решения · ${c.solutions.length}</h3><span class="cap">Одни заглушки и эталон, разные инструкции оператору</span></div>
${c.solutions.length ? html`<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px">${c.solutions.map(solutionCard)}</div>` : html`<div class="empty">У кейса нет решений: он доступен только для ручного запуска.</div>`}
${hint(html`Кейс и решения правятся в файлах; ClawGym перечитывает их по кнопке проверки. Редактор кейсов и решений — ${later()}`, 'file')}
</section>
</article>`
    : html`<div class="det"><div class="empty">Выберите кейс.</div></div>`}
</div>`;
}

export const refreshOn = (msg) => msg.type === 'config';

export const actions = {
  search(el, ctx) {
    ctx.state.q = el.value;
    return ctx.rerender();
  },
  async reload(el, ctx) {
    const r = await post('/api/config/reload');
    const e = r.issues.filter((i) => i.severity === 'error').length;
    toast(e ? `Ошибок в файлах: ${e}` : 'Файлы перечитаны, ошибок нет', e > 0);
    return ctx.rerender();
  },
};
