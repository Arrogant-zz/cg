// Экран «Прогоны»: что идёт сейчас, очередь, завершённые с успехом среди оценённых (RUN-03, RES-02).
import { html, icon, get, post, typeBadge, runStatus, fmtDate, fmtTime, fmtDur, since, plural, hint, ver, mk, exchangeCard, toast, removeRun } from '../lib.js';

export const title = 'Прогоны';

const bar = (cells, width) => html`<div class="bar"${width ? html` style="width: ${width}px"` : ''} aria-hidden="true">${cells.map((c) => html`<i class="${c}"></i>`)}</div>`;

function skillsLine(r) {
  if (!r.skillset) return 'не выбран';
  if (!r.skillset.version) return r.skillset.label;
  return `${r.skillset.label} · копия ${r.skillset.version}`;
}

function runningCard(r) {
  const p = r.progress;
  const phase = p.phase ? ` · ${p.phase}` : '';
  return html`<article class="card p24" style="display: flex; flex-direction: column; gap: 18px">
<div class="row" style="justify-content: space-between">${typeBadge(r.type)}${runStatus(r, r.startedAt ? fmtDur(since(r.startedAt)) : '')}</div>
<div class="col" style="gap: 4px"><a class="h3" href="/runs/${r.id}" style="text-decoration: none">#${r.id} ${r.title}</a><span class="cap mono">${r.configFile}</span></div>
<div class="col" style="gap: 8px">
${bar(r.bar)}
<span class="sm t2">${p.pos ? `Решение ${p.pos} из ${p.total}` : `Готово ${p.done} из ${p.total}`}${phase}${r.repetitions > 1 ? ` · повторений ${r.repetitions}` : ''}</span>
</div>
<dl class="kvs sm" style="grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px">
<dt>Скиллы</dt><dd>${skillsLine(r)}</dd>
<dt>Модели</dt><dd>агент ${r.models.agent} · оператор ${r.models.operator ?? '—'} · оценка ${r.models.judge ?? '—'}</dd>
</dl>
<div class="row" style="margin-top: auto"><a class="btn" href="/runs/${r.id}" style="flex: 1">Открыть ход</a><button class="btn stop" type="button" data-action="stop" data-id="${r.id}">${icon('stop')}Остановить</button></div>
</article>`;
}

function queuedCard(r, ahead) {
  return html`<article class="soft p24" style="display: flex; flex-direction: column; gap: 18px">
<div class="row" style="justify-content: space-between">${typeBadge(r.type)}<span class="st"><span class="dot queue"></span>В очереди${r.startAt ? ` · старт ${fmtDate(r.startAt)}` : ''}</span></div>
<div class="col" style="gap: 4px"><a class="h3" href="/runs/${r.id}" style="text-decoration: none">#${r.id} ${r.title}</a><span class="cap mono">${r.configFile}</span></div>
<span class="sm t2">${ahead.length ? `Начнётся после ${ahead.map((x) => `#${x.id}`).join(', ')} · ` : 'Ждёт свободную сессию агента · '}${r.progress.total} ${plural(r.progress.total, 'решение', 'решения', 'решений')}${r.type === 'checking' ? ' · capture и curator выключены' : ''}</span>
<div class="row" style="margin-top: auto"><button class="btn ghost" type="button" style="margin-left: -18px" data-action="stop" data-id="${r.id}">Убрать из очереди</button></div>
</article>`;
}

