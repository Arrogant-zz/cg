// Экран «Сравнение»: сопоставимость условий, метрики A → B, различия по кейсам (RES-02, SK-06).
import { html, icon, get, typeBadge, fmtDate, fmtDur, mk, hint, later, fmtShare } from '../lib.js';

export const title = 'Сравнение';

function runOption(r, selected) {
  const ss = r.testOperator ? ` · ${r.testOperator}` : '';
  return html`<option value="${r.id}" ${selected ? 'selected' : ''}>#${r.id} ${r.title}${ss} · ${fmtDate(r.finishedAt)}</option>`;
}

// Доли от 0 до 1: метрики аналитика. Δ = B − A, как ΔM1 = M1_after − M1_before в документе аналитика.
const SHARES = ['final-action', 'tools-f1', 'answer-match', 'case-score'];
const LEAD = { 'final-action': 'ΔM1', 'case-score': 'ΔM2' };

function deltaOf(a, b) {
  if (!a || !b || a.status !== 'ok' || b.status !== 'ok' || a.value === null || b.value === null) return html`<span class="delta same">${a?.status !== 'ok' && b?.status !== 'ok' ? 'нет данных ни в одном прогоне' : 'нет данных в одном из прогонов'}</span>`;
  if (a.denominator !== b.denominator && a.denominator !== null) return html`<span class="delta same">знаменатели различаются</span>`;
  const d = b.value - a.value;
  const lead = LEAD[a.builtin] ? `${LEAD[a.builtin]} ` : '';
  if (SHARES.includes(a.builtin)) {
    if (Math.abs(d) < 0.005) return html`<span class="delta same">${lead}0,00 · без изменений</span>`;
    return html`<span class="delta ${d > 0 ? 'up' : 'down'}">${lead}${d > 0 ? '+' : '−'}${fmtShare(Math.abs(d))}</span>`;
  }
  if (!d) return html`<span class="delta same">без изменений</span>`;
  const good = ['success', 'answer-quality', 'action-checks'].includes(a.builtin) ? d > 0 : d < 0;
  const size = a.builtin === 'turns-duration' ? fmtDur(Math.abs(d)) : String(Math.abs(Math.round(d * 10) / 10));
  if (a.builtin === 'turns-duration' && Math.abs(d) < 1000) return html`<span class="delta same">без заметных изменений</span>`;
  return html`<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '+' : '−'}${size}</span>`;
}

function pairKpi(p) {
  const a = p.a;
  const b = p.b;
  if (a.status !== 'ok' && b?.status !== 'ok') return html`<div class="kpi dim"><span class="k">${a.title}</span><span class="v na">нет данных</span><span class="cap">${a.reason || b?.reason || ''}</span></div>`;
  return html`<div class="kpi"><span class="k">${a.title}</span><span class="v">${a.status === 'ok' ? a.display : '—'} <span class="ar">→</span> ${b?.status === 'ok' ? b.display : '—'}</span>${deltaOf(a, b)}</div>`;
}

