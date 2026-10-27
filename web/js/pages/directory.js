// Экран «Справочники»: REST-подключения агентов, модели по ролям, встроенные метрики, контракт инструментов (AG-01–03, MOD-01–02, MET-01).
import { html, icon, get, ref, hint, later, mk, issuesBox, warningsList } from '../lib.js';

export const title = 'Справочники';

function agentSection(a) {
  const health = !a.health ? '' : a.health.ok === null ? html`<span class="pill na">${a.health.note}</span>` : html`<span class="pill ${a.health.ok ? 'pass' : 'tech'}">${a.health.ok ? icon('check') : icon('bolt')}${a.health.note}</span>`;
  return html`<section class="sec" id="agent-${a.id}" aria-labelledby="ag-${a.id}" style="gap: 22px">
<div class="row" style="justify-content: space-between; gap: 16px; align-items: flex-end">
<div class="col" style="gap: 8px">${ref(a.file)}<h2 class="h1" id="ag-${a.id}" style="font-size: 26px; line-height: 34px">${a.title}</h2></div>
<div class="row" style="gap: 8px">${health}${a.contractConditional ? html`<span class="pill na">Сверка с кодом оркестратора — ожидает</span>` : html`<span class="pill pass">${icon('check')}Контракт сверен</span>`}</div>
</div>
${issuesBox(a.issues, 'Ошибки в подключении')}${warningsList(a.issues)}
<div class="ag">
<div>
<span class="lbl" style="padding-bottom: 6px">Запрос</span>
<div class="kv"><span class="k">Метод и адрес</span><span class="mono">${a.request.method} ${a.request.url}</span>${a.request.missing.length ? html`<span class="cap" style="color: #4B3BA0">не заданы: ${a.request.missing.join(', ')}</span>` : html`<span class="cap mono">${a.request.urlResolved}</span>`}</div>
<div class="kv"><span class="k">Заголовки</span><span>${a.request.headers.length ? a.request.headers.map((h) => html`<span class="mono">${h.name}: ${h.value}</span><br>`) : 'нет'}</span><span class="cap">секреты — ссылками на окружение, в снимок не входят</span></div>
<div class="kv"><span class="k">Шаблон тела</span><span class="mono">${a.request.body}</span></div>
<div class="kv"><span class="k">Текст реплики</span><span class="mono">${a.request.textPath}</span></div>
<div class="kv"><span class="k">Привязка</span><span><span class="mono">${a.request.taskIdHeader}</span> ← ${a.request.taskIdScope === 'execution' ? 'выполнение кейса' : 'каждое сообщение'} · <span class="mono">${a.request.senderIdHeader}</span> ← сессия прогона</span></div>
</div>
<div>
<span class="lbl" style="padding-bottom: 6px">Ответ</span>
<div class="kv"><span class="k">Тип ответа</span><span>${a.response.mode === 'sync' ? 'синхронный' : a.response.mode}${a.response.sample ? html` · по образцу <span class="mono">${a.response.sample}</span>` : ''}</span></div>
<div class="kv"><span class="k">Реплика</span><span class="mono">${a.response.replyPath}</span></div>
<div class="kv"><span class="k">Статус хода</span><span class="mono">${a.response.statusPath ?? '—'}</span></div>
<div class="kv"><span class="k">Ошибка агента</span><span class="mono">${a.response.errorPath ?? '—'}</span></div>
<div class="kv"><span class="k">Использование модели</span><span>${a.response.usage.inputPath || a.response.usage.outputPath || a.response.usage.totalPath ? html`<span class="mono">${[a.response.usage.inputPath, a.response.usage.outputPath, a.response.usage.totalPath].filter(Boolean).join(' · ')}</span>` : 'в ответе нет → токены агента «нет данных»'}</span></div>
<div class="kv"><span class="k">Поток и опрос задачи</span><span class="t3">не поддержаны</span></div>
</div>
<div>
<span class="lbl" style="padding-bottom: 6px">Инструменты и команды</span>
<div class="kv"><span class="k">MCP-контракт</span><span class="mono">${a.mcp.contract}</span></div>
<div class="kv"><span class="k">MCP-сервер стенда</span><span>x-task-id — из заголовка <span class="mono">${a.mcp.taskIdHeader}</span>, затем из _meta и аргумента; протокол — запрошенный агентом, если поддержан (${a.mcp.protocols.join(', ')}), иначе ${a.mcp.protocols[0]}. Общий для всех агентов</span></div>
<div class="kv"><span class="k">Служебные команды</span><span class="row" style="gap: 6px"><span class="ref">${a.commands.reset}</span><span class="ref">${a.commands.capture}</span><span class="ref">${a.commands.curator}</span></span></div>
<div class="kv"><span class="k">Модель и скиллы</span><span>${icon('lock', 's14')} ${a.model ?? 'модель не указана'} · задаёт сборка агента; скиллы живут у тестового оператора, ClawGym их не ставит и не выгружает</span></div>
<div class="kv"><span class="k">Версия агента</span><span>${a.build ?? 'не указана'}${a.learningKit ? ` · ${a.learningKit}` : ''}</span></div>
<div class="kv"><span class="k">Сессии</span><span>до ${a.sessions.max} одновременно · один диалог на сессию</span></div>
</div>
</div>
</section>`;
}

