import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {installFetch, testConfig} from './helpers/fake-services.mjs';
import {ServiceError} from '../server/demo/http.mjs';
import {kvPutJson} from '../server/demo/kv.mjs';
import {getRun, newRun, runKey} from '../server/demo/runs.mjs';
import {
  JOB_TIMEOUT_MS, MISSING_GRACE_MS, addMemoryFile, documentOutcome, refreshMemory,
} from '../server/demo/investor/memory-step.mjs';
import {addScrubTerms} from '../server/demo/scrub.mjs';

// The names a deployment would list in DEMO_PRIVATE_NAMES.
addScrubTerms(['acme', 'globex']);

const session = {accessToken: 'tok', accountId: 'acct_test'};
const VU = 'vu_0123456789abcdef0123456789abcdef';
const RUN_ID = 'run_AAAAAAAAAAAAAAAA';
const enc = text => new TextEncoder().encode(text);
const keyOf = (name, content) => `demo-${createHash('sha256').update(`${name}\n${content}`).digest('hex').slice(0, 40)}`;
const CONTACTS = '# 微信联系人\n刘静：前同事';
const MINUTES = '# 储能材料行业交流\n赵一凡：良率约 60%';

async function seedRun(cfg) {
  const run = newRun({id: RUN_ID, vuId: VU, vuName: 'CoSens 演示 · 投资人 · 11-20 14:30', now: 1000});
  await kvPutJson(cfg.kv, runKey(session.accountId, RUN_ID), run);
  return run;
}

function memoryStack() {
  const s = {ingested: [], ingestQueue: [], jobs: new Map(), jobError: null, uploads: [], docs: new Map(), statsCalls: 0, statsError: null};
  s.fetch = installFetch([
    {method: 'POST', url: 'https://memory.test/memory/ingest', reply: async req => {
      const body = JSON.parse(await req.text());
      s.ingested.push(body);
      const queued = s.ingestQueue.shift();
      if (queued) return queued();
      const jobId = `job-${s.ingested.length}`;
      s.jobs.set(jobId, 'pending');
      return {source_id: body.source_id, revision: 1, job_id: jobId, content_hash: 'hash', state: 'pending'};
    }},
    {method: 'GET', url: /^https:\/\/memory\.test\/memory\/jobs\/[^/?]+$/, reply: (req, url) => {
      if (s.jobError) return s.jobError();
      const jobId = decodeURIComponent(url.pathname.split('/').pop());
      return s.jobs.has(jobId) ? {job_id: jobId, state: s.jobs.get(jobId)} : Response.json({detail: 'resource unavailable'}, {status: 404});
    }},
    {method: 'POST', url: 'https://memory.test/v1/document/upload', reply: req => {
      s.uploads.push(req.headers.get('content-type'));
      const documentId = `doc_${s.uploads.length}`;
      s.docs.set(documentId, {document_id: documentId, status: 'parsing', stage: 'parsing', recall_ready: false});
      return {ok: true, document_id: documentId, filename: 'deck.pdf', status: 'uploaded', stage: 'uploaded'};
    }},
    {method: 'POST', url: 'https://memory.test/v1/document/status', reply: async req => {
      const {document_ids: ids} = JSON.parse(await req.text());
      return {ok: true, backend: 'memory', runtime: 'memory',
        statuses: ids.map(id => s.docs.get(id) || {document_id: id, status: 'missing', stage: 'missing', recall_ready: false})};
    }},
    {method: 'POST', url: 'https://memory.test/v1/graph/types', reply: () => {
      s.statsCalls += 1;
      if (s.statsError) return s.statsError();
      return {ok: true, graph: {
        nodes: {total: 10, types: [
          {type: 'Entity', count: 8, subtypes: [{type: 'person', count: 3}, {type: 'organization', count: 2}, {type: 'company', count: 1}, {type: 'project', count: 2}]},
          {type: 'Episode', count: 2, subtypes: []}]},
        edges: {total: 9, types: [{type: 'RELATION', count: 7}, {type: 'SUPPORTS', count: 2}]}}};
    }},
  ]);
  return s;
}

test('addMemoryFile writes text with the Source prefix and a replay-safe key', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    const run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo', now: () => 2000});
    const key = keyOf('微信联系人.md', CONTACTS);
    assert.equal(s.ingested.length, 1);
    assert.equal(s.ingested[0].content, `Source: 微信联系人\n\n${CONTACTS}`);
    assert.equal(s.ingested[0].request_key, key);
    assert.equal(s.ingested[0].source_id, key);
    assert.equal(s.ingested[0].source_kind, 'document');
    assert.deepEqual(run.memory.files, [{key, name: '微信联系人.md', source: 'demo', kind: 'text', state: 'pending',
      jobId: 'job-1', documentId: null, error: null, addedAt: 2000}]);
    assert.equal(run.memory.startedAt, 2000);
    assert.equal(run.memory.completedAt, null);
    assert.equal(run.version, 2);
    assert.deepEqual(await getRun(cfg, session.accountId, RUN_ID), run);
  } finally {
    s.fetch.restore();
  }
});

