import {test} from 'node:test';
import assert from 'node:assert/strict';
import {envFromConfig, installFetch, openAiChunks, seedSession, sessionCookie, sseReply, testConfig} from './helpers/fake-services.mjs';
import {kvGetJson, kvPutJson} from '../server/demo/kv.mjs';
import {analysisKey} from '../server/demo/investor/analyze.mjs';
import {onRequest as apiMiddleware} from '../functions/api/demo/_middleware.js';
import * as runsRoute from '../functions/api/demo/investor/runs/index.js';
import * as runRoute from '../functions/api/demo/investor/runs/[id]/index.js';
import * as filesRoute from '../functions/api/demo/investor/runs/[id]/files.js';
import * as methodRoute from '../functions/api/demo/investor/runs/[id]/method.js';
import * as analyzeRoute from '../functions/api/demo/investor/runs/[id]/analyze.js';
import * as analysisRoute from '../functions/api/demo/investor/runs/[id]/analysis.js';
import {addScrubTerms} from '../server/demo/scrub.mjs';

// The names a deployment would list in DEMO_PRIVATE_NAMES.
addScrubTerms(['acme', 'globex']);

const ORIGIN = 'https://cosens.ai';
const ACCOUNT = 'acct_test';
const VU = 'vu_0123456789abcdef0123456789abcdef';
const NEW_VU = 'vu_fedcba9876543210fedcba9876543210';
const MiB = 1024 * 1024;
/** Run ids must match runs.mjs /^run_[A-Za-z0-9_-]{16}$/, or getRun treats them as unknown. */
const rid = tag => `run_${tag.padEnd(16, '0')}`;
const LLM_URL = 'https://llm.test/v1/chat/completions';
const RSI_EXECUTIONS = 'https://rsi.test/api/executions';
const encoder = new TextEncoder();
const BP_TEXT = '# 锂境科技\n\n创始人陈立，曾任蓝岸新能源研发经理。中试良率 90%。';
const DEMO_FILES = {
 '1-记忆资料/微信联系人.md': '# 微信联系人\n\n刘静，前蓝岸新能源研发总监。',
 '2-投资方法/项目A 衡石动力 BP.md': '# 衡石动力 BP\n\n固态电池隔膜。',
 '3-新BP/锂境科技 BP.md': BP_TEXT,
};
const size = path => encoder.encode(DEMO_FILES[path]).length;
const MANIFEST = {groups: [
 {id: 'memory', files: [{name: '微信联系人.md', path: '1-记忆资料/微信联系人.md', size: size('1-记忆资料/微信联系人.md')}]},
 {id: 'method', files: [{name: '项目A 衡石动力 BP.md', path: '2-投资方法/项目A 衡石动力 BP.md', size: size('2-投资方法/项目A 衡石动力 BP.md'), slot: 'A', role: 'bp'}]},
 {id: 'bp', files: [{name: '锂境科技 BP.md', path: '3-新BP/锂境科技 BP.md', size: size('3-新BP/锂境科技 BP.md')}]},
]};
const RECIPE_VIEW = {
 recipeId: 'recipe_1', versionId: 'version_1', number: 2, name: '早期硬科技 BP 投资方法', description: '投资建议书写法',
 instructions: '## 方法\n\n关键指标必须找两位独立专家交叉验证。', selfTest: 98, rules: ['关键指标找独立专家验证'],
};
const QUERIES = ['谁是硫化物电解质专家？', '良率的行业口径是多少？', '谁和陈立共事过？', '谁投过锂境科技？'];
const REPORT = {
 verdict: {title: '暂不投', text: '良率口径未证实。'},
 top_question: {title: '90% 良率是什么口径？', text: '请给出批次数据。', sources: ['锂境科技 BP']},
 experts: [{name: '赵一凡', independent: true, role: '教授 · 1 度', why: '懂电解质', sources: ['微信联系人']}],
 expert_gap: '还差 1 位。',
 people: [{name: '刘静', degree: '1 度', relation: '共事过', path: '您 → 刘静 → 创始人', why: '同公司', sources: ['微信联系人']}],
 people_gap: '还差 2 位。',
};

function fakeAssets() {
 return {fetch: async input => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'https://assets.local');
  const path = decodeURIComponent(url.pathname);
  if (path.endsWith('/manifest.json')) return Response.json(MANIFEST);
  const hit = Object.keys(DEMO_FILES).find(p => path === p || path.endsWith(`/${p}`));
  return hit ? new Response(DEMO_FILES[hit], {headers: {'Content-Type': 'text/markdown; charset=utf-8'}}) : new Response('not found', {status: 404});
 }};
}

async function setup(t, routes = []) {
 const cfg = testConfig();
 await seedSession(cfg);
 const fake = installFetch(routes);
 t.after(() => fake.restore());
 return {cfg, fake, env: envFromConfig(cfg, {ASSETS: fakeAssets()})};
}

/** Run the API middleware, then the route, the way Pages chains them. */
async function send(env, handler, {method = 'GET', path, params = {}, json: body, form, cookie = sessionCookie('sid-test'), lang} = {}) {
 const headers = {};
 if (cookie) headers.Cookie = lang ? `${cookie}; cosens-lang=${lang}` : cookie;
 if (method !== 'GET') headers.Origin = ORIGIN;
 const init = {method, headers};
 if (body !== undefined) {
  headers['Content-Type'] = 'application/json';
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
 }
 if (form) init.body = form;
 const waits = [];
 const chain = [...[apiMiddleware].flat(), handler];
 const context = {request: new Request(ORIGIN + path, init), env, params, data: {}, waitUntil: promise => waits.push(promise), next: null};
 let index = 0;
 context.next = async () => {
  index += 1;
  return chain[index](context);
 };
 const response = await chain[0](context);
 return {response, waits};
}

function project(slot, files = {}) {
 return {slot, title: `项目${slot}`, bp: files.bp ?? null, proposal: files.proposal ?? null, executionId: null, attempt: 0, status: 'idle', stage: null, progress: 0, error: null};
}

