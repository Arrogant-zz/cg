// Ручной режим: запуск любого кейса без автоматического решения и список ручных сессий (MAN-01).
import { html, icon, get, post, fmtDate, hint, plural, toast, removeSession } from '../lib.js';

export const title = 'Ручной режим';

export async function render(ctx) {
  const [cases, dir, sessions, { runs }] = await Promise.all([get('/api/cases'), get('/api/directory'), get('/api/manual'), get('/api/runs')]);
  const pre = ctx.state.case ?? ctx.query.get('case') ?? cases.cases[0]?.id;
  const agent = dir.agents.find((a) => a.id === ctx.state.agent) ?? dir.agents[0];
  // Поле x-a2a-sender-id нужно только существующему оператору: новый получает идентификатор от ClawGym.
  const existing = ctx.state.senderMode === 'existing';
  // Операторы завершённых прогонов этого агента: на них можно продолжить вручную.
  // Один оператор проходит несколько прогонов: в подсказке — его последний прогон (список прогонов — от новых к старым).
  const seen = new Set();
  const known = runs
    .filter((r) => ['completed', 'stopped'].includes(r.status) && r.agent.id === agent?.id)
    .flatMap((r) => r.senders.map((id) => ({ id, label: `после #${r.id} ${r.title} · ${r.type === 'training' ? 'обучение' : 'проверка'}` })))
    .filter((k) => !seen.has(k.id) && seen.add(k.id));
  return html`<header class="ph"><div class="ph-t"><h1 class="h1">Ручной режим</h1><p class="lede">Любой кейс можно пройти вручную: агент получает ответы из заглушек кейса, а реплики, решения по действиям и служебные команды задаёте вы. Перед началом ClawGym отправляет обязательный /reset.</p></div></header>
<div class="split">
<form class="mn sec" data-submit="start" aria-labelledby="new-h" style="gap: 20px">
<h2 class="h2" id="new-h">Новый ручной кейс</h2>
<div class="form-grid">
<label class="field"><span class="lbl">Кейс</span><select class="input" name="case" data-change="field" data-key="case">${cases.cases.map((c) => html`<option value="${c.id}" ${c.id === pre ? 'selected' : ''}>${c.id} · ${c.title}${c.solutions ? '' : ' · только вручную'}</option>`)}</select></label>
<label class="field"><span class="lbl">Агент</span><select class="input" name="agent" data-change="field" data-key="agent">${dir.agents.map((a) => html`<option value="${a.id}" ${a.id === agent?.id ? 'selected' : ''}>${a.title}${a.health?.ok === false ? ` · ${a.health.note}` : ''}</option>`)}</select></label>
<label class="field"><span class="lbl">Тестовый оператор</span><select class="input" name="senderMode" data-change="field" data-key="senderMode"><option value="new" ${existing ? '' : 'selected'}>новый — стартовые скиллы сборки</option><option value="existing" ${existing ? 'selected' : ''}>существующий — его накопленные скиллы</option></select></label>
${existing
    ? html`<label class="field"><span class="lbl">x-a2a-sender-id существующего оператора</span><input class="input mono" name="senderId" required placeholder="${known.length ? 'выберите из списка или введите' : 'lab-…'}" list="known-senders" value="${ctx.state.senderId ?? ''}" data-change="field" data-key="senderId"><datalist id="known-senders">${known.map((k) => html`<option value="${k.id}">${k.label}</option>`)}</datalist></label>`
    : ''}
</div>
${hint(`Модель и стартовые скиллы задаёт сборка агента${agent?.model ? ` (${agent.model})` : ''}: ClawGym их не переключает и не устанавливает. Чтобы проверить вручную результат обучения, выберите существующего оператора — например, оператора обучающего прогона.`, 'info')}
<div class="row"><button class="btn pri" type="submit">${icon('play')}Начать кейс</button><span class="cap">Займёт одну сессию агента до завершения</span></div>
</form>
<aside class="sd" aria-labelledby="ses-h">
<h2 class="h3" id="ses-h">Сессии · ${sessions.length}</h2>
${sessions.length
    ? html`<div class="col" style="gap: 4px">${sessions.map(
        (s) => {
          const item = html`<a class="li" href="/manual/${s.id}"><span class="row" style="justify-content: space-between"><span class="mono sm m5">${s.case.id}</span>${s.status === 'active' ? html`<span class="st"><span class="dot live"></span>идёт</span>` : html`<span class="cap">${fmtDate(s.closedAt)}</span>`}</span><span class="sm">${s.case.title}</span><span class="cap">${s.key} · ${s.agent.title}${s.evaluation ? ` · ${s.evaluation.outcome === 'passed' ? 'пройден' : s.evaluation.outcome === 'failed' ? 'не пройден' : 'не оценён'}` : ''}</span></a>`;
          // Активную сессию сначала завершают: кнопка удаления только у закрытых.
          if (s.status === 'active') return item;
          return html`<div class="li-row">${item}<button class="btn ghost ib del" type="button" data-action="remove" data-id="${s.id}" data-key="${s.key}" data-case="${s.case.id}" data-title="${s.case.title}" aria-label="Удалить сессию ${s.key}" title="Удалить сессию">${icon('trash')}</button></div>`;
        },
      )}</div>`
    : html`<div class="empty">Ручных сессий ещё не было.</div>`}
</aside>
</div>`;
}

export const refreshOn = (msg) => msg.type === 'manual' && msg.topic === 'runs';

export const actions = {
  async remove(el, ctx) {
    if (await removeSession({ id: Number(el.dataset.id), key: el.dataset.key, caseId: el.dataset.case, caseTitle: el.dataset.title })) return ctx.rerender();
  },
  field(el, ctx) {
    ctx.state[el.dataset.key] = el.value;
    return ctx.rerender();
  },
  async start(form, ctx) {
    const f = new FormData(form);
    const body = {
      case: f.get('case'),
      agent: f.get('agent'),
      sender: f.get('senderMode') === 'existing' ? { mode: 'existing', id: String(f.get('senderId') ?? '').trim() } : { mode: 'new' },
    };
    const r = await post('/api/manual', body);
    toast(`Сессия ${r.key}: /reset и стартовое сообщение отправляются`);
    ctx.navigate(`/manual/${r.id}`);
  },
};
void plural;
