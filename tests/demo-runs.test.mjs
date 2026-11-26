import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeKv} from './helpers/fake-kv.mjs';
import {installFetch, testConfig} from './helpers/fake-services.mjs';
import {kvGetJson, kvPutJson} from '../server/demo/kv.mjs';
import {ServiceError} from '../server/demo/http.mjs';
import {
  FILE_TTL_SECONDS, KV_WRITE_BACKOFF_MS, RUN_INDEX_MAX, base64ToBytes, bytesToBase64, createRun, demoError, fileKvKey,
  getFile, getRun, indexKey, listRuns, newRun, putFile, putJsonPaced, requireRun, runKey, runStep, runSummary, saveRun,
  checkTimeZone, vuName, withRefreshError,
} from '../server/demo/runs.mjs';

const session = {accessToken: 'tok', accountId: 'acct_test'};
const VU = 'vu_0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 10, 20, 6, 30); // 14:30 in Shanghai
const NAME = 'CoSens Demo · Investor · 11-20 14:30';
const failsWith = (status, code) => err => err instanceof ServiceError && err.status === status && err.code === code;

function accountRoute(seen, reply) {
  return {method: 'POST', url: 'https://account.test/virtual-users', reply: async req => {
    const body = JSON.parse(await req.text());
    seen.push({body, auth: req.headers.get('authorization')});
    if (reply) return reply();
    return {requestId: 'req-1', timestamp: '2026-11-20T06:30:00Z', error: null, data: {
      vuId: VU, name: body.name, ownerAccountId: 'acct_test', role: 'owner',
      createdAt: '2026-11-20T06:30:00Z', updatedAt: '2026-11-20T06:30:00Z'}};
  }};
}

async function seed(cfg, id, change = () => {}) {
  const run = newRun({id, vuId: VU, vuName: `演示 ${id}`, now: 1000});
  change(run);
  await kvPutJson(cfg.kv, runKey('acct_test', id), run);
  return run;
}

test('vuName uses the given time zone, UTC by default, and rolls the date over', () => {
  assert.equal(vuName(NOW, 'Asia/Shanghai'), NAME);
  assert.equal(vuName(NOW), 'CoSens Demo · Investor · 11-20 06:30');
  assert.equal(vuName(NOW, 'America/Los_Angeles'), 'CoSens Demo · Investor · 11-19 22:30');
  assert.equal(vuName(Date.UTC(2026, 11, 31, 16, 5), 'Asia/Shanghai'), 'CoSens Demo · Investor · 01-01 00:05');
  assert.equal(vuName(Date.UTC(2026, 0, 1, 1, 2), 'Asia/Shanghai'), 'CoSens Demo · Investor · 01-01 09:02');
  // Daylight saving time: 07:30 UTC is 00:30 in Los Angeles in July (UTC-7) and 23:30 the day before in January (UTC-8).
  assert.equal(vuName(Date.UTC(2026, 6, 1, 7, 30), 'America/Los_Angeles'), 'CoSens Demo · Investor · 07-01 00:30');
  assert.equal(vuName(Date.UTC(2026, 0, 2, 7, 30), 'America/Los_Angeles'), 'CoSens Demo · Investor · 01-01 23:30');
  assert.equal(vuName(NOW, 'Not/AZone'), 'CoSens Demo · Investor · 11-20 06:30');
});

test('vuName follows the visitor\'s language and never hard-codes Chinese', () => {
  assert.equal(vuName(NOW, 'Asia/Shanghai', 'en'), NAME);
  assert.equal(vuName(NOW, 'Asia/Shanghai', 'zh'), 'CoSens 演示 · 投资人 · 11-20 14:30');
  assert.equal(vuName(NOW, 'Asia/Shanghai', 'fr'), NAME, 'an unknown language is English');
  assert.equal(/[\u3000-\u9fff]/.test(vuName(NOW)), false);
  assert.equal(/[\u3000-\u9fff]/.test(JSON.stringify(newRun({id: 'run_x', vuId: VU, vuName: vuName(NOW), now: 1}))), false, 'a new run stores no Chinese');
});