function baseRun(id, overrides = {}) {
 const now = Date.now();
 return {
  id, demo: 'investor', version: 1, vuId: VU, vuName: 'CoSens 演示 · 投资人 · 11-20 14:30', createdAt: now, updatedAt: now,
  memory: {files: [], stats: null, startedAt: null, completedAt: null},
  method: {projects: [project('A'), project('B')], recipe: null, startedAt: null, completedAt: null, error: null},
  bp: null, lastAnalysisAt: null, ...overrides,
 };
}

function readyRun(id) {
 const now = Date.now();
 const done = slot => ({...project(slot, {bp: {fileKey: `method-${slot}-bp`, name: `项目${slot} BP.md`}, proposal: {fileKey: `method-${slot}-proposal`, name: `项目${slot} 投资建议书.md`}}), executionId: `execution_${slot}`, attempt: 1, status: 'completed', stage: 'done', progress: 100});
 return baseRun(id, {
  memory: {files: [], stats: {people: 2, organizations: 1, relations: 3}, startedAt: now, completedAt: now},
  method: {projects: [done('A'), done('B')], recipe: RECIPE_VIEW, startedAt: now, completedAt: now, error: null},
  bp: {fileKey: 'bp', name: '锂境科技 BP.md'},
 });
}

async function seedRun(cfg, run, accountId = ACCOUNT) {
 await kvPutJson(cfg.kv, `run:${accountId}:${run.id}`, run);
 const index = (await kvGetJson(cfg.kv, `runs:${accountId}:investor`)) ?? [];
 await kvPutJson(cfg.kv, `runs:${accountId}:investor`, [run.id, ...index.filter(id => id !== run.id)]);
 return run;
}

async function seedFile(cfg, runId, fileKey, name, content) {
 await kvPutJson(cfg.kv, `file:${ACCOUNT}:${runId}:${fileKey}`, {name, mime: 'text/markdown', encoding: 'utf-8', content});
}

const storedRun = (cfg, runId) => kvGetJson(cfg.kv, `run:${ACCOUNT}:${runId}`);

function upload(group, name, bytes, extra = {}) {
 const form = new FormData();
 form.append('file', new File([bytes], name));
 form.append('group', group);
 for (const [key, value] of Object.entries(extra)) form.append(key, value);
 return form;
}

async function readEvents(response) {
 const text = await response.text();
 return text.split('\n\n').map(block => block.trim()).filter(block => block.startsWith('data: ')).map(block => JSON.parse(block.slice(6)));
}

const ingestRoute = {method: 'POST', url: 'https://memory.test/memory/ingest', reply: async req => {
 const body = await req.json();
 return {source_id: body.source_id, revision: 1, job_id: 'job-1', content_hash: '0'.repeat(64), state: 'pending'};
}};
const documentRoute = {method: 'POST', url: 'https://memory.test/v1/document/upload', reply: () => ({ok: true, document_id: 'doc_1', parser_job_id: 'pj_1', filename: '会议纪要.pdf', status: 'uploaded', stage: 'uploaded'})};
const jobRoute = reply => ({method: 'GET', url: /^https:\/\/memory\.test\/memory\/jobs\//, reply});
const graphRoute = {method: 'POST', url: 'https://memory.test/v1/graph/types', reply: () => ({ok: true, graph: {
 nodes: {types: [{type: 'Entity', count: 3, subtypes: [{type: 'person', count: 2}, {type: 'organization', count: 1}]}]},
 edges: {types: [{type: 'RELATION', count: 4}]},
}})};
const recallRoute = {method: 'POST', url: 'https://memory.test/memory/recall', reply: async req => {
 const body = await req.json();
 return {query: body.query, items: [{id: 'ep-contacts', kind: 'episode', text: '资料：微信联系人\n\n刘静，前蓝岸新能源研发总监。', score: 0.7}], estimated_tokens: 40};
}};
function llmRoute(script) {
 let index = 0;
 return {method: 'POST', url: LLM_URL, reply: async () => {
  const step = script[index];
  index += 1;
  if (!step) throw new Error(`the model was called ${index} times but the script has ${script.length} replies`);
  return typeof step === 'function' ? step() : sseReply(openAiChunks(step));
 }};
}
const toolCall = (n, query) => ({id: `call_${n}`, name: 'memory_recall', arguments: JSON.stringify({query})});
const goodScript = () => [{toolCalls: QUERIES.map((q, i) => toolCall(i, q))}, {content: JSON.stringify(REPORT)}];

test('every investor route answers 401 without a session', async t => {
 const {env, fake} = await setup(t);
 const cases = [
  [runsRoute.onRequestGet, 'GET', '/api/demo/investor/runs', {}],
  [runsRoute.onRequestPost, 'POST', '/api/demo/investor/runs', {}],
  [runRoute.onRequestGet, 'GET', '/api/demo/investor/runs/run_x', {id: 'run_x'}],
  [filesRoute.onRequestPost, 'POST', '/api/demo/investor/runs/run_x/files', {id: 'run_x'}],
  [methodRoute.onRequestPost, 'POST', '/api/demo/investor/runs/run_x/method', {id: 'run_x'}],
  [analyzeRoute.onRequestPost, 'POST', '/api/demo/investor/runs/run_x/analyze', {id: 'run_x'}],
  [analysisRoute.onRequestGet, 'GET', '/api/demo/investor/runs/run_x/analysis', {id: 'run_x'}],
 ];
 for (const [handler, method, path, params] of cases) {
  const {response} = await send(env, handler, {method, path, params, cookie: null, json: method === 'POST' ? {} : undefined});
  assert.equal(response.status, 401, `${method} ${path}`);
  assert.equal((await response.json()).error.code, 'not_authenticated', `${method} ${path}`);
 }
 assert.equal(fake.calls.length, 0);
});

test('GET runs is empty for a new visitor and never cached or indexed', async t => {
 const {env} = await setup(t);
 const {response} = await send(env, runsRoute.onRequestGet, {path: '/api/demo/investor/runs'});
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), {runs: []});
 assert.match(response.headers.get('Cache-Control'), /no-store/);
 assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('GET runs lists only this account, newest first, with the step reached', async t => {
 const {cfg, env} = await setup(t);
 const r0 = baseRun(rid('step0'), {createdAt: 1000});
 const r1 = baseRun(rid('step1'), {createdAt: 2000, memory: {files: [], stats: {people: 1, organizations: 0, relations: 0}, startedAt: 1, completedAt: 2}});
 const r2 = {...readyRun(rid('step2')), createdAt: 3000};
 const r3 = {...readyRun(rid('step3')), createdAt: 4000, lastAnalysisAt: 5000};
 for (const run of [r0, r1, r2, r3]) await seedRun(cfg, run);
 await seedRun(cfg, baseRun(rid('other')), 'acct_other');
 const {response} = await send(env, runsRoute.onRequestGet, {path: '/api/demo/investor/runs'});
 assert.equal(response.status, 200);
 assert.deepEqual((await response.json()).runs, [
  {id: rid('step3'), vuId: VU, vuName: r3.vuName, space: 'new', createdAt: 4000, step: 3},
  {id: rid('step2'), vuId: VU, vuName: r2.vuName, space: 'new', createdAt: 3000, step: 2},
  {id: rid('step1'), vuId: VU, vuName: r1.vuName, space: 'new', createdAt: 2000, step: 1},
  {id: rid('step0'), vuId: VU, vuName: r0.vuName, space: 'new', createdAt: 1000, step: 0},
 ]);
});

test('POST runs creates a fresh VU in the visitor account and a new run', async t => {
 const {env, fake} = await setup(t, [{method: 'POST', url: 'https://account.test/virtual-users', reply: async req => {
  const {name} = await req.json();
  return {requestId: 'req-1', timestamp: '2026-11-20T06:30:00Z', error: null,
   data: {vuId: NEW_VU, name, ownerAccountId: ACCOUNT, role: 'owner', createdAt: '2026-11-20T06:30:00Z', updatedAt: '2026-11-20T06:30:00Z'}};
 }}]);
 const {response} = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: {}});
 assert.equal(response.status, 201);
 const {run} = await response.json();
 assert.match(run.id, /^run_/);
 assert.equal(run.vuId, NEW_VU);
 assert.match(run.vuName, /^CoSens Demo · Investor · \d{2}-\d{2} \d{2}:\d{2}$/);
 assert.equal(run.space, 'new');
 const [create] = fake.calls;
 assert.equal(create.headers.get('Authorization'), 'Bearer tok');
 assert.equal(JSON.parse(create.body).name, run.vuName);
 const listed = await send(env, runsRoute.onRequestGet, {path: '/api/demo/investor/runs'});
 assert.deepEqual((await listed.response.json()).runs.map(r => [r.id, r.step]), [[run.id, 0]]);
});

