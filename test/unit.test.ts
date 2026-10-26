// Модульные тесты: заглушки, шаблоны, JSONPath, строки результата команд, план команд, проверка ссылок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StubState, matchStub, renderResponse, condMatches } from '../src/stubs/engine.js';
import type { BasketDef, StubDef } from '../src/config/types.js';
import { renderLines, renderValue } from '../src/util/template.js';
import { queryPath, setPath } from '../src/util/jsonpath.js';
import { parseCapture, parseCurator } from '../src/agent/commands.js';
import { buildPlan } from '../src/runner/plan.js';
import { loadRegistry } from '../src/config/loader.js';
import { resolveRun } from '../src/runner/resolve.js';
import { loadEnv } from '../src/env.js';
import { checkAllowedHost } from '../src/agent/client.js';
import { HOME } from './helpers.js';
import { BODY_LIMIT, clip, maskedHeaders, startExchange } from '../src/util/httplog.js';
import { maskHeaders } from '../src/util/core.js';

const stub = (s: Partial<StubDef>, index: number): StubDef => ({ id: `s${index}`, tool: 't', origin: 'case', index, ...s });

test('заглушка: побеждает более точное условие, при равенстве — первая', () => {
  const list = [stub({ result: { json: 1 } }, 0), stub({ when: { card: '1' }, result: { json: 2 } }, 1), stub({ when: { card: '1', kind: { regex: '^v' } }, result: { json: 3 } }, 2)];
  assert.equal(matchStub(list, undefined, { card: '1', kind: 'visa' })?.stub.id, 's2');
  assert.equal(matchStub(list, undefined, { card: '1', kind: 'mir' })?.stub.id, 's1');
  assert.equal(matchStub(list, undefined, { card: '2' })?.stub.id, 's0');
  assert.equal(matchStub([], [stub({ result: { text: 'd' } }, 0)], {})?.stub.id, 's0', 'затем умолчания контракта');
  assert.equal(matchStub([stub({ when: { a: 1 }, result: { text: 'x' } }, 0)], undefined, { a: 2 }), null);
  assert.ok(condMatches(5, '5'), 'скаляры сравниваются как строки');
  assert.ok(condMatches('b', { in: ['a', 'b'] }));
  assert.ok(condMatches(undefined, { exists: false }));
});

test('заглушка: последовательность, эффект и состояние выполнения', () => {
  const s = stub({ sequence: [{ result: { json: { status: '{{state.card}}' } }, effect: { card: 'active' } }, { error: 'already_active' }] }, 0);
  const st = new StubState({ card: 'blocked' });
  const ctx = () => ({ state: st.state, args: {} });
  const r1 = renderResponse(st.next(s).response, ctx(), st);
  assert.deepEqual(r1.value, { status: 'blocked' });
  assert.equal(st.state.card, 'active');
  const r2 = renderResponse(st.next(s).response, ctx(), st);
  assert.equal(r2.isError, true);
  const r3 = renderResponse(st.next(s).response, ctx(), st);
  assert.equal(r3.isError, true, 'последний ответ повторяется');
  const other = new StubState({ card: 'blocked' });
  assert.equal(other.state.card, 'blocked', 'состояние одного выполнения не влияет на другое');
});

test('шаблоны: тип значения сохраняется, пустые строки стартового сообщения выпадают', () => {
  assert.equal(renderValue('{{args.n}}', { args: { n: 7 } }), 7);
  assert.equal(renderValue('n={{args.n}}', { args: { n: 7 } }), 'n=7');
  assert.equal(renderLines('Тематика: {{case.topic}}\nКарта: {{start.card}}', { case: { topic: 'Карты' }, start: {} }), 'Тематика: Карты');
});

test('JSONPath: чтение с [*] и запись по пути', () => {
  const o = { result: { parts: [{ text: 'a' }, { text: 'b' }] } };
  assert.deepEqual(queryPath(o, '$.result.parts[*].text'), ['a', 'b']);
  const b: any = {};
  setPath(b, '$.params.metadata.model', 'x');
  assert.equal(b.params.metadata.model, 'x');
});

test('строки результата capture и curator ищутся по всему ответу с обёртками', () => {
  const c = parseCapture('Сохраняю.\n`Case captured: learning/cases/pending/a.md — signal: strong`\nГотово');
  assert.deepEqual([c.kind, (c as any).path, (c as any).signal], ['captured', 'learning/cases/pending/a.md', 'strong']);
  assert.equal(parseCapture('«Case capture skipped: нет обращения»').kind, 'skipped');
  assert.equal(parseCapture('Case capture failed: pii').kind, 'failed');
  assert.equal(parseCapture('Готово').kind, 'unrecognized');
  const u = parseCurator('**Curator complete: 3 processed, ? left, 1 updated, 0 routing fixes, 2 created, 0 conflicts. Report: r.md**');
  assert.equal(u.kind, 'complete');
  assert.equal((u as any).left, null);
  assert.equal(parseCurator('No pending cases.').kind, 'empty');
});

