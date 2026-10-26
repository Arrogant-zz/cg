// Стартовое сообщение как в оркестраторе: x-task-id в request_ref, ответы заглушек инструментов в тексте;
// выключенный инструмент (enabled: false) не попадает в tools/list и при вызове получает «не найден».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadRegistry } from '../src/config/loader.js';
import { renderStartMessage } from '../src/execution/dialog.js';
import { startStand, until, HOME, type Stand } from './helpers.js';

let home: string;

// Копия настроек: контракт с выключенным инструментом, шаблон с блоком оркестратора, кейс с заглушками для старта.
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-start-'));
  for (const d of ['contracts', 'cases', 'solutions', 'agents', 'models', 'skillsets', 'metrics', 'templates', 'data', 'baskets', 'runs']) {
    fs.cpSync(path.join(HOME, d), path.join(home, d), { recursive: true });
  }
  const contractFile = path.join(home, 'contracts/tools.json');
  const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
  const schema = { type: 'object', properties: {} };
  contract.tools.push(
    { name: 'get_assigned_case', description: 'Получение кейса для сотрудника', inputSchema: schema, enabled: false },
    { name: 'get_static_attributes', description: 'Получение статических атрибутов кейса', inputSchema: schema },
  );
  fs.writeFileSync(contractFile, JSON.stringify(contract, null, 2));
  const tplFile = path.join(home, 'contracts/start-message.txt');
  const tpl = fs.readFileSync(tplFile, 'utf8').trimEnd();
  fs.writeFileSync(
    tplFile,
    `${tpl}\n\`\`\`\n    Тематика: {{tools.get_static_attributes.classifier.categoryName}}\n    request_ref: {{execution.taskId}}\n\`\`\`.\n` +
      'Результат вызова инструмента «Получение кейса для сотрудника»{{tools.get_assigned_case}}.\n' +
      'Результат вызова инструмента «Получение статических атрибутов кейса»{{tools.get_static_attributes}}.\n' +
      'Результат вызова инструмента «Получение динамических атрибутов кейса»{{tools.get_dynamic_attributes}}\n',
  );
  const caseFile = path.join(home, 'cases/card-blocked-wrong-pin.yaml');
  const c = YAML.parse(fs.readFileSync(caseFile, 'utf8'));
  c.tools.get_assigned_case = [{ id: 'assigned', result: { json: { taskId: '{{execution.taskId}}', caseId: 'CZK-1', status: 'ASSIGNED' } } }];
  // Последовательность и эффект: шаблон берёт первый ответ и не меняет состояние выполнения.
  c.tools.get_static_attributes = [
    {
      id: 'static',
      sequence: [
        { result: { json: { classifier: { categoryName: 'Карты / Блокировка' }, priority: 1 } }, effect: { statics: 'read' } },
        { result: { json: { classifier: { categoryName: 'Повторный вызов' } } } },
      ],
    },
  ];
  fs.writeFileSync(caseFile, YAML.stringify(c));
  const agentFile = path.join(home, 'agents/fake-agent.yaml');
  const agent = YAML.parse(fs.readFileSync(agentFile, 'utf8'));
  agent.commands = { ...(agent.commands ?? {}), capture: '/case-capture request_ref={{taskId}} category={{topic}}' };
  fs.writeFileSync(agentFile, YAML.stringify(agent));
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('шаблон стартового сообщения: x-task-id, ответы заглушек, первый ответ последовательности без эффекта', async () => {
  const reg = await loadRegistry(home, path.join(home, 'var'));
  assert.deepEqual(
    reg.issues.filter((i) => i.severity === 'error'),
    [],
  );
  const c = reg.cases.get('card-blocked-wrong-pin')!;
  const before = JSON.stringify(c.state);
  const missing = new Set<string>();
  const text = renderStartMessage(reg.contract!, c, { caseNumber: 'CG-1-01', requestRef: 'rr', taskId: 'cg-1-1-01-abcd' }, c.state, missing);
  const block = [
    '```',
    '    Тематика: Карты / Блокировка',
    '    request_ref: cg-1-1-01-abcd',
    '```.',
    'Результат вызова инструмента «Получение кейса для сотрудника»{"taskId":"cg-1-1-01-abcd","caseId":"CZK-1","status":"ASSIGNED"}.',
    'Результат вызова инструмента «Получение статических атрибутов кейса»{"classifier":{"categoryName":"Карты / Блокировка"},"priority":1}.',
  ].join('\n');
  assert.ok(text.endsWith(block), text);
  assert.ok(missing.has('tools.get_dynamic_attributes'), 'строка без заглушки выпадает');
  assert.ok(!text.includes('динамических атрибутов'));
  assert.equal(JSON.stringify(c.state), before, 'эффект заглушки не применяется');
});