test('POST runs names the VU in the browser time zone, and in UTC for a zone that is not one', async t => {
 const named = (zone, at) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return `CoSens Demo · Investor · ${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
 };
 for (const [timeZone, zone] of [['America/Los_Angeles', 'America/Los_Angeles'], ['Asia/Kolkata', 'Asia/Kolkata'], ['Not/AZone', 'UTC'], [42, 'UTC'], [undefined, 'UTC']]) {
  const {env} = await setup(t, [{method: 'POST', url: 'https://account.test/virtual-users', reply: async req => {
   const {name} = await req.json();
   return {requestId: 'req-1', timestamp: '2026-11-20T06:30:00Z', error: null,
    data: {vuId: NEW_VU, name, ownerAccountId: ACCOUNT, role: 'owner', createdAt: '2026-11-20T06:30:00Z', updatedAt: '2026-11-20T06:30:00Z'}};
  }}]);
  const before = Date.now();
  const {response} = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: {timeZone}});
  const after = Date.now();
  assert.equal(response.status, 201, String(timeZone));
  const {run} = await response.json();
  // The minute can tick over during the request; either side of it is right.
  assert.ok([named(zone, before), named(zone, after)].includes(run.vuName), `${timeZone}: ${run.vuName}`);
 }
});

test('POST runs without a body still creates a run, named in UTC', async t => {
 const {env} = await setup(t, [{method: 'POST', url: 'https://account.test/virtual-users', reply: async req => {
  const {name} = await req.json();
  return {requestId: 'req-1', timestamp: '2026-11-20T06:30:00Z', error: null,
   data: {vuId: NEW_VU, name, ownerAccountId: ACCOUNT, role: 'owner', createdAt: '2026-11-20T06:30:00Z', updatedAt: '2026-11-20T06:30:00Z'}};
 }}]);
 const {response} = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs'});
 assert.equal(response.status, 201);
 assert.match((await response.json()).run.vuName, /^CoSens Demo · Investor · \d{2}-\d{2} \d{2}:\d{2}$/);
});

test('POST runs refuses an oversized body', async t => {
 const {env} = await setup(t);
 const {response} = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: {timeZone: 'x'.repeat(5000)}});
 assert.equal(response.status, 413);
});

test('POST runs refuses a body that is not JSON', async t => {
 const {env} = await setup(t);
 const {response} = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: 'not json'});
 assert.equal(response.status, 400);
 assert.equal((await response.json()).error.code, 'invalid_request');
});

test('POST runs passes account errors through and creates no run', async t => {
 for (const [status, error, expected] of [
  [403, {code: 'permission_denied', message: 'VU test accounts cannot create virtual users'}, {status: 403, code: 'permission_denied'}],
  [401, {code: 'token_invalid', message: 'bad token'}, {status: 401, code: 'not_authenticated'}],
 ]) {
  const {cfg, env} = await setup(t, [{method: 'POST', url: 'https://account.test/virtual-users', reply: () => Response.json({data: null, error}, {status})}]);
  const {response} = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: {}});
  assert.equal(response.status, expected.status);
  const body = await response.json();
  assert.equal(body.error.code, expected.code);
  if (status === 403) assert.equal(body.error.service, 'account');
  assert.equal(await kvGetJson(cfg.kv, `runs:${ACCOUNT}:investor`), null);
 }
});

test('GET run answers run_not_found for unknown runs and for other accounts', async t => {
 const {cfg, env} = await setup(t);
 await seedRun(cfg, baseRun(rid('foreign')), 'acct_other');
 for (const id of ['run_missing', rid('foreign')]) {
  const {response} = await send(env, runRoute.onRequestGet, {path: `/api/demo/investor/runs/${id}`, params: {id}});
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'run_not_found');
 }
});

test('GET run returns a fresh run as stored', async t => {
 const {cfg, env} = await setup(t);
 const run = await seedRun(cfg, baseRun(rid('fresh')));
 const {response} = await send(env, runRoute.onRequestGet, {path: `/api/demo/investor/runs/${run.id}`, params: {id: run.id}});
 assert.equal(response.status, 200);
 const body = await response.json();
 assert.equal(body.run.id, run.id);
 assert.equal(body.run.vuId, VU);
 assert.equal(body.refreshError, undefined);
});

test('GET run refreshes pending memory jobs', async t => {
 const {cfg, env} = await setup(t, [jobRoute(() => ({job_id: 'job-1', state: 'committed'})), graphRoute]);
 const file = {key: 'demo-abc', name: '微信联系人.md', source: 'demo', kind: 'text', state: 'pending', jobId: 'job-1', documentId: null, error: null, addedAt: 1};
 const run = await seedRun(cfg, baseRun(rid('pending'), {memory: {files: [file], stats: null, startedAt: 1, completedAt: null}}));
 const {response} = await send(env, runRoute.onRequestGet, {path: `/api/demo/investor/runs/${run.id}`, params: {id: run.id}});
 assert.equal(response.status, 200);
 assert.equal((await response.json()).run.memory.files[0].state, 'committed');
 assert.equal((await storedRun(cfg, run.id)).memory.files[0].state, 'committed');
});

test('GET run keeps showing the saved run when Memory is down', async t => {
 const {cfg, env} = await setup(t, [jobRoute(() => Response.json({detail: 'service unavailable'}, {status: 503})), graphRoute]);
 // A file added just now: memory-step fails a pending job only after 30 minutes, so it stays pending.
 const now = Date.now();
 const file = {key: 'demo-abc', name: '微信联系人.md', source: 'demo', kind: 'text', state: 'pending', jobId: 'job-1', documentId: null, error: null, addedAt: now};
 const run = await seedRun(cfg, baseRun(rid('outage'), {memory: {files: [file], stats: null, startedAt: now, completedAt: null}}));
 const {response} = await send(env, runRoute.onRequestGet, {path: `/api/demo/investor/runs/${run.id}`, params: {id: run.id}});
 assert.equal(response.status, 200);
 const body = await response.json();
 assert.equal(body.run.id, run.id);
 assert.equal(body.run.memory.files[0].state, 'pending');
 // memory-step reports the outage as a non-enumerable run.refreshError; the route surfaces it.
 assert.equal(body.refreshError.service, 'memory');
 assert.equal(typeof body.refreshError.code, 'string');
 // The page's sentence, then Memory's own error line.
 assert.equal(body.refreshError.message, 'Memory is not responding. Progress will update automatically later. Memory 503 http_503: service unavailable');
 assert.equal((await storedRun(cfg, run.id)).refreshError, undefined);
});

test('POST files adds a bundled memory file through Memory ingest', async t => {
 const {cfg, env, fake} = await setup(t, [ingestRoute]);
 const run = await seedRun(cfg, baseRun(rid('files1')));
 const {response} = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, json: {group: 'memory', demoPath: '1-记忆资料/微信联系人.md'}});
 assert.equal(response.status, 201);
 const {run: updated} = await response.json();
 assert.equal(updated.memory.files.length, 1);
 assert.equal(updated.memory.files[0].name, '微信联系人.md');
 assert.equal(updated.memory.files[0].source, 'demo');
 const ingest = fake.calls.find(call => call.url === 'https://memory.test/memory/ingest');
 assert.equal(ingest.headers.get('X-Virtual-User-Id'), VU);
 assert.ok(JSON.parse(ingest.body).content.startsWith('Source: 微信联系人\n\n'));
});

test('POST files uploads a visitor PDF to Memory as a document', async t => {
 const {cfg, env} = await setup(t, [documentRoute]);
 const run = await seedRun(cfg, baseRun(rid('files2')));
 const {response} = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, form: upload('memory', '会议纪要.pdf', encoder.encode('%PDF-1.4 demo'))});
 assert.equal(response.status, 201);
 const file = (await response.json()).run.memory.files[0];
 assert.equal(file.kind, 'document');
 assert.equal(file.source, 'upload');
});

test('POST files stores a bundled method file under the slot and role from the manifest', async t => {
 const {cfg, env} = await setup(t);
 const run = await seedRun(cfg, baseRun(rid('files3')));
 const {response} = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, json: {group: 'method', demoPath: '2-投资方法/项目A 衡石动力 BP.md'}});
 assert.equal(response.status, 201);
 const projectA = (await response.json()).run.method.projects.find(p => p.slot === 'A');
 assert.equal(projectA.bp.name, '项目A 衡石动力 BP.md');
});

test('POST files stores the bundled BP and a visitor BP as UTF-8 text', async t => {
 const {cfg, env} = await setup(t);
 const run = await seedRun(cfg, baseRun(rid('files4')));
 const demo = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, json: {group: 'bp', demoPath: '3-新BP/锂境科技 BP.md'}});
 assert.equal(demo.response.status, 201);
 assert.deepEqual((await demo.response.json()).run.bp, {fileKey: 'bp', name: '锂境科技 BP.md'});
 assert.deepEqual(await kvGetJson(cfg.kv, `file:${ACCOUNT}:${run.id}:bp`), {name: '锂境科技 BP.md', mime: 'text/markdown; charset=utf-8', encoding: 'utf-8', content: BP_TEXT});
 const own = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, form: upload('bp', '星河储能 BP.md', encoder.encode('# 星河储能'))});
 assert.equal(own.response.status, 201);
 assert.deepEqual((await own.response.json()).run.bp, {fileKey: 'bp', name: '星河储能 BP.md'});
 assert.equal((await kvGetJson(cfg.kv, `file:${ACCOUNT}:${run.id}:bp`)).content, '# 星河储能');
});

test('POST files rejects unsupported types with 415', async t => {
 const {cfg, env, fake} = await setup(t);
 const run = await seedRun(cfg, baseRun(rid('files5')));
 for (const form of [
  upload('bp', '新项目 BP.pdf', encoder.encode('%PDF-1.4')),
  upload('memory', 'setup.exe', new Uint8Array([0x4d, 0x5a])),
  upload('method', '项目A 衡石动力 BP.png', new Uint8Array([0x89, 0x50]), {slot: 'A', role: 'bp'}),
  upload('bp', '乱码 BP.md', new Uint8Array([0xff, 0xfe, 0x00, 0xd8])),
 ]) {
  const {response} = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, form});
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'unsupported_file');
 }
 assert.equal(fake.calls.length, 0);
 assert.deepEqual(await storedRun(cfg, run.id), run);
});

test('POST files rejects oversized files with 413', async t => {
 const {cfg, env, fake} = await setup(t);
 const run = await seedRun(cfg, baseRun(rid('files6')));
 for (const form of [
  upload('method', '项目A 衡石动力 BP.md', new Uint8Array(4 * MiB + 1), {slot: 'A', role: 'bp'}),
  upload('bp', '大 BP.md', new Uint8Array(4 * MiB + 1)),
  upload('memory', '大文档.pdf', new Uint8Array(20 * MiB + 1)),
  upload('memory', '长文本.md', encoder.encode('a'.repeat(2_000_001))),
 ]) {
  const {response} = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, form});
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'file_too_large');
 }
 assert.equal(fake.calls.length, 0);
});

test('POST files rejects malformed requests with 400 and unknown demo files with 404', async t => {
 const {cfg, env, fake} = await setup(t);
 const run = await seedRun(cfg, baseRun(rid('files7')));
 const path = `/api/demo/investor/runs/${run.id}/files`;
 const noFile = new FormData();
 noFile.append('group', 'memory');
 for (const [request, code] of [
  [{json: {group: 'other', demoPath: '1-记忆资料/微信联系人.md'}}, 'invalid_group'],
  [{form: upload('other', '笔记.md', encoder.encode('# 笔记'))}, 'invalid_group'],
  [{json: '{not json'}, 'invalid_request'],
  [{json: {group: 'memory'}}, 'invalid_request'],
  [{form: noFile}, 'invalid_request'],
  [{form: upload('method', '项目B 微澜光电 BP.md', encoder.encode('# BP'))}, 'invalid_method_file'],
  [{form: upload('method', '项目B 微澜光电 BP.md', encoder.encode('# BP'), {slot: 'C', role: 'bp'})}, 'invalid_method_file'],
  [{form: upload('method', '项目B 微澜光电 BP.md', encoder.encode('# BP'), {slot: 'B', role: 'summary'})}, 'invalid_method_file'],
  [{form: upload('memory', '空.md', new Uint8Array(0))}, 'empty_file'],
 ]) {
  const {response} = await send(env, filesRoute.onRequestPost, {method: 'POST', path, params: {id: run.id}, ...request});
  assert.equal(response.status, 400, JSON.stringify(request.json ?? code));
  assert.equal((await response.json()).error.code, code);
 }
 // A demo path is served only from its own manifest group: an unknown path and a path from
 // another group are both 404 demo_file_not_found.
 for (const json of [{group: 'memory', demoPath: '1-记忆资料/不存在.md'}, {group: 'bp', demoPath: '1-记忆资料/微信联系人.md'}]) {
  const missing = await send(env, filesRoute.onRequestPost, {method: 'POST', path, params: {id: run.id}, json});
  assert.equal(missing.response.status, 404, json.demoPath);
  assert.equal((await missing.response.json()).error.code, 'demo_file_not_found');
 }
 const unknownRun = await send(env, filesRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs/run_missing/files', params: {id: 'run_missing'}, json: {group: 'bp', demoPath: '3-新BP/锂境科技 BP.md'}});
 assert.equal(unknownRun.response.status, 404);
 assert.equal((await unknownRun.response.json()).error.code, 'run_not_found');
 assert.equal(fake.calls.length, 0);
});

test('POST method needs both complete projects, then starts project A', async t => {
 const {cfg, env, fake} = await setup(t, [{method: 'POST', url: RSI_EXECUTIONS, reply: () => ({
  id: 'execution_a', status: 'queued', stage: 'queued', progress_percent: 0, recipe_id: 'recipe_1', recipe_version_id: null, test_results: [], error: null,
 })}]);
 const missing = await send(env, methodRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs/run_missing/method', params: {id: 'run_missing'}, json: {}});
 assert.equal(missing.response.status, 404);
 assert.equal((await missing.response.json()).error.code, 'run_not_found');

 const files = slot => ({bp: {fileKey: `method-${slot}-bp`, name: `项目${slot} BP.md`}, proposal: {fileKey: `method-${slot}-proposal`, name: `项目${slot} 投资建议书.md`}});
 const half = baseRun(rid('half'), {method: {projects: [project('A', files('A')), project('B', {bp: files('B').bp})], recipe: null, startedAt: null, completedAt: null, error: null}});
 await seedRun(cfg, half);
 const notReady = await send(env, methodRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${half.id}/method`, params: {id: half.id}, json: {}});
 assert.equal(notReady.response.status, 409);
 assert.equal((await notReady.response.json()).error.code, 'step_not_ready');
 assert.equal(fake.calls.length, 0);

 const full = baseRun(rid('full'), {method: {projects: [project('A', files('A')), project('B', files('B'))], recipe: null, startedAt: null, completedAt: null, error: null}});
 await seedRun(cfg, full);
 for (const slot of ['A', 'B']) {
  await seedFile(cfg, full.id, `method-${slot}-bp`, `项目${slot} BP.md`, `# 项目${slot} BP`);
  await seedFile(cfg, full.id, `method-${slot}-proposal`, `项目${slot} 投资建议书.md`, `# 项目${slot} 投资建议书`);
 }
 const started = await send(env, methodRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${full.id}/method`, params: {id: full.id}, json: {}});
 assert.equal(started.response.status, 202);
 const {run} = await started.response.json();
 assert.equal(typeof run.method.startedAt, 'number');
 assert.equal(run.method.projects.find(p => p.slot === 'A').executionId, 'execution_a');
 const create = fake.calls.find(call => call.url === RSI_EXECUTIONS);
 assert.equal(create.headers.get('X-Virtual-User-Id'), VU);
 assert.deepEqual(JSON.parse(create.body).files.map(f => f.role).sort(), ['artifact', 'input']);
});

test('POST analyze answers 404 and step_not_ready before opening a stream', async t => {
 const {cfg, env, fake} = await setup(t);
 const missing = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs/run_missing/analyze', params: {id: 'run_missing'}, json: {}});
 assert.equal(missing.response.status, 404);
 assert.equal((await missing.response.json()).error.code, 'run_not_found');
 const noMemory = readyRun(rid('nomemory'));
 noMemory.memory.completedAt = null;
 const noRecipe = readyRun(rid('norecipe'));
 noRecipe.method.recipe = null;
 const noBp = readyRun(rid('nobp'));
 noBp.bp = null;
 const noBpFile = readyRun(rid('nobpfile'));
 for (const run of [noMemory, noRecipe, noBp, noBpFile]) {
  await seedRun(cfg, run);
  if (run !== noBpFile) await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
  const {response} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}});
  assert.equal(response.status, 409, run.id);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  assert.equal((await response.json()).error.code, 'step_not_ready');
 }
 assert.equal(fake.calls.length, 0);
});

test('POST analyze streams step 3 and GET analysis replays the saved result', async t => {
 const {cfg, env, fake} = await setup(t, [llmRoute(goodScript()), recallRoute]);
 const run = await seedRun(cfg, readyRun(rid('analyze')));
 await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
 const before = await send(env, analysisRoute.onRequestGet, {path: `/api/demo/investor/runs/${run.id}/analysis`, params: {id: run.id}});
 assert.equal(before.response.status, 404);
 assert.equal((await before.response.json()).error.code, 'analysis_not_found');

 const {response, waits} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}});
 assert.equal(response.status, 200);
 assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
 assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
 const events = await readEvents(response);
 await Promise.all(waits);
 assert.equal(waits.length >= 1, true);
 assert.deepEqual(events.map(e => e.type), ['phase', ...QUERIES.flatMap(() => ['recall', 'recall_done']), 'phase', 'report']);
 assert.equal(events[0].text, 'Reading the BP: 锂境科技 BP');
 const saved = await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id));
 assert.deepEqual(events.at(-1).analysis, saved);
 assert.deepEqual(saved.report.top_question.sources, [{title: '锂境科技 BP', verified: true}]);
 assert.equal((await storedRun(cfg, run.id)).lastAnalysisAt, saved.at);
 const firstModelCall = JSON.parse(fake.calls.find(call => call.url === LLM_URL).body);
 assert.ok(firstModelCall.messages[1].content.includes(`${RECIPE_VIEW.instructions}\n\n## New BP: 锂境科技 BP\n\n${BP_TEXT}`));
 assert.equal(fake.calls.find(call => call.url === LLM_URL).headers.get('Authorization'), 'Bearer tok');

 const after = await send(env, analysisRoute.onRequestGet, {path: `/api/demo/investor/runs/${run.id}/analysis`, params: {id: run.id}});
 assert.equal(after.response.status, 200);
 assert.deepEqual(await after.response.json(), {analysis: saved});
 const foreign = await send(env, analysisRoute.onRequestGet, {path: '/api/demo/investor/runs/run_missing/analysis', params: {id: 'run_missing'}});
 assert.equal(foreign.response.status, 404);
 assert.equal((await foreign.response.json()).error.code, 'run_not_found');
});

