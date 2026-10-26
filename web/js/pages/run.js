// Экраны «Ход прогона» и «Результат прогона» (SK-03, SOL-05, RUN-03, MET-03, RES-01–03, SK-04–05, RUN-02).
import {
  html,
  raw,
  icon,
  get,
  post,
  typeBadge,
  runStatus,
  fmtDate,
  fmtDur,
  fmtClock,
  since,
  plural,
  planView,
  planLegend,
  stepsView,
  outcomePill,
  kpi,
  mk,
  ver,
  ref,
  hint,
  later,
  feed,
  changesList,
  toast,
  STATUS_TITLES,
} from '../lib.js';

export const title = (ctx) => `Прогон #${ctx.params[0]}`;

function strip(run) {
  const s = run.settings;
  const ss = s.skillset;
  const nv = run.lines.map((l) => l.skills.newVersion).filter(Boolean);
  const skills =
    ss === 'build'
      ? html`<span class="row" style="gap: 6px"><span class="ver copy">сборка</span>стартовые скиллы</span>`
      : ss
        ? html`<span class="row" style="gap: 6px">${ver(ss.version, run.type === 'training' ? 'src' : '')}${nv.length ? html`${icon('arrow', 's14 t3')}${nv.map((v) => ver(v.id))}` : ''}${ss.title}${run.status === 'running' ? ' · копия' : ''}</span>`
        : 'не выбран';
  return html`<div class="strip">
<span><span class="cap">Агент</span><span>${s.agent.title}</span></span>
<span><span class="cap">Модель агента</span><span>${s.agentModel.title}${s.agentModel.switchable ? '' : ' · развёртывание'}</span></span>
<span><span class="cap">Оператор</span><span>${s.operator?.id ?? '—'}</span></span>
<span><span class="cap">Оценка</span><span>${s.judge?.id ?? 'не выбрана'}</span></span>
<span><span class="cap">Скиллы</span>${skills}</span>
<span><span class="cap">Снимок настроек</span><a href="#snap">${fmtDate(run.snapshot.createdAt)}</a></span>
</div>`;
}

function lineTabs(run, idx) {
  if (run.lines.length < 2) return '';
  return html`<div class="seg" role="group" aria-label="Повторение">${run.lines.map((l) => html`<button type="button" class="${l.index === idx ? 'on' : ''}" data-action="line" data-line="${l.index}" aria-pressed="${l.index === idx}">Повторение ${l.index}</button>`)}</div>`;
}

function itemsList(run, line, live) {
  const training = run.type === 'training';
  const rows = line.items
    .filter((i) => i.kind === 'case')
    .map((i) => {
      const cur = line.current && line.current.index === i.index;
      const dur = i.startedAt ? (i.finishedAt ? fmtClock(Date.parse(i.finishedAt) - Date.parse(i.startedAt)) : null) : null;
      const inner = html`<span class="pos ${i.outcome || i.status === 'running' ? '' : 't3'}">${i.pos}</span>
<span class="col" style="gap: 2px"><span class="m5 mono ${i.outcome || i.status === 'running' ? '' : 't2'}">${i.case?.id}</span><span class="cap">${i.solution?.title}${cur && line.current.phase ? ` · ${line.current.phase}` : ''}</span></span>
${stepsView({ ...i, liveTurns: live?.name === i.execName ? live.turns : null }, training)}
<span>${outcomePill(i)}</span>
<span class="num t3" style="text-align: right">${dur ?? (i.status === 'running' && i.startedAt ? html`<span data-since="${i.startedAt}">—</span>` : '—')}</span>`;
      return i.execName ? html`<a class="it ${cur ? 'cur' : ''}" href="/runs/${run.id}/cases/${i.execName}">${inner}</a>` : html`<div class="it">${inner}</div>`;
    });
  return html`<div class="col" style="gap: 0"><div class="it hd" style="border-top: 0; padding-top: 4px"><span class="lbl">№</span><span class="lbl">Кейс · решение</span><span class="lbl">Шаги</span><span class="lbl">Итог</span><span class="lbl" style="text-align: right">Время</span></div>${rows}</div>`;
}