test('выключенный инструмент не в tools/list; x-task-id стартового сообщения — в тексте, заголовке и capture', async () => {
  const s: Stand = await startStand({ CLAWGYM_HOME: home });
  try {
    const mcp = async (method: string, params: unknown, taskId?: string) => {
      const res = await fetch(`${s.base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(taskId ? { 'x-task-id': taskId } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as any;
    };
    const names = (await mcp('tools/list', {})).result.tools.map((t: any) => t.name);
    assert.ok(!names.includes('get_assigned_case'), 'выключенный инструмент не предъявляется');
    assert.ok(names.includes('get_static_attributes') && names.includes('get_card_status'));

    const created = await s.api('POST', '/api/manual', { case: 'card-blocked-wrong-pin', agent: 'fake-agent', model: 'fake-agent-a', skillset: 'build' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.id;
    const get = async () => (await s.api('GET', `/api/manual/${id}`)).data;
    const start = await until(async () => (await get()).execution?.events.find((e: any) => e.type === 'start_message'), 20000, 'стартовое сообщение');
    const taskId = /request_ref: (\S+)/.exec(start.text.split('```')[1])?.[1];
    assert.ok(taskId && taskId.startsWith('cg-'), start.text);
    assert.match(start.text, new RegExp(`«Получение кейса для сотрудника»\\{"taskId":"${taskId}"`));
    const http = (await s.api('GET', `/api/manual/${id}/http`)).data as any[];
    assert.equal(http.find((x) => x.label === 'Стартовое сообщение').request.headers['x-task-id'], taskId, 'в тексте тот же x-task-id, что в заголовке');

    // Вызов выключенного инструмента — «не найден»; включённый получает первый ответ последовательности.
    const off = await mcp('tools/call', { name: 'get_assigned_case', arguments: {} }, taskId);
    assert.equal(off.result.isError, true);
    assert.match(off.result.content[0].text, /get_assigned_case не найден/);
    const on = await mcp('tools/call', { name: 'get_static_attributes', arguments: {} }, taskId);
    assert.match(on.result.content[0].text, /Карты \/ Блокировка/, 'шаблон не израсходовал первый ответ');
    const ev = (await get()).execution.events.find((e: any) => e.type === 'tool_call' && e.tool === 'get_assigned_case');
    assert.equal(ev.outcome, 'unknown_tool');
    assert.equal(ev.disabled, true);

    // Доводим ход агента до конца и проверяем {{taskId}} в /case-capture.
    await until(
      async () => {
        const m = await get();
        for (const p of m.execution.pending ?? []) {
          if (p.kind === 'confirmation') await s.api('POST', `/api/manual/${id}/tool/${p.callId}`, { action: 'approve' });
          else await s.api('POST', `/api/manual/${id}/tool/${p.callId}`, { action: 'answer', text: '{}' });
        }
        return m.busy === null && !(m.execution.pending ?? []).length;
      },
      30000,
      'конец хода агента',
    );
    assert.equal((await s.api('POST', `/api/manual/${id}/command`, { name: 'capture' })).status, 200);
    const cmd = await until(async () => (await get()).execution.events.find((e: any) => e.type === 'command' && e.name === 'capture'), 20000, 'capture');
    assert.equal(cmd.text, `/case-capture request_ref=${taskId} category=Карты / Блокировка`);
  } finally {
    await s.close();
  }
});