test('POST analyze ends the stream with an error event when the model refuses the request', async t => {
 const {cfg, env} = await setup(t, [llmRoute([() => Response.json({error: {code: 'account_concurrency_limit_exceeded', message: 'too many concurrent requests'}}, {status: 429})]), recallRoute]);
 const run = await seedRun(cfg, readyRun(rid('busy')));
 await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
 const {response, waits} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}});
 assert.equal(response.status, 200);
 const events = await readEvents(response);
 await Promise.all(waits);
 assert.deepEqual(events.map(e => e.type), ['phase', 'error']);
 assert.equal(events[1].code, 'account_concurrency_limit_exceeded');
 assert.equal(events[1].service, 'model');
 assert.equal(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), null);
 assert.equal((await storedRun(cfg, run.id)).lastAnalysisAt, null);
});

test('step 3 errors reach the page in the service own words, scrubbed: credit, rate limit, busy, too long, 5xx', async t => {
 const cases = [
  // The prod case: the gateway's 402 with its own sentence.
  [() => Response.json({error: {code: 'gateway_credit_insufficient', message: 'account credit is insufficient; add credit before retrying'}}, {status: 402}), 'gateway_credit_insufficient', 'Model gateway 402 gateway_credit_insufficient: account credit is insufficient; add credit before retrying'],
  [() => Response.json({error: {code: 'rate_limit_exceeded', message: 'Rate limit reached'}}, {status: 429}), 'rate_limit_exceeded', 'Model gateway 429 rate_limit_exceeded: Rate limit reached'],
  [() => Response.json({error: {code: 'overloaded', message: 'The model is overloaded'}}, {status: 503}), 'overloaded', 'Model gateway 503 overloaded: The model is overloaded'],
  [() => Response.json({error: {code: 'context_length_exceeded', message: "This model's maximum context length is 131072 tokens"}}, {status: 400}), 'context_length_exceeded', "Model gateway 400 context_length_exceeded: This model's maximum context length is 131072 tokens"],
  [() => new Response('<html>Internal Server Error</html>', {status: 500}), 'http_500', 'Model gateway 500 http_500'],
  // An error chunk inside a 200 stream, naming the model id and an internal host: both are scrubbed.
  [() => sseReply([{error: {code: 'insufficient_balance', message: 'test-model at llm-internal.svc:8900 ran out of credit'}}]), 'insufficient_balance', 'Model gateway 502 insufficient_balance: [private] at [host] ran out of credit'],
 ];
 for (const [reply, code, message] of cases) {
  const {cfg, env} = await setup(t, [llmRoute([reply]), recallRoute]);
  const run = await seedRun(cfg, readyRun(rid(`err${code.slice(0, 8)}`)));
  await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
  const {response, waits} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}});
  const events = await readEvents(response);
  await Promise.all(waits);
  const error = events.at(-1);
  assert.deepEqual([error.type, error.code, error.service, error.message], ['error', code, 'model', message], code);
 }
});