function prepSection(line) {
  return html`<section class="sec" aria-labelledby="prep-h" style="gap: 8px">
<div class="sec-h" style="padding-bottom: 6px"><h2 class="h2" id="prep-h">Подготовка</h2><span class="cap">до первого кейса${line.prep.durationMs !== null ? ` · ${fmtDur(line.prep.durationMs)}` : ''}</span></div>
${line.prep.items.length ? line.prep.items.map((p) => html`<div class="okr">${mk(p.ok === null ? 'na' : p.ok)}<span>${p.text}${p.note ? html`<span class="cap"> · ${p.note}</span>` : ''}</span><span class="cap num">${fmtDate(p.ts).split(', ')[1] ?? ''}</span></div>`) : html`<div class="okr">${mk('na')}<span>Ждёт свободную сессию агента</span><span class="cap"></span></div>`}
</section>`;
}

function correctionsBars(line) {
  const items = line.items.filter((i) => i.kind === 'case' && (i.outcome || i.status === 'running'));
  if (!items.length) return html`<span class="cap">Кейсы ещё не завершены</span>`;
  const max = Math.max(1, ...items.map((i) => i.stats?.corrections ?? 0));
  return html`<div class="bars">${items.map((i) => {
    const n = i.stats?.corrections ?? 0;
    if (i.status === 'running') return html`<div class="row"><span class="num t3" style="width: 14px">${i.pos}</span><span class="b live" style="width: 32px"></span><span class="sm t3">идёт</span></div>`;
    if (i.outcome === 'technical') return html`<div class="row"><span class="num t3" style="width: 14px">${i.pos}</span><span class="pill tech" style="min-height: 20px">сбой</span></div>`;
    return html`<div class="row"><span class="num t3" style="width: 14px">${i.pos}</span><span class="b ${n ? '' : 'zero'}" style="width: ${n ? Math.round((n / max) * 120) : 3}px"></span><span class="num sm">${n}${i.repeated.length ? ` · из них ${i.repeated.length} ${plural(i.repeated.length, 'повторная', 'повторные', 'повторных')}` : ''}</span></div>`;
  })}</div>`;
}

function curatorPass(p) {
  const title = p.reason === 'final' ? 'финальный' : `curator ${p.pass}`;
  const st = p.status === 'running' ? html`<span class="st"><span class="dot live"></span>выполняется</span>` : p.status === 'ok' ? '' : p.status === 'skipped' ? html`<span class="cap">очередь пуста</span>` : html`<span class="pill tech">${icon('bolt')}${p.error ?? p.status}</span>`;
  return html`<div class="col" style="gap: 4px">
<span class="row m5" style="gap: 8px; padding-bottom: 6px"><span class="pb cu" style="height: 24px; padding: 0 8px">${icon('curator')}${title}</span>после позиции ${p.afterPos}${p.durationMs ? ` · ${fmtDur(p.durationMs)}` : ''}${st}</span>
${p.changes ? changesList(p.changes) : html`<span class="cap">${p.exportNote || 'изменения не выгружены'}</span>`}
${p.status === 'failed' && p.changes?.length ? html`<span class="cap" style="padding-top: 6px">Частичный проход: правки могли примениться до ошибки команды — состояние сохранено.</span>` : ''}
</div>`;
}

function liveAside(run, line) {
  if (run.type !== 'training') {
    return html`<aside class="sd"><section class="soft p24 sec" style="gap: 14px"><h2 class="h3">Проверка без обучения</h2><ul class="col sm t2" style="gap: 6px">${run.planText.map((t) => html`<li>${t}</li>`)}</ul><hr class="rule"><div class="col" style="gap: 6px"><span class="lbl">Рабочая копия</span><span class="sm">${line.skills.source ? `${line.skills.source.version} · ${line.skills.source.files} ${plural(line.skills.source.files, 'файл', 'файла', 'файлов')}` : line.skills.mode === 'build' ? 'стартовые скиллы сборки' : 'не выбрана'}</span><span class="cap">Неизменность набора проверится в конце прогона.</span></div></section></aside>`;
  }
  const nextCur = run.plan.filter((s) => s.kind === 'curator').find((s) => !line.curatorPasses.some((p) => p.pass === s.pass));
  return html`<aside class="sd" aria-labelledby="learn-h"><section class="soft p24 sec" style="gap: 20px">
<h2 class="h3" id="learn-h">Обучение в этом прогоне</h2>
<div class="col" style="gap: 10px"><span class="lbl">Поправки оператора по позициям</span>${correctionsBars(line)}</div>
${line.curatorPasses.length ? html`<hr class="rule">${line.curatorPasses.map(curatorPass)}` : ''}
<hr class="rule">
<div class="col" style="gap: 6px"><span class="lbl">Рабочая копия</span>
<span class="sm">${line.skills.source ? `${line.skills.source.version}${line.curatorPasses.length ? ` и ${line.curatorPasses.length} ${plural(line.curatorPasses.length, 'проход', 'прохода', 'проходов')} curator` : ''}` : line.skills.mode === 'build' ? 'стартовые скиллы сборки' : 'набор не выбран'}</span>
<span class="cap">${nextCur ? `Следующий curator — после позиции ${nextCur.afterPos}. ` : ''}Новая версия сохранится в конце прогона.</span>
</div>
</section></aside>`;
}

