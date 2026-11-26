import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig, installFetch} from './helpers/fake-services.mjs';
import {ingest, getJob, recall, listItems, graphStats, uploadDocument, documentStatus} from '../server/demo/services/memory.mjs';
import {ServiceError} from '../server/demo/http.mjs';

const VU = 'vu_0123456789abcdef0123456789abcdef';
const serviceError = (service, status, code) => (err) => {
  assert.ok(err instanceof ServiceError, `expected ServiceError, got ${err}`);
  assert.equal(err.service, service);
  assert.equal(err.status, status);
  if (code) assert.equal(err.code, code);
  return true;
};
const assertMemoryHeaders = (call, json) => {
  assert.equal(call.headers.get('authorization'), 'Bearer oauth-token');
  assert.equal(call.headers.get('x-virtual-user-id'), VU);
  assert.equal(call.headers.get('x-auth-type'), null);
  assert.equal(call.headers.get('x-cosens-auth-type'), null);
  if (json) assert.equal(call.headers.get('content-type'), 'application/json');
};

let mock = null;
afterEach(() => { mock?.restore(); mock = null; });

test('ingest posts the SDK body with durable document source and returns the receipt', async () => {
  const cfg = testConfig();
  const receipt = {source_id: 'demo-abc', revision: 1, job_id: 'job-1', content_hash: 'h', state: 'pending'};
  mock = installFetch([{method: 'POST', url: 'https://memory.test/memory/ingest', reply: () => receipt}]);
  const out = await ingest(cfg, 'oauth-token', VU, {content: '资料：微信联系人\n\n# 联系人', requestKey: 'demo-abc'});
  assert.deepEqual(out, receipt);
  const call = mock.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://memory.test/memory/ingest');
  assertMemoryHeaders(call, true);
  assert.deepEqual(JSON.parse(call.body), {content: '资料：微信联系人\n\n# 联系人', request_key: 'demo-abc', source_id: 'demo-abc', source_kind: 'document', durable: true});
});

test('ingest sends an explicit sourceId and sourceKind when given', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://memory.test/memory/ingest', reply: () => ({job_id: 'j', state: 'pending'})}]);
  await ingest(cfg, 'oauth-token', VU, {content: 'x', requestKey: 'k1', sourceId: 's1', sourceKind: 'message'});
  assert.deepEqual(JSON.parse(mock.calls[0].body), {content: 'x', request_key: 'k1', source_id: 's1', source_kind: 'message', durable: true});
});

test('ingest maps 409 idempotency conflicts and refuses bad input before calling', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://memory.test/memory/ingest', reply: () => Response.json({detail: 'idempotency key reused with different request'}, {status: 409})}]);
  await assert.rejects(ingest(cfg, 'oauth-token', VU, {content: 'x', requestKey: 'k'}), serviceError('memory', 409));
  const before = mock.calls.length;
  await assert.rejects(ingest(cfg, 'oauth-token', VU, {content: '', requestKey: 'k'}), TypeError);
  await assert.rejects(ingest(cfg, 'oauth-token', VU, {content: 'x', requestKey: 'k'.repeat(257)}), TypeError);
  await assert.rejects(ingest(cfg, 'oauth-token', 'vu_bad', {content: 'x', requestKey: 'k'}), serviceError('memory', 400, 'invalid_virtual_user_id'));
  await assert.rejects(ingest(cfg, '', VU, {content: 'x', requestKey: 'k'}), serviceError('auth', 401, 'not_authenticated'));
  assert.equal(mock.calls.length, before);
});

test('getJob reads state (not status) from the job route', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'GET', url: 'https://memory.test/memory/jobs/d5e793b7-dbe0', reply: () => ({job_id: 'd5e793b7-dbe0', state: 'committed'})}]);
  assert.deepEqual(await getJob(cfg, 'oauth-token', VU, 'd5e793b7-dbe0'), {job_id: 'd5e793b7-dbe0', state: 'committed'});
  assert.equal(mock.calls[0].url, 'https://memory.test/memory/jobs/d5e793b7-dbe0');
  assertMemoryHeaders(mock.calls[0], false);
  assert.equal(mock.calls[0].body, null);
});