test('a step 1 file refused by Memory is stored with Memory own error line', async t => {
 const {cfg, env} = await setup(t, [{method: 'POST', url: 'https://memory.test/memory/ingest', reply: () => Response.json({error: {code: 'RATE_LIMITED', message: 'Too many ingest requests for this user'}}, {status: 429})}]);
 const run = await seedRun(cfg, baseRun(rid('memrate')));
 const {response} = await send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, json: {group: 'memory', demoPath: '1-记忆资料/微信联系人.md'}});
 assert.equal(response.status, 201);
 const [file] = (await response.json()).run.memory.files;
 assert.deepEqual([file.state, file.error], ['failed', 'Memory 429 RATE_LIMITED: Too many ingest requests for this user']);
});

test('POST analyze scrubs URLs and internal hosts from the stream error event', async t => {
 const {cfg, env} = await setup(t, [llmRoute([() => Response.json({error: {code: 'provider_error', message: 'acme-llm upstream http://10.0.3.7:8000/v1 failed'}}, {status: 500})]), recallRoute]);
 const run = await seedRun(cfg, readyRun(rid('leak')));
 await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
 const {response, waits} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}});
 const events = await readEvents(response);
 await Promise.all(waits);
 const error = events.at(-1);
 assert.equal(error.type, 'error');
 assert.equal(error.service, 'model');
 assert.doesNotMatch(error.message, /https?:\/\/|10\.0\.3\.7/);
 assert.doesNotMatch(error.message, /10\.0\.3\.7/);
 assert.doesNotMatch(JSON.stringify(events), /acme-llm|10\.0\.3\.7/i);
});

