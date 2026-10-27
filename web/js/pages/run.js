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
  ref,
  hint,
  later,
  feed,
  exchangeCard,
  toast,
  STATUS_TITLES,
  removeRun,
  fmtShare,
  fmtRuns,
  FINAL_CLASS_TITLES,
} from '../lib.js';

export const title = (ctx) => `Прогон #${ctx.params[0]}`;

function strip(run) {
  const s = run.settings;
  return html`<div class="strip">
<span><span class="cap">Агент</span><span>${s.agent.title}${s.agent.model ? ` · ${s.agent.model}` : ''}</span></span>
<span><span class="cap">LLM-оператор</span><span>${s.operator?.id ?? '—'}</span></span>
<span><span class="cap">Оценка</span><span>${s.judge?.id ?? 'не выбрана'}</span></span>
<span><span class="cap">Тестовый оператор</span><span>${run.testOperatorLabel}</span></span>
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

/** Что сделал curator — по строке результата; файлы скиллов остаются в агенте у тестового оператора. */
function curatorResult(p) {
  const c = p.parsed?.kind === 'complete' ? p.parsed : null;
  if (c) {
    return html`<span class="sm">разобрано ${c.processed} · создано ${c.created} · обновлено ${c.updated}${c.left ? ` · осталось ${c.left}` : ''}${c.conflicts ? ` · конфликтов ${c.conflicts}` : ''}</span>${c.report ? html`<span class="cap mono" style="word-break: break-all">${c.report}</span>` : ''}`;
  }
  if (p.parsed?.kind === 'empty') return html`<span class="cap">очередь была пуста</span>`;
  return p.reply && p.status !== 'running' ? html`<span class="cap">строка результата не распознана — ответ в HTTP-обменах</span>` : '';
}

function curatorPass(p) {
  const title = p.reason === 'final' ? 'финальный' : `curator ${p.pass}`;
  const st = p.status === 'running' ? html`<span class="st"><span class="dot live"></span>выполняется</span>` : p.status === 'ok' ? '' : p.status === 'skipped' ? html`<span class="cap">очередь пуста</span>` : html`<span class="pill tech">${icon('bolt')}${p.error ?? p.status}</span>`;
  return html`<div class="col" style="gap: 4px">
<span class="row m5" style="gap: 8px; padding-bottom: 6px"><span class="pb cu" style="height: 24px; padding: 0 8px">${icon('curator')}${title}</span>после позиции ${p.afterPos}${p.durationMs ? ` · ${fmtDur(p.durationMs)}` : ''}${st}</span>
${curatorResult(p)}
${p.http?.length ? html`<details class="raw" id="cur-http-${p.pass}-${p.startedAt}"><summary>HTTP-обмены прохода · ${p.http.length}</summary><div class="col" style="gap: 8px; padding: 8px 0">${p.http.map(exchangeCard)}</div></details>` : ''}
</div>`;
}

function liveAside(run, line) {
  if (run.type !== 'training') {
    return html`<aside class="sd"><section class="soft p24 sec" style="gap: 14px"><h2 class="h3">Проверка без обучения</h2><ul class="col sm t2" style="gap: 6px">${run.planText.map((t) => html`<li>${t}</li>`)}</ul><hr class="rule"><div class="col" style="gap: 6px"><span class="lbl">Тестовый оператор</span><span class="sm">${run.testOperatorLabel}</span><span class="cap">В проверке /case-capture и /skill-curator не отправляются — скиллы оператора не меняются.</span></div></section></aside>`;
  }
  const nextCur = run.plan.filter((s) => s.kind === 'curator').find((s) => !line.curatorPasses.some((p) => p.pass === s.pass));
  return html`<aside class="sd" aria-labelledby="learn-h"><section class="soft p24 sec" style="gap: 20px">
<h2 class="h3" id="learn-h">Обучение в этом прогоне</h2>
<div class="col" style="gap: 10px"><span class="lbl">Поправки оператора по позициям</span>${correctionsBars(line)}</div>
${line.curatorPasses.length ? html`<hr class="rule">${line.curatorPasses.map(curatorPass)}` : ''}
<hr class="rule">
<div class="col" style="gap: 6px"><span class="lbl">Тестовый оператор</span>
<span class="sm">${run.testOperatorLabel}</span>
<span class="cap">${nextCur ? `Следующий curator — после позиции ${nextCur.afterPos}. ` : ''}Выученное остаётся у оператора в агенте: после прогона его можно проверить.</span>
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

/** Проверка для обученного оператора: настройка с тем же агентом, лучше та, что продолжает файл этого прогона. */
function nextCheckConfig(run, configs) {
  const same = configs.filter((c) => c.basket.type === 'checking' && c.agent === run.settings.agent.id);
  return same.find((c) => c.continueFrom === run.configId) ?? same[0] ?? null;
}

/** Скиллы остались у тестового оператора в агенте (решение владельца от 27.10.2026): следующий прогон может продолжить на нём. */
function operatorAside(run, line) {
  const finished = run.status === 'completed' || run.status === 'stopped';
  return html`<aside class="sd"><section class="soft p24 sec" aria-labelledby="op-h" style="gap: 14px">
<h2 class="h3" id="op-h">Тестовый оператор</h2>
<span class="sm">${run.testOperatorLabel}</span>
${run.lines.map((l) => html`<div class="okr">${mk(l.error ? 'tech' : l.senderId ? true : 'na')}<span class="mono" style="font-size: 12px; word-break: break-all">${l.senderId || 'линия не начиналась'}</span><span class="cap">${run.lines.length > 1 ? `линия ${l.index}` : 'x-a2a-sender-id'}</span></div>${l.error ? html`<span class="cap">${l.error}</span>` : ''}`)}
<span class="cap">${run.type === 'training' ? 'Выученное за прогон осталось у оператора в агенте: ClawGym скиллы не выгружает. Что сделал curator — в проходах ниже.' : 'Проверка не отправляла /case-capture и /skill-curator: скиллы оператора не менялись.'}</span>
${finished && line.senderId ? html`<a class="btn" href="/runs/new?continue=${run.id}">${icon('play')}Продолжить на этом операторе</a>` : ''}
</section></aside>`;
}

/** M1: матрица ошибок по классам финального действия — строки эталон, столбцы действие агента; показываются встретившиеся классы. */
function classMatrix(m) {
  if (!m || m.status !== 'ok' || !m.details?.matrix) return '';
  const d = m.details;
  const used = d.classes.map((_, i) => i).filter((i) => d.matrix[i].some((x) => x) || d.matrix.some((row) => row[i]));
  const name = (i) => FINAL_CLASS_TITLES[d.classes[i]] ?? d.classes[i];
  const single = d.perClass.filter((c) => c.support).length === 1;
  return html`<section class="sec" aria-labelledby="cm-h">
<div class="sec-h"><h2 class="h2" id="cm-h">M1 · классы финального действия</h2><span class="cap">macro-F1 ${fmtShare(d.macroF1)} · accuracy ${fmtShare(d.accuracy)} · строки — эталон, столбцы — действие агента</span></div>
<div class="tw"><table class="tbl cm"><thead><tr><th>Эталон</th>${used.map((i) => html`<th class="n">${name(i)}</th>`)}<th class="n">F1 класса</th><th class="n">Кейсов</th></tr></thead>
<tbody>${used.map((i) => html`<tr><td class="m5">${name(i)}</td>${used.map((j) => {
    const v = d.matrix[i][j];
    return html`<td class="n ${v === 0 ? 'zero' : i === j ? 'hit' : 'miss'}">${v}</td>`;
  })}<td class="n num">${fmtShare(d.perClass[i].f1)}</td><td class="n num t2">${d.perClass[i].support}</td></tr>`)}</tbody></table></div>
<span class="cap">Незавершённые кейсы в M1 не входят: ${d.incomplete} из ${d.finished}${d.technical ? `, из них технический сбой — ${d.technical}` : ''}.${d.noReference ? ` Без эталонного класса: ${d.noReference}.` : ''}</span>
${single ? hint('В корзине один эталонный класс: M1 заметит только ошибки в сторону других классов. Для полной картины нужны кейсы, где финал — не ответ клиенту.') : ''}
</section>`;
}

function analystCell(sc) {
  if (!sc) return html`<span class="t3">—</span>`;
  const f = sc.final;
  const a = sc.answer;
  const wrong = f.correct === false ? html`<div class="cap">эталон — ${FINAL_CLASS_TITLES[f.expected] ?? f.expected}</div>` : '';
  return html`<span class="row" style="gap: 6px; flex-wrap: nowrap">${mk(f.incomplete || f.correct === null ? 'na' : f.correct)}<span class="num m5">${sc.caseScore === null ? '—' : fmtShare(sc.caseScore)}</span></span>
<div class="cap nw">F1 ${fmtShare(sc.tools.f1)} · A ${a.status === 'ok' ? (a.runs ? fmtRuns(a) : fmtShare(a.score)) : a.status === 'failed' ? 'сбой' : '—'}</div>${f.incomplete ? html`<div class="cap">не завершён</div>` : wrong}`;
}

function resultsTable(run, line) {
  const training = run.type === 'training';
  const analystOn = run.settings.metrics.some((m) => m.builtin === 'final-action' || m.builtin === 'case-score');
  return html`<div class="tw"><table class="tbl">
<thead><tr><th>№</th><th>Кейс · решение</th><th>Итог</th><th>Действия</th><th>Ответ</th>${analystOn ? html`<th title="Финальное действие верно (M1) · case_score (M2)">M1 · M2</th>` : ''}${training ? html`<th>Поправки</th>` : ''}<th>Команды</th><th class="r">Время</th></tr></thead>
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
${analystOn ? html`<td>${analystCell(i.scores)}</td>` : ''}
${training ? html`<td>${i.stats ? html`<span class="num">${i.stats.corrections}</span> ${i.repeated.map((l) => html`<span class="lesson">повтор ${l}</span>`)}` : html`<span class="t3">—</span>`}</td>` : ''}
<td><span class="steps">${cmds}</span></td>
<td class="r num t3">${i.startedAt && i.finishedAt ? fmtClock(Date.parse(i.finishedAt) - Date.parse(i.startedAt)) : '—'}</td>
</tr>`;
    })}</tbody></table></div>`;
}

function snapshot(run) {
  const snapFiles = run.snapshot.files.length;
  const p = run.settings.prompts;
  return html`<section class="sec" id="snap" aria-labelledby="mat-h">