function currentSection(run, line, live) {
  if (!live) return '';
  const it = line.items.find((i) => i.execName === live.name);
  const lim = it?.limits ?? run.settings.limits;
  const events = live.events.slice(-8);
  return html`<section class="sec" aria-labelledby="cur-h">
<div class="sec-h"><h2 class="h2" id="cur-h">Сейчас: позиция ${it?.pos ?? '—'}</h2><a class="btn" href="/runs/${run.id}/cases/${live.name}">Открыть разбор${icon('chevRight')}</a></div>
${feed(events, { full: true })}
<div class="row cap" style="gap: 20px; padding-top: 4px">
<span>Ходы: <span class="num t2">${live.turns} из ${lim.maxTurns}</span></span>
<span>Время кейса: <span class="num t2"><span data-since="${live.startedAt}">—</span> из ${fmtClock(lim.maxDurationSec * 1000)}</span></span>
<span>Запросы оператора: <span class="num t2">${live.operatorCalls} из ${lim.maxOperatorCalls}</span></span>
</div>
</section>`;
}

/** Кривая обучения: поправки по позициям; техсбой — пропуск, а не ноль; повтор урока — оранжевое кольцо. */
function curve(run) {
  const m = (run.summary ?? []).find((x) => x.builtin === (run.type === 'training' ? 'corrections' : 'success'));
  const series = m?.series ?? [];
  const cases = run.lines[0].items.filter((i) => i.kind === 'case');
  if (!cases.length) return '';
  const n = cases.length;
  const W = 720;
  const x0 = 80;
  const step = n > 1 ? (W - 60 - x0) / (n - 1) : 0;
  const xs = (pos) => x0 + (pos - 1) * step;
  const training = run.type === 'training';
  const maxV = training ? Math.max(1, ...series.map((p) => p.max ?? p.value ?? 0)) : 1;
  const y = (v) => 180 - (v / maxV) * 135;
  const parts = [];
  const ticks = training ? [...new Set([0, Math.ceil(maxV / 2), maxV])] : [0, 1];
  for (const t of ticks) parts.push(`<line class="${t === 0 ? 'cv-base' : 'cv-grid'}" x1="40" y1="${y(t)}" x2="${W - 20}" y2="${y(t)}"></line><text class="te" x="28" y="${y(t) + 4}">${training ? t : t ? 'успех' : 'нет'}</text>`);
  if (training) {
    for (const p of run.lines[0].curatorPasses) {
      const x = p.reason === 'final' ? W - 20 : Math.min(W - 20, xs(p.afterPos) + step / 3);
      parts.push(`<line class="cv-cur" x1="${x}" y1="30" x2="${x}" y2="180"></line><text class="cu ${p.reason === 'final' ? 'te' : 'tm'}" x="${x}" y="20">${p.reason === 'final' ? 'финальный' : `curator ${p.pass}`}</text>`);
    }
  }
  const pts = series.map((p) => ({ ...p, x: xs(p.pos) }));
  let prev = null;
  for (const p of pts) {
    if (p.value === null) continue;
    if (prev) parts.push(`<polyline class="${pts.slice(pts.indexOf(prev) + 1, pts.indexOf(p)).some((q) => q.value === null) ? 'cv-gap' : 'cv-line'}" points="${prev.x},${y(prev.value)} ${p.x},${y(p.value)}"></polyline>`);
    if (run.lines.length > 1 && p.min !== null && p.max !== p.min) parts.push(`<rect class="cv-band" x="${p.x - 6}" y="${y(p.max)}" width="12" height="${Math.max(2, y(p.min) - y(p.max))}" rx="3"></rect>`);
    prev = p;
  }
  for (const p of pts) {
    const it = cases.find((c) => c.pos === p.pos);
    if (p.value === null) {
      const tech = it?.outcome === 'technical';
      parts.push(`<circle class="${tech ? 'cv-tech' : 'cv-na'}" cx="${p.x}" cy="180" r="7"></circle><text class="${tech ? 'tv ' : ''}tm" x="${p.x}" y="204">${tech ? 'сбой' : it?.outcome === 'not_evaluated' ? 'не оценено' : '—'}</text>`);
    } else if (p.mark === 'repeat') parts.push(`<circle class="cv-rep" cx="${p.x}" cy="${y(p.value)}" r="7"></circle><text class="tm" x="${p.x}" y="${y(p.value) - 17}">повтор</text>`);
    else parts.push(`<circle class="cv-pt" cx="${p.x}" cy="${y(p.value)}" r="5"></circle>`);
    parts.push(`<text class="tm" x="${p.x}" y="224">${p.pos}</text>`);
  }
  parts.push(`<text class="tm" x="${W / 2}" y="245">позиция в корзине</text>`);
  return raw(`<svg class="chart" viewBox="0 0 ${W} 248" role="img" aria-label="${training ? 'Поправки оператора по позициям корзины' : 'Успех по позициям корзины'}">${parts.join('')}</svg>`);
}

