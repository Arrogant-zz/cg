// Детерминированная «модель» для офлайн-разработки: играет LLM-оператора и судью по контексту ClawGym.
// Не заменяет настоящую LLM: правила грубые и опираются на подсказки (hint) и метку стиля решения.

interface Ctx {
  mode: 'training' | 'checking';
  case: { facts: string[] };
  reference: {
    criteria: { id: string; text: string; lesson: string | null; hint?: string }[];
    required: { tool: string; before: string | null; lesson: string | null }[];
    forbidden: { tool: string; lesson: string | null }[];
    final: string | null;
  };
  style: string | null;
  lessons: { id: string; rule: string }[];
  transcript: any[];
  event: { type: 'turn_end'; agentReply: string; looksLikeQuestion: boolean } | { type: 'confirmation'; tool: string; args: any };
}

const decision = (d: Partial<Record<string, unknown>>) => ({
  reply: null,
  confirmation: null,
  correction: false,
  lessonId: null,
  lessonNote: null,
  explanation: false,
  approval: false,
  finish: false,
  reason: '',
  ...d,
});

export function fakeOperator(ctx: Ctx) {
  const style = ctx.style ?? 'explain-now';
  const ev = ctx.event;
  const rule = (id: string | null) => ctx.lessons.find((l) => l.id === id)?.rule ?? null;
  const executed = (tool: string) => ctx.transcript.some((t) => t.role === 'tool' && t.tool === tool && t.executed);
  const corrections = ctx.transcript.filter((t) => t.role === 'operator' && t.correction);
  const timesCorrected = (lesson: string | null) => corrections.filter((t) => t.lessonId === lesson).length;
  const agentText = ctx.transcript.filter((t) => t.role === 'agent').map((t) => t.text).join('\n');

  const correct = (lesson: string | null, pointer: string) => {
    const r = rule(lesson);
    if (style === 'explain-now' && r) return { reply: r, explanation: true };
    if (style === 'minimal') return { reply: pointer, explanation: false };
    return { reply: pointer, explanation: false };
  };

  if (ev.type === 'confirmation') {
    if (ctx.mode === 'checking') return decision({ confirmation: 'approve', reason: 'проверка: без вмешательства' });
    const fb = ctx.reference.forbidden.find((f) => f.tool === ev.tool);
    if (fb && timesCorrected(fb.lesson) < 1) {
      const c = correct(fb.lesson, 'Это действие здесь не нужно.');
      return decision({ confirmation: 'reject', correction: true, lessonId: fb.lesson, ...c, reason: `${ev.tool} запрещён эталоном` });
    }
    const req = ctx.reference.required.find((r) => r.before === ev.tool && !executed(r.tool));
    if (req && timesCorrected(req.lesson) < (style === 'minimal' ? 1 : 2)) {
      const c = correct(req.lesson, style === 'minimal' ? 'Пока нельзя.' : 'Пока не выполняйте это. Не хватает одной проверки.');
      return decision({ confirmation: 'reject', correction: true, lessonId: req.lesson, ...c, reason: `до ${ev.tool} нужен ${req.tool}` });
    }
    return decision({ confirmation: 'approve', reason: 'действие соответствует эталону' });
  }

  const text = ev.agentReply;
  if (/обращение закрыто/i.test(text)) return decision({ finish: true, approval: true, reason: 'итоговое действие выполнено' });

  if (ctx.mode === 'checking') {
    if (ev.looksLikeQuestion && !/можно закрывать/i.test(text)) {
      const words = text.toLowerCase().match(/[а-яё]{5,}/g) ?? [];
      const fact = ctx.case.facts.find((f) => words.some((w) => f.toLowerCase().includes(w.slice(0, 5))));
      return decision({ reply: fact ?? 'Таких данных в обращении нет.', reason: 'вопрос о фактах' });
    }
    if (/можно закрывать/i.test(text)) return decision({ reply: 'Хорошо, можно закрывать обращение.', approval: true, reason: 'проверка: оператор не исправляет агента' });
    return decision({ reply: 'Продолжайте.', reason: 'проверка' });
  }

  if (ev.looksLikeQuestion && !/можно закрывать/i.test(text)) {
    const last = [...corrections].reverse().find((t) => t.lessonId);
    const lastLesson = last?.lessonId ?? lastRejectLesson(ctx);
    if (lastLesson && style !== 'minimal') return decision({ reply: rule(lastLesson), correction: true, lessonId: lastLesson, explanation: true, reason: 'объяснение по вопросу агента' });
    if (style === 'minimal') return decision({ reply: 'Решите сами, как правильно.', reason: 'минимальная помощь' });
    const fact = ctx.case.facts[0];
    return decision({ reply: fact ?? 'Таких данных нет.', reason: 'вопрос о фактах' });
  }
  if (/можно закрывать/i.test(text)) {
    const missing = ctx.reference.criteria.find((c) => c.hint && c.lesson && !new RegExp(c.hint, 'iu').test(agentText));
    if (missing && timesCorrected(missing.lesson) < (style === 'minimal' ? 1 : 2)) {
      const c = correct(missing.lesson, 'Ответ клиенту неполный.');
      return decision({ correction: true, lessonId: missing.lesson, ...c, reason: `в ответе нет: ${missing.text}` });
    }
    return decision({ reply: 'Хорошо, можно закрывать обращение.', approval: true, reason: 'ответ соответствует эталону' });
  }
  return decision({ reply: 'Продолжайте.', reason: 'ход без вопроса' });
}

function lastRejectLesson(ctx: Ctx): string | null {
  const rejected = [...ctx.transcript].reverse().find((t) => t.role === 'tool' && t.confirmation === 'reject');
  if (!rejected) return null;
  const req = ctx.reference.required.find((r) => r.before === rejected.tool);
  if (req) return req.lesson;
  return ctx.reference.forbidden.find((f) => f.tool === rejected.tool)?.lesson ?? null;
}

export function fakeJudge(ctx: { reference: { criteria: { id: string; text: string; hint?: string }[] }; result: { agentMessages: { seq: number; text: string }[] } }) {
  const msgs = ctx.result.agentMessages;
  return {
    criteria: ctx.reference.criteria.map((c) => {
      if (!c.hint) return { id: c.id, passed: true, reason: 'fake-llm: подсказки нет, критерий принят без проверки' };
      const re = new RegExp(c.hint, 'iu');
      const hit = msgs.find((m) => re.test(m.text));
      return hit ? { id: c.id, passed: true, reason: `есть в ответе #${hit.seq}` } : { id: c.id, passed: false, reason: `в ответах агента нет: ${c.text.toLowerCase()}` };
    }),
    summary: 'Оценка fake-llm по подсказкам критериев',
  };
}