<div class="sec-h"><h2 class="h2" id="mat-h">Снимок настроек</h2><a class="btn" href="/api/runs/${run.id}/materials.zip" download>${icon('download')}Скачать снимок и журналы</a></div>
<div class="col" style="gap: 0">
<div class="okr">${mk(true)}<span>Корзина, ${run.settings.basket.items} ${plural(run.settings.basket.items, 'решение', 'решения', 'решений')} с кейсами, агент, модели оператора и оценки, подсказки (${[p.operator, p.judge, p.answerJudge].filter(Boolean).join(', ')}), определения метрик, контракт ${run.settings.contract.version}</span><span class="cap num">${snapFiles} ${plural(snapFiles, 'файл', 'файла', 'файлов')}</span></div>
<div class="okr">${mk(true)}<span>Авторизация в снимок не входит. Правка исходных файлов не меняет этот результат</span><span class="cap">${fmtDate(run.snapshot.createdAt)}</span></div>
<div class="okr">${mk('na')}<span>Файлы скиллов в снимок не входят: они живут в агенте у тестового оператора</span><span class="cap"></span></div>
</div>
${run.snapshot.files.length ? html`<details class="raw"><summary>Файлы снимка</summary><pre>${run.snapshot.files.map((f) => `${f.file}${f.hash ? ` @${f.hash}` : ''}`).join('\n')}</pre></details>` : ''}
</section>`;
}

function headerActions(run, configs) {
  if (run.status === 'running' || run.status === 'queued') {
    return html`<div class="ph-a" style="flex-direction: column; align-items: flex-end; gap: 6px"><button class="btn stop" type="button" data-action="stop">${icon('stop')}${run.status === 'queued' ? 'Убрать из очереди' : 'Остановить прогон'}</button><span class="cap" style="max-width: 300px; text-align: right">Новые кейсы не начнутся. Текущий шаг и отправленные команды сохранятся в результате.</span></div>`;
  }
  const check = run.type === 'training' && run.status === 'completed' ? nextCheckConfig(run, configs) : null;
  return html`<div class="ph-a"><a class="btn" href="/compare?b=${run.id}">${icon('compare')}Сравнить</a>${check ? html`<a class="btn pri" href="/runs/new?config=${encodeURIComponent(check.id)}&continue=${run.id}">${icon('play')}Проверить на этом операторе</a>` : ''}<button class="btn ghost del" type="button" data-action="remove" data-title="${run.title}">${icon('trash')}Удалить</button></div>`;
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

  // В проверке главные цифры — M1 и M2 по документу аналитика: они идут первыми.
  const lead = run.type === 'checking' ? ['final-action', 'case-score'] : [];
  const summary = run.summary ?? [];
  const metrics = [...lead.flatMap((b) => summary.filter((m) => m.builtin === b)), ...summary.filter((m) => !lead.includes(m.builtin))];
  return html`${head}