function manualCard(m) {
  const pending = m.execution?.pending ?? [];
  const p = pending[0];
  const st = p ? html`<span class="st"><span class="dot live"></span>${p.kind === 'confirmation' ? 'Ждёт решения' : 'Ждёт ответа'}${p.deadline ? html` · <span data-deadline="${p.deadline}">—</span>` : ''}</span>` : m.busy ? html`<span class="st"><span class="dot live"></span>${m.busy}</span>` : html`<span class="st"><span class="dot done"></span>Ход агента завершён</span>`;
  const ss = m.skillset === 'build' ? 'стартовые скиллы сборки' : m.skillset ? `${m.skillset.title} · копия ${m.skillset.version}` : 'не выбран';
  return html`<article class="card p24" style="display: flex; flex-direction: column; gap: 18px">
<div class="row" style="justify-content: space-between"><span class="pill">${icon('user')}Ручной кейс</span>${st}</div>
<div class="col" style="gap: 4px"><a class="h3" href="/manual/${m.id}" style="text-decoration: none">${m.case.id} · ${m.case.title}</a><span class="cap">Ведёте вы${m.case.solutions ? '' : ' · у кейса нет автоматических решений'}</span></div>
${p ? html`<div class="tool ${p.kind === 'confirmation' ? 'wait' : 'miss'}" style="width: 100%"><div class="tool-h"><span class="nm">${p.tool}</span><span class="pill ${p.kind === 'confirmation' ? 'live' : 'na'}">${p.kind === 'confirmation' ? 'Подтверждение' : 'Нет заглушки'}</span></div></div>` : ''}
<dl class="kvs sm" style="grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px"><dt>Скиллы</dt><dd>${ss}</dd><dt>Модель</dt><dd>агент ${m.agentModel.title}</dd></dl>
<div class="row" style="margin-top: auto"><a class="btn pri" href="/manual/${m.id}" style="flex: 1">Вернуться в чат</a></div>
</article>`;
}

function skillsCell(r) {
  if (!r.skillset) return html`<span class="t3">—</span>`;
  if (!r.skillset.version) return html`<span class="t2">${r.skillset.label}</span>`;
  const nv = r.newVersions[0];
  return html`<span class="row" style="gap: 8px; flex-wrap: nowrap">${nv ? html`${ver(r.skillset.version, 'src')}${icon('arrow', 's14 t3')}${ver(nv.id)}` : ver(r.skillset.version, r.type === 'training' ? 'src' : '')}<span>${r.skillset.label}</span></span>`;
}

function outside(r) {
  const parts = [];
  if (r.status === 'stopped') return html`<span class="st"><span class="dot stop"></span>Остановлен${r.notStarted ? ` · ${r.notStarted} не начаты` : ''}</span>`;
  if (r.status === 'failed') return html`<span class="pill tech">${icon('bolt')}${r.error ?? 'сбой стенда'}</span>`;
  if (r.tech) parts.push(html`<span class="pill tech">${icon('bolt')}${r.tech} ${plural(r.tech, 'технический сбой', 'технических сбоя', 'технических сбоев')}</span>`);
  if (r.notEvaluated) parts.push(html`<span class="pill na">${r.notEvaluated} не оценено</span>`);
  return parts.length ? html`<span class="row" style="gap: 6px">${parts}</span>` : html`<span class="t3">—</span>`;
}

function comparePair(done) {
  const checks = done.filter((r) => r.type === 'checking' && r.status === 'completed');
  for (let i = 0; i < checks.length; i++) {
    const b = checks[i];
    const a = checks.slice(i + 1).find((x) => x.configId !== b.configId || x.skillset?.version !== b.skillset?.version);
    if (a) return [a, b];
  }
  return null;
}

function standSection(status, traffic) {
  const entries = status.stand ?? [];
  if (!entries.length && !traffic.length) return '';
  return html`<section class="sec" aria-labelledby="stand-h">
<div class="sec-h"><h2 class="h2" id="stand-h">Журнал стенда</h2><span class="cap">События вне кейсов: вызовы MCP без привязки, сбои стенда</span></div>
${entries.length ? html`<div class="col" style="gap: 0">${entries.slice(0, 12).map((e) => html`<div class="okr">${mk(e.level === 'info' ? 'na' : 'tech')}<span>${e.message}${e.data?.httpId ? html` · <a href="#http-${e.data.httpId}" data-action="openUnbound" data-http="${e.data.httpId}">HTTP</a>` : ''}</span><span class="cap num">${fmtTime(e.ts)}</span></div>`)}</div>` : ''}
${traffic.length ? html`<details class="raw" id="mcp-unbound"><summary>MCP-запросы без привязки к кейсу · ${traffic.length}: initialize, tools/list и вызовы без известного x-task-id</summary><div class="col" style="gap: 8px; padding: 8px 0">${traffic.slice(0, 60).map(exchangeCard)}</div></details>` : ''}
</section>`;
}