test('POST analyze ends with no_search when the model writes without searching', async t => {
 const {cfg, env} = await setup(t, [llmRoute([{content: JSON.stringify(REPORT)}]), recallRoute]);
 const run = await seedRun(cfg, readyRun(rid('nosearch')));
 await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
 const {response, waits} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}});
 const events = await readEvents(response);
 await Promise.all(waits);
 assert.deepEqual(events.at(-1).type, 'error');
 assert.equal(events.at(-1).code, 'no_search');
 assert.equal(events.at(-1).service, 'model');
 assert.equal(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), null);
});

test('POST analyze still saves the result after the page disconnects', async t => {
 const script = goodScript();
 const slowReport = script[1];
 script[1] = async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  return sseReply(openAiChunks(slowReport));
 };
 const {cfg, env} = await setup(t, [llmRoute(script), recallRoute]);
 const run = await seedRun(cfg, readyRun(rid('gone')));
 await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
 const {response, waits} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}});
 const reader = response.body.getReader();
 const first = await reader.read();
 assert.match(new TextDecoder().decode(first.value), /"type":"phase"/);
 await reader.cancel();
 assert.equal(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), null);
 await Promise.all(waits);
 const saved = await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id));
 assert.equal(saved.report.verdict.title, REPORT.verdict.title);
 assert.equal((await storedRun(cfg, run.id)).lastAnalysisAt, saved.at);
});

