import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeKv} from './helpers/fake-kv.mjs';
import {kvGetJson, kvPutJson, kvDelete, KEYS, TTL, RUN_LIST_MAX} from '../server/demo/kv.mjs';

function clock(start = 1_000_000) {
  const c = {t: start, now: () => c.t};
  return c;
}

test('fake KV stores text, reads json, and returns null for missing keys', async () => {
  const kv = fakeKv();
  assert.equal(await kv.get('missing'), null);
  assert.equal(await kv.get('missing', 'json'), null);
  await kv.put('a', '{"x":1}');
  assert.equal(await kv.get('a'), '{"x":1}');
  assert.equal(await kv.get('a', 'text'), '{"x":1}');
  assert.deepEqual(await kv.get('a', 'json'), {x: 1});
  assert.deepEqual(await kv.get('a', {type: 'json'}), {x: 1});
  await kv.put('bad', 'not json');
  await assert.rejects(kv.get('bad', 'json'), SyntaxError);
  await assert.rejects(kv.get('a', 'arrayBuffer'), TypeError);
});

test('fake KV expires a key exactly expirationTtl seconds after the put', async () => {
  const c = clock();
  const kv = fakeKv({now: c.now});
  await kv.put('k', 'v', {expirationTtl: 60});
  c.t += 59_999;
  assert.equal(await kv.get('k'), 'v');
  c.t += 1;
  assert.equal(await kv.get('k'), null);
  assert.deepEqual(kv.dump(), {});
});

test('fake KV overwrite without a ttl removes the old expiry; with a ttl restarts it', async () => {
  const c = clock();
  const kv = fakeKv({now: c.now});
  await kv.put('k', 'one', {expirationTtl: 60});
  await kv.put('k', 'two');
  c.t += 10 * 365 * 24 * 3600e3;
  assert.equal(await kv.get('k'), 'two');
  await kv.put('j', 'one', {expirationTtl: 60});
  c.t += 30_000;
  await kv.put('j', 'two', {expirationTtl: 60});
  c.t += 45_000;
  assert.equal(await kv.get('j'), 'two');
  c.t += 15_000;
  assert.equal(await kv.get('j'), null);
});

test('fake KV enforces the real KV input rules', async () => {
  const kv = fakeKv();
  await assert.rejects(kv.put('k', 'v', {expirationTtl: 59}), RangeError);
  await assert.rejects(kv.put('k', 'v', {expirationTtl: Number.NaN}), RangeError);
  await assert.rejects(kv.put('k', {a: 1}), TypeError);
  await assert.rejects(kv.put('k', 12), TypeError);
  await assert.rejects(kv.put('', 'v'), TypeError);
  await assert.rejects(kv.get('x'.repeat(513)), TypeError);
  await kv.put('x'.repeat(512), 'ok');
  assert.equal(await kv.get('x'.repeat(512)), 'ok');
});

test('fake KV delete removes a key and deleting a missing key is fine', async () => {
  const kv = fakeKv();
  await kv.put('k', 'v');
  await kv.delete('k');
  await kv.delete('k');
  assert.equal(await kv.get('k'), null);
});

test('fake KV list filters by prefix, sorts names and skips expired keys', async () => {
  const c = clock();
  const kv = fakeKv({now: c.now});
  await kv.put('run:acct_a:run_2', '{}');
  await kv.put('run:acct_a:run_1', '{}');
  await kv.put('run:acct_b:run_3', '{}');
  await kv.put('run:acct_a:run_old', '{}', {expirationTtl: 60});
  await kv.put('sess:x', '"v1.a.b"');
  c.t += 60_000;
  assert.deepEqual(await kv.list({prefix: 'run:acct_a:'}), {keys: [{name: 'run:acct_a:run_1'}, {name: 'run:acct_a:run_2'}], list_complete: true});
  assert.deepEqual((await kv.list()).keys.map((k) => k.name), ['run:acct_a:run_1', 'run:acct_a:run_2', 'run:acct_b:run_3', 'sess:x']);
  assert.deepEqual(kv.dump(), {'run:acct_a:run_1': '{}', 'run:acct_a:run_2': '{}', 'run:acct_b:run_3': '{}', 'sess:x': '"v1.a.b"'});
});

test('two fake KV instances do not share data', async () => {
  const a = fakeKv();
  const b = fakeKv();
  await a.put('k', 'v');
  assert.equal(await b.get('k'), null);
});