function versionAside(run) {
  if (run.type !== 'training') {
    return html`<aside class="sd"><section class="soft p24 sec" style="gap: 14px"><h2 class="h3">Неизменность набора</h2>
${run.lines.map((l) => {
      const im = l.skills.immutability;
      if (!im) return html`<div class="okr">${mk('na')}<span>Не проверялась</span><span class="cap"></span></div>`;
      return html`<div class="okr">${mk(im.status === 'unchanged' ? true : im.status === 'changed' ? false : 'na')}<span>${im.status === 'unchanged' ? `${l.skills.source?.version ?? 'Набор'} не изменился за проверку` : im.status === 'changed' ? 'Проверка изменила набор — не смешивается с обучением' : im.note}</span><span class="cap num">${im.files ? `${im.files} ${plural(im.files, 'файл', 'файла', 'файлов')}` : ''}</span></div>${im.changes?.length ? changesList(im.changes) : ''}`;
    })}
<span class="cap">Сверяются только файлы прикладного набора; журналы и другие материалы workspace изменениями скиллов не считаются.</span>
</section></aside>`;
  }
  const l = run.lines[0];
  const s = l.skills;
  const ch = s.changes ?? [];
  const add = ch.filter((c) => c.kind === 'added').length;
  const mod = ch.filter((c) => c.kind === 'modified').length;
  const del = ch.filter((c) => c.kind === 'removed').length;
  const src = s.source?.version;
  return html`<aside class="sd"><section class="soft p24 sec" aria-labelledby="ver-h" style="gap: 18px">
<h2 class="h3" id="ver-h">Новая версия скиллов</h2>
${src
    ? html`<div class="lin" style="flex-direction: column; align-items: stretch; gap: 6px">
<span class="lin-n">${ver(src, 'src')}<span class="col" style="gap: 0"><span class="sm m5">исходная</span><span class="cap">не изменена</span></span></span>
${icon('arrowDown', 't3')}
${s.newVersion ? html`<span class="lin-n">${ver(s.newVersion.id)}<span class="col" style="gap: 0"><span class="sm m5">результат #${run.id}${s.newVersion.status === 'partial' ? ' · частичная' : ''}</span><span class="cap">${fmtDate(run.finishedAt)}</span></span></span>` : html`<span class="lin-n"><span class="ver copy">копия</span><span class="col" style="gap: 0"><span class="sm m5">версия не создана</span><span class="cap">итоговое состояние — в материалах</span></span></span>`}
</div>`
    : ''}
${s.final ? html`<div class="row sm" style="gap: 16px"><span><span class="s add mono b">+${add}</span> ${plural(add, 'создан', 'создано', 'создано')}</span><span><span class="mono b">~${mod}</span> изменено</span><span><span class="s del mono b">−${del}</span> удалено</span></div>` : ''}
<span class="cap">${s.versionNote}</span>
${s.newVersion ? html`<div class="row"><a class="btn" href="/skillsets/${s.source.skillset}?v=${s.newVersion.id}" style="flex: 1">Открыть ${s.newVersion.id}</a><a class="btn" href="/skillsets/${s.source.skillset}?v=${s.newVersion.id}&diff=${src}" style="flex: 1">Различия с ${src}</a></div>` : ''}
</section></aside>`;
}