// ---- Language: ?lang, the cosens-lang cookie, then SITE_DEFAULT_LOCALE (English) ----

const CJK = /[　-鿿＀-￯]/;
const vuRoute = () => ({method: 'POST', url: 'https://account.test/virtual-users', reply: async req => {
 const {name} = await req.json();
 return {requestId: 'req-1', timestamp: '2026-11-20T06:30:00Z', error: null,
  data: {vuId: NEW_VU, name, ownerAccountId: ACCOUNT, role: 'owner', createdAt: '2026-11-20T06:30:00Z', updatedAt: '2026-11-20T06:30:00Z'}};
}});

test('the run name follows ?lang, then the cosens-lang cookie, then the configured default, and stores no hard-coded Chinese', async t => {
 const names = {};
 for (const [label, options, extraEnv] of [
  ['default', {}, {}],
  ['cookie zh', {lang: 'zh'}, {}],
  ['cookie en over a zh default', {lang: 'en'}, {SITE_DEFAULT_LOCALE: 'zh'}],
  ['configured zh default', {}, {SITE_DEFAULT_LOCALE: 'zh'}],
  ['?lang=zh over an en cookie', {lang: 'en', query: '?lang=zh'}, {}],
  ['?lang=en over a zh default', {query: '?lang=en'}, {SITE_DEFAULT_LOCALE: 'zh'}],
  ['an invalid ?lang falls through to the cookie', {lang: 'zh', query: '?lang=fr'}, {}],
  ['an invalid default is English', {}, {SITE_DEFAULT_LOCALE: 'fr'}],
 ]) {
  const cfg = testConfig();
  await seedSession(cfg);
  const fake = installFetch([vuRoute()]);
  t.after(() => fake.restore());
  const env = envFromConfig(cfg, {ASSETS: fakeAssets(), ...extraEnv});
  const {response} = await send(env, runsRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs${options.query ?? ''}`, json: {timeZone: 'UTC'}, lang: options.lang});
  assert.equal(response.status, 201, label);
  names[label] = (await response.json()).run;
 }
 assert.match(names.default.vuName, /^CoSens Demo · Investor · /);
 assert.match(names['cookie zh'].vuName, /^CoSens 演示 · 投资人 · /);
 assert.match(names['cookie en over a zh default'].vuName, /^CoSens Demo · Investor · /);
 assert.match(names['configured zh default'].vuName, /^CoSens 演示 · 投资人 · /);
 assert.match(names['?lang=zh over an en cookie'].vuName, /^CoSens 演示 · 投资人 · /);
 assert.match(names['?lang=en over a zh default'].vuName, /^CoSens Demo · Investor · /);
 assert.match(names['an invalid ?lang falls through to the cookie'].vuName, /^CoSens 演示 · 投资人 · /);
 assert.match(names['an invalid default is English'].vuName, /^CoSens Demo · Investor · /);
 // A new run keeps no Chinese label of its own: the empty project titles are named by the page ("Project A" or its Chinese name).
 assert.deepEqual(names.default.method.projects.map(p => p.title), ['', '']);
 assert.equal(CJK.test(JSON.stringify({...names.default, vuName: ''})), false);
 assert.equal(CJK.test(JSON.stringify({...names['cookie zh'], vuName: ''})), false);
});

test('server messages are English by default and Chinese for ?lang=zh or the cookie', async t => {
 const {cfg, env} = await setup(t);
 const fresh = await seedRun(cfg, baseRun(rid('langmsg')));
 const path = `/api/demo/investor/runs/${fresh.id}`;
 const asks = [
  ['run missing', runRoute.onRequestGet, 'GET', '/api/demo/investor/runs/run_missing', {id: 'run_missing'}, undefined, 'This demo could not be found.', '找不到这次演示'],
  ['no analysis', analysisRoute.onRequestGet, 'GET', `${path}/analysis`, {id: fresh.id}, undefined, 'This demo has no saved analysis yet.', '这次演示还没有保存的分析结果。'],
  ['step 1 first', analyzeRoute.onRequestPost, 'POST', `${path}/analyze`, {id: fresh.id}, {}, 'Finish step 1 first: hand the materials to the AI to remember.', '请先完成第 1 步：把资料交给 AI 记住。'],
  ['bad group', filesRoute.onRequestPost, 'POST', `${path}/files`, {id: fresh.id}, {group: 'other', demoPath: 'x'}, 'The material group must be memory, method or bp.', '资料分组只能是 memory、method 或 bp'],
  ['missing demo path', filesRoute.onRequestPost, 'POST', `${path}/files`, {id: fresh.id}, {group: 'memory'}, 'Please say which demo file to use.', '请指明要使用的演示资料'],
  ['files not ready', methodRoute.onRequestPost, 'POST', `${path}/method`, {id: fresh.id}, {}, 'Project A, Project B: still missing a BP or an investment recommendation.', '项目 A、项目 B还缺 BP 或投资建议书'],
 ];
 for (const [label, handler, method, requestPath, params, json, english, chinese] of asks) {
  const en = await send(env, handler, {method, path: requestPath, params, json});
  assert.equal((await en.response.json()).error.message, english, label);
  const viaCookie = await send(env, handler, {method, path: requestPath, params, json, lang: 'zh'});
  assert.equal((await viaCookie.response.json()).error.message, chinese, `${label} (cookie)`);
  const viaQuery = await send(env, handler, {method, path: `${requestPath}?lang=zh`, params, json});
  assert.equal((await viaQuery.response.json()).error.message, chinese, `${label} (?lang)`);
  assert.equal(CJK.test(english), false, label);
 }
 // The sign-in gate answers in the visitor's language too, without a session.
 const gate = await send(env, runsRoute.onRequestGet, {path: '/api/demo/investor/runs', cookie: null});
 assert.equal((await gate.response.json()).error.message, 'Your login has expired. Please sign in again.');
 const gateZh = await send(env, runsRoute.onRequestGet, {path: '/api/demo/investor/runs?lang=zh', cookie: null});
 assert.equal((await gateZh.response.json()).error.message, '登录已过期，请重新登录');
});

test('a refused file explains itself in the visitor\'s language', async t => {
 const {cfg, env} = await setup(t);
 const run = await seedRun(cfg, baseRun(rid('langfile')));
 const send1 = lang => send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, form: upload('bp', 'plan.pdf', encoder.encode('%PDF-1.4')), lang});
 assert.equal((await (await send1()).response.json()).error.message, 'The new BP must be a .md, .markdown or .txt file.');
 assert.equal((await (await send1('zh')).response.json()).error.message, '新 BP 只支持 .md、.markdown、.txt');
 const empty = lang => send(env, filesRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/files`, params: {id: run.id}, form: upload('memory', 'empty.md', new Uint8Array(0)), lang});
 assert.equal((await (await empty()).response.json()).error.message, '"empty.md" is an empty file.');
 assert.equal((await (await empty('zh')).response.json()).error.message, '「empty.md」是空文件');
});