export async function render() {
  const d = await get('/api/directory');
  return html`<div class="col" style="gap: 20px">
<header class="ph"><div class="ph-t"><h1 class="h1">Справочники</h1><p class="lede">Подключения к агентам, модели, встроенные метрики и контракт инструментов. Настраиваются файлами в agents/, models/, metrics/ и contracts/; ClawGym проверяет их до запуска.</p></div></header>
<nav class="tabs" aria-label="Справочники"><a class="tab on" href="#agents">Агенты · ${d.agents.length}</a><a class="tab" href="#models">Модели · ${d.models.length}</a><a class="tab" href="#metrics">Метрики · ${d.metrics.length}</a><a class="tab" href="#tools">Инструменты · ${d.tools.filter((t) => t.enabled).length}${d.tools.some((t) => !t.enabled) ? ` из ${d.tools.length}` : ''}</a></nav>
</div>
<div id="agents" class="col" style="gap: 36px">${d.agents.map(agentSection)}</div>
<hr class="rule">
<section class="sec" id="models" aria-labelledby="mo-h">
<div class="sec-h"><h2 class="h2" id="mo-h">Модели</h2><span class="cap mono">models/</span></div>
<div class="tw"><table class="tbl"><thead><tr><th>Модель</th><th>Роли</th><th>Провайдер и параметры</th><th>Готовность</th></tr></thead>
<tbody>${d.models.map(
    (m) => html`<tr><td><span class="mono m5">${m.id}</span><div class="cap">${m.title}</div></td><td>${m.roles.map((r) => html`<span class="pill">${r === 'operator' ? 'оператор' : 'оценка'}</span> `)}</td><td class="t2">${m.provider}${m.model ? html` · <span class="mono">${m.model}</span>` : ''}${Object.entries(m.params ?? {}).length ? ` · ${Object.entries(m.params).map(([k, v]) => `${k} ${v}`).join(' · ')}` : ''}${m.endpoint ? html`<div class="cap mono">POST ${m.endpoint}</div>` : ''}${m.auth ? html`<div class="cap">${icon('lock', 's14')} ${m.auth}</div>` : ''}${m.description ? html`<div class="cap">${m.description}</div>` : ''}</td><td>${m.readiness ? html`<span class="pill na">${m.readiness}</span>` : mk(true)}</td></tr>`,
  )}</tbody></table></div>
${hint('Здесь модели LLM-оператора и судьи. Модель агента задаёт его сборка — она указана у подключения. Одна модель может играть обе роли, но вызовы и контексты ролей всегда раздельные.')}
</section>
<hr class="rule">
<section class="sec" id="metrics" aria-labelledby="me-h">
<div class="sec-h"><h2 class="h2" id="me-h">Встроенные метрики</h2><span class="cap">Выбираются в файле прогона · свои формулы — ${later('позднее')}</span></div>
<div class="tw"><table class="tbl"><thead><tr><th>Метрика</th><th>Что означает</th><th>Уровень</th><th>Нужные события</th><th class="r">Расчёт</th></tr></thead>
<tbody>${d.metrics.map((m) => html`<tr><td class="m5 nw">${m.title}<div class="cap mono">${m.builtin}</div></td><td class="t2">${m.description}${Object.keys(m.params ?? {}).length ? html`<div class="cap mono" style="word-break: break-word; padding-top: 4px">${Object.entries(m.params).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div>` : ''}</td><td class="nw">${m.level.join(', ')}</td><td class="t2">${m.needs}</td><td class="r mono cap">${m.version}</td></tr>`)}</tbody></table></div>
</section>
<hr class="rule">
<section class="sec" id="tools" aria-labelledby="to-h">
<div class="sec-h"><h2 class="h2" id="to-h">Инструменты MCP</h2>${d.contract ? html`<span class="row cap" style="gap: 8px"><span class="mono">${d.contract.file} · ${d.contract.version}</span>${d.contract.conditional ? html`<span class="pill na">условный контракт</span>` : ''}</span>` : ''}</div>
${d.contract?.conditional ? hint('Имена, описания и схемы инструментов, обёртка результата и тексты ошибок условные: их нужно снять с кода Java-оркестратора (plan.md, этап 0; docs/CONTRACTS.md).', 'warn') : ''}
<div class="tw"><table class="tbl"><thead><tr><th>Инструмент</th><th>Описание</th><th>Тип</th><th>Подтверждение</th><th>В tools/list</th></tr></thead>
<tbody>${d.tools.map((t) => html`<tr${t.enabled ? '' : html` class="t3"`}><td class="mono m5">${t.name}</td><td class="t2">${t.description}</td><td>${t.kind === 'action' ? 'активный' : 'информационный'}</td><td>${t.requiresConfirmation ? html`<span class="pill live">требует</span>` : html`<span class="t3">—</span>`}</td><td>${t.enabled ? mk(true) : html`<span class="pill na">выключен</span>`}</td></tr>`)}</tbody></table></div>
${d.tools.some((t) => !t.enabled) ? hint('Выключенный инструмент (enabled: false в контракте) агенту не предъявляется, вызов получает ошибку «не найден». Его заглушки в кейсах остаются и доступны шаблону стартового сообщения как {{tools.<имя>}}.') : ''}
${d.contract ? html`<div class="col" style="gap: 6px"><span class="lbl">Тексты ошибок для агента</span><dl class="kvs sm">${Object.entries(d.contract.errors).map(([k, v]) => html`<dt class="mono">${k}</dt><dd>${v}</dd>`)}</dl></div><div class="col" style="gap: 6px"><span class="lbl">Шаблон стартового сообщения · ${d.contract.startMessage.file}</span><pre class="diff">${d.contract.startMessage.text}</pre></div>` : ''}
</section>`;
}

export const refreshOn = (msg) => msg.type === 'config' || msg.type === 'health';
