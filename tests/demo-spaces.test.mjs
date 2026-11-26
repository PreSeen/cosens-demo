import {test} from 'node:test';
import assert from 'node:assert/strict';
import {envFromConfig, installFetch, seedSession, sessionCookie, testConfig} from './helpers/fake-services.mjs';
import {kvGetJson, kvPutJson} from '../server/demo/kv.mjs';
import {ServiceError} from '../server/demo/http.mjs';
import {indexKey, newRun, runKey} from '../server/demo/runs.mjs';
import {WRITE_ROLES, canWrite, listSpaces, requireWritableSpace} from '../server/demo/spaces.mjs';
import {onRequest as apiMiddleware} from '../functions/api/demo/_middleware.js';
import * as spacesRoute from '../functions/api/demo/investor/spaces.js';
import * as runsRoute from '../functions/api/demo/investor/runs/index.js';

const ORIGIN = 'https://cosens.ai';
const ACCOUNT = 'acct_test';
const session = {accessToken: 'tok', accountId: ACCOUNT};
const vuId = n => `vu_${String(n).repeat(32).slice(0, 32)}`;
const OWN = vuId(1), SHARED_WRITE = vuId(2), SHARED_READ = vuId(3), OLD_DEMO = vuId(4);
const vu = (id, role, createdAt, name = `空间 ${id.slice(3, 7)}`) => ({vuId: id, name, ownerAccountId: role === 'owner' ? ACCOUNT : 'acct_other', role, createdAt, updatedAt: createdAt});
const envelope = data => ({requestId: 'req-1', timestamp: '2026-11-22T06:30:00Z', data, error: null});
const failure = (status, code, message) => Response.json({requestId: 'req-2', timestamp: '2026-11-22T06:30:00Z', data: null, error: {code, message}}, {status});
const LIST_URL = 'https://account.test/virtual-users';
const listRoute = reply => ({method: 'GET', url: LIST_URL, reply});
const getRoute = reply => ({method: 'GET', url: /^https:\/\/account\.test\/virtual-users\/vu_/, reply});
const createRoute = reply => ({method: 'POST', url: LIST_URL, reply});
const ALL = [
  vu(OWN, 'owner', '2026-11-21T08:00:00Z', '我的工作记忆'),
  vu(SHARED_WRITE, 'write', '2026-11-22T01:00:00Z', '团队共享'),
  vu(SHARED_READ, 'read', '2026-11-22T02:00:00Z', '只读资料'),
  vu(OLD_DEMO, 'owner', '2026-11-20T06:30:00Z', 'CoSens 演示 · 投资人 · 11-20 14:30'),
];

async function seedRunFor(cfg, id, vuIdValue, accountId = ACCOUNT) {
  const run = newRun({id, vuId: vuIdValue, vuName: 'x', now: 1000});
  await kvPutJson(cfg.kv, runKey(accountId, id), run);
  const index = (await kvGetJson(cfg.kv, indexKey(accountId))) ?? [];
  await kvPutJson(cfg.kv, indexKey(accountId), [id, ...index]);
}

function withFetch(t, routes) {
  const mock = installFetch(routes);
  t.after(() => mock.restore());
  return mock;
}

/** Run the API middleware, then the route, the way Pages chains them. */
async function send(env, handler, {method = 'GET', path, json: body, cookie = sessionCookie('sid-test')} = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== 'GET') headers.Origin = ORIGIN;
  const init = {method, headers};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const chain = [apiMiddleware, handler];
  const context = {request: new Request(ORIGIN + path, init), env, params: {}, data: {}, waitUntil: () => {}, next: null};
  let index = 0;
  context.next = async () => chain[++index](context);
  return chain[0](context);
}

async function routeSetup(t, routes) {
  const cfg = testConfig();
  await seedSession(cfg);
  const mock = withFetch(t, routes);
  return {cfg, mock, env: envFromConfig(cfg)};
}

