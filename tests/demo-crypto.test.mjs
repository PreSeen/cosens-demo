import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {b64url, fromB64url, randomId, sha256Hex, pkceChallenge, pkcePair, seal, open} from '../server/demo/crypto.mjs';

const secret = 'test-secret-0123456789abcdef0123456789abcdef';
const session = {accessToken: 'tok-secret-value', refreshToken: 'mcp_rt_abc', expiresAt: 1790000000000, accountId: 'acct_test', email: '周明远@example.com', clientId: 'client_1', createdAt: 1789990000000};

test('b64url encodes without padding and with the URL-safe alphabet', () => {
  assert.equal(b64url(new Uint8Array([])), '');
  assert.equal(b64url(new Uint8Array([0xfb, 0xff])), '-_8');
  assert.equal(b64url(new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61])), 'Zm9vYmE');
  assert.equal(b64url(new Uint8Array([1, 2, 3]).buffer), 'AQID');
});

test('b64url round-trips every byte value and large inputs', () => {
  const all = Uint8Array.from({length: 256}, (_, i) => i);
  assert.deepEqual(fromB64url(b64url(all)), all);
  const big = new Uint8Array(200000).map((_, i) => (i * 7) & 255);
  assert.deepEqual(fromB64url(b64url(big)), big);
});

test('fromB64url rejects padding, the standard alphabet, impossible lengths and non-strings', () => {
  for (const bad of ['Zm9vYmE=', 'a+b/', 'abcde', '!!!!', 'ab cd']) assert.throws(() => fromB64url(bad), TypeError, bad);
  assert.throws(() => fromB64url(null), TypeError);
});

test('randomId is base64url of the requested byte count and does not repeat', () => {
  assert.match(randomId(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(randomId(12), /^[A-Za-z0-9_-]{16}$/);
  assert.equal(fromB64url(randomId(12)).length, 12);
  const ids = new Set(Array.from({length: 200}, () => randomId(12)));
  assert.equal(ids.size, 200);
  for (const bad of [0, -1, 1.5, 2000]) assert.throws(() => randomId(bad), RangeError);
});

test('sha256Hex matches the standard vectors for text and bytes', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const name = '微信联系人.md\n内容';
  assert.equal(await sha256Hex(name), createHash('sha256').update(name, 'utf8').digest('hex'));
});

test('pkceChallenge matches RFC 7636 appendix B', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('pkcePair gives a 43-character verifier and its S256 challenge', async () => {
  const a = await pkcePair();
  const b = await pkcePair();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'));
  assert.notEqual(a.verifier, b.verifier);
});

test('seal and open round-trip a session, including non-ASCII text', async () => {
  const sealed = await seal(secret, session);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await open(secret, sealed), session);
  assert.deepEqual(await open(secret, await seal(secret, 'plain string')), 'plain string');
  assert.deepEqual(await open(secret, await seal(secret, [1, null, {a: true}])), [1, null, {a: true}]);
});

test('sealed text hides the plaintext and uses a fresh IV each time', async () => {
  const one = await seal(secret, session);
  const two = await seal(secret, session);
  assert.notEqual(one, two);
  assert.notEqual(one.split('.')[1], two.split('.')[1]);
  for (const sealed of [one, two]) {
    assert.equal(sealed.includes('tok-secret-value'), false);
    assert.equal(sealed.includes(Buffer.from('tok-secret-value').toString('base64url').slice(0, 12)), false);
  }
});

test('open returns null with the wrong secret', async () => {
  const sealed = await seal(secret, session);
  assert.equal(await open('another-secret-0123456789abcdef0123456789', sealed), null);
});

function flipByte(part, index) {
  const bytes = fromB64url(part);
  bytes[index] ^= 0x01;
  return b64url(bytes);
}

test('open returns null for any tampered byte in the IV or ciphertext', async () => {
  const sealed = await seal(secret, session);
  const [version, iv, cipher] = sealed.split('.');
  const cipherLength = fromB64url(cipher).length;
  for (const index of [0, 5, 11]) assert.equal(await open(secret, `${version}.${flipByte(iv, index)}.${cipher}`), null, `iv byte ${index}`);
  for (const index of [0, Math.floor(cipherLength / 2), cipherLength - 1]) assert.equal(await open(secret, `${version}.${iv}.${flipByte(cipher, index)}`), null, `cipher byte ${index}`);
});

test('open returns null for truncated, re-versioned and malformed input', async () => {
  const sealed = await seal(secret, session);
  const [version, iv, cipher] = sealed.split('.');
  const shortIv = b64url(fromB64url(iv).subarray(0, 8));
  const cases = [
    sealed.slice(0, -4),
    `v2.${iv}.${cipher}`,
    `${version}.${iv}`,
    `${version}.${iv}.${cipher}.extra`,
    `${version}.${shortIv}.${cipher}`,
    `${version}.${iv}.${b64url(new Uint8Array(15))}`,
    `${version}.${iv}.not*base64`,
    `${version}..${cipher}`,
    '',
    'garbage',
    JSON.stringify(session),
  ];
  for (const value of cases) assert.equal(await open(secret, value), null, value);
  for (const value of [null, undefined, 42, {}, ['v1', iv, cipher]]) assert.equal(await open(secret, value), null, String(value));
});

test('a value sealed under one secret cannot be moved between secrets or forged', async () => {
  const forged = `v1.${b64url(new Uint8Array(12))}.${b64url(new TextEncoder().encode(JSON.stringify(session) + '0123456789abcdef'))}`;
  assert.equal(await open(secret, forged), null);
});

test('seal rejects an empty secret and values JSON cannot represent', async () => {
  await assert.rejects(seal('', session), TypeError);
  await assert.rejects(seal(secret, undefined), TypeError);
  await assert.rejects(seal(secret, () => 1), TypeError);
});