test('план команд: curator каждые 2 и финальный проход неполной пачки; в проверке curator нет', () => {
  const items = [1, 2, 3, 4, 5].map((i) => ({ kind: 'solution' as const, index: i - 1, solution: `s${i}`, limits: {}, note: '' }));
  const b: BasketDef = { id: 'b', title: 'b', type: 'training', description: '', curator: { enabled: true, every: 2, final: true, resetBefore: true }, checking: { confirmations: 'approve' }, items, source: { file: 'b', hash: '', text: '' } };
  const passes = buildPlan(b).filter((s) => s.kind === 'curator') as any[];
  assert.deepEqual(passes.map((p) => [p.afterPos, p.reason]), [
    [2, 'every'],
    [4, 'every'],
    [5, 'final'],
  ]);
  const plan = buildPlan({ ...b, type: 'checking', curator: { ...b.curator, enabled: false } });
  assert.ok(plan.every((s) => s.kind === 'case' && !s.capture));
});

test('белый список хостов агента', () => {
  assert.equal(checkAllowedHost('http://127.0.0.1:8091/a', ['127.0.0.1']), null);
  assert.match(checkAllowedHost('https://prod.bank/a', ['stand.local']) ?? '', /не входит/);
  assert.equal(checkAllowedHost('https://a.stand.local/x', ['.stand.local']), null);
});

test('битая ссылка в корзине: ошибка с файлом и полем, прогон не запускается', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-cfg-'));
  for (const d of ['contracts', 'cases', 'solutions', 'agents', 'models', 'skillsets', 'metrics', 'templates', 'data']) {
    fs.cpSync(path.join(HOME, d), path.join(home, d), { recursive: true });
  }
  fs.mkdirSync(path.join(home, 'baskets'));
  fs.mkdirSync(path.join(home, 'runs'));
  fs.writeFileSync(path.join(home, 'baskets/broken.yaml'), 'id: broken\ntitle: Битая\ntype: training\nitems:\n  - solution: card-blocked-wrong-pin/explain-now\n  - solution: transfer-delay/explain-on-ask\n');
  fs.writeFileSync(path.join(home, 'runs/broken.yaml'), 'id: broken\nbasket: broken\nagent: fake-agent\nmodels: { agent: fake-agent-a, operator: fake-operator, judge: fake-judge }\nskillset: { id: cards, version: V1 }\n');
  try {
    const reg = await loadRegistry(home, path.join(home, 'var'));
    const issue = reg.issues.find((i) => i.file === 'baskets/broken.yaml' && i.severity === 'error');
    assert.ok(issue);
    assert.equal(issue!.field, 'items[1].solution');
    assert.match(issue!.reason, /transfer-delay\/explain-on-ask/);
    const p = resolveRun(reg, loadEnv({ CLAWGYM_HOME: home }, home), 'broken');
    assert.equal(p.ok, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('журнал HTTP: авторизация скрыта, большое тело обрезается', () => {
  const h = maskedHeaders({ Authorization: 'Bearer secret-token-123', 'x-task-id': 'cg-1', 'Set-Cookie': 'sid=abcdef123456', 'X-Gateway-Token': 'gw-secret-777', 'X-Gateway-Key': 'gw-key-888888', 'Mcp-Session-Id': 'abc-session-42' });
  assert.equal(h['x-task-id'], 'cg-1');
  assert.equal(h['mcp-session-id'], 'abc-session-42');
  assert.ok(!h.authorization.includes('secret-token-123'));
  assert.ok(!h['set-cookie'].includes('abcdef123456'));
  assert.ok(!h['x-gateway-token'].includes('gw-secret-777') && !h['x-gateway-key'].includes('gw-key-888888'));
  // Значение из окружения скрывается при любом имени заголовка.
  assert.ok(!maskHeaders({ 'X-Tenant': 'tenant-from-env-1' }, ['X-Tenant'])['X-Tenant'].includes('tenant-from-env-1'));
  const x = startExchange('agent', 't', { method: 'POST', url: 'https://user:pa55word@stand.local/a2a?api_key=k-123456789&lang=ru', headers: {}, body: '{}' });
  assert.ok(!x.request.url.includes('pa55word') && !x.request.url.includes('k-123456789') && x.request.url.includes('lang=ru'));
  assert.equal(startExchange('mcp', 't', { method: 'POST', url: '/mcp', headers: {}, body: '' }).request.url, '/mcp');
  for (const ch of ['я', '€', '😀']) {
    const big = clip(ch.repeat(BODY_LIMIT));
    assert.equal(big.truncated, true);
    assert.ok(Buffer.byteLength(big.body) <= BODY_LIMIT && !big.body.endsWith('\uFFFD'));
  }
  assert.equal(clip('{}').truncated, false);
});