test('kvPutJson and kvGetJson round-trip JSON values', async () => {
  const kv = fakeKv();
  const run = {id: 'run_abc', version: 3, memory: {files: [{name: '微信联系人.md'}], stats: null}, bp: null};
  await kvPutJson(kv, 'run:acct_test:run_abc', run);
  assert.deepEqual(await kvGetJson(kv, 'run:acct_test:run_abc'), run);
  assert.equal(kv.dump()['run:acct_test:run_abc'], JSON.stringify(run));
  await kvPutJson(kv, 'runs:acct_test:investor', ['run_b', 'run_a']);
  assert.deepEqual(await kvGetJson(kv, 'runs:acct_test:investor'), ['run_b', 'run_a']);
  await kvPutJson(kv, 'lock:refresh:sid', '1', {ttl: 60});
  assert.equal(await kvGetJson(kv, 'lock:refresh:sid'), '1');
});

test('a sealed session string is stored as JSON text and read back unchanged', async () => {
  const kv = fakeKv();
  await kvPutJson(kv, 'sess:sid-1', 'v1.AAAA.BBBB', {ttl: TTL.session});
  assert.equal(kv.dump()['sess:sid-1'], '"v1.AAAA.BBBB"');
  assert.equal(await kvGetJson(kv, 'sess:sid-1'), 'v1.AAAA.BBBB');
});

test('kvGetJson returns null for missing keys and for corrupt JSON', async () => {
  const kv = fakeKv();
  assert.equal(await kvGetJson(kv, 'nothing'), null);
  await kv.put('broken', '{"a":');
  assert.equal(await kvGetJson(kv, 'broken'), null);
});

test('kvPutJson ttl expires the value through the injected clock', async () => {
  const c = clock();
  const kv = fakeKv({now: c.now});
  await kvPutJson(kv, 'oauth:state-1', {verifier: 'v'}, {ttl: TTL.oauthState});
  await kvPutJson(kv, 'client:https://cosens.ai/api/demo/auth/callback', {clientId: 'c'});
  c.t += 599_999;
  assert.deepEqual(await kvGetJson(kv, 'oauth:state-1'), {verifier: 'v'});
  c.t += 1;
  assert.equal(await kvGetJson(kv, 'oauth:state-1'), null);
  assert.deepEqual(await kvGetJson(kv, 'client:https://cosens.ai/api/demo/auth/callback'), {clientId: 'c'});
});

test('kvPutJson rejects ttl below the KV minimum and values JSON cannot hold', async () => {
  const kv = fakeKv();
  await assert.rejects(kvPutJson(kv, 'k', {}, {ttl: 30}), RangeError);
  await assert.rejects(kvPutJson(kv, 'k', {}, {ttl: 90.5}), RangeError);
  await assert.rejects(kvPutJson(kv, 'k', undefined), TypeError);
  assert.deepEqual(kv.dump(), {});
});

test('kvDelete removes the key', async () => {
  const kv = fakeKv();
  await kvPutJson(kv, 'analysis:acct_test:run_1', {at: 1});
  await kvDelete(kv, 'analysis:acct_test:run_1');
  assert.equal(await kvGetJson(kv, 'analysis:acct_test:run_1'), null);
});

test('key builders follow the skeleton key scheme', () => {
  assert.equal(KEYS.session('sid'), 'sess:sid');
  assert.equal(KEYS.oauthState('st'), 'oauth:st');
  assert.equal(KEYS.client('https://cosens.ai/api/demo/auth/callback'), 'client:https://cosens.ai/api/demo/auth/callback');
  assert.equal(KEYS.run('acct_1', 'run_2'), 'run:acct_1:run_2');
  assert.equal(KEYS.runList('acct_1'), 'runs:acct_1:investor');
  assert.equal(KEYS.file('acct_1', 'run_2', 'method-A-bp'), 'file:acct_1:run_2:method-A-bp');
  assert.equal(KEYS.analysis('acct_1', 'run_2'), 'analysis:acct_1:run_2');
  assert.equal(KEYS.refreshLock('sid'), 'lock:refresh:sid');
  assert.deepEqual(TTL, {session: 2592000, oauthState: 600, file: 2592000, refreshLock: 60});
  assert.equal(RUN_LIST_MAX, 50);
});
