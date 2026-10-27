// GigaChat API v1 и v2: формат запроса по OpenAPI, разбор ответа, клиентский сертификат и вызов без него (http внутри Istio),
// ошибки сертификатов, проверка файлов моделей и прогон, где оператор и оценка работают через GigaChat.
// Тесты с сертификатами без openssl пропускаются.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvider, modelAuth, modelReadiness, LlmError, type LlmRequest } from '../src/llm/provider.js';
import { structuredCall } from '../src/llm/structured.js';
import { JUDGE_SCHEMA } from '../src/operator/prompts.js';
import { loadRegistry } from '../src/config/loader.js';
import type { ModelDef, ModelTls } from '../src/config/types.js';
import { startFakeGigaChat, type FakeGigaChat } from '../dev/fake-gigachat/server.js';
import { makePki, PASSPHRASE, type Pki } from './pki.js';
import { startStand, CONFIG } from './helpers.js';

// Сертификаты создаются при загрузке модуля: от них зависит, пропускать ли тесты.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-gigachat-'));
const pki: Pki | null = makePki(dir);
const skip = pki ? false : 'нет openssl: тестовые сертификаты не созданы';
let gc: FakeGigaChat;

before(async () => {
  if (pki) gc = await startFakeGigaChat({ tls: { cert: fs.readFileSync(pki.serverCert), key: fs.readFileSync(pki.serverKey), ca: fs.readFileSync(pki.ca) } });
});
after(async () => {
  await gc?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function model(provider: 'gigachat-v1' | 'gigachat-v2', tls: Partial<ModelTls> = {}, extra: Partial<ModelDef> = {}): ModelDef {
  return {
    id: 'gc',
    title: 'gc',
    roles: ['judge'],
    provider,
    baseUrl: gc.url,
    path: null,
    apiKey: null,
    model: 'GigaChat-2-Max',
    headers: {},
    tls: { cert: pki!.clientCert, key: pki!.clientKey, pfx: null, passphrase: null, ca: pki!.ca, ...tls },
    params: { temperature: 0.01, maxTokens: 500, retries: 0, timeoutMs: 10_000 },
    description: '',
    source: { file: 'models/gc.yaml', hash: '', text: '' },
    ...extra,
  };
}

// Контекст судьи в том виде, в каком его понимает dev/fake-gigachat.
const judgeReq: LlmRequest = {
  system: 'Оценка (подсказка judge-v1)',
  user: '```json\n' + JSON.stringify({ reference: { criteria: [{ id: 'c1', text: 'Называет причину', hint: 'PIN' }] }, result: { agentMessages: [{ seq: 3, text: 'Карта заблокирована из-за неверного PIN' }] } }) + '\n```',
  schema: JUDGE_SCHEMA as any,
  schemaName: 'judge',
};

async function failure(m: ModelDef): Promise<LlmError> {
  try {
    await createProvider(m, {}).complete(judgeReq);
  } catch (e) {
    assert.ok(e instanceof LlmError, String(e));
    return e;
  }
  assert.fail('вызов должен был завершиться ошибкой');
}

test('GigaChat v1 и v2: запрос по OpenAPI, клиентский сертификат, разбор ответа', { skip }, async () => {
  gc.requests.length = 0;
  for (const provider of ['gigachat-v1', 'gigachat-v2'] as const) {
    const r = await structuredCall<any>(createProvider(model(provider), {}), judgeReq, () => []);
    assert.equal(r.value.criteria[0].passed, true, provider);
    assert.equal(r.model, 'GigaChat-2-Max:2.0.28.2');
    assert.ok(r.usage && r.usage.input! > 0 && r.usage.output! > 0, 'токены из usage');
  }
  const [v1, v2] = gc.requests;
  assert.equal(v1.path, '/v1/chat/completions');
  assert.equal(v2.path, '/v2/chat/completions');
  for (const x of [v1, v2]) {
    assert.equal(x.client, 'clawgym-test-client', 'вызов подписан клиентским сертификатом');
    assert.match(x.requestId ?? '', /^[0-9a-f-]{36}$/, 'X-Request-ID для поиска в журналах GigaChat');
  }
  assert.deepEqual(
    v1.body.messages.map((m: any) => [m.role, typeof m.content]),
    [
      ['system', 'string'],
      ['user', 'string'],
    ],
  );
  assert.deepEqual(v1.body.response_format, { type: 'json_schema', schema: JUDGE_SCHEMA, strict: true });
  assert.equal(v1.body.temperature, 0.01);
  assert.equal(v1.body.max_tokens, 500);
  assert.deepEqual(v2.body.messages[0], { role: 'system', content: [{ text: judgeReq.system }] });
  assert.deepEqual(v2.body.model_options, { temperature: 0.01, max_tokens: 500, response_format: { type: 'json_schema', schema: JUDGE_SCHEMA, strict: true } });
  assert.equal(v2.body.temperature, undefined, 'в v2 параметры — внутри model_options');
});

test('GigaChat: зашифрованный ключ, PKCS#12, отказ фильтра и обрезка ответа', { skip }, async () => {
  const ok = await createProvider(model('gigachat-v1', { key: pki!.clientKeyEnc, passphrase: PASSPHRASE }), {}).complete(judgeReq);
  assert.match(ok.text, /criteria/);
  if (pki!.clientPfx) {
    const p = await createProvider(model('gigachat-v2', { cert: null, key: null, pfx: pki!.clientPfx, passphrase: PASSPHRASE }), {}).complete(judgeReq);
    assert.match(p.text, /criteria/);
  }
  const blocked = await failure(model('gigachat-v2', {}, { model: 'GigaChat-blacklist' }));
  assert.equal(blocked.kind, 'refusal');
  assert.match(blocked.message, /response_blacklist/);
  assert.equal((await failure(model('gigachat-v1', {}, { model: 'GigaChat-length' }))).kind, 'truncated');
  // Нарушение схемы запроса GigaChat возвращает 422; такой ответ не повторяется.
  const bad = await failure(model('gigachat-v1', {}, { params: { temperature: 0, retries: 2, timeoutMs: 10_000 } }));
  assert.equal(bad.status, 422);
  assert.match(bad.message, /temperature/);
});

test('GigaChat: ошибки сертификата объясняют, что исправить', { skip }, async () => {
  const noCa = await failure(model('gigachat-v1', { ca: null }));
  assert.equal(noCa.kind, 'network');
  assert.match(noCa.message, /tls\.ca/);
  const noCert = await failure({ ...model('gigachat-v1'), tls: { cert: null, key: null, pfx: null, passphrase: null, ca: pki!.ca } });
  assert.match(noCert.message, /не принял клиентский сертификат/);
  const stranger = await failure(model('gigachat-v1', { cert: pki!.strangerCert, key: pki!.strangerKey }));
  assert.match(stranger.message, /не принял клиентский сертификат/);
  const mismatch = await failure(model('gigachat-v1', { key: pki!.strangerKey }));
  assert.equal(mismatch.kind, 'config');
  assert.match(mismatch.message, /не подходит к сертификату/);
  const wrongPass = await failure(model('gigachat-v1', { key: pki!.clientKeyEnc, passphrase: 'wrong' }));
  assert.equal(wrongPass.kind, 'config');
  assert.match(wrongPass.message, /tls\.passphrase/);
  const absent = model('gigachat-v1', { cert: path.join(dir, 'absent.crt') });
  assert.match(modelReadiness(absent, {}) ?? '', /нет файлов сертификата: tls\.cert/);
  const noFile = await failure(absent);
  assert.equal(noFile.kind, 'config');
  // Адрес и файлы из окружения: без переменных модель не готова и не вызывается.
  const fromEnv = model('gigachat-v2', { cert: '${env:GC_CERT}', key: '${env:GC_KEY}' }, { baseUrl: '${env:GC_URL}' });
  assert.match(modelReadiness(fromEnv, {}) ?? '', /не заданы переменные окружения: GC_CERT, GC_KEY, GC_URL|GC_URL, GC_CERT, GC_KEY/);
  assert.equal(modelReadiness(fromEnv, { GC_URL: gc.url, GC_CERT: pki!.clientCert, GC_KEY: pki!.clientKey }), null);
});

test('GigaChat без сертификата: http-адрес внутри Istio — вызов как есть, сертификат по http отклоняется', async () => {
  const plain = await startFakeGigaChat();
  try {
    const reg = await loadRegistry(CONFIG);
    const env = { GIGACHAT_BASE_URL: plain.url };
    for (const id of ['op-gigachat', 'judge-gigachat']) {
      const m = reg.models.get(id)!;
      assert.equal(modelReadiness(m, env), null, `${id}: достаточно http-адреса`);
      assert.match(modelAuth(m, env) ?? '', /без сертификата: http/);
      const r = await createProvider({ ...m, params: { ...m.params, retries: 0 } }, env).complete(judgeReq);
      assert.match(r.text, /criteria/);
    }
    assert.deepEqual(
      plain.requests.map((x) => [x.path, x.client]),
      [
        ['/v1/chat/completions', null],
        ['/v2/chat/completions', null],
      ],
    );
    // Сертификат по http не передаётся: это ошибка настройки, а не тихий отказ от mTLS.
    const op = reg.models.get('op-gigachat')!;
    const withCert = { ...env, GIGACHAT_CERT_FILE: '/certs/client.crt', GIGACHAT_KEY_FILE: '/certs/client.key' };
    assert.match(modelReadiness(op, withCert) ?? '', /только по https.*Istio/);
    await assert.rejects(createProvider(op, withCert).complete(judgeReq), (e: any) => e instanceof LlmError && e.kind === 'config');
    assert.match(modelReadiness(op, { ...env, GIGACHAT_CERT_FILE: '/certs/client.crt' }) ?? '', /нужны оба файла/);
    assert.match(modelReadiness(op, {}) ?? '', /^не заданы переменные окружения: GIGACHAT_BASE_URL$/);
  } finally {
    await plain.close();
  }
});

test('файлы моделей GigaChat: сертификат необязателен, но задаётся целиком; ограничения параметров', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-gc-cfg-'));
  for (const d of ['contracts', 'cases', 'solutions', 'agents', 'models', 'metrics', 'templates', 'baskets', 'runs']) {
    fs.cpSync(path.join(CONFIG, d), path.join(home, d), { recursive: true });
  }
  const w = (name: string, text: string) => fs.writeFileSync(path.join(home, 'models', `${name}.yaml`), text);
  w('gc-no-tls', 'id: gc-no-tls\nroles: [judge]\nprovider: gigachat-v1\nbaseUrl: https://gc.local/api\nmodel: GigaChat\n');
  w('gc-istio', 'id: gc-istio\nroles: [judge]\nprovider: gigachat-v2\nbaseUrl: http://gigachat.ai.svc.cluster.local/api\nmodel: GigaChat\n');
  w('gc-ca-only', 'id: gc-ca-only\nroles: [judge]\nprovider: gigachat-v1\nbaseUrl: https://gc.local/api\nmodel: GigaChat\ntls:\n  ca: /etc/ssl/russian-trusted-root.crt\n');
  w('gc-zero', 'id: gc-zero\nroles: [judge]\nprovider: gigachat-v2\nbaseUrl: https://gc.local/api\nmodel: GigaChat\ntls:\n  pfx: /x.p12\nparams:\n  temperature: 0\n');
  w('gc-json-object', 'id: gc-json-object\nroles: [judge]\nprovider: gigachat-v1\nbaseUrl: https://gc.local/api\nmodel: GigaChat\nparams:\n  responseFormat: json_object\n');
  w('openai', 'id: openai\nroles: [judge]\nprovider: openai-compatible\nbaseUrl: https://llm.local/v1\nmodel: m\n');
  w('gc-half', 'id: gc-half\nroles: [judge]\nprovider: gigachat-v1\nbaseUrl: http://gc.local/api\nmodel: GigaChat\ntls:\n  cert: /x.crt\n  passphrase: secret\n');
  try {
    const reg = await loadRegistry(home);
    const issues = (id: string) => reg.issues.filter((i) => i.file === `models/${id}.yaml`).map((i) => `${i.severity} ${i.field}: ${i.reason}`);
    for (const id of ['gc-no-tls', 'gc-istio', 'gc-ca-only']) assert.deepEqual(issues(id), [], `${id}: сертификат необязателен`);
    assert.ok(issues('gc-zero').some((x) => x.startsWith('error params.temperature')));
    assert.ok(issues('gc-json-object').some((x) => x.startsWith('error') && /responseFormat/.test(x)), 'GigaChat: только json_schema или none');
    assert.ok(issues('openai').some((x) => x.startsWith('error') && /provider/.test(x)), 'провайдеры OpenAI и Anthropic убраны');
    assert.ok(issues('gc-half').some((x) => x.startsWith('error tls.key')));
    assert.ok(issues('gc-half').some((x) => x.startsWith('error baseUrl') && /https/.test(x)));
    assert.ok(issues('gc-half').some((x) => x.startsWith('warning tls.passphrase')));
    assert.deepEqual(issues('op-gigachat'), [], 'пример из репозитория проходит проверку');
    assert.deepEqual(issues('judge-gigachat'), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('журнал HTTP вызовов LLM: каждая попытка — обмен «llm», токен и заголовки из окружения скрыты, переспрос формата подписан', async () => {
  const plain = await startFakeGigaChat();
  try {
    const reg = await loadRegistry(CONFIG);
    const base = reg.models.get('judge-gigachat')!;
    const env = { GIGACHAT_BASE_URL: plain.url, GC_CLIENT_ID: 'client-777' };
    const seen: any[] = [];
    const onExchange: LlmRequest['onExchange'] = (x, phase) => {
      if (phase === 'end') seen.push(x);
    };
    const m: ModelDef = { ...base, apiKey: 'tok-123456', headers: { 'X-Client-ID': '${env:GC_CLIENT_ID}' }, params: { ...base.params, retries: 0 } };
    await createProvider(m, env).complete({ ...judgeReq, label: 'LLM-оценка · проба', onExchange });
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].kind, seen[0].label, seen[0].response.status], ['llm', 'LLM-оценка · проба', 200]);
    assert.match(seen[0].request.url, /\/v2\/chat\/completions$/);
    assert.equal(JSON.parse(seen[0].request.body).model, 'GigaChat-2-Max', 'тело запроса — как ушло в модель');
    const dump = JSON.stringify(seen[0]);
    assert.ok(!dump.includes('tok-123456') && !dump.includes('client-777'), 'токен и заголовок из окружения скрыты');
    // Ответ не JSON: переспрос формата — второй обмен со своей подписью.
    seen.length = 0;
    const bad: ModelDef = { ...m, headers: { 'X-Fake-Fail': 'format' } };
    await assert.rejects(structuredCall(createProvider(bad, env), { ...judgeReq, label: 'LLM-оценка · проба', onExchange }, () => [], 1));
    assert.deepEqual(
      seen.map((x) => x.label),
      ['LLM-оценка · проба', 'LLM-оценка · проба · переспрос формата'],
    );
  } finally {
    await plain.close();
  }
});

test('прогон: оператор на GigaChat v1, оценка на GigaChat v2 — те же итоги, что на заглушке без сертификата', { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawgym-gc-home-'));
  for (const d of ['contracts', 'cases', 'solutions', 'agents', 'models', 'metrics', 'templates', 'baskets', 'runs']) {
    fs.cpSync(path.join(CONFIG, d), path.join(home, d), { recursive: true });
  }
  const tls = 'tls:\n  cert: ${env:GC_CERT}\n  key: ${env:GC_KEY}\n  ca: ${env:GC_CA}\n';
  fs.writeFileSync(path.join(home, 'models/gc-operator.yaml'), `id: gc-operator\nroles: [operator]\nprovider: gigachat-v1\nbaseUrl: \${env:GC_URL}\nmodel: GigaChat-2-Max\n${tls}params:\n  temperature: 0.3\n  retries: 0\n  devHints: true\n`);
  fs.writeFileSync(path.join(home, 'models/gc-judge.yaml'), `id: gc-judge\nroles: [judge]\nprovider: gigachat-v2\nbaseUrl: \${env:GC_URL}\nmodel: GigaChat-2-Max\n${tls}params:\n  temperature: 0.01\n  retries: 0\n  devHints: true\n`);
  fs.writeFileSync(
    path.join(home, 'runs/gc-check.yaml'),
    'id: gc-check\ntitle: Проверка · вторая линия · GigaChat\nbasket: second-line-check\nagent: fake-agent\nmodels:\n  operator: gc-operator\n  judge: gc-judge\nmetrics: all\n',
  );
  const s = await startStand({ CLAWGYM_CONFIG: home, GC_URL: gc.url, GC_CERT: pki!.clientCert, GC_KEY: pki!.clientKey, GC_CA: pki!.ca });
  try {
    gc.requests.length = 0;
    const created = await s.api('POST', '/api/runs', { config: 'gc-check' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const viaGc = await s.waitRun(created.data.id);
    const viaFake = await s.waitRun((await s.api('POST', '/api/runs', { config: 'demo-check' })).data.id);
    for (const r of [viaGc, viaFake]) assert.equal(r.status, 'completed', r.error ?? '');
    const outcomes = (r: any) => r.lines[0].items.filter((i: any) => i.kind === 'case').map((i: any) => [i.pos, i.outcome, i.steps.judge?.status]);
    assert.deepEqual(outcomes(viaGc), outcomes(viaFake));
    assert.ok(outcomes(viaGc).every(([, , judge]: any) => judge === 'ok'), 'оценка получена у всех кейсов');
    assert.equal(viaGc.settings.operator.provider, 'gigachat-v1');
    assert.equal(viaGc.settings.judge.provider, 'gigachat-v2');
    const paths = new Set(gc.requests.map((x) => x.path));
    assert.deepEqual([...paths].sort(), ['/v1/chat/completions', '/v2/chat/completions']);
    assert.ok(gc.requests.every((x) => x.client === 'clawgym-test-client'));
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
