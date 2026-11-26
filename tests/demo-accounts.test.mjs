import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig, installFetch} from './helpers/fake-services.mjs';
import {createVirtualUser, listVirtualUsers, getVirtualUser} from '../server/demo/services/accounts.mjs';
import {ServiceError} from '../server/demo/http.mjs';

const VU = 'vu_0123456789abcdef0123456789abcdef';
const RAW = {vuId: VU, name: 'CoSens 演示 · 投资人 · 11-20 14:30', ownerAccountId: 'acct_owner', role: 'owner', createdAt: '2026-11-20T06:30:00Z', updatedAt: '2026-11-20T06:30:00Z'};
const envelope = (data) => ({requestId: 'req-1', timestamp: '2026-11-20T06:30:00Z', data, error: null});
const failure = (status, code, message) => Response.json({requestId: 'req-2', timestamp: '2026-11-20T06:30:00Z', data: null, error: {code, message}}, {status});
const serviceError = (service, status, code) => (err) => {
  assert.ok(err instanceof ServiceError, `expected ServiceError, got ${err}`);
  assert.equal(err.service, service);
  assert.equal(err.status, status);
  if (code) assert.equal(err.code, code);
  return true;
};

let mock = null;
afterEach(() => { mock?.restore(); mock = null; });

test('createVirtualUser posts the trimmed name with the bearer token and unwraps data', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://account.test/virtual-users', reply: () => envelope({...RAW, members: [{accountId: 'x'}]})}]);
  const vu = await createVirtualUser(cfg, 'oauth-token', '  CoSens 演示 · 投资人 · 11-20 14:30  ');
  assert.deepEqual(vu, RAW);
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.equal(call.url, 'https://account.test/virtual-users');
  assert.equal(call.headers.get('authorization'), 'Bearer oauth-token');
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.equal(call.headers.get('x-auth-type'), null);
  assert.equal(call.headers.get('x-virtual-user-id'), null);
  assert.deepEqual(JSON.parse(call.body), {name: 'CoSens 演示 · 投资人 · 11-20 14:30'});
});

test('createVirtualUser rejects empty and over-long names before calling', async () => {
  const cfg = testConfig();
  mock = installFetch([]);
  await assert.rejects(createVirtualUser(cfg, 't', '   '), TypeError);
  await assert.rejects(createVirtualUser(cfg, 't', 'x'.repeat(161)), TypeError);
  assert.equal(mock.calls.length, 0);
});

test('listVirtualUsers returns every VU from the data array', async () => {
  const cfg = testConfig();
  const shared = {...RAW, vuId: 'vu_ffffffffffffffffffffffffffffffff', role: 'read', ownerAccountId: 'acct_other'};
  mock = installFetch([{method: 'GET', url: 'https://account.test/virtual-users', reply: () => envelope([RAW, shared])}]);
  assert.deepEqual(await listVirtualUsers(cfg, 'tok'), [RAW, shared]);
  assert.equal(mock.calls[0].headers.get('authorization'), 'Bearer tok');
  assert.equal(mock.calls[0].body, null);
});

test('listVirtualUsers refuses a non-array data field', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'GET', url: 'https://account.test/virtual-users', reply: () => envelope({items: []})}]);
  await assert.rejects(listVirtualUsers(cfg, 'tok'), serviceError('account', 502, 'invalid_response'));
});

test('getVirtualUser encodes the id and drops members', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'GET', url: `https://account.test/virtual-users/${VU}`, reply: () => envelope({...RAW, members: []})}]);
  assert.deepEqual(await getVirtualUser(cfg, 'tok', VU), RAW);
  assert.equal(mock.calls[0].url, `https://account.test/virtual-users/${VU}`);
});

test('error envelopes map to account ServiceErrors with the upstream status and code', async () => {
  const cfg = testConfig();
  mock = installFetch([
    {method: 'GET', url: 'https://account.test/virtual-users', reply: () => failure(401, 'token_invalid', 'Token is invalid')},
    {method: 'GET', url: /\/virtual-users\/vu_/, reply: () => failure(404, 'virtual_user_not_found', 'Virtual User was not found')},
    {method: 'POST', url: 'https://account.test/virtual-users', reply: () => failure(403, 'permission_denied', 'denied')},
  ]);
  await assert.rejects(listVirtualUsers(cfg, 'tok'), serviceError('account', 401, 'token_invalid'));
  await assert.rejects(getVirtualUser(cfg, 'tok', VU), serviceError('account', 404, 'virtual_user_not_found'));
  await assert.rejects(createVirtualUser(cfg, 'tok', 'n'), serviceError('account', 403, 'permission_denied'));
});

test('a 200 envelope carrying an error or no vuId is not accepted', async () => {
  const cfg = testConfig();
  let reply = {requestId: 'r', data: null, error: {code: 'virtual_user_name_invalid', message: 'bad'}};
  mock = installFetch([{method: 'POST', url: 'https://account.test/virtual-users', reply: () => reply}]);
  await assert.rejects(createVirtualUser(cfg, 'tok', 'n'), serviceError('account', 502, 'virtual_user_name_invalid'));
  reply = envelope({name: 'no id'});
  await assert.rejects(createVirtualUser(cfg, 'tok', 'n'), serviceError('account', 502, 'invalid_response'));
});

test('a missing token is an auth error and sends nothing', async () => {
  const cfg = testConfig();
  mock = installFetch([]);
  await assert.rejects(listVirtualUsers(cfg, ''), serviceError('auth', 401, 'not_authenticated'));
  await assert.rejects(getVirtualUser(cfg, null, VU), serviceError('auth', 401, 'not_authenticated'));
  assert.equal(mock.calls.length, 0);
});
