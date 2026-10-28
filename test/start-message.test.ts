// Стартовое сообщение как в оркестраторе: x-task-id в request_ref, ответы заглушек инструментов в тексте;
// инструменты контракта — из tools/list стенда, выключенный (enabled: false) не попадает в tools/list и при вызове получает «не найден».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadRegistry } from '../src/config/loader.js';
import { renderStartMessage } from '../src/execution/dialog.js';
import { mergeTools, toolsFromJson } from '../src/config/tools-import.js';
import { startStand, until, CONFIG, type Stand } from './helpers.js';

let home: string;

// Копия настроек: get_cases_assigned выключен (нужен только старту), статические атрибуты — последовательность с эффектом.
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-start-'));
  for (const d of ['contracts', 'cases', 'solutions', 'agents', 'models', 'metrics', 'templates', 'baskets', 'runs']) {
    fs.cpSync(path.join(CONFIG, d), path.join(home, d), { recursive: true });
  }
  const contractFile = path.join(home, 'contracts/tools.json');
  const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  contract.tools.find((t: any) => t.name === 'get_cases_assigned').enabled = false;
  fs.writeFileSync(contractFile, JSON.stringify(contract, null, 2));
  const caseFile = path.join(home, 'cases/spasibo-bonus-missing.yaml');
  const c = YAML.parse(fs.readFileSync(caseFile, 'utf8'));
  // Шаблон берёт первый ответ последовательности и не применяет эффект.
  c.tools.get_static_attributes_assigned = [
    {
      id: 'static',
      sequence: [
        { result: { json: { classifier: { categoryName: 'СберСпасибо / Начисление бонусов' }, channel: 'CHAT' } }, effect: { statics: 'read' } },
        { result: { json: { classifier: { categoryName: 'Повторный вызов' } } } },
      ],
    },
  ];
  fs.writeFileSync(caseFile, YAML.stringify(c));
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('стартовое сообщение в формате оркестратора: x-task-id, ответы заглушек, первый ответ последовательности без эффекта', async () => {
  const reg = await loadRegistry(home);
  assert.deepEqual(
    reg.issues.filter((i) => i.severity === 'error'),
    [],
  );
  const c = reg.cases.get('spasibo-bonus-missing')!;
  const before = JSON.stringify(c.state);
  const missing = new Set<string>();
  const text = renderStartMessage(reg.contract!, c, { caseNumber: 'CG-1-01', requestRef: 'rr', taskId: 'cg-1-1-01-abcd' }, c.state, missing);
  const lines = text.split('\n');
  assert.match(lines[0], /^Новое обращение/);
  assert.deepEqual(lines.slice(1, 5), ['```', '    Тематика: СберСпасибо / Начисление бонусов', '    request_ref: cg-1-1-01-abcd', '```.']);
  assert.match(lines[5], /^Результат вызова инструмента «Получение кейса для сотрудника»\{"caseId":"CASE-TEST-1001","taskId":"cg-1-1-01-abcd",/);
  assert.equal(lines[6], 'Результат вызова инструмента «Получение статических атрибутов кейса»{"classifier":{"categoryName":"СберСпасибо / Начисление бонусов"},"channel":"CHAT"}.');
  assert.match(lines[7], /«Получение информации по клиенту для SC»\{"clientId":"CL-TEST-0001".*\}\.$/, 'ответ по умолчанию из contracts/tool-defaults.yaml');
  assert.match(lines[8], /«Получение динамических атрибутов кейса»\{.*"periodFrom":"2026-10-01".*\}$/);
  assert.equal(missing.size, 0);
  assert.equal(JSON.stringify(c.state), before, 'эффект заглушки не применяется');
});

test('импорт tools/list: поля MCP из ответа, пометки ClawGym сохраняются, расхождения видны', async () => {
  const current = JSON.parse(fs.readFileSync(path.join(CONFIG, 'contracts/tools.json'), 'utf8')).tools;
  const listed = current.map(({ requiresConfirmation: _c, kind: _k, enabled: _e, terminal: _t, ...t }: any) => t);
  const same = mergeTools(current, toolsFromJson({ jsonrpc: '2.0', id: 1, result: { tools: listed } }));
  assert.deepEqual([same.added, same.removed, same.changed], [[], [], []]);
  assert.deepEqual(same.tools, current, 'пометки kind, requiresConfirmation и terminal перенесены');
  assert.deepEqual(same.tools.find((t) => t.name === 'change_stage')!.terminal, { when: { 'request.keepOnSelf': false } }, 'условие terminal сохранено');
  const edited = listed.filter((t: any) => t.name !== 'get_unified_list').map((t: any) => (t.name === 'cases_postpone' ? { ...t, description: 'Отложить кейс (новое описание)' } : t));
  edited.push({ name: 'get_new_tool', title: 'get_new_tool', description: 'Новый инструмент', inputSchema: { type: 'object', properties: {}, required: [] } });
  const diff = mergeTools(current, toolsFromJson(edited));
  assert.deepEqual(diff.added, ['get_new_tool']);
  assert.deepEqual(diff.removed, ['get_unified_list']);
  assert.deepEqual(diff.changed, [{ name: 'cases_postpone', fields: ['description'] }]);
  assert.equal(diff.tools.find((t) => t.name === 'cases_postpone')!.requiresConfirmation, true);
  assert.equal(diff.tools.find((t) => t.name === 'cases_postpone')!.terminal, true);
  assert.equal(diff.tools.find((t) => t.name === 'get_new_tool')!.terminal, undefined, 'новый инструмент — без пометок, не терминальный');
});

test('tools/list как у оркестратора; выключенный инструмент — только для старта; x-task-id старта — в тексте, заголовке и capture', async () => {
  const s: Stand = await startStand({ CLAWGYM_CONFIG: home });
  try {
    const mcp = async (method: string, params: unknown, taskId?: string) => {
      const res = await fetch(`${s.base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(taskId ? { 'x-task-id': taskId } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as any;
    };
    const tools = (await mcp('tools/list', {})).result.tools;
    assert.equal(tools.length, 37, 'все инструменты стенда, кроме выключенного');
    assert.ok(!tools.some((t: any) => t.name === 'get_cases_assigned'));
    const close = tools.find((t: any) => t.name === 'get_close_with_answer');
    assert.deepEqual(Object.keys(close), ['name', 'title', 'description', 'inputSchema', 'annotations'], 'поля MCP как у оркестратора, без пометок ClawGym');
    assert.ok(!tools.some((t: any) => 'terminal' in t || 'requiresConfirmation' in t), 'пометка terminal агенту не уходит');
    assert.equal(close.annotations.destructiveHint, true);

    const created = await s.api('POST', '/api/manual', { case: 'spasibo-bonus-missing', agent: 'fake-agent' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.id;
    const get = async () => (await s.api('GET', `/api/manual/${id}`)).data;
    const start = await until(async () => (await get()).execution?.events.find((e: any) => e.type === 'start_message'), 20000, 'стартовое сообщение');
    const taskId = /request_ref: (\S+)/.exec(start.text)?.[1];
    assert.ok(taskId && taskId.startsWith('cg-'), start.text);
    assert.match(start.text, new RegExp(`«Получение кейса для сотрудника»\\{"caseId":"CASE-TEST-1001","taskId":"${taskId}"`));
    const http = (await s.api('GET', `/api/manual/${id}/http`)).data as any[];
    assert.equal(http.find((x) => x.label === 'Стартовое сообщение').request.headers['x-task-id'], taskId, 'в тексте тот же x-task-id, что в заголовке');

    // Выключенный инструмент — «не найден»; включённый получает первый ответ последовательности.
    const off = await mcp('tools/call', { name: 'get_cases_assigned', arguments: { isCallActive: true } }, taskId);
    assert.equal(off.result.isError, true);
    assert.match(off.result.content[0].text, /get_cases_assigned не найден/);
    const on = await mcp('tools/call', { name: 'get_static_attributes_assigned', arguments: {} }, taskId);
    assert.match(on.result.content[0].text, /СберСпасибо \/ Начисление бонусов/, 'шаблон не израсходовал первый ответ');
    const ev = (await get()).execution.events.find((e: any) => e.type === 'tool_call' && e.tool === 'get_cases_assigned');
    assert.equal(ev.outcome, 'unknown_tool');
    assert.equal(ev.disabled, true);

    // Агент закончил ход вопросом «Можно закрывать?»; /case-capture уходит с request_ref = x-task-id.
    await until(async () => ((await get()).busy === null ? true : null), 30000, 'конец хода агента');
    assert.equal((await s.api('POST', `/api/manual/${id}/command`, { name: 'capture' })).status, 200);
    const cmd = await until(async () => (await get()).execution.events.find((e: any) => e.type === 'command' && e.name === 'capture'), 20000, 'capture');
    assert.equal(cmd.text, `/case-capture request_ref=${taskId} category=СберСпасибо / Начисление бонусов`);
  } finally {
    await s.close();
  }
});