test('getJob rejects an unknown state and maps 404', async () => {
  const cfg = testConfig();
  let reply = {job_id: 'j', status: 'committed'};
  mock = installFetch([{method: 'GET', url: /\/memory\/jobs\//, reply: () => reply}]);
  await assert.rejects(getJob(cfg, 'oauth-token', VU, 'j'), serviceError('memory', 502, 'invalid_response'));
  reply = Response.json({detail: 'resource unavailable'}, {status: 404});
  await assert.rejects(getJob(cfg, 'oauth-token', VU, 'j'), serviceError('memory', 404));
});

test('recall posts query and token_budget (default 2000) and returns items', async () => {
  const cfg = testConfig();
  const items = [{id: 'e1', kind: 'episode', text: '资料：2026-03-14 腾讯会议纪要 储能材料行业交流\n\n# 纪要', score: 0.83}];
  mock = installFetch([{method: 'POST', url: 'https://memory.test/memory/recall', reply: () => ({query: '谁是专家？', items, estimated_tokens: 1123})}]);
  const out = await recall(cfg, 'oauth-token', VU, '谁是专家？');
  assert.deepEqual(out, {query: '谁是专家？', items, estimated_tokens: 1123});
  assertMemoryHeaders(mock.calls[0], true);
  assert.deepEqual(JSON.parse(mock.calls[0].body), {query: '谁是专家？', token_budget: 2000});
  await recall(cfg, 'oauth-token', VU, 'q', 800);
  assert.deepEqual(JSON.parse(mock.calls[1].body), {query: 'q', token_budget: 800});
});

test('recall maps VU errors from the AppError envelope', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://memory.test/memory/recall', reply: () => Response.json({ok: false, error: {code: 'VIRTUAL_USER_NOT_FOUND', message: 'Virtual User was not found', details: null}}, {status: 404})}]);
  await assert.rejects(recall(cfg, 'oauth-token', VU, 'q'), serviceError('memory', 404, 'VIRTUAL_USER_NOT_FOUND'));
});

test('listItems sends the limit query parameter', async () => {
  const cfg = testConfig();
  const body = {sources: [{source_id: 'demo-1', revision: 1, content_hash: 'h', recorded_at: '2026-11-20T18:42:28+00:00', text: 't', truncated: false}], experiences: [], limit: 200};
  mock = installFetch([{method: 'GET', url: 'https://memory.test/memory/items', reply: () => body}]);
  assert.deepEqual(await listItems(cfg, 'oauth-token', VU), body);
  assert.equal(mock.calls[0].url, 'https://memory.test/memory/items?limit=200');
  await listItems(cfg, 'oauth-token', VU, 5);
  assert.equal(mock.calls[1].url, 'https://memory.test/memory/items?limit=5');
});

test('graphStats counts Entity person, organisation-like subtypes and RELATION edges', async () => {
  const cfg = testConfig();
  const graph = {ok: true, user_id: VU, graph_id: `context-${VU}`, graph: {
    nodes: {total: 225, types: [
      {type: 'Entity', count: 199, subtypes: [{type: 'person', count: 78}, {type: 'organization', count: 52}, {type: 'company', count: 3}, {type: 'institution', count: 2}, {type: 'project', count: 15}]},
      {type: 'Episode', count: 24, subtypes: [{type: 'person', count: 999}]},
      {type: 'Community', count: 2, subtypes: []},
    ]},
    edges: {total: 793, types: [{type: 'RELATION', count: 326}, {type: 'SUPPORTS', count: 310}, {type: 'COMMUNITY_MEMBER', count: 98}]},
    values: {total: 429, types: [{type: 'RELATION', count: 429}]},
  }};
  mock = installFetch([{method: 'POST', url: 'https://memory.test/v1/graph/types', reply: () => graph}]);
  assert.deepEqual(await graphStats(cfg, 'oauth-token', VU), {people: 78, organizations: 57, relations: 326});
  assertMemoryHeaders(mock.calls[0], true);
  assert.deepEqual(JSON.parse(mock.calls[0].body), {graph_type: 'context'});
});

test('graphStats returns zeros for an empty graph', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://memory.test/v1/graph/types', reply: () => ({ok: true, graph: {nodes: {total: 0, types: []}, edges: {total: 0, types: []}}})}]);
  assert.deepEqual(await graphStats(cfg, 'oauth-token', VU), {people: 0, organizations: 0, relations: 0});
});

test('uploadDocument sends multipart with only the file part and the VU header', async () => {
  const cfg = testConfig();
  const response = {ok: true, document_id: 'doc_1', parser_job_id: 'p1', filename: '尽调笔记.pdf', status: 'uploaded', stage: 'uploaded'};
  mock = installFetch([{method: 'POST', url: 'https://memory.test/v1/document/upload', reply: () => response}]);
  const out = await uploadDocument(cfg, 'oauth-token', VU, {name: '尽调笔记.pdf', bytes: new TextEncoder().encode('%PDF-1.4 test'), mime: 'application/pdf'});
  assert.deepEqual(out, response);
  const call = mock.calls[0];
  assert.equal(call.headers.get('authorization'), 'Bearer oauth-token');
  assert.equal(call.headers.get('x-virtual-user-id'), VU);
  assert.match(call.headers.get('content-type'), /^multipart\/form-data; boundary=/);
  assert.match(call.body, /Content-Disposition: form-data; name="file"; filename="尽调笔记\.pdf"/);
  assert.match(call.body, /Content-Type: application\/pdf/);
  assert.match(call.body, /%PDF-1\.4 test/);
  assert.equal((call.body.match(/Content-Disposition/g) ?? []).length, 1);
  assert.doesNotMatch(call.body, /name="(graph_id|user_id)"/);
});

test('uploadDocument rejects a response without document_id', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://memory.test/v1/document/upload', reply: () => ({ok: true})}]);
  await assert.rejects(uploadDocument(cfg, 'oauth-token', VU, {name: 'a.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf'}), serviceError('memory', 502, 'invalid_response'));
});