test('checkTimeZone keeps IANA zones the runtime knows and turns anything else into UTC', () => {
  assert.equal(checkTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(checkTimeZone('asia/shanghai'), 'Asia/Shanghai');
  assert.equal(checkTimeZone('America/Los_Angeles'), 'America/Los_Angeles');
  assert.equal(checkTimeZone('UTC'), 'UTC');
  for (const value of [undefined, null, '', 'Mars/Olympus_Mons', 'Asia/Shanghai; DROP', 8, {}, ['Asia/Shanghai'], 'A'.repeat(65)]) {
    assert.equal(checkTimeZone(value), 'UTC', JSON.stringify(value));
  }
});

test('createRun creates a Virtual User and records an empty run', async () => {
  const cfg = testConfig();
  const seen = [];
  const mock = installFetch([accountRoute(seen)]);
  try {
    const run = await createRun(cfg, session, {now: () => NOW, timeZone: 'Asia/Shanghai'});
    assert.deepEqual(seen.map(call => call.body), [{name: NAME}]);
    assert.equal(seen[0].auth, 'Bearer tok');
    assert.match(run.id, /^run_[A-Za-z0-9_-]{16}$/);
    assert.deepEqual(run, newRun({id: run.id, vuId: VU, vuName: NAME, now: NOW}));
    assert.equal(run.version, 1);
    assert.equal(run.demo, 'investor');
    assert.deepEqual(run.method.projects.map(project => [project.slot, project.title, project.status, project.attempt]),
      [['A', '', 'idle', 0], ['B', '', 'idle', 0]]);
    assert.deepEqual(run.memory, {files: [], stats: null, startedAt: null, completedAt: null});
    assert.deepEqual(await kvGetJson(cfg.kv, runKey('acct_test', run.id)), run);
    assert.deepEqual(await kvGetJson(cfg.kv, indexKey('acct_test')), [run.id]);
  } finally {
    mock.restore();
  }
});

test('the run index keeps the newest 50 runs, newest first', async () => {
  const cfg = testConfig();
  const old = Array.from({length: RUN_INDEX_MAX}, (_, i) => `run_${String(i).padStart(16, '0')}`);
  await kvPutJson(cfg.kv, indexKey('acct_test'), old);
  const mock = installFetch([accountRoute([])]);
  try {
    const run = await createRun(cfg, session, {now: () => NOW});
    const index = await kvGetJson(cfg.kv, indexKey('acct_test'));
    assert.equal(index.length, RUN_INDEX_MAX);
    assert.equal(index[0], run.id);
    assert.deepEqual(index.slice(1), old.slice(0, RUN_INDEX_MAX - 1));
  } finally {
    mock.restore();
  }
});

test('createRun stores nothing when the Virtual User cannot be created', async () => {
  const cfg = testConfig();
  const mock = installFetch([accountRoute([], () => Response.json(
    {requestId: 'r', timestamp: 't', data: null, error: {code: 'permission_denied', message: 'not allowed'}}, {status: 403}))]);
  try {
    await assert.rejects(createRun(cfg, session, {now: () => NOW}), err => err instanceof ServiceError && err.status === 403);
    assert.equal((await cfg.kv.list({prefix: 'run'})).keys.length, 0);
  } finally {
    mock.restore();
  }
});

test('getRun ignores malformed ids and requireRun answers run_not_found', async () => {
  const cfg = testConfig();
  await seed(cfg, 'run_AAAAAAAAAAAAAAAA');
  assert.equal((await getRun(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA')).id, 'run_AAAAAAAAAAAAAAAA');
  assert.equal(await getRun(cfg, 'acct_other', 'run_AAAAAAAAAAAAAAAA'), null);
  assert.equal(await getRun(cfg, 'acct_test', '../run_AAAAAAAAAAAAAAAA'), null);
  assert.equal(await getRun(cfg, 'acct_test', 'run_short'), null);
  assert.equal(await getRun(cfg, 'acct_test', undefined), null);
  await assert.rejects(requireRun(cfg, 'acct_test', 'run_ZZZZZZZZZZZZZZZZ'), failsWith(404, 'run_not_found'));
});

test('listRuns returns summaries newest first with the step reached and skips missing runs', async () => {
  const cfg = testConfig();
  await seed(cfg, 'run_AAAAAAAAAAAAAAAA', run => { run.memory.completedAt = 2000; });
  await seed(cfg, 'run_BBBBBBBBBBBBBBBB', run => { run.memory.completedAt = 2000; run.method.recipe = {recipeId: 'recipe_1'}; });
  await seed(cfg, 'run_CCCCCCCCCCCCCCCC', run => { run.lastAnalysisAt = 3000; run.memory.completedAt = 2000; run.method.recipe = {recipeId: 'r'}; });
  await kvPutJson(cfg.kv, indexKey('acct_test'),
    ['run_CCCCCCCCCCCCCCCC', 'run_DDDDDDDDDDDDDDDD', 'run_BBBBBBBBBBBBBBBB', 'run_AAAAAAAAAAAAAAAA']);
  assert.deepEqual(await listRuns(cfg, 'acct_test'), [
    {id: 'run_CCCCCCCCCCCCCCCC', vuId: VU, vuName: '演示 run_CCCCCCCCCCCCCCCC', space: 'new', createdAt: 1000, step: 3},
    {id: 'run_BBBBBBBBBBBBBBBB', vuId: VU, vuName: '演示 run_BBBBBBBBBBBBBBBB', space: 'new', createdAt: 1000, step: 2},
    {id: 'run_AAAAAAAAAAAAAAAA', vuId: VU, vuName: '演示 run_AAAAAAAAAAAAAAAA', space: 'new', createdAt: 1000, step: 1},
  ]);
  assert.deepEqual(await listRuns(cfg, 'acct_nobody'), []);
  const fresh = newRun({id: 'run_EEEEEEEEEEEEEEEE', vuId: VU, vuName: 'x', now: 1});
  assert.equal(runStep(fresh), 0);
  assert.deepEqual(runSummary(fresh), {id: 'run_EEEEEEEEEEEEEEEE', vuId: VU, vuName: 'x', space: 'new', createdAt: 1, step: 0});
  // Runs stored before the space choice existed were all in a fresh VU.
  const {space: _, ...older} = fresh;
  assert.equal(runSummary(older).space, 'new');
});

test('createRun with a checked space writes into that VU and creates none', async () => {
  const cfg = testConfig();
  const seen = [];
  const mock = installFetch([accountRoute(seen)]);
  try {
    const space = {vuId: VU, name: '我的工作记忆', role: 'write'};
    const run = await createRun(cfg, session, {now: () => NOW, space});
    assert.equal(seen.length, 0);
    assert.deepEqual(run, newRun({id: run.id, vuId: VU, vuName: '我的工作记忆', space: 'existing', now: NOW}));
    assert.deepEqual(await kvGetJson(cfg.kv, runKey('acct_test', run.id)), run);
    assert.deepEqual(await kvGetJson(cfg.kv, indexKey('acct_test')), [run.id]);
    // A VU without a name is shown by its id.
    assert.equal((await createRun(cfg, session, {space: {vuId: VU, name: '', role: 'owner'}})).vuName, VU);
  } finally {
    mock.restore();
  }
});

test('saveRun bumps the version and updatedAt and returns the saved run', async () => {
  const cfg = testConfig();
  await seed(cfg, 'run_AAAAAAAAAAAAAAAA');
  const saved = await saveRun(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', draft => { draft.bp = {fileKey: 'bp', name: 'x.md'}; }, {now: () => 5000});
  assert.equal(saved.version, 2);
  assert.equal(saved.updatedAt, 5000);
  assert.deepEqual(saved.bp, {fileKey: 'bp', name: 'x.md'});
  assert.deepEqual(await getRun(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA'), saved);
});

test('saveRun skips the write when the mutation returns false', async () => {
  const cfg = testConfig();
  const run = await seed(cfg, 'run_AAAAAAAAAAAAAAAA');
  const result = await saveRun(cfg, 'acct_test', run.id, () => false, {now: () => 5000});
  assert.equal(result.version, 1);
  assert.equal((await getRun(cfg, 'acct_test', run.id)).updatedAt, 1000);
});

test('saveRun re-applies the mutation after a concurrent write', async () => {
  const cfg = testConfig();
  const run = await seed(cfg, 'run_AAAAAAAAAAAAAAAA');
  let calls = 0;
  const saved = await saveRun(cfg, 'acct_test', run.id, async draft => {
    calls += 1;
    if (calls === 1) {
      const other = structuredClone(run);
      other.version = 2;
      other.bp = {fileKey: 'bp', name: 'other.md'};
      await kvPutJson(cfg.kv, runKey('acct_test', run.id), other);
    }
    draft.lastAnalysisAt = 123;
  }, {now: () => 5000});
  assert.equal(calls, 2);
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.bp, {fileKey: 'bp', name: 'other.md'});
  assert.equal(saved.lastAnalysisAt, 123);
});

test('saveRun gives up with run_conflict after 3 retries', async () => {
  const cfg = testConfig();
  const run = await seed(cfg, 'run_AAAAAAAAAAAAAAAA');
  const key = runKey('acct_test', run.id);
  let calls = 0;
  await assert.rejects(saveRun(cfg, 'acct_test', run.id, async draft => {
    calls += 1;
    const stored = await kvGetJson(cfg.kv, key);
    stored.version += 1;
    await kvPutJson(cfg.kv, key, stored);
    draft.lastAnalysisAt = calls;
  }), failsWith(409, 'run_conflict'));
  assert.equal(calls, 4);
});

test('saveRun answers run_not_found and passes mutation errors through', async () => {
  const cfg = testConfig();
  await assert.rejects(saveRun(cfg, 'acct_test', 'run_ZZZZZZZZZZZZZZZZ', () => true), failsWith(404, 'run_not_found'));
  const run = await seed(cfg, 'run_AAAAAAAAAAAAAAAA');
  await assert.rejects(saveRun(cfg, 'acct_test', run.id, () => { throw demoError(409, 'step_not_ready', 'locked'); }),
    failsWith(409, 'step_not_ready'));
  assert.equal((await getRun(cfg, 'acct_test', run.id)).version, 1);
});

// Real Workers KV refuses a second write to the same key within one second.
function throttledKv(base, intervalMs = 1000) {
  const last = new Map();
  return {...base, async put(key, value, options) {
    const at = Date.now();
    if (last.has(key) && at - last.get(key) < intervalMs) throw new Error('KV PUT failed: 429 Too Many Requests');
    last.set(key, at);
    return base.put(key, value, options);
  }};
}

test('saveRun waits out the KV one-write-per-second limit instead of failing', async () => {
  const base = fakeKv();
  const cfg = testConfig({kv: throttledKv(base)});
  await kvPutJson(base, runKey('acct_test', 'run_AAAAAAAAAAAAAAAA'), newRun({id: 'run_AAAAAAAAAAAAAAAA', vuId: VU, vuName: 'x', now: 1000}));
  const first = await saveRun(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', draft => { draft.bp = {fileKey: 'bp', name: 'a.md'}; });
  const started = Date.now();
  const second = await saveRun(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', draft => { draft.lastAnalysisAt = 7; });
  assert.ok(Date.now() - started >= 1000, 'the second write waited for the KV limit');
  assert.deepEqual([first.version, second.version, second.bp.name, second.lastAnalysisAt], [2, 3, 'a.md', 7]);
  assert.deepEqual(await getRun(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA'), second);
  assert.ok(KV_WRITE_BACKOFF_MS >= 1000);
  const broken = {...base, put: async () => { throw new Error('KV PUT failed: 500 Internal'); }};
  await assert.rejects(putJsonPaced(broken, 'k', 1), /500 Internal/);
});

test('withRefreshError attaches a non-persisted refreshError and keeps the first one', () => {
  const run = newRun({id: 'run_AAAAAAAAAAAAAAAA', vuId: VU, vuName: 'x', now: 1});
  assert.equal(withRefreshError(run, null), run);
  const flagged = withRefreshError(run, new ServiceError('memory', 503, 'http_503', 'busy'));
  assert.deepEqual(flagged.refreshError, {service: 'memory', code: 'http_503', message: 'busy'});
  assert.equal(run.refreshError, undefined);
  assert.deepEqual(flagged, run);
  assert.equal(JSON.stringify(flagged), JSON.stringify(run));
  assert.equal(withRefreshError(flagged, new ServiceError('rsi', 502, 'x', 'y')).refreshError.service, 'memory');
});

test('demoError is a ServiceError without a service', () => {
  const err = demoError(415, 'unsupported_file', '不支持');
  assert.ok(err instanceof ServiceError);
  assert.equal(err.service, null);
  assert.equal(err.status, 415);
  assert.equal(err.code, 'unsupported_file');
  assert.equal(err.message, '不支持');
});

test('putFile and getFile round-trip text and binary files and expire after 30 days', async () => {
  let clock = 0;
  const cfg = testConfig({kv: fakeKv({now: () => clock})});
  const text = new TextEncoder().encode('﻿# 锂境科技 BP\n良率 90%');
  const binary = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80]);
  assert.deepEqual(await putFile(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', 'bp', {name: '锂境科技 BP.md', mime: 'text/markdown; charset=utf-8', bytes: text}),
    {fileKey: 'bp', name: '锂境科技 BP.md'});
  await putFile(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', 'method-A-bp', {name: 'a.pdf', mime: 'application/pdf', bytes: binary});
  const stored = await kvGetJson(cfg.kv, fileKvKey('acct_test', 'run_AAAAAAAAAAAAAAAA', 'bp'));
  assert.equal(stored.encoding, 'utf-8');
  assert.equal(stored.content, '﻿# 锂境科技 BP\n良率 90%');
  const textBack = await getFile(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', 'bp');
  assert.deepEqual([...textBack.bytes], [...text]);
  assert.equal(textBack.name, '锂境科技 BP.md');
  assert.equal(textBack.mime, 'text/markdown; charset=utf-8');
  const binaryBack = await getFile(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', 'method-A-bp');
  assert.equal(binaryBack.encoding, 'base64');
  assert.equal(binaryBack.content, bytesToBase64(binary));
  assert.deepEqual([...binaryBack.bytes], [...binary]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(binary))], [...binary]);
  assert.equal(await getFile(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', 'missing'), null);
  clock = FILE_TTL_SECONDS * 1000 + 1000;
  assert.equal(await getFile(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', 'bp'), null);
});

test('putFile rejects unsafe file keys', async () => {
  const cfg = testConfig();
  await assert.rejects(putFile(cfg, 'acct_test', 'run_AAAAAAAAAAAAAAAA', '../x', {name: 'x', mime: 'text/plain', bytes: new Uint8Array([1])}),
    /invalid file key/);
});