export async function render(ctx) {
  const { runs } = await get('/api/runs');
  const done = runs.filter((r) => r.status === 'completed' || r.status === 'stopped');
  let a = Number(ctx.query.get('a')) || null;
  let b = Number(ctx.query.get('b')) || null;
  if (b && !a) {
    const rb = done.find((r) => r.id === b);
    a = done.find((r) => r.id !== b && r.configId !== rb?.configId && r.type === rb?.type)?.id ?? done.find((r) => r.id !== b)?.id ?? null;
  }
  if (!a && !b && done.length >= 2) {
    b = done[0].id;
    a = done[1].id;
  }
  const head = html`<header class="ph"><div class="ph-t"><h1 class="h1">Сравнение прогонов</h1><p class="lede">Одна проверяющая корзина до и после обучения тестового оператора — или любые два прогона. Сначала — сопоставимы ли условия, затем — что изменилось в каждом кейсе.</p></div></header>`;
  if (done.length < 2) return html`${head}<div class="empty">Для сравнения нужны два завершённых прогона.</div>`;
  const c = await get(`/api/compare?a=${a}&b=${b}`);
  const pickA = html`<label class="field"><span class="lbl">Прогон A</span><select class="input" data-change="pick" data-side="a">${done.map((r) => runOption(r, r.id === a))}</select></label>`;
  const pickB = html`<label class="field"><span class="lbl">Прогон B</span><select class="input" data-change="pick" data-side="b">${done.map((r) => runOption(r, r.id === b))}</select></label>`;
  const opOf = (x) => html`<span class="pill">${x.testOperator}</span>`;
  const scored = c.cases.some((x) => x.a?.scores || x.b?.scores);
  return html`${head}
<div class="pair">${pickA}<button class="btn ghost sq" type="button" data-action="swap" aria-label="Поменять прогоны местами" style="align-self: end">${icon('swap')}</button>${pickB}</div>
<div class="row" style="gap: 8px">${typeBadge(c.a.type)}<a href="/runs/${c.a.id}">#${c.a.id}</a>${opOf(c.a)}${icon('arrow', 's14 t3')}${typeBadge(c.b.type)}<a href="/runs/${c.b.id}">#${c.b.id}</a>${opOf(c.b)}</div>
<section class="split" aria-labelledby="cmp-h">
<div class="mn sec" style="gap: 6px">
<div class="sec-h" style="padding-bottom: 10px"><h2 class="h2" id="cmp-h">Сопоставимость условий</h2><span class="pill ${c.comparable ? 'pass' : 'na'}">${c.comparable ? icon('check') : ''}${c.conclusion}</span></div>
<div class="tw"><table class="tbl"><thead><tr><th>Настройка</th><th>#${c.a.id}</th><th>#${c.b.id}</th><th></th></tr></thead>
<tbody>${c.rows.map((r) => html`<tr><td class="${r.focus ? 'm5' : 't2'}">${r.title}</td><td><span class="${r.key === 'basket' || r.key === 'contract' ? 'mono' : ''}">${r.a}</span></td><td><span class="${r.key === 'basket' || r.key === 'contract' ? 'mono' : ''}">${r.b}</span></td><td class="r">${r.same ? mk(true) : r.focus ? html`<span class="pill live">сравниваем это</span>` : html`<span class="pill fail">различается</span>`}</td></tr>`)}</tbody></table></div>
</div>
<aside class="sd" style="gap: 20px">
${c.limitations.length ? html`<div class="soft p20 col" style="gap: 10px"><span class="row m5" style="gap: 8px">${icon('warn')}Ограничения</span>${c.limitations.map((l) => html`<span class="sm t2">${l}</span>`)}</div>` : ''}
${hint('Схема аналитика: проверка на новом тестовом операторе, обучение, та же проверка на обученном операторе. Тогда условия различаются только оператором, а ΔM1 и ΔM2 показывают эффект обучения.')}
</aside>
</section>
<section class="kpis" aria-label="Метрики A и B" style="grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr))">
${c.metrics.filter((p) => LEAD[p.a.builtin]).map(pairKpi)}
<div class="kpi"><span class="k">Успех на общих кейсах</span><span class="v">${c.common.passA} <span class="ar">→</span> ${c.common.passB} <small>из ${c.common.n}</small></span><span class="delta ${c.common.passB > c.common.passA ? 'up' : c.common.passB < c.common.passA ? 'down' : 'same'}">${c.common.passB - c.common.passA > 0 ? '+' : ''}${c.common.passB - c.common.passA} ${Math.abs(c.common.passB - c.common.passA) === 1 ? 'кейс' : 'кейса'}</span></div>
${c.metrics.filter((p) => !LEAD[p.a.builtin]).filter((p) => !['corrections', 'repeated-corrections'].includes(p.a.builtin) || c.a.type === 'training').map(pairKpi)}
</section>
<section class="sec" aria-labelledby="cases-h">
<div class="sec-h"><h2 class="h2" id="cases-h">По кейсам</h2><span class="row cap" style="gap: 14px"><span>Улучшилось <span class="num t2 m5">${c.counts.better}</span></span><span>Ухудшилось <span class="num t2 m5">${c.counts.worse}</span></span><span>Без изменений <span class="num t2 m5">${c.counts.same}</span></span><span>Не сравнивается <span class="num t2 m5">${c.counts.na}</span></span></span></div>
<div class="tw"><table class="tbl"><thead><tr><th>№</th><th>Кейс</th><th>#${c.a.id}</th><th>#${c.b.id}</th><th>Изменение</th>${scored ? html`<th title="case_score = w_tools · F1 + w_answer · A_judge">case_score</th>` : ''}<th>Что видно в журнале</th></tr></thead>
<tbody>${c.cases.map((x) => {
    const cell = (it) => (!it ? mk('na') : it.outcome === 'passed' ? mk(true) : it.outcome === 'failed' ? mk(false) : it.outcome === 'technical' ? mk('tech') : mk('na'));
    const link = (run, it) => (it?.execName ? `/runs/${run}/cases/${it.execName}` : null);
    const ch = x.change === 'better' ? html`<span class="pill pass">Улучшение</span>` : x.change === 'worse' ? html`<span class="pill fail">Ухудшение</span>` : x.change === 'same' ? html`<span class="pill">Без изменений</span>` : html`<span class="pill na">Не сравнивается</span>`;
    const sa = x.a?.scores?.caseScore ?? null;
    const sb = x.b?.scores?.caseScore ?? null;
    const sd = sa !== null && sb !== null ? sb - sa : null;
    const scoreCell = html`<td class="num nw">${fmtShare(sa)} <span class="t3">→</span> ${fmtShare(sb)}${sd !== null && Math.abs(sd) >= 0.005 ? html` <span class="delta ${sd > 0 ? 'up' : 'down'}" style="display: inline">${sd > 0 ? '+' : '−'}${fmtShare(Math.abs(sd))}</span>` : ''}</td>`;
    return html`<tr><td class="num m5">${x.pos}</td><td>${link(c.b.id, x.b) ? html`<a class="rl mono" href="${link(c.b.id, x.b)}">${x.case}</a>` : html`<span class="mono">${x.case}</span>`}<div class="cap">${x.solution}</div></td><td>${link(c.a.id, x.a) ? html`<a href="${link(c.a.id, x.a)}" aria-label="Разбор в #${c.a.id}">${cell(x.a)}</a>` : cell(x.a)}</td><td>${link(c.b.id, x.b) ? html`<a href="${link(c.b.id, x.b)}" aria-label="Разбор в #${c.b.id}">${cell(x.b)}</a>` : cell(x.b)}</td><td>${ch}</td>${scored ? scoreCell : ''}<td class="t2">${x.note || html`<span class="t3">—</span>`}</td></tr>`;
  })}</tbody></table></div>
${hint(html`Здесь — наблюдаемые различия ответа и действий. Причины по журналу знаний агента — «урок не показан», «скилл не прочитан», «прочитан, но не применён» — ${later()}`)}
</section>`;
}

export const actions = {
  pick(el, ctx) {
    const q = new URLSearchParams(location.search);
    const other = el.dataset.side === 'a' ? 'b' : 'a';
    if (!q.get(other)) q.set(other, document.querySelector(`select[data-side="${other}"]`)?.value ?? '');
    q.set(el.dataset.side, el.value);
    ctx.navigate(`/compare?${q}`, true);
  },
  swap(el, ctx) {
    const a = document.querySelector('select[data-side="a"]')?.value;
    const b = document.querySelector('select[data-side="b"]')?.value;
    ctx.navigate(`/compare?a=${b}&b=${a}`, true);
  },
};
