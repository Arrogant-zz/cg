// Экран «Корзины»: два типа, правила команд, план, фиксированный состав (BASK-01–05).
import { html, icon, get, typeBadge, mk, ref, hint, later, planView, planLegend, issuesBox, plural } from '../lib.js';

export const title = 'Корзины';

function rules(b) {
  if (b.type === 'checking') {
    return html`<div class="okr">${mk(true)}<span>/reset перед каждым кейсом</span><span class="mono cap">обязательно</span></div>
<div class="okr">${mk(true)}<span>/case-capture и /skill-curator не отправляются</span><span class="mono cap">тип checking</span></div>
<div class="okr">${mk(true)}<span>${b.checking.confirmations === 'approve' ? 'Подтверждения разрешаются без вмешательства оператора' : 'По подтверждениям решает LLM-оператор без поправок'}</span><span class="mono cap">checking.confirmations: ${b.checking.confirmations}</span></div>
<div class="okr">${mk('na')}<span>Поправки из инструкции решения в проверке не исполняются; попытка отмечается как нарушение режима</span><span class="cap">правило раннера</span></div>`;
  }
  const c = b.curator;
  return html`<div class="okr">${mk(c.enabled && c.every > 0 ? true : 'na')}<span>${c.enabled && c.every > 0 ? `/skill-curator каждые ${c.every} завершённых решения` : 'Периодический /skill-curator выключен'}</span><span class="mono cap">curator.every: ${c.every}</span></div>
<div class="okr">${mk(c.enabled && c.final ? true : 'na')}<span>Финальный проход, если последняя пачка неполная</span><span class="mono cap">curator.final: ${c.final}</span></div>
<div class="okr">${mk(c.resetBefore ? true : 'na')}<span>/reset перед /skill-curator</span><span class="mono cap">curator.resetBefore: ${c.resetBefore}</span></div>
<div class="okr">${mk('na')}<span>Кейс прерван технически: capture не отправляется, счётчик curator не растёт</span><span class="cap">правило раннера</span></div>`;
}