test('a Memory outage notice follows the language', async t => {
 const {cfg, env} = await setup(t, [jobRoute(() => Response.json({detail: 'service unavailable'}, {status: 503})), graphRoute]);
 const now = Date.now();
 const file = {key: 'demo-abc', name: '微信联系人.md', source: 'demo', kind: 'text', state: 'pending', jobId: 'job-1', documentId: null, error: null, addedAt: now};
 const run = await seedRun(cfg, baseRun(rid('langoutage'), {memory: {files: [file], stats: null, startedAt: now, completedAt: null}}));
 const {response} = await send(env, runRoute.onRequestGet, {path: `/api/demo/investor/runs/${run.id}`, params: {id: run.id}, lang: 'zh'});
 assert.equal((await response.json()).refreshError.message, 'Memory暂时没有响应，进度稍后会自动更新。 Memory 503 http_503: service unavailable');
 const english = await send(env, runRoute.onRequestGet, {path: `/api/demo/investor/runs/${run.id}`, params: {id: run.id}});
 assert.equal((await english.response.json()).refreshError.message, 'Memory is not responding. Progress will update automatically later. Memory 503 http_503: service unavailable');
});

test('POST analyze streams in Chinese for the zh locale and writes the model prompts in Chinese', async t => {
 const {cfg, env, fake} = await setup(t, [llmRoute(goodScript()), recallRoute]);
 const run = await seedRun(cfg, readyRun(rid('analyzezh')));
 await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
 const {response, waits} = await send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}, lang: 'zh'});
 const events = await readEvents(response);
 await Promise.all(waits);
 assert.equal(events[0].text, '读 BP：锂境科技 BP');
 assert.equal(events.at(-2).text, '按你的方法写报告（约 1 分钟）');
 const first = JSON.parse(fake.calls.find(call => call.url === LLM_URL).body);
 assert.ok(first.messages[0].content.startsWith('你是一位投资人的投资助手'));
 assert.ok(first.messages[1].content.includes('## 新 BP：锂境科技 BP'));
});

test('POST analyze reports a failed run in the visitor\'s language', async t => {
 const {cfg, env} = await setup(t, [llmRoute([{content: JSON.stringify(REPORT)}]), recallRoute]);
 const run = await seedRun(cfg, readyRun(rid('analyzefail')));
 await seedFile(cfg, run.id, 'bp', '锂境科技 BP.md', BP_TEXT);
 const ask = lang => send(env, analyzeRoute.onRequestPost, {method: 'POST', path: `/api/demo/investor/runs/${run.id}/analyze`, params: {id: run.id}, json: {}, lang});
 const {response, waits} = await ask('zh');
 const events = await readEvents(response);
 await Promise.all(waits);
 assert.deepEqual([events.at(-1).type, events.at(-1).code], ['error', 'no_search']);
 assert.equal(events.at(-1).message, '模型没有在记忆里检索就想直接写报告，这样的报告没有依据，已经拒绝。请重试。');
});