function resultsTable(run, line) {
  const training = run.type === 'training';
  return html`<div class="tw"><table class="tbl">
<thead><tr><th>№</th><th>Кейс · решение</th><th>Итог</th><th>Действия</th><th>Ответ</th>${training ? html`<th>Поправки</th>` : ''}<th>Команды</th><th class="r">Время</th></tr></thead>
<tbody>${line.items
    .filter((i) => i.kind === 'case')
    .map((i) => {
      const reason = i.outcome === 'failed' ? [...(i.checks ?? []).filter((c) => c.passed === false).map((c) => c.text), ...(i.answerFailed ?? [])][0] : i.outcome === 'technical' ? 'не ошибка агента' : i.outcome === 'not_evaluated' ? i.reason : '';
      const cmds = [html`<span class="sp ${i.steps.reset && i.steps.reset !== 'ok' ? 'tech' : ''}">reset</span>`];
      if (training) cmds.push(i.steps.capture?.status === 'not_sent' ? html`<span class="sp off">capture не отправлялся</span>` : i.steps.capture ? html`<span class="sp ${i.steps.capture.status === 'ok' ? '' : 'tech'}">capture</span>` : '');
      if (i.steps.curatorPass) cmds.push(html`<span class="sp">curator ${i.steps.curatorPass}</span>`);
      const ch = i.steps.checks;
      const jd = i.steps.judge;
      return html`<tr>
<td class="num m5">${i.pos}</td>
<td>${i.execName ? html`<a class="rl mono" href="/runs/${run.id}/cases/${i.execName}">${i.case?.id}</a>` : html`<span class="mono m5">${i.case?.id}</span>`}<div class="cap">${i.solution?.title}</div></td>
<td>${outcomePill(i)}${reason ? html`<div class="cap" style="padding-top: 4px">${reason}</div>` : ''}</td>
<td class="num">${ch ? html`<span${ch.passed < ch.total ? raw(' style="color: #A51C14"') : ''}>${ch.passed}/${ch.total}</span>` : html`<span class="t3">—</span>`}</td>
<td class="num">${jd?.status === 'ok' ? html`<span${jd.passed < jd.total ? raw(' style="color: #A51C14"') : ''}>${jd.passed}/${jd.total}</span>` : jd && jd.total ? html`<span class="pill na">${jd.status === 'failed' ? 'сбой судьи' : 'не оценён'}</span>` : html`<span class="t3">—</span>`}</td>
${training ? html`<td>${i.stats ? html`<span class="num">${i.stats.corrections}</span> ${i.repeated.map((l) => html`<span class="lesson">повтор ${l}</span>`)}` : html`<span class="t3">—</span>`}</td>` : ''}
<td><span class="steps">${cmds}</span></td>
<td class="r num t3">${i.startedAt && i.finishedAt ? fmtClock(Date.parse(i.finishedAt) - Date.parse(i.startedAt)) : '—'}</td>
</tr>`;
    })}</tbody></table></div>`;
}