export async function render(ctx) {
  const list = await get('/api/baskets');
  const sel = ctx.params[0] ?? list[0]?.id;
  const b = sel ? await get(`/api/baskets/${encodeURIComponent(sel)}`).catch(() => null) : null;
  return html`<header class="ph"><div class="ph-t"><h1 class="h1">Корзины</h1><p class="lede">Корзина — упорядоченный набор решений одного типа. Тип определяет, учится ли агент во время прогона; смешивать обучение и проверку в одной корзине нельзя.</p></div></header>
<section class="types" aria-label="Типы корзин">
<div style="background: #FDF6F1">
${typeBadge('training')}
<ul class="col" style="gap: 6px">
<li>${icon('reset')}<span>/reset перед каждым кейсом</span></li>
<li>${icon('capture')}<span>/case-capture после каждого завершённого кейса, даже решённого неверно</span></li>
<li>${icon('curator')}<span>/skill-curator — по настройке корзины</span></li>
<li>${icon('bot')}<span>Оператор помогает по сценарию решения</span></li>
<li>${icon('layers')}<span>Изменения скиллов фиксируются после каждого /skill-curator; итог — новая версия набора</span></li>
</ul>
</div>
<div style="background: #F7F7F4">
${typeBadge('checking')}
<ul class="col" style="gap: 6px">
<li>${icon('reset')}<span>/reset перед каждым кейсом</span></li>
<li>${icon('x')}<span>Без /case-capture и /skill-curator</span></li>
<li>${icon('bot')}<span>Оператор только уточняет факты; поправки из инструкции решения не исполняются, расхождение отмечается</span></li>
<li>${icon('layers')}<span>Набор скиллов меняться не должен: файлы сверяются до и после, изменение отмечается в результате</span></li>
</ul>
</div>
</section>
<div class="split">
<div class="lst">
<span class="lbl" style="padding: 0 16px 6px">baskets/ · ${list.length} ${plural(list.length, 'файл', 'файла', 'файлов')}</span>
${list.map(
    (x) => html`<a class="li ${x.id === sel ? 'on' : ''}" href="/baskets/${x.id}"><span class="row" style="justify-content: space-between"><span class="m5">${x.title}</span>${x.errors ? html`<span class="pill fail">ошибка</span>` : x.type === 'training' ? html`<span class="ball"></span>` : html`<span class="ring"></span>`}</span><span class="cap mono">${x.file.replace('baskets/', '')} · ${x.firstError ? x.firstError.field ?? '' : `${x.items} ${plural(x.items, 'решение', 'решения', 'решений')}`}</span></a>`,
  )}
</div>
${b
    ? html`<article class="det" aria-labelledby="b-h">
<div class="col" style="gap: 10px">
<div class="row" style="gap: 8px">${typeBadge(b.type)}${ref(b.file)}</div>
<h2 class="h1" id="b-h" style="font-size: 26px; line-height: 34px">${b.title}</h2>
${b.description ? html`<span class="sm t2">${b.description}</span>` : ''}
<span class="sm t2">${b.runsUsing.length ? html`Используется в ${b.runsUsing.map((r) => html`<a class="mono" href="/runs/new?config=${r.id}">${r.file}</a> `)}` : 'Не используется в файлах прогонов'}${b.lastRun ? html` · последний прогон <a href="/runs/${b.lastRun.id}">#${b.lastRun.id}</a>` : ''}</span>
${issuesBox(b.issues, 'Ошибки в файле корзины')}
</div>
<section class="sec" aria-labelledby="rules-h" style="gap: 4px"><h3 class="h2" id="rules-h" style="padding-bottom: 10px">Команды</h3>${rules(b)}</section>
<section class="sec" aria-labelledby="plan-h">
<div class="sec-h"><h3 class="h2" id="plan-h">План команд</h3><span class="cap">показывается до запуска и сохраняется в результате</span></div>
<div class="row" style="justify-content: flex-end">${planLegend(b.type === 'training')}</div>
${planView(b.plan)}
<ul class="col sm t2" style="gap: 6px">${b.planText.map((t) => html`<li>${t}</li>`)}</ul>
</section>
<section class="sec" aria-labelledby="items-h">
<div class="sec-h"><h3 class="h2" id="items-h">Состав · фиксированный порядок</h3><span class="cap">Один кейс может войти несколько раз с разными решениями</span></div>
<div class="tw"><table class="tbl"><thead><tr><th>№</th><th>Кейс</th><th>Решение — сценарий оператора</th><th>После кейса</th></tr></thead>
<tbody>${b.items.map((i) =>
      i.kind === 'curator'
        ? html`<tr><td class="num m5">—</td><td colspan="2" class="t2">Явный шаг curator${i.note ? ` · ${i.note}` : ''}</td><td><span class="pb cu" style="height: 26px; padding: 0 8px">${icon('curator')}curator</span></td></tr>`
        : html`<tr><td class="num m5">${i.pos}</td><td>${i.case ? html`<a class="rl mono" href="/cases/${i.case}">${i.case}</a>` : html`<span class="pill fail">решение не найдено</span>`}</td><td>${i.title ?? html`<span class="mono">${i.solution}</span>`}</td><td><span class="steps">${i.capture ? html`<span class="sp">capture</span>` : html`<span class="sp off">без capture</span>`}${i.curatorAfter.map((r) => html`<span class="pb cu" style="height: 26px; padding: 0 8px">${r === 'final' ? 'curator финальный' : 'curator'}</span>`)}</span></td></tr>`,
    )}</tbody></table></div>
${hint(html`Состав и периодичность curator правятся в файле корзины. Редактор корзин — ${later()}`, 'file')}
</section>
</article>`
    : html`<div class="det"><div class="empty">В baskets/ нет корзин.</div></div>`}
</div>`;
}

export const refreshOn = (msg) => msg.type === 'config';
