import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  testConfig, installFetch, sseReply, openAiChunks, sessionCookie, seedSession, envFromConfig, assetsFetcher, TEST_SCOPES,
} from './helpers/fake-services.mjs';
import {open} from '../server/demo/crypto.mjs';
import {kvGetJson} from '../server/demo/kv.mjs';

let mock = null;
afterEach(() => { mock?.restore(); mock = null; });

test('testConfig has the fixed test endpoints and accepts overrides', () => {
  const cfg = testConfig();
  assert.equal(cfg.memoryBase, 'https://memory.test');
  assert.equal(cfg.accountBase, 'https://account.test');
  assert.equal(cfg.rsiBase, 'https://rsi.test/api');
  assert.equal(cfg.llmBase, 'https://llm.test/v1');
  assert.equal(cfg.llmModel, 'test-model');
  assert.equal(cfg.scopes, 'openid email offline_access memory.read memory.write memory.document.upload vu.manage rsi.read rsi.write llm.invoke');
  assert.equal(cfg.scopes, TEST_SCOPES);
  assert.equal(cfg.clientId, null);
  assert.equal(cfg.secret, 'test-secret-0123456789abcdef0123456789abcdef');
  assert.equal(typeof cfg.kv.get, 'function');
  assert.equal(testConfig({llmModel: 'other'}).llmModel, 'other');
  assert.notEqual(testConfig().kv, testConfig().kv);
  assert.deepEqual([cfg.oauthBase, cfg.oauthResource, cfg.memoryViaGateway], ['https://account.test', 'https://memory.test/mcp/', false]);
  const moved = testConfig({memoryBase: 'https://m.test', accountBase: 'https://a.test'});
  assert.deepEqual([moved.oauthBase, moved.oauthResource], ['https://a.test', 'https://m.test/mcp/']);
  assert.equal(testConfig({oauthResource: 'https://r.test/mcp'}).oauthResource, 'https://r.test/mcp');
});

test('installFetch matches exact URLs without query, RegExps on the full URL, and records calls', async () => {
  const original = globalThis.fetch;
  mock = installFetch([
    {method: 'GET', url: 'https://memory.test/memory/items', reply: () => ({sources: []})},
    {method: 'POST', url: /^https:\/\/rsi\.test\/api\/executions$/, reply: async (req) => new Response(await req.text(), {status: 201})},
  ]);
  const a = await fetch('https://memory.test/memory/items?limit=5', {headers: {Authorization: 'Bearer t'}});
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), {sources: []});
  const b = await fetch('https://rsi.test/api/executions', {method: 'POST', body: '{"x":1}'});
  assert.equal(b.status, 201);
  assert.equal(await b.text(), '{"x":1}');
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].method, 'GET');
  assert.equal(mock.calls[0].url, 'https://memory.test/memory/items?limit=5');
  assert.equal(mock.calls[0].headers.get('authorization'), 'Bearer t');
  assert.equal(mock.calls[0].body, null);
  assert.equal(mock.calls[1].body, '{"x":1}');
  await assert.rejects(fetch('https://rsi.test/api/executions?x=1', {method: 'POST', body: '{}'}), /unexpected fetch POST https:\/\/rsi\.test\/api\/executions\?x=1/);
  await assert.rejects(fetch('https://memory.test/memory/items', {method: 'DELETE'}), {message: 'unexpected fetch DELETE https://memory.test/memory/items'});
  assert.deepEqual(mock.unmatched, ['unexpected fetch POST https://rsi.test/api/executions?x=1', 'unexpected fetch DELETE https://memory.test/memory/items']);
  mock.restore();
  mock = null;
  assert.equal(globalThis.fetch, original);
});

test('installFetch records multipart bodies as text', async () => {
  mock = installFetch([{method: 'POST', url: 'https://memory.test/v1/document/upload', reply: () => ({ok: true})}]);
  const form = new FormData();
  form.append('file', new Blob([new TextEncoder().encode('hello')], {type: 'application/pdf'}), 'a.pdf');
  await fetch('https://memory.test/v1/document/upload', {method: 'POST', body: form});
  assert.match(mock.calls[0].headers.get('content-type'), /^multipart\/form-data; boundary=/);
  assert.match(mock.calls[0].body, /name="file"; filename="a\.pdf"/);
  assert.match(mock.calls[0].body, /hello/);
});

test('sseReply streams data lines in small chunks and ends with [DONE]', async () => {
  const res = sseReply([{type: 'phase', text: '读 BP'}, {n: 2}]);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  let chunks = 0;
  const parts = [];
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    chunks += 1;
    assert.ok(value.byteLength <= 17);
    parts.push(value);
  }
  assert.ok(chunks > 3);
  const text = new TextDecoder().decode(Buffer.concat(parts));
  assert.equal(text, 'data: {"type":"phase","text":"读 BP"}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n');
  assert.equal(await sseReply([{a: 1}], {done: false}).text(), 'data: {"a":1}\n\n');
});