test('adding the same file again does nothing, the same text under another name is a new source', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'});
    const again = await addMemoryFile(cfg, session, run, {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'upload'});
    assert.equal(again, run);
    assert.equal(s.ingested.length, 1);
    run = await addMemoryFile(cfg, session, run, {name: '联系人副本.md', bytes: enc(CONTACTS), source: 'upload'});
    assert.equal(s.ingested.length, 2);
    assert.notEqual(s.ingested[0].request_key, s.ingested[1].request_key);
    assert.deepEqual(run.memory.files.map(file => [file.name, file.source]), [['微信联系人.md', 'demo'], ['联系人副本.md', 'upload']]);
  } finally {
    s.fetch.restore();
  }
});

test('PDF and Word files go to the document upload', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    const run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: 'deck.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), source: 'upload', now: () => 2000});
    assert.equal(s.ingested.length, 0);
    assert.equal(s.uploads.length, 1);
    assert.match(s.uploads[0], /^multipart\/form-data/);
    const [file] = run.memory.files;
    assert.deepEqual([file.kind, file.state, file.documentId, file.jobId], ['document', 'pending', 'doc_1', null]);
  } finally {
    s.fetch.restore();
  }
});

test('unsupported files are refused before any call', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    await assert.rejects(addMemoryFile(cfg, session, await seedRun(cfg), {name: 'slides.pptx', bytes: enc('x'), source: 'upload'}),
      err => err instanceof ServiceError && err.status === 415 && err.code === 'unsupported_file');
    assert.equal(s.fetch.calls.length, 0);
    assert.equal((await getRun(cfg, session.accountId, RUN_ID)).version, 1);
  } finally {
    s.fetch.restore();
  }
});

test('a failed write is recorded and the same key is replayed when it is added again', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  s.ingestQueue.push(() => Response.json({detail: 'source write is busy'}, {status: 503}));
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'});
    assert.equal(run.memory.files[0].state, 'failed');
    assert.ok(run.memory.files[0].error.length > 0);
    assert.equal(run.memory.files[0].jobId, null);
    run = await addMemoryFile(cfg, session, run, {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'});
    assert.equal(s.ingested.length, 2);
    assert.equal(s.ingested[1].request_key, keyOf('微信联系人.md', CONTACTS));
    assert.deepEqual([run.memory.files.length, run.memory.files[0].state, run.memory.files[0].error], [1, 'pending', null]);
  } finally {
    s.fetch.restore();
  }
});

test('upstream error text is scrubbed before it is stored on the file', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  s.ingestQueue.push(() => Response.json({detail: 'acme ingest at https://acme.internal/v1/x failed, Bearer abc.def'}, {status: 503}));
  try {
    const run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'});
    const {error} = run.memory.files[0];
    assert.equal(run.memory.files[0].state, 'failed');
    assert.ok(error.length > 0);
    assert.doesNotMatch(error, /https?:|acme|abc\.def/i);
    const stored = await getRun(cfg, session.accountId, RUN_ID);
    assert.doesNotMatch(stored.memory.files[0].error, /https?:|acme/i);
  } finally {
    s.fetch.restore();
  }
  const outcome = documentOutcome({status: 'failed', failure: {message: 'globex parser https://10.0.0.1/doc crashed'}}, 0, 0);
  assert.equal(outcome.state, 'failed');
  assert.doesNotMatch(outcome.error, /https?:|globex/i);
});

test('an expired login is passed through and nothing is recorded', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  s.ingestQueue.push(() => Response.json({ok: false, error: {code: 'INVALID_TOKEN', message: 'Token is invalid'}}, {status: 401}));
  try {
    await assert.rejects(addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'}),
      err => err.status === 401);
    assert.equal((await getRun(cfg, session.accountId, RUN_ID)).memory.files.length, 0);
  } finally {
    s.fetch.restore();
  }
});