test('documentStatus posts document_ids and returns statuses; empty list makes no call', async () => {
  const cfg = testConfig();
  const statuses = [{document_id: 'doc_1', status: 'completed', stage: 'completed', recall_ready: true, derived_complete: true, failed_jobs: []}];
  mock = installFetch([{method: 'POST', url: 'https://memory.test/v1/document/status', reply: () => ({ok: true, backend: 'memory', runtime: 'memory', statuses})}]);
  assert.deepEqual(await documentStatus(cfg, 'oauth-token', VU, ['doc_1']), statuses);
  assertMemoryHeaders(mock.calls[0], true);
  assert.deepEqual(JSON.parse(mock.calls[0].body), {document_ids: ['doc_1']});
  assert.deepEqual(await documentStatus(cfg, 'oauth-token', VU, []), []);
  assert.equal(mock.calls.length, 1);
});

test('plain-text 5xx from Memory maps to a memory ServiceError', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://memory.test/memory/recall', reply: () => new Response('Bad Gateway', {status: 502})}]);
  await assert.rejects(recall(cfg, 'oauth-token', VU, 'q'), serviceError('memory', 502));
});

test('through the gateway, the four forwarded Memory routes use the gateway base and X-Auth-Type: mcp_access_token', async () => {
  const cfg = testConfig({memoryBase: 'https://rsi.test/api', memoryViaGateway: true, oauthResource: 'https://rsi.test/mcp'});
  mock = installFetch([
    {method: 'POST', url: 'https://rsi.test/api/memory/ingest', reply: () => ({job_id: 'j1', state: 'pending'})},
    {method: 'GET', url: 'https://rsi.test/api/memory/jobs/j1', reply: () => ({job_id: 'j1', state: 'committed'})},
    {method: 'POST', url: 'https://rsi.test/api/memory/recall', reply: () => ({items: []})},
    {method: 'GET', url: 'https://rsi.test/api/memory/items', reply: () => ({sources: []})},
  ]);
  await ingest(cfg, 'oauth-token', VU, {content: 'x', requestKey: 'k'});
  await getJob(cfg, 'oauth-token', VU, 'j1');
  await recall(cfg, 'oauth-token', VU, '赵一凡');
  await listItems(cfg, 'oauth-token', VU, 5);
  assert.equal(mock.calls.length, 4);
  for (const call of mock.calls) {
    assert.equal(call.headers.get('authorization'), 'Bearer oauth-token');
    assert.equal(call.headers.get('x-auth-type'), 'mcp_access_token');
    assert.equal(call.headers.get('x-virtual-user-id'), VU);
  }
});

test('through the gateway, graph stats and document upload/status are refused without a call', async () => {
  const cfg = testConfig({memoryBase: 'https://rsi.test/api', memoryViaGateway: true, oauthResource: 'https://rsi.test/mcp'});
  mock = installFetch([]);
  await assert.rejects(graphStats(cfg, 'oauth-token', VU), serviceError('memory', 501, 'not_available'));
  await assert.rejects(uploadDocument(cfg, 'oauth-token', VU, {name: 'a.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf'}), serviceError('memory', 415, 'unsupported_file'));
  await assert.rejects(documentStatus(cfg, 'oauth-token', VU, ['doc_1']), serviceError('memory', 501, 'not_available'));
  assert.equal(mock.calls.length, 0);
});
