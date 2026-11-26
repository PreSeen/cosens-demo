// Web Crypto helpers shared by login and sessions. Works the same in Pages Functions and Node 22+.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEAL_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** @type {Map<string, Promise<CryptoKey>>} */
const keyCache = new Map();

/** @param {Uint8Array|ArrayBuffer} bytes @returns {string} base64url without padding */
export function b64url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} str base64url without padding @returns {Uint8Array} */
export function fromB64url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new TypeError('invalid base64url');
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** @param {number} [bytes] @returns {string} */
export function randomId(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 1024) throw new RangeError('randomId bytes must be an integer from 1 to 1024');
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** @param {string|Uint8Array|ArrayBuffer} textOrBytes @returns {Promise<string>} lowercase hex */
export async function sha256Hex(textOrBytes) {
  const data = typeof textOrBytes === 'string' ? encoder.encode(textOrBytes) : textOrBytes;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {string} verifier @returns {Promise<string>} S256 code challenge (RFC 7636) */
export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

/** @returns {Promise<{verifier:string, challenge:string}>} */
export async function pkcePair() {
  const verifier = randomId(32);
  return {verifier, challenge: await pkceChallenge(verifier)};
}

/** @param {string} secret @returns {Promise<CryptoKey>} */
function sealKey(secret) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('seal secret must be a non-empty string');
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']).then((base) => crypto.subtle.deriveKey(
      {name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('cosens-demo'), info: encoder.encode('session')},
      base,
      {name: 'AES-GCM', length: 256},
      false,
      ['encrypt', 'decrypt'],
    ));
    keyCache.set(secret, key);
  }
  return key;
}

/** @param {string} secret @param {unknown} obj @returns {Promise<string>} "v1.<iv>.<ciphertext>" */
export async function seal(secret, obj) {
  const plain = JSON.stringify(obj);
  if (plain === undefined) throw new TypeError('seal needs a JSON value');
  const key = await sealKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(SEAL_VERSION)}, key, encoder.encode(plain));
  return `${SEAL_VERSION}.${b64url(iv)}.${b64url(new Uint8Array(cipher))}`;
}

/** @param {string} secret @param {unknown} str @returns {Promise<any|null>} null on any tamper or format error */
export async function open(secret, str) {
  if (typeof str !== 'string') return null;
  const parts = str.split('.');
  if (parts.length !== 3 || parts[0] !== SEAL_VERSION) return null;
  try {
    const iv = fromB64url(parts[1]);
    const cipher = fromB64url(parts[2]);
    if (iv.length !== IV_BYTES || cipher.length < TAG_BYTES) return null;
    const key = await sealKey(secret);
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv, additionalData: encoder.encode(SEAL_VERSION)}, key, cipher);
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}