test('canWrite admits the Owner and write members only', () => {
  assert.deepEqual(WRITE_ROLES, ['owner', 'write']);
  assert.equal(canWrite({role: 'owner'}), true);
  assert.equal(canWrite({role: 'write'}), true);
  for (const role of ['read', null, undefined, '', 'OWNER', 'admin']) assert.equal(canWrite({role}), false, String(role));
  assert.equal(canWrite(null), false);
});

test('listSpaces lists writable VUs newest first, marks demo VUs and counts read-only ones', async t => {
  const cfg = testConfig();
  await seedRunFor(cfg, 'run_aaaaaaaaaaaaaaaa', OLD_DEMO);
  await seedRunFor(cfg, 'run_bbbbbbbbbbbbbbbb', SHARED_READ);
  // A run of another account in the same KV never marks this account's VU.
  await seedRunFor(cfg, 'run_cccccccccccccccc', OWN, 'acct_other');
  const mock = withFetch(t, [listRoute(() => envelope(ALL))]);
  const result = await listSpaces(cfg, session);
  assert.deepEqual(result, {
    spaces: [
      {vuId: SHARED_WRITE, name: '团队共享', createdAt: Date.parse('2026-11-22T01:00:00Z'), role: 'write', demo: false},
      {vuId: OWN, name: '我的工作记忆', createdAt: Date.parse('2026-11-21T08:00:00Z'), role: 'owner', demo: false},
      {vuId: OLD_DEMO, name: 'CoSens 演示 · 投资人 · 11-20 14:30', createdAt: Date.parse('2026-11-20T06:30:00Z'), role: 'owner', demo: true},
    ],
    readOnly: 1,
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].headers.get('authorization'), 'Bearer tok');
});

test('listSpaces answers an empty list for a visitor without VUs, and one entry for one VU', async t => {
  const cfg = testConfig();
  let reply = envelope([]);
  withFetch(t, [listRoute(() => reply)]);
  assert.deepEqual(await listSpaces(cfg, session), {spaces: [], readOnly: 0});
  reply = envelope([vu(SHARED_READ, 'read', '2026-11-22T02:00:00Z')]);
  assert.deepEqual(await listSpaces(cfg, session), {spaces: [], readOnly: 1});
  reply = envelope([vu(OWN, 'owner', null)]);
  assert.deepEqual(await listSpaces(cfg, session), {spaces: [{vuId: OWN, name: '空间 1111', createdAt: null, role: 'owner', demo: false}], readOnly: 0});
});

test('listSpaces passes an account service failure through', async t => {
  const cfg = testConfig();
  withFetch(t, [listRoute(() => failure(503, 'service_unavailable', 'down'))]);
  await assert.rejects(listSpaces(cfg, session), err => err instanceof ServiceError && err.service === 'account' && err.status === 503);
});

test('requireWritableSpace re-reads the VU and refuses ids it cannot use', async t => {
  const cfg = testConfig();
  const replies = {[OWN]: () => envelope(ALL[0]), [SHARED_WRITE]: () => envelope(ALL[1]), [SHARED_READ]: () => envelope(ALL[2]),
    [vuId(9)]: () => failure(404, 'virtual_user_not_found', 'Virtual user not found'), [vuId(8)]: () => failure(502, 'bad_gateway', 'upstream')};
  const mock = withFetch(t, [getRoute((req, url) => replies[url.pathname.split('/').pop()]())]);
  assert.equal((await requireWritableSpace(cfg, session, OWN)).vuId, OWN);
  assert.equal((await requireWritableSpace(cfg, session, SHARED_WRITE)).role, 'write');
  const refused = (status, code) => err => err instanceof ServiceError && err.service === null && err.status === status && err.code === code;
  await assert.rejects(requireWritableSpace(cfg, session, SHARED_READ), refused(403, 'space_read_only'));
  await assert.rejects(requireWritableSpace(cfg, session, vuId(9)), refused(404, 'space_not_found'));
  await assert.rejects(requireWritableSpace(cfg, session, vuId(8)), err => err.service === 'account' && err.status === 502);
  const calls = mock.calls.length;
  for (const bad of ['', 'vu_123', 'VU_' + '1'.repeat(32), `${OWN}/members`, null, 42]) {
    await assert.rejects(requireWritableSpace(cfg, session, bad), refused(400, 'invalid_request'), String(bad));
  }
  assert.equal(mock.calls.length, calls, 'a malformed id never reaches the account service');
});

