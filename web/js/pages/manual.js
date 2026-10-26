// Ручной режим: запуск любого кейса без автоматического решения и список ручных сессий (MAN-01).
import { html, icon, get, post, fmtDate, hint, plural, toast } from '../lib.js';

export const title = 'Ручной режим';

export async function render(ctx) {
  const [cases, dir, skillsets, sessions] = await Promise.all([get('/api/cases'), get('/api/directory'), get('/api/skillsets'), get('/api/manual')]);
  const pre = ctx.state.case ?? ctx.query.get('case') ?? cases.cases[0]?.id;
  const agent = dir.agents.find((a) => a.id === ctx.state.agent) ?? dir.agents[0];
  // Модель агента выбирается, только если подключение переключает её запросом (MOD-02).
  const switchable = agent?.model.switch === 'request';
  const agentModels = dir.models.filter((m) => m.roles.includes('agent') && (switchable ? m.provider === 'agent-request' : m.provider === 'deployment'));
  const installable = agent && agent.skills.kind !== 'none';
  return html`<header class="ph"><div class="ph-t"><h1 class="h1">Ручной режим</h1><p class="lede">Любой кейс можно пройти вручную: агент получает ответы из заглушек кейса, а реплики, решения по действиям и служебные команды задаёте вы. Перед началом ClawGym отправляет обязательный /reset.</p></div></header>
<div class="split">
<form class="mn sec" data-submit="start" aria-labelledby="new-h" style="gap: 20px">
<h2 class="h2" id="new-h">Новый ручной кейс</h2>
<div class="form-grid">
<label class="field"><span class="lbl">Кейс</span><select class="input" name="case" data-change="field" data-key="case">${cases.cases.map((c) => html`<option value="${c.id}" ${c.id === pre ? 'selected' : ''}>${c.id} · ${c.title}${c.solutions ? '' : ' · только вручную'}</option>`)}</select></label>
<label class="field"><span class="lbl">Агент</span><select class="input" name="agent" data-change="field" data-key="agent">${dir.agents.map((a) => html`<option value="${a.id}" ${a.id === agent?.id ? 'selected' : ''}>${a.title}${a.health?.ok === false ? ` · ${a.health.note}` : ''}</option>`)}</select></label>
<label class="field"><span class="lbl">Модель агента</span>${switchable
    ? html`<select class="input" name="model">${agentModels.map((m) => html`<option value="${m.id}">${m.title}</option>`)}</select>`
    : html`<select class="input" name="model" disabled><option value="">${agent?.model.fixed ?? 'задана развёртыванием'} · задана развёртыванием</option></select>`}</label>
<label class="field"><span class="lbl">Скиллы</span><select class="input" name="skillset"><option value="build">стартовые скиллы сборки</option><option value="">не подготавливать</option>${installable ? skillsets.flatMap((s) => s.versions.filter((v) => v.status === 'ready').map((v) => html`<option value="${s.id}@${v.id}">${s.title} · рабочая копия ${v.id}</option>`)) : ''}</select></label>
<label class="field"><span class="lbl">Тестовый оператор</span><select class="input" name="senderMode"><option value="new">новый x-a2a-sender-id</option><option value="existing">существующий</option></select></label>
<label class="field"><span class="lbl">Существующий x-a2a-sender-id</span><input class="input mono" name="senderId" placeholder="lab-…"></label>
</div>
${hint(installable ? 'Модель агента выбирается, только если подключение переключает её параметром запроса. Выбранная версия скиллов устанавливается в рабочую копию сессии; исходная версия не меняется.' : 'Это подключение не переключает модель и не устанавливает наборы скиллов: используются модель развёртывания и стартовые скиллы сборки.', 'info')}
<div class="row"><button class="btn pri" type="submit">${icon('play')}Начать кейс</button><span class="cap">Займёт одну сессию агента до завершения</span></div>
</form>
<aside class="sd" aria-labelledby="ses-h">
<h2 class="h3" id="ses-h">Сессии · ${sessions.length}</h2>
${sessions.length
    ? html`<div class="col" style="gap: 4px">${sessions.map(
        (s) => html`<a class="li" href="/manual/${s.id}"><span class="row" style="justify-content: space-between"><span class="mono sm m5">${s.case.id}</span>${s.status === 'active' ? html`<span class="st"><span class="dot live"></span>идёт</span>` : html`<span class="cap">${fmtDate(s.closedAt)}</span>`}</span><span class="sm">${s.case.title}</span><span class="cap">${s.key} · ${s.agent.title}${s.evaluation ? ` · ${s.evaluation.outcome === 'passed' ? 'пройден' : s.evaluation.outcome === 'failed' ? 'не пройден' : 'не оценён'}` : ''}</span></a>`,
      )}</div>`
    : html`<div class="empty">Ручных сессий ещё не было.</div>`}
</aside>
</div>`;
}

export const refreshOn = (msg) => msg.type === 'manual' && msg.topic === 'runs';

export const actions = {
  field(el, ctx) {
    ctx.state[el.dataset.key] = el.value;
    return ctx.rerender();
  },
  async start(form, ctx) {
    const f = new FormData(form);
    const ss = String(f.get('skillset') ?? '');
    const body = {
      case: f.get('case'),
      agent: f.get('agent'),
      model: f.get('model') || null,
      skillset: ss === 'build' ? 'build' : ss ? { id: ss.split('@')[0], version: ss.split('@')[1] } : null,
      sender: { mode: f.get('senderMode'), id: f.get('senderId') || undefined },
    };
    const r = await post('/api/manual', body);
    toast(`Сессия ${r.key}: /reset и стартовое сообщение отправляются`);
    ctx.navigate(`/manual/${r.id}`);
  },
};
void plural;