test('refreshMemory follows jobs, then records the graph stats once every file is committed', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'});
    run = await addMemoryFile(cfg, session, run, {name: '储能材料行业交流.md', bytes: enc(MINUTES), source: 'demo'});
    s.jobs.set('job-1', 'committed');
    run = await refreshMemory(cfg, session, run, {now: () => 9000});
    assert.deepEqual(run.memory.files.map(file => file.state), ['committed', 'pending']);
    assert.equal(run.memory.completedAt, null);
    assert.equal(s.statsCalls, 0);
    const unchanged = await refreshMemory(cfg, session, run, {now: () => 9500});
    assert.equal(unchanged.version, run.version);
    s.jobs.set('job-2', 'committed');
    run = await refreshMemory(cfg, session, run, {now: () => 10000});
    assert.deepEqual(run.memory.files.map(file => file.state), ['committed', 'committed']);
    assert.equal(run.memory.completedAt, 10000);
    assert.deepEqual(run.memory.stats, {people: 3, organizations: 3, relations: 7});
    assert.equal(s.statsCalls, 1);
    const callsBefore = s.fetch.calls.length;
    const done = await refreshMemory(cfg, session, run, {now: () => 11000});
    assert.equal(done.version, run.version);
    assert.equal(s.fetch.calls.length, callsBefore);
  } finally {
    s.fetch.restore();
  }
});

test('a failed job can be added again under a fresh request key', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo', now: () => 2000});
    s.jobs.set('job-1', 'failed');
    run = await refreshMemory(cfg, session, run, {now: () => 3000});
    assert.equal(run.memory.files[0].state, 'failed');
    assert.equal(run.memory.files[0].error, 'Memory job job-1 failed');
    run = await addMemoryFile(cfg, session, run, {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo', now: () => 5000});
    const key = keyOf('微信联系人.md', CONTACTS);
    assert.equal(s.ingested[1].request_key, `${key}-r${(5000).toString(36)}`);
    assert.equal(s.ingested[1].source_id, s.ingested[1].request_key);
    assert.deepEqual([run.memory.files.length, run.memory.files[0].key, run.memory.files[0].state, run.memory.files[0].jobId, run.memory.files[0].error],
      [1, key, 'pending', 'job-2', null]);
  } finally {
    s.fetch.restore();
  }
});

test('a missing job fails the file, a transient error keeps it pending without a write, a stuck job times out', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo', now: () => 1000});
    run = await addMemoryFile(cfg, session, run, {name: '储能材料行业交流.md', bytes: enc(MINUTES), source: 'demo', now: () => 1000});
    s.jobError = () => Response.json({detail: 'busy'}, {status: 500});
    const same = await refreshMemory(cfg, session, run, {now: () => 2000});
    assert.equal(same.version, run.version);
    assert.deepEqual(same.memory.files.map(file => file.state), ['pending', 'pending']);
    s.jobError = null;
    s.jobs.delete('job-1');
    run = await refreshMemory(cfg, session, run, {now: () => 3000});
    assert.equal(run.memory.files[0].state, 'failed');
    assert.match(run.memory.files[0].error, /The writing job could not be found/);
    run = await refreshMemory(cfg, session, run, {now: () => 1000 + JOB_TIMEOUT_MS + 1});
    assert.equal(run.memory.files[1].state, 'failed');
    assert.match(run.memory.files[1].error, /more than 30 minutes/);
    assert.equal(run.memory.completedAt, null);
  } finally {
    s.fetch.restore();
  }
});

test('Memory down during a poll reports refreshError memory and leaves the stored run unchanged', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    const run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo', now: () => 1000});
    const stored = JSON.stringify(await getRun(cfg, session.accountId, RUN_ID));
    s.jobError = () => Response.json({detail: 'service unavailable'}, {status: 503});
    const down = await refreshMemory(cfg, session, run, {now: () => 2000});
    assert.equal(down.refreshError.service, 'memory');
    assert.equal(typeof down.refreshError.code, 'string');
    assert.ok(!Object.keys(down).includes('refreshError'));
    assert.deepEqual([down.version, down.memory.files[0].state], [run.version, 'pending']);
    assert.equal(JSON.stringify(await getRun(cfg, session.accountId, RUN_ID)), stored);
    assert.ok(!stored.includes('refreshError'));
    s.jobError = null;
    s.jobs.set('job-1', 'committed');
    const clean = await refreshMemory(cfg, session, run, {now: () => 3000});
    assert.equal(clean.refreshError, undefined);
    assert.equal(clean.memory.files[0].state, 'committed');
  } finally {
    s.fetch.restore();
  }
});