export async function render() {
  const [{ runs, manual }, status, traffic] = await Promise.all([get('/api/runs'), get('/api/status'), get('/api/mcp/traffic?unbound=1')]);
  const active = runs.filter((r) => r.status === 'running');
  const queued = runs.filter((r) => r.status === 'queued').sort((a, b) => a.id - b.id);
  const done = runs.filter((r) => !['running', 'queued'].includes(r.status));
  const pair = comparePair(done);
  const now = [...active.map(runningCard), ...manual.map(manualCard), ...queued.map((r, i) => queuedCard(r, [...active, ...queued.slice(0, i)]))];
  return html`<header class="ph">
<div class="ph-t"><h1 class="h1">Прогоны</h1><p class="lede">Корзины выполняются на стенде по мере освобождения сессий агента. Ручные кейсы идут в свободных сессиях.</p></div>
<div class="ph-a"><a class="btn" href="/manual">${icon('chat')}Ручной кейс</a><a class="btn pri" href="/runs/new">${icon('play')}Запустить прогон</a></div>
</header>
<section class="sec" aria-labelledby="now-h">
<div class="sec-h"><h2 class="h2" id="now-h">Сейчас на стенде</h2><span class="cap">В одной сессии агента — один диалог за раз</span></div>
${now.length ? html`<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(330px, 100%), 1fr)); gap: 16px">${now}</div>` : html`<div class="empty">Сейчас на стенде ничего не выполняется. Запустите прогон из файла в runs/ или пройдите кейс вручную.</div>`}
</section>
<section class="sec" aria-labelledby="done-h">
<div class="sec-h"><h2 class="h2" id="done-h">Завершённые</h2>${pair ? html`<a class="btn" href="/compare?a=${pair[0].id}&b=${pair[1].id}">${icon('compare')}Сравнить #${pair[0].id} и #${pair[1].id}</a>` : ''}</div>
${done.length
    ? html`<div class="tw"><table class="tbl">
<thead><tr><th>Прогон</th><th>Тип</th><th>Набор скиллов</th><th>Успех среди оценённых</th><th>Вне оценки</th><th class="r">Завершён</th><th aria-label="Удаление"></th></tr></thead>
<tbody>${done.map(
        (r) => html`<tr>
<td><a class="rl" href="/runs/${r.id}">#${r.id} ${r.title}</a><div class="cap mono">${r.configFile}</div></td>
<td>${typeBadge(r.type)}</td>
<td>${skillsCell(r)}</td>
<td>${r.success.evaluated ? html`<div class="col" style="gap: 6px"><span class="num m5">${r.success.passed} из ${r.success.evaluated}</span><div class="bar" style="width: 128px" aria-hidden="true">${r.bar.map((c) => html`<i class="${c}"></i>`)}</div></div>` : html`<span class="pill na">нет оценённых</span>`}</td>
<td>${outside(r)}</td>
<td class="r nw num">${fmtDate(r.finishedAt)}</td>
<td class="r"><button class="btn ghost ib del" type="button" data-action="remove" data-id="${r.id}" data-title="${r.title}" data-versions="${r.newVersions.map((v) => v.id).join(',')}" aria-label="Удалить прогон #${r.id}" title="Удалить прогон">${icon('trash')}</button></td>
</tr>`,
      )}</tbody></table></div>`
    : html`<div class="empty">Завершённых прогонов пока нет.</div>`}
${hint('Успех считается среди оценённых кейсов. Технические сбои, неоценённые и не начатые кейсы показаны отдельно и не превращаются в неуспех агента.')}
</section>
${standSection(status, traffic)}`;
}

export const refreshOn = (msg) => (msg.type === 'run' && msg.topic === 'runs') || msg.type === 'manual' || msg.type === 'stand';

export const actions = {
  async remove(el, ctx) {
    const versions = el.dataset.versions ? el.dataset.versions.split(',') : [];
    if (await removeRun({ id: Number(el.dataset.id), title: el.dataset.title, versions })) return ctx.rerender();
  },
  openUnbound(el, ctx) {
    (ctx.state.openIds ??= new Set()).add('mcp-unbound');
    ctx.state.focus = `http-${el.dataset.http}`;
    return ctx.rerender();
  },
  async stop(el, ctx) {
    await post(`/api/runs/${el.dataset.id}/stop`);
    toast('Остановка отправлена: новые кейсы не начнутся');
    ctx.rerender();
  },
};