test('GET spaces needs a session and answers the writable spaces, private and not indexed', async t => {
  const {cfg, env, mock} = await routeSetup(t, [listRoute(() => envelope(ALL))]);
  await seedRunFor(cfg, 'run_aaaaaaaaaaaaaaaa', OLD_DEMO);
  const anonymous = await send(env, spacesRoute.onRequestGet, {path: '/api/demo/investor/spaces', cookie: null});
  assert.equal(anonymous.status, 401);
  assert.equal(mock.calls.length, 0);
  const response = await send(env, spacesRoute.onRequestGet, {path: '/api/demo/investor/spaces'});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const body = await response.json();
  assert.deepEqual(body.spaces.map(s => [s.vuId, s.demo]), [[SHARED_WRITE, false], [OWN, false], [OLD_DEMO, true]]);
  assert.equal(body.readOnly, 1);
});

test('GET spaces reports an account service failure with its service', async t => {
  const {env} = await routeSetup(t, [listRoute(() => failure(500, 'internal_error', 'boom'))]);
  const response = await send(env, spacesRoute.onRequestGet, {path: '/api/demo/investor/spaces'});
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.service, 'account');
});

test('POST runs with vuId starts the run in that VU without creating one', async t => {
  for (const space of [ALL[0], ALL[1]]) {
    const {cfg, env, mock} = await routeSetup(t, [getRoute(() => envelope({...space, members: []})), createRoute(() => { throw new Error('no VU may be created'); })]);
    const response = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: {timeZone: 'Asia/Shanghai', vuId: space.vuId}});
    assert.equal(response.status, 201, space.role);
    const {run} = await response.json();
    assert.equal(run.vuId, space.vuId);
    assert.equal(run.vuName, space.name);
    assert.equal(run.space, 'existing');
    assert.deepEqual(mock.calls.map(call => `${call.method} ${new URL(call.url).pathname}`), [`GET /virtual-users/${space.vuId}`]);
    assert.deepEqual(await kvGetJson(cfg.kv, indexKey(ACCOUNT)), [run.id]);
    const listed = await (await send(env, runsRoute.onRequestGet, {path: '/api/demo/investor/runs'})).json();
    assert.deepEqual(listed.runs.map(r => [r.id, r.vuId, r.space]), [[run.id, space.vuId, 'existing']]);
  }
});

test('POST runs refuses a VU the visitor may only read, or cannot see, and stores no run', async t => {
  for (const [reply, status, code] of [
    [() => envelope(ALL[2]), 403, 'space_read_only'],
    [() => failure(404, 'virtual_user_not_found', 'Virtual user not found'), 404, 'space_not_found'],
  ]) {
    const {cfg, env, mock} = await routeSetup(t, [getRoute(reply)]);
    const response = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: {vuId: SHARED_READ}});
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.match(body.error.message, /create a new demo space/);
    assert.equal(mock.calls.length, 1);
    assert.equal(await kvGetJson(cfg.kv, indexKey(ACCOUNT)), null);
  }
});

test('POST runs refuses a malformed vuId before calling the account service', async t => {
  for (const bad of [null, 7, '', 'vu_x', ['vu']]) {
    const {cfg, env, mock} = await routeSetup(t, []);
    const response = await send(env, runsRoute.onRequestPost, {method: 'POST', path: '/api/demo/investor/runs', json: {vuId: bad}});
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal((await response.json()).error.code, 'invalid_request');
    assert.equal(mock.calls.length, 0);
    assert.equal(await kvGetJson(cfg.kv, indexKey(ACCOUNT)), null);
  }
});