test('document status moves uploads to committed or failed', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: 'deck.pdf', bytes: new Uint8Array([1, 2]), source: 'upload', now: () => 1000});
    run = await addMemoryFile(cfg, session, run, {name: 'notes.docx', bytes: new Uint8Array([3, 4]), source: 'upload', now: () => 1000});
    const same = await refreshMemory(cfg, session, run, {now: () => 2000});
    assert.equal(same.version, run.version);
    s.docs.set('doc_1', {document_id: 'doc_1', status: 'completed', stage: 'completed', recall_ready: true});
    s.docs.set('doc_2', {document_id: 'doc_2', status: 'failed', stage: 'failed', failure: {message: 'parse error'}});
    run = await refreshMemory(cfg, session, run, {now: () => 3000});
    assert.deepEqual(run.memory.files.map(file => [file.state, file.error]), [['committed', null], ['failed', 'Memory document doc_2 failed: parse error']]);
    assert.equal(run.memory.completedAt, null);
    assert.equal(s.statsCalls, 0);
  } finally {
    s.fetch.restore();
  }
});

test('documentOutcome waits briefly for a missing document before failing it', () => {
  assert.deepEqual(documentOutcome({status: 'missing'}, 1000, 1000 + MISSING_GRACE_MS - 1), {state: 'pending', error: null});
  assert.equal(documentOutcome({status: 'missing'}, 1000, 1000 + MISSING_GRACE_MS + 1).state, 'failed');
  assert.deepEqual(documentOutcome({status: 'parsing', recall_ready: false}, 0, 0), {state: 'pending', error: null});
  assert.deepEqual(documentOutcome({status: 'written', recall_ready: true}, 0, 0), {state: 'committed', error: null});
  assert.deepEqual(documentOutcome({status: 'failed', error: 'ocr failed'}, 0, 0), {state: 'failed', error: 'Memory document failed: ocr failed'});
  assert.deepEqual(documentOutcome({document_id: 'doc_9', status: 'failed', failure: {message: 'parser crashed at 10.0.0.5:9000'}}, 0, 0), {state: 'failed', error: 'Memory document doc_9 failed: parser crashed at [host]'});
  assert.deepEqual(documentOutcome({status: 'failed'}, 0, 0), {state: 'failed', error: 'Memory document failed'});
});

test('a stats failure still completes the step and the next refresh fills the stats in', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  s.statsError = () => Response.json({ok: false, error: {code: 'INTERNAL', message: 'down'}}, {status: 500});
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'});
    s.jobs.set('job-1', 'committed');
    run = await refreshMemory(cfg, session, run, {now: () => 4000});
    assert.equal(run.memory.completedAt, 4000);
    assert.equal(run.memory.stats, null);
    assert.equal(run.refreshError.service, 'memory');
    const still = await refreshMemory(cfg, session, run, {now: () => 4500});
    assert.equal(still.version, run.version);
    assert.equal(still.refreshError.service, 'memory');
    s.statsError = null;
    run = await refreshMemory(cfg, session, run, {now: () => 5000});
    assert.deepEqual(run.memory.stats, {people: 3, organizations: 3, relations: 7});
    assert.equal(run.memory.completedAt, 4000);
    assert.equal(run.refreshError, undefined);
  } finally {
    s.fetch.restore();
  }
});

test('adding a file after completion reopens the step until it is committed', async () => {
  const cfg = testConfig();
  const s = memoryStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo'});
    s.jobs.set('job-1', 'committed');
    run = await refreshMemory(cfg, session, run, {now: () => 4000});
    assert.equal(run.memory.completedAt, 4000);
    run = await addMemoryFile(cfg, session, run, {name: '储能材料行业交流.md', bytes: enc(MINUTES), source: 'upload'});
    assert.equal(run.memory.completedAt, null);
    s.jobs.set('job-2', 'committed');
    run = await refreshMemory(cfg, session, run, {now: () => 6000});
    assert.equal(run.memory.completedAt, 6000);
    assert.equal(s.statsCalls, 2);
  } finally {
    s.fetch.restore();
  }
});

const GATEWAY_CFG = () => testConfig({memoryBase: 'https://rsi.test/api', memoryViaGateway: true, oauthResource: 'https://rsi.test/mcp'});

function gatewayStack() {
  const s = {ingested: [], jobs: new Map(), headers: []};
  s.fetch = installFetch([
    {method: 'POST', url: 'https://rsi.test/api/memory/ingest', reply: async req => {
      s.headers.push(req.headers.get('x-auth-type'));
      const body = JSON.parse(await req.text());
      s.ingested.push(body);
      const jobId = `job-${s.ingested.length}`;
      s.jobs.set(jobId, 'pending');
      return {source_id: body.source_id, revision: 1, job_id: jobId, content_hash: 'hash', state: 'pending'};
    }},
    {method: 'GET', url: /^https:\/\/rsi\.test\/api\/memory\/jobs\/[^/?]+$/, reply: (req, url) => {
      s.headers.push(req.headers.get('x-auth-type'));
      const jobId = decodeURIComponent(url.pathname.split('/').pop());
      return {job_id: jobId, state: s.jobs.get(jobId)};
    }},
  ]);
  return s;
}