<section class="kpis" aria-label="Метрики прогона" style="grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr))">${metrics.map((m) => kpi(m))}</section>
${classMatrix(metrics.find((m) => m.builtin === 'final-action'))}
<div class="split">
<section class="mn sec" aria-labelledby="curve-h" style="gap: 14px">
<div class="sec-h"><h2 class="h2" id="curve-h">${run.type === 'training' ? 'Кривая обучения' : 'Результат по позициям'}</h2><span class="cap">${run.type === 'training' ? 'Поправки оператора по позициям корзины' : 'Успех среди оценённых, по позициям'}${run.lines.length > 1 ? ' · среднее и разброс повторений' : ''}</span></div>
${curve(run)}
${hint(html`Технический сбой — пропуск на кривой, а не ноль. Почему урок повторился после curator, покажет разбор журнала агента — ${later()}`)}
</section>
${operatorAside(run, line)}
</div>
<section class="sec" aria-labelledby="res-h">
<div class="sec-h"><h2 class="h2" id="res-h">Результаты по решениям</h2><span class="cap">Оценка — до служебных команд: capture и curator её не меняют</span></div>
${resultsTable(run, line)}
</section>
${run.type === 'training'
    ? html`<section class="sec" aria-labelledby="chg-h"><div class="sec-h"><h2 class="h2" id="chg-h">Проходы curator</h2><span class="cap">По строке результата /skill-curator · файлы скиллов остаются у тестового оператора в агенте</span></div>
${line.curatorPasses.length ? html`<div class="pass3">${line.curatorPasses.map(curatorPass)}</div>` : html`<div class="empty">Проходов curator не было.</div>`}</section>`
    : ''}
${snapshot(run)}`;
}

export const refreshOn = (msg, ctx) => msg.topic === `run:${ctx.params[0]}`;

export const actions = {
  line(el, ctx) {
    ctx.state.line = Number(el.dataset.line);
    return ctx.rerender();
  },
  async remove(el, ctx) {
    if (await removeRun({ id: Number(ctx.params[0]), title: el.dataset.title })) ctx.navigate('/');
  },
  async stop(el, ctx) {
    await post(`/api/runs/${ctx.params[0]}/stop`);
    toast('Остановка отправлена: новые кейсы не начнутся');
    return ctx.rerender();
  },
};
void STATUS_TITLES;