test('openAiChunks splits reasoning, content and interleaved tool-call arguments and reassembles', () => {
  const calls = [
    {id: 'call_1', name: 'memory_recall', arguments: '{"query": "谁是固态电池专家？"}'},
    {id: 'call_2', name: 'memory_recall', arguments: '{"query": "锂境科技的融资方"}'},
  ];
  const chunks = openAiChunks({content: '最终报告内容', reasoning: '先想一想再回答', toolCalls: calls});
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
  const last = chunks.at(-1);
  assert.deepEqual(last.choices, []);
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'tool_calls');
  const deltas = chunks.flatMap((c) => c.choices.map((ch) => ch.delta));
  assert.equal(deltas.map((d) => d.content ?? '').join(''), '最终报告内容');
  assert.equal(deltas.map((d) => d.reasoning_content ?? '').join(''), '先想一想再回答');
  assert.ok(deltas.filter((d) => d.content).length >= 3);
  const toolDeltas = deltas.flatMap((d) => d.tool_calls ?? []);
  assert.deepEqual(toolDeltas.map((t) => t.index), [0, 1, 0, 1, 0, 1]);
  for (const [index, call] of calls.entries()) {
    const mine = toolDeltas.filter((t) => t.index === index);
    assert.equal(mine[0].id, call.id);
    assert.equal(mine[0].function.name, call.name);
    assert.ok(mine.length >= 2);
    assert.notEqual(mine[0].function.arguments, call.arguments);
    assert.equal(mine.map((t) => t.function.arguments).join(''), call.arguments);
  }
  assert.equal(openAiChunks({content: 'hi'}).at(-2).choices[0].finish_reason, 'stop');
});

test('sessionCookie formats the demo cookie', () => {
  assert.equal(sessionCookie('abc'), 'cs_demo=abc');
});

test('seedSession stores a sealed Session under sess:<sid>', async () => {
  const cfg = testConfig();
  const sid = await seedSession(cfg, {sid: 's1', accessToken: 'at', accountId: 'acct_1', email: 'a@b.c', expiresAt: 123});
  assert.equal(sid, 's1');
  const sealed = await kvGetJson(cfg.kv, 'sess:s1');
  assert.equal(typeof sealed, 'string');
  const session = await open(cfg.secret, sealed);
  assert.equal(session.accessToken, 'at');
  assert.equal(session.accountId, 'acct_1');
  assert.equal(session.email, 'a@b.c');
  assert.equal(session.expiresAt, 123);
  assert.equal(session.refreshToken, 'rt-test');
  assert.equal(session.clientId, 'client-test');
  assert.equal(typeof session.createdAt, 'number');
  assert.equal(await seedSession(cfg), 'sid-test');
});

test('envFromConfig maps Config to DEMO_* bindings and applies extra', async () => {
  const cfg = testConfig();
  const env = envFromConfig(cfg, {EXTRA: 'x'});
  assert.equal(env.DEMO_KV, cfg.kv);
  assert.equal(env.DEMO_MEMORY_BASE, 'https://memory.test');
  assert.equal(env.DEMO_ACCOUNT_BASE, 'https://account.test');
  assert.equal(env.DEMO_RSI_BASE, 'https://rsi.test/api');
  assert.equal(env.DEMO_LLM_BASE, 'https://llm.test/v1');
  assert.equal(env.DEMO_LLM_MODEL, 'test-model');
  assert.equal(env.DEMO_OAUTH_SCOPES, TEST_SCOPES);
  assert.equal(env.DEMO_SESSION_SECRET, cfg.secret);
  assert.equal('DEMO_OAUTH_CLIENT_ID' in env, false);
  assert.equal(env.EXTRA, 'x');
  assert.equal(envFromConfig(testConfig({clientId: 'cid'})).DEMO_OAUTH_CLIENT_ID, 'cid');
  for (const name of ['DEMO_OAUTH_BASE', 'DEMO_OAUTH_RESOURCE', 'DEMO_MEMORY_VIA_GATEWAY']) assert.equal(name in env, false, name);
  const gateway = envFromConfig(testConfig({oauthBase: 'https://oauth.test', oauthResource: 'https://rsi.test/mcp', memoryViaGateway: true}));
  assert.deepEqual([gateway.DEMO_OAUTH_BASE, gateway.DEMO_OAUTH_RESOURCE, gateway.DEMO_MEMORY_VIA_GATEWAY], ['https://oauth.test', 'https://rsi.test/mcp', 'true']);
  const missing = await env.ASSETS.fetch('https://cosens.test/demo/assets/investor/does-not-exist.json');
  assert.equal(missing.status, 404);
  const custom = {fetch: async () => new Response('x')};
  assert.equal(envFromConfig(cfg, {ASSETS: custom}).ASSETS, custom);
});

test('assetsFetcher serves files under root, strips /demo, refuses traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-assets-'));
  try {
    await mkdir(join(root, 'assets', 'investor'), {recursive: true});
    await writeFile(join(root, 'assets', 'investor', 'manifest.json'), '{"groups":[]}');
    await writeFile(join(root, 'assets', 'investor', '微信联系人.md'), '# 联系人');
    const assets = assetsFetcher(root);
    const manifest = await assets.fetch('https://cosens.test/demo/assets/investor/manifest.json');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await manifest.json(), {groups: []});
    const md = await assets.fetch(new Request(`https://cosens.test/demo/assets/investor/${encodeURIComponent('微信联系人.md')}`));
    assert.equal(md.status, 200);
    assert.equal(await md.text(), '# 联系人');
    assert.equal((await assets.fetch('https://cosens.test/assets/investor/manifest.json')).status, 200);
    assert.equal((await assets.fetch('https://cosens.test/demo/..%2F..%2F..%2Fetc%2Fpasswd')).status, 404);
    assert.equal((await assets.fetch('https://cosens.test/demo/assets/investor')).status, 404);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