test('through the gateway, own PDF and Word files are refused with the text-only message and nothing is stored', async () => {
  const cfg = GATEWAY_CFG();
  const s = gatewayStack();
  try {
    const run = await seedRun(cfg);
    for (const name of ['deck.pdf', 'memo.docx']) {
      await assert.rejects(addMemoryFile(cfg, session, run, {name, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), source: 'upload'}),
        err => err instanceof ServiceError && err.status === 415 && err.code === 'unsupported_file' && /^This environment accepts only Markdown and text/.test(err.text('en')) && /^这个环境只支持 Markdown 和文本/.test(err.text('zh')));
    }
    assert.equal(s.fetch.calls.length, 0);
    assert.deepEqual((await getRun(cfg, session.accountId, RUN_ID)).memory.files, []);
  } finally {
    s.fetch.restore();
  }
});

test('through the gateway, Markdown goes to /memory/ingest and step 1 completes with stats left null', async () => {
  const cfg = GATEWAY_CFG();
  const s = gatewayStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'upload', now: () => 2000});
    assert.equal(s.ingested[0].content, `Source: 微信联系人\n\n${CONTACTS}`);
    s.jobs.set('job-1', 'committed');
    run = await refreshMemory(cfg, session, run, {now: () => 3000});
    assert.equal(run.refreshError, undefined);
    assert.equal(run.memory.files[0].state, 'committed');
    assert.equal(run.memory.completedAt, 3000);
    assert.equal(run.memory.stats, null);
    assert.deepEqual(s.headers, ['mcp_access_token', 'mcp_access_token']);
    assert.deepEqual(s.fetch.unmatched, []);
    const again = await refreshMemory(cfg, session, run, {now: () => 4000});
    assert.equal(again.version, run.version, 'a finished step 1 without stats is not rewritten');
    assert.deepEqual(s.fetch.unmatched, []);
  } finally {
    s.fetch.restore();
  }
});

test('through the gateway, a document already pending from before fails with the text-only message without a call', async () => {
  const cfg = GATEWAY_CFG();
  const s = gatewayStack();
  try {
    const run = await seedRun(cfg);
    run.memory.files.push({key: 'demo-doc', name: 'deck.pdf', source: 'upload', kind: 'document', state: 'pending', jobId: null, documentId: 'doc_1', error: null, addedAt: 2000});
    await kvPutJson(cfg.kv, runKey(session.accountId, RUN_ID), run);
    const out = await refreshMemory(cfg, session, run, {now: () => 3000});
    assert.equal(out.memory.files[0].state, 'failed');
    assert.match(out.memory.files[0].error, /^This environment accepts only Markdown and text/);
    assert.equal(s.fetch.calls.length, 0);
  } finally {
    s.fetch.restore();
  }
});

test('the Chinese locale writes the 资料 prefix and Chinese file errors', async () => {
  const cfg = GATEWAY_CFG();
  const s = gatewayStack();
  try {
    let run = await addMemoryFile(cfg, session, await seedRun(cfg), {name: '微信联系人.md', bytes: enc(CONTACTS), source: 'demo', now: () => 2000, locale: 'zh'});
    assert.equal(s.ingested[0].content, `资料：微信联系人\n\n${CONTACTS}`);
    run.memory.files.push({key: 'demo-doc', name: 'deck.pdf', source: 'upload', kind: 'document', state: 'pending', jobId: null, documentId: 'doc_1', error: null, addedAt: 2000});
    await kvPutJson(cfg.kv, runKey(session.accountId, RUN_ID), run);
    const out = await refreshMemory(cfg, session, run, {now: () => 3000, locale: 'zh'});
    assert.match(out.memory.files.at(-1).error, /^这个环境只支持 Markdown 和文本，PDF 和 Word 请另存为 \.md 或 \.txt 再上传$/);
  } finally {
    s.fetch.restore();
  }
});

test('by default no file error stored in the run contains Chinese', () => {
  for (const status of [{status: 'failed'}, {status: 'missing'}, {stage: 'failed', failure: {message: 'upstream refused'}}]) {
    assert.equal(/[\u3000-\u9fff]/.test(documentOutcome(status, 0, 10 * 60e3).error ?? ''), false);
  }
});