function materials(run) {
  const mats = run.lines.flatMap((l) => l.materials.map((m) => ({ ...m, line: l.index })));
  const caps = mats.filter((m) => m.kind === 'capture');
  const curs = mats.filter((m) => m.kind === 'curator');
  const skillsOk = run.lines.some((l) => l.skills.final);
  const snapFiles = run.snapshot.files.length;
  return html`<section class="sec" id="snap" aria-labelledby="mat-h">
<div class="sec-h"><h2 class="h2" id="mat-h">Материалы и снимок настроек</h2><a class="btn" href="/api/runs/${run.id}/materials.zip" download>${icon('download')}Скачать материалы</a></div>
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 0 40px">
<div class="col" style="gap: 0">
${run.type === 'training' ? html`<div class="okr">${mk(curs.length && curs.every((m) => m.ok) ? true : curs.length ? 'na' : 'na')}<span>Отчёты curator${curs.some((m) => !m.ok) ? ` — ${curs.filter((m) => !m.ok).map((m) => m.note).join('; ')}` : ''}</span><span class="cap num">${curs.filter((m) => m.ok).length} из ${curs.length}</span></div>
<div class="okr">${mk(caps.length && caps.every((m) => m.ok) ? true : 'na')}<span>Кейсы capture${caps.some((m) => !m.ok) ? ` — ${caps.filter((m) => !m.ok).map((m) => `${m.label}: ${m.note}`).join('; ')}` : ''}</span><span class="cap num">${caps.filter((m) => m.ok).length} из ${caps.length}</span></div>` : ''}
<div class="okr">${mk(skillsOk ? true : 'na')}<span>${skillsOk ? 'Исходное и итоговое состояние скиллов из workspace тестового оператора' : 'Файлы скиллов не выгружены: подключение не даёт доступа к workspace'}</span><span class="cap num">${run.lines.map((l) => (l.skills.final ? `${l.skills.initial?.files ?? '—'} и ${l.skills.final.files}` : '—')).join(', ')}</span></div>
</div>
<div class="col" style="gap: 0">
<div class="okr">${mk(true)}<span>Снимок: корзина, ${run.settings.basket.items} ${plural(run.settings.basket.items, 'решение', 'решения', 'решений')} с кейсами, агент, модели, ${run.settings.skillset && run.settings.skillset !== 'build' ? `набор ${run.settings.skillset.version} с контрольными суммами, ` : ''}подсказки оператора и судьи (${run.settings.prompts.operator}, ${run.settings.prompts.judge}), определения метрик, контракт ${run.settings.contract.version}</span><span class="cap num">${snapFiles} ${plural(snapFiles, 'файл', 'файла', 'файлов')}</span></div>
<div class="okr">${mk(true)}<span>Авторизация в снимок не входит. Правка исходных файлов не меняет этот результат</span><span class="cap">${fmtDate(run.snapshot.createdAt)}</span></div>
</div>
</div>
${run.snapshot.files.length ? html`<details class="raw"><summary>Файлы снимка</summary><pre>${run.snapshot.files.map((f) => `${f.file}${f.hash ? ` @${f.hash}` : ''}`).join('\n')}</pre></details>` : ''}
</section>`;
}

function headerActions(run, configs) {
  if (run.status === 'running' || run.status === 'queued') {
    return html`<div class="ph-a" style="flex-direction: column; align-items: flex-end; gap: 6px"><button class="btn stop" type="button" data-action="stop">${icon('stop')}${run.status === 'queued' ? 'Убрать из очереди' : 'Остановить прогон'}</button><span class="cap" style="max-width: 300px; text-align: right">Новые кейсы не начнутся. Текущий шаг и отправленные команды сохранятся в результате.</span></div>`;
  }
  const nv = run.lines.map((l) => l.skills.newVersion).find((v) => v && v.status === 'ready');
  const ss = run.settings.skillset;
  const checkCfg = nv && ss && ss !== 'build' ? configs.find((c) => c.basket.type === 'checking' && c.skillset.startsWith(ss.title)) : null;
  return html`<div class="ph-a"><a class="btn" href="/compare?b=${run.id}">${icon('compare')}Сравнить</a>${nv ? html`<a class="btn pri" href="/runs/new?${checkCfg ? `config=${encodeURIComponent(checkCfg.id)}&` : ''}skillsetVersion=${nv.id}">${icon('play')}Проверить ${nv.id}</a>` : ''}</div>`;
}

