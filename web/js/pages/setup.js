// Экран «Запуск прогона»: файл прогона, проверка ссылок, тестовый оператор, план команд, метрики (CFG-02, RUN-01, BASK-02–03, MET-02).
import { html, icon, get, post, typeBadge, planView, planLegend, issuesBox, warningsList, fmtDate, hint, mk, plural, toast } from '../lib.js';

export const title = 'Запуск прогона';

function choice(c, selected) {
  return html`<button class="choice ${selected ? 'on' : ''}" type="button" data-action="pick" data-id="${c.id}" aria-pressed="${selected ? 'true' : 'false'}">
<span class="row" style="justify-content: space-between">${c.basket.type ? typeBadge(c.basket.type) : html`<span class="pill fail">нет корзины</span>`}${c.errors ? html`<span class="pill fail">${icon('warn')}${c.errors} ${plural(c.errors, 'ошибка', 'ошибки', 'ошибок')}</span>` : c.lastRun ? html`<span class="cap">#${c.lastRun.id} · ${fmtDate(c.lastRun.createdAt, false)}</span>` : html`<span class="cap">не запускался</span>`}</span>
<span class="h3">${c.title}</span>
<span class="cap mono">${c.file}</span>
<span class="sm t2">${c.basket.items} ${plural(c.basket.items, 'решение', 'решения', 'решений')} · ${c.testOperator}</span>
</button>`;
}

/** Значение выбора тестового оператора: из адреса (?continue=), иначе из файла прогона. */
function operatorChoice(p, ctx) {
  const q = ctx.query.get('continue');
  if (q) return q;
  if (p.resolved?.testOperator.mode === 'continue') return String(p.resolved.testOperator.run);
  return p.continueFrom ? '' : 'new';
}

// Решение владельца от 27.10.2026: скиллы живут в агенте у тестового оператора (x-a2a-sender-id); ClawGym их не ставит и не выгружает.
function operatorRow(p, ctx) {
  const value = operatorChoice(p, ctx);
  const t = p.resolved?.testOperator;
  const training = p.resolved?.basket.type === 'training';
  const kind = (x) => (x.type === 'training' ? 'обучение' : 'проверка');
  // Отката скиллов нет: после выбранного прогона оператор мог пройти другие, и агент продолжит с его текущими скиллами.
  const current = t?.later?.length
    ? `После него оператор прошёл ${t.later.join(', ')}: агент продолжит с текущими скиллами оператора, а не с теми, что были сразу после #${t.run}.`
    : 'Агент продолжит со скиллами, которые оператор получил там.';
  const note =
    t?.mode === 'continue'
      ? `Тот же x-a2a-sender-id, что в прогоне #${t.run}. ${current} ${training ? 'Обучение продолжит менять его скиллы.' : 'Проверка не отправляет /case-capture и /skill-curator — скиллы оператора не меняются.'}`
      : 'Новый x-a2a-sender-id: агент начнёт со стартовых скиллов своей сборки. Чтобы проверить результат обучения, продолжите на операторе обучающего прогона.';
  return html`<span class="col" style="gap: 8px">
<select class="input" data-change="operator" aria-label="Тестовый оператор">
<option value="new" ${value === 'new' ? 'selected' : ''}>Новый — стартовые скиллы сборки агента</option>
${p.continueFrom && !value ? html`<option value="" selected disabled>Продолжить на последнем прогоне ${p.continueFrom} — завершённого нет</option>` : ''}
${p.continueOptions.map((o) => html`<option value="${o.id}" ${value === String(o.id) ? 'selected' : ''}>Продолжить на операторе #${o.id} ${o.title} · ${kind(o)} · ${fmtDate(o.finishedAt, false)}${o.later.length ? ` · потом прошёл ${o.later.join(', ')}` : ''}</option>`)}
</select>
<span class="cap">${note}${p.continueFrom ? ` По умолчанию файл продолжает последний завершённый прогон «${p.continueFrom}».` : ''}</span>
</span>`;
}

function whatRuns(p, ctx) {
  const r = p.resolved;
  if (!r) return '';
  return html`<section class="sec" aria-labelledby="what-h" style="gap: 4px">
<div class="sec-h" style="padding-bottom: 12px"><h2 class="h2" id="what-h">Что будет запущено</h2><span class="cap">Тип прогона берётся из корзины</span></div>
<div class="cfg"><span class="t3">Корзина</span><span class="col" style="gap: 6px"><span class="row"><a class="m5" href="/baskets/${r.basket.id}">${r.basket.title}</a>${typeBadge(r.basket.type)}</span><span class="cap mono">${r.basket.file} · ${r.basket.items} ${plural(r.basket.items, 'решение', 'решения', 'решений')} из ${r.basket.cases} ${plural(r.basket.cases, 'кейса', 'кейсов', 'кейсов')}</span></span></div>
<div class="cfg"><span class="t3">Агент</span><span class="col" style="gap: 6px"><span class="m5">${r.agent.title}</span><span class="cap">REST · <span class="mono">${r.agent.file}</span> · ${[r.agent.commands.reset, r.basket.type === 'training' ? r.agent.commands.capture.split(' ')[0] : null, r.basket.type === 'training' ? r.agent.commands.curator : null].filter(Boolean).join(', ')} · сборка ${r.agent.build ?? 'не указана'} · модель ${r.agent.model ?? 'не указана'}</span><span class="cap">Модель и стартовые скиллы задаёт сборка агента: ClawGym их не переключает</span></span></div>
<div class="cfg"><span class="t3">Модель оператора</span><span class="col" style="gap: 6px"><span class="m5">${r.operator?.title ?? '—'}</span><span class="cap">LLM-оператор ведёт диалог по инструкции решения${r.operator ? ` · ${r.operator.provider}` : ''}</span></span></div>
<div class="cfg"><span class="t3">Модель оценки</span><span class="col" style="gap: 6px"><span class="m5">${r.judge?.title ?? 'не выбрана'}</span><span class="cap">${r.judge ? 'Отдельный вызов после завершения кейса; оценку агент не видит' : 'Без модели оценки смысл ответа останется «не оценён»'}</span></span></div>
<div class="cfg"><span class="t3">Тестовый оператор</span>${operatorRow(p, ctx)}</div>
<div class="cfg"><span class="t3">Лимиты</span><span class="col" style="gap: 6px"><span>${r.limits.maxTurns} ходов · ${Math.round(r.limits.maxDurationSec / 60)} мин на кейс · ${r.limits.maxOperatorCalls} запросов оператора</span><span class="cap">Повторений: ${r.repetitions}${r.repetitions > 1 ? ' — у каждого свой тестовый оператор' : ''}${r.startAt ? ` · старт ${fmtDate(r.startAt)}` : ''}</span></span></div>
</section>`;
}

export async function render(ctx) {
  const configs = await get('/api/run-configs');
  if (!configs.length) {
    return html`<div class="col" style="gap: 14px"><nav class="crumbs"><a href="/">Прогоны</a>${icon('chevRight', 's14')}<span>Запуск прогона</span></nav><h1 class="h1">Запуск прогона</h1></div><div class="empty">В каталоге runs/ нет файлов прогонов.</div>`;
  }
  const sel = ctx.query.get('config') && configs.some((c) => c.id === ctx.query.get('config')) ? ctx.query.get('config') : ctx.state.sel ?? configs[0].id;
  ctx.state.sel = sel;
  const cont = ctx.query.get('continue');
  const p = await get(`/api/run-configs/${encodeURIComponent(sel)}/preview${cont ? `?continueFrom=${encodeURIComponent(cont)}` : ''}`);
  const training = p.resolved?.basket.type === 'training';
  const ahead = p.queueAhead.length;
  return html`<div class="col" style="gap: 14px">
<nav class="crumbs" aria-label="Путь"><a href="/">Прогоны</a>${icon('chevRight', 's14')}<span>Запуск прогона</span></nav>
<header class="ph">
<div class="ph-t"><h1 class="h1">Запуск прогона</h1><p class="lede">Прогон описан файлом в runs/: корзина, агент, модели оператора и оценки, тестовый оператор и метрики. Перед запуском ClawGym проверяет ссылки и показывает, что именно будет выполнено.</p></div>
<div class="ph-a"><button class="btn" type="button" data-action="reload">${icon('refresh')}Проверить файлы снова</button></div>
</header>
</div>
<div class="split">
<aside class="sd" aria-labelledby="files-h" style="flex: 1 1 300px; gap: 12px">
<div class="sec-h"><h2 class="h3" id="files-h">Файлы прогона</h2><span class="cap mono">runs/</span></div>
${configs.map((c) => choice(c, c.id === sel))}
${hint('Новый прогон — новый файл в runs/. Редактор настроек прогона появится на следующем этапе.', 'file')}
</aside>
<div class="mn" style="gap: 32px">
${p.ok
    ? html`<div class="soft p20" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px">
<div class="col" style="gap: 4px; flex: 1 1 360px">
<span class="row m5" style="gap: 10px">${mk(true)}<span>Настройки проверены: ${p.files} ${plural(p.files, 'файл', 'файла', 'файлов')}, все ссылки разрешены</span></span>
<span class="cap" style="padding-left: 30px">${ahead ? `Встанет в очередь после ${p.queueAhead.map((q) => `#${q.id}`).join(', ')}. ` : `Сессии агента: ${p.sessions.used} из ${p.sessions.capacity}. `}При запуске сохранится снимок настроек: правка файлов потом не изменит результат.</span>
</div>
<button class="btn pri" type="button" data-action="start">${icon('play')}Запустить прогон</button>
</div>`
    : html`${issuesBox(p.issues)}<div class="row" style="gap: 12px"><button class="btn" type="button" data-action="reload">${icon('refresh')}Проверить снова</button><button class="btn off" type="button" disabled>Запустить прогон</button><span class="cap">Агенту не отправлено ни одного запроса</span></div>`}
${whatRuns(p, ctx)}
<section class="sec" aria-labelledby="plan-h">
<div class="sec-h"><h2 class="h2" id="plan-h">План команд</h2>${planLegend(training)}</div>
${p.plan.length ? html`<div class="col" style="gap: 16px">${planView(p.plan)}<ul class="col sm t2" style="gap: 6px">${p.planText.map((t) => html`<li>${t}</li>`)}</ul></div>` : hint('План команд появится, когда корзина пройдёт проверку.', 'warn')}
</section>
<section class="sec" aria-labelledby="met-h">
<div class="sec-h"><h2 class="h2" id="met-h">Метрики</h2><span class="cap">Встроенные расчёты из <span class="mono">metrics/</span> · недоступное покажется как «нет данных», а не ноль</span></div>
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); column-gap: 36px">
${p.metrics.map((m) => html`<div class="okr">${mk(m.available ? true : 'na')}<span>${m.title}</span><span class="cap">${m.available ? m.reason || m.source : m.reason}</span></div>`)}
</div>
</section>
${p.issues.some((i) => i.severity === 'warning') ? html`<section class="sec" style="gap: 6px"><h2 class="h3">Предупреждения</h2>${warningsList(p.issues)}</section>` : ''}
</div>
</div>`;
}

export const refreshOn = (msg) => msg.type === 'config';

export const actions = {
  pick(el, ctx) {
    ctx.state.sel = el.dataset.id;
    const q = new URLSearchParams(location.search);
    q.set('config', el.dataset.id);
    q.delete('continue');
    history.replaceState(null, '', `/runs/new?${q}`);
    ctx.query = q;
    return ctx.rerender();
  },
  operator(el, ctx) {
    const q = new URLSearchParams(location.search);
    q.set('config', ctx.state.sel);
    if (el.value) q.set('continue', el.value);
    else q.delete('continue');
    history.replaceState(null, '', `/runs/new?${q}`);
    ctx.query = q;
    return ctx.rerender();
  },
  async reload(el, ctx) {
    const r = await post('/api/config/reload');
    const errors = r.issues.filter((i) => i.severity === 'error').length;
    toast(errors ? `Файлы перечитаны: ошибок ${errors}` : 'Файлы перечитаны: ошибок нет', errors > 0);
    return ctx.rerender();
  },
  async start(el, ctx) {
    const cont = ctx.query.get('continue');
    const run = await post('/api/runs', { config: ctx.state.sel, overrides: cont ? { continueFrom: cont } : {} });
    toast(`Прогон #${run.id} поставлен в очередь`);
    ctx.navigate(`/runs/${run.id}`);
  },
};
