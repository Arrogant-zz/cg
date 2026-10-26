// Экран «Наборы скиллов»: происхождение версий, состав и контрольные суммы, различия (SK-01–02, SK-05).
import { html, icon, get, ver, ref, hint, later, fmtDate, diffView, plural } from '../lib.js';

export const title = 'Наборы скиллов';

function lineage(set) {
  const out = [];
  for (const v of set.versions) {
    if (v.origin.from) {
      out.push(html`<div class="vedge"><span>обучение</span><span class="ln"></span>${v.origin.run ? html`<a href="/runs/${v.origin.run}">прогон #${v.origin.run}</a>` : ''}<span>на рабочей копии ${v.origin.from}</span></div>`);
    }
    out.push(
      html`<div class="vnode ${v.generated ? 'on' : ''}"><span class="row" style="gap: 8px">${ver(v.id, v.generated ? '' : 'src')}<span class="m5">${v.generated ? 'результат обучения' : 'исходная'}</span>${v.status === 'partial' ? html`<span class="pill na">частичная</span>` : ''}</span><span class="sm t2">${v.generated ? `Ссылки: ${v.origin.from} и прогон #${v.origin.run}` : v.origin.note || 'импорт'}${v.createdAt ? ` · ${fmtDate(v.createdAt, v.generated)}` : ''}</span><span class="cap">${v.files.length} ${plural(v.files.length, 'файл', 'файла', 'файлов')} · не перезаписывается</span></div>`,
    );
  }
  return html`<div class="row" style="gap: 12px; align-items: stretch; flex-wrap: wrap">${out}</div>`;
}

export async function render(ctx) {
  const list = await get('/api/skillsets');
  const sel = ctx.params[0] ?? list[0]?.id;
  if (!sel) return html`<header class="ph"><div class="ph-t"><h1 class="h1">Наборы скиллов</h1></div></header><div class="empty">В skillsets/ нет наборов.</div>`;
  const set = await get(`/api/skillsets/${encodeURIComponent(sel)}`);
  const vid = ctx.query.get('v') && set.versions.some((v) => v.id === ctx.query.get('v')) ? ctx.query.get('v') : set.versions[set.versions.length - 1].id;
  const v = set.versions.find((x) => x.id === vid);
  const diffWith = ctx.query.get('diff');
  const diff = diffWith ? await get(`/api/skillsets/${encodeURIComponent(sel)}/diff?from=${encodeURIComponent(diffWith)}&to=${encodeURIComponent(vid)}`).catch(() => null) : null;
  const open = ctx.state.open;
  const fileView = open ? await get(`/api/skillsets/${encodeURIComponent(sel)}/versions/${encodeURIComponent(vid)}/file?path=${encodeURIComponent(open)}`).catch(() => null) : null;
  const versionsCount = list.reduce((s, x) => s + x.versions.length, 0);
  const checks = set.versions.flatMap((x) => x.checks.map((c) => ({ ...c, version: x.id })));
  return html`<header class="ph">
<div class="ph-t"><h1 class="h1">Наборы скиллов</h1><p class="lede">Только прикладные скиллы — процедуры решения обращений. /case-capture, /skill-curator и общие правила входят в версию агента и при выборе набора не меняются.</p></div>
<div class="ph-a"><span class="cap">skillsets/ · ${list.length} ${plural(list.length, 'набор', 'набора', 'наборов')} · ${versionsCount} ${plural(versionsCount, 'версия', 'версии', 'версий')}</span></div>
</header>
<div class="split">
<div class="lst">${list.map(
    (s) => html`<a class="li ${s.id === sel ? 'on' : ''}" href="/skillsets/${s.id}"><span class="m5">${s.title}</span><span class="row" style="gap: 4px">${s.versions.map((x) => ver(x.id, x.generated ? '' : 'src'))}${s.inRuns.map((r) => html`<span class="cap">копия в прогоне #${r.id}</span>`)}</span></a>`,
  )}</div>
<article class="det" aria-labelledby="s-h">
<div class="row" style="justify-content: space-between; gap: 16px; align-items: flex-end">
<div class="col" style="gap: 8px">${ref(set.file)}<h2 class="h1" id="s-h" style="font-size: 26px; line-height: 34px">${set.title}</h2>${set.description ? html`<span class="sm t2">${set.description}</span>` : ''}</div>
<div class="row"><a class="btn" href="/compare">${icon('compare')}Прогоны на версиях</a><a class="btn pri" href="/runs/new?skillsetVersion=${vid}">${icon('play')}<span>Проверить ${vid}</span></a></div>
</div>
<section class="sec" aria-labelledby="lin-h">
<h3 class="h2" id="lin-h">Происхождение версий</h3>
${lineage(set)}
<div class="uses"><span class="lbl" style="font-size: 13px">Проверки на копиях:</span>${checks.length ? checks.map((c) => html`<span><a href="/runs/${c.id}">#${c.id}</a> — ${c.version}, ${c.success.passed} из ${c.success.evaluated}</span>`) : html`<span>ещё не было</span>`}<span class="cap">Рабочая копия становится версией только после обучения</span></div>
</section>
<section class="sec" aria-labelledby="files-h">
<div class="sec-h"><h3 class="h2" id="files-h">Состав версии</h3><div class="seg" role="group" aria-label="Версия">${set.versions.map((x) => html`<button type="button" class="${x.id === vid ? 'on' : ''}" data-action="ver" data-v="${x.id}" aria-pressed="${x.id === vid}">${x.id}</button>`)}</div></div>
<dl class="kvs sm">
<dt>Источник</dt><dd>${v.generated ? html`результат обучения <a href="/runs/${v.origin.run}">#${v.origin.run}</a> из ${v.origin.from}${v.origin.line && v.origin.line > 1 ? `, линия ${v.origin.line}` : ''}` : v.origin.note || 'импорт'}</dd>
<dt>Совместимость</dt><dd>${set.compatibility.agent ?? 'не указана'}${set.compatibility.learningKit ? `, комплект обучения ${set.compatibility.learningKit}` : ''}</dd>
<dt>Контрольная сумма</dt><dd class="mono">sha256 ${v.checksum.slice(0, 4)}…${v.checksum.slice(-4)}</dd>
</dl>
<div class="tw"><table class="tbl"><thead><tr><th>Файл</th><th>${v.origin.from ? `Относительно ${v.origin.from}` : 'Изменения'}</th><th class="r">Контрольная сумма</th></tr></thead>
<tbody>${v.files.map(
    (f) => html`<tr><td><a class="mono sm" href="#" data-action="open" data-path="${f.path}">${f.path}</a></td><td>${f.change ? (f.change.kind === 'added' ? html`<span class="row" style="gap: 8px"><span class="s add mono b">+</span><span class="cap">создан обучением</span></span>` : html`<span class="row" style="gap: 8px"><span class="s mod mono b">~</span><span class="dl"><span class="p">+${f.change.added}</span> <span class="m">−${f.change.removed}</span></span></span>`) : html`<span class="cap">${v.origin.from ? 'без изменений' : 'исходный'}</span>`}</td><td class="r mono cap">${f.sha256.slice(0, 4)}…</td></tr>`,
  )}${v.removed.map((p) => html`<tr><td class="mono sm t3">${p}</td><td><span class="row" style="gap: 8px"><span class="s del mono b">−</span><span class="cap">удалён обучением</span></span></td><td></td></tr>`)}</tbody></table></div>
${fileView ? html`<div class="col" style="gap: 8px"><div class="row" style="justify-content: space-between"><span class="ref">${fileView.path}</span><button class="btn ghost" type="button" data-action="close">Свернуть</button></div><pre class="diff">${fileView.content}</pre></div>` : ''}
${v.origin.from ? html`<div class="row"><a class="btn" href="/skillsets/${sel}?v=${vid}&diff=${v.origin.from}">${icon('compare')}Различия с ${v.origin.from}</a></div>` : ''}
${diff ? html`<div class="col" style="gap: 12px"><h3 class="h3">Различия ${diff.from} → ${diff.to}</h3>${diff.changes.length ? diff.changes.map((c) => html`<div class="col" style="gap: 6px"><span class="row" style="gap: 8px"><span class="s ${c.kind === 'added' ? 'add' : c.kind === 'removed' ? 'del' : 'mod'} mono b">${c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}</span><span class="mono sm">${c.path}</span><span class="dl"><span class="p">+${c.added}</span> <span class="m">−${c.removed}</span></span></span>${diffView(c.unified)}</div>`) : html`<span class="cap">Версии совпадают</span>`}</div>` : ''}
<div class="row" style="gap: 8px"><a class="btn" href="/api/skillsets/${sel}/versions/${vid}/download" download>${icon('download')}<span>Скачать файлы ${vid}</span></a><span class="cap">Набор добавляется файлом в skillsets/; полученные обучением версии лежат в каталоге данных. Редактор — ${later()}</span></div>
</section>
${hint('Версия неизменяема: каждый прогон работает с рабочей копией, обучение создаёт новую версию со ссылками на исходную и прогон.', 'layers')}
</article>
</div>`;
}

export const refreshOn = (msg) => msg.type === 'config';

export const actions = {
  ver(el, ctx) {
    ctx.state.open = null;
    ctx.navigate(`/skillsets/${ctx.params[0] ?? ''}?v=${el.dataset.v}`.replace('/skillsets/?', '/skillsets?'), true);
  },
  open(el, ctx) {
    ctx.state.open = el.dataset.path;
    return ctx.rerender();
  },
  close(el, ctx) {
    ctx.state.open = null;
    return ctx.rerender();
  },
};