export async function render(ctx) {
  const id = ctx.params[0];
  const run = await get(`/api/runs/${id}`);
  const lineIdx = ctx.state.line && run.lines.some((l) => l.index === ctx.state.line) ? ctx.state.line : run.lines.find((l) => l.status === 'running')?.index ?? 1;
  const line = run.lines.find((l) => l.index === lineIdx);
  const running = run.status === 'running' || run.status === 'queued';
  let live = null;
  if (running && line.current?.execName) {
    try {
      const ex = await get(`/api/runs/${id}/executions/${line.current.execName}`);
      live = { name: line.current.execName, events: ex.events, turns: ex.turns, operatorCalls: ex.operatorCalls, startedAt: ex.startedAt };
    } catch {
      live = null;
    }
  }
  const configs = running ? [] : await get('/api/run-configs').catch(() => []);
  const dur = run.startedAt ? fmtDur(since(run.startedAt, run.finishedAt)) : '';
  const statusExtra = run.status === 'running' ? dur : run.finishedAt ? `${fmtDate(run.finishedAt)}${dur ? ` · ${dur}` : ''}` : '';
  const head = html`<div class="col" style="gap: 14px">
<nav class="crumbs" aria-label="Путь"><a href="/">Прогоны</a>${icon('chevRight', 's14')}<span>#${run.id}</span></nav>
<header class="ph">
<div class="ph-t"><div class="row" style="gap: 12px">${typeBadge(run.type)}${runStatus(run, statusExtra)}${ref(run.configFile)}</div><h1 class="h1">#${run.id} ${run.title}</h1>${run.error ? html`<p class="lede" style="color: #4B3BA0">${run.error}</p>` : ''}</div>
${headerActions(run, configs)}
</header>
${strip(run)}
${lineTabs(run, lineIdx)}
</div>`;

  if (running) {
    const done = line.items.filter((i) => i.kind === 'case' && i.outcome).length;
    const total = line.items.filter((i) => i.kind === 'case').length;
    return html`${head}
<div class="split"><div class="mn">
${prepSection(line)}
<section class="sec" aria-labelledby="flow-h">
<div class="sec-h"><h2 class="h2" id="flow-h">Ход корзины</h2><span class="cap">Готово ${done} из ${total}${line.current?.phase ? ` · сейчас: ${line.current.phase}` : ''}</span></div>
<div class="row" style="justify-content: flex-end">${planLegend(run.type === 'training')}</div>
${planView(run.plan, { items: line.items, passes: line.curatorPasses })}
${itemsList(run, line, live)}
</section>
${currentSection(run, line, live)}
</div>
${liveAside(run, line)}
</div>`;
  }

  const metrics = run.summary ?? [];
  return html`${head}
<section class="kpis" aria-label="Метрики прогона" style="grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr))">${metrics.map((m) => kpi(m))}</section>
<div class="split">
<section class="mn sec" aria-labelledby="curve-h" style="gap: 14px">
<div class="sec-h"><h2 class="h2" id="curve-h">${run.type === 'training' ? 'Кривая обучения' : 'Результат по позициям'}</h2><span class="cap">${run.type === 'training' ? 'Поправки оператора по позициям корзины' : 'Успех среди оценённых, по позициям'}${run.lines.length > 1 ? ' · среднее и разброс повторений' : ''}</span></div>
${curve(run)}
${hint(html`Технический сбой — пропуск на кривой, а не ноль. Почему урок повторился после curator, покажет разбор журнала агента — ${later()}`)}
</section>
${versionAside(run)}
</div>
<section class="sec" aria-labelledby="res-h">
<div class="sec-h"><h2 class="h2" id="res-h">Результаты по решениям</h2><span class="cap">Оценка — до служебных команд: capture и curator её не меняют</span></div>
${resultsTable(run, line)}
</section>
${run.type === 'training'
    ? html`<section class="sec" aria-labelledby="chg-h"><div class="sec-h"><h2 class="h2" id="chg-h">Изменения скиллов по проходам curator</h2><span class="cap">Только прикладные скиллы набора · комплект обучения — часть версии агента</span></div>
${line.curatorPasses.length ? html`<div class="pass3">${line.curatorPasses.map(curatorPass)}</div>` : html`<div class="empty">Проходов curator не было.</div>`}</section>`
    : ''}
<section class="sec" style="gap: 8px"><h2 class="h3">Подготовка набора</h2>${line.prep.items.map((p) => html`<div class="okr">${mk(p.ok === null ? 'na' : p.ok)}<span>${p.text}${p.note ? html`<span class="cap"> · ${p.note}</span>` : ''}</span><span class="cap"></span></div>`)}${line.error ? html`<div class="okr">${mk('tech')}<span>${line.error}</span><span></span></div>` : ''}</section>
${materials(run)}`;
}

export const refreshOn = (msg, ctx) => msg.topic === `run:${ctx.params[0]}`;

export const actions = {
  line(el, ctx) {
    ctx.state.line = Number(el.dataset.line);
    return ctx.rerender();
  },
  async stop(el, ctx) {
    await post(`/api/runs/${ctx.params[0]}/stop`);
    toast('Остановка отправлена: новые кейсы не начнутся');
    return ctx.rerender();
  },
};
void STATUS_TITLES;
