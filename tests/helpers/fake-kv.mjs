// In-memory stand-in for a Workers KV namespace. Expiry follows the injected clock, and the
// same input rules as real KV apply (string values, expirationTtl of at least 60 seconds).

const MAX_KEY_BYTES = 512;
const MIN_TTL_SECONDS = 60;

export function fakeKv({now = () => Date.now()} = {}) {
  /** @type {Map<string, {value:string, expiresAt:number|null}>} */
  const store = new Map();

  function checkKey(key) {
    if (typeof key !== 'string' || key === '') throw new TypeError('KV key must be a non-empty string');
    if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) throw new TypeError(`KV key longer than ${MAX_KEY_BYTES} bytes`);
  }

  function live(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && now() >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  return {
    async get(key, type = 'text') {
      checkKey(key);
      const kind = typeof type === 'object' && type !== null ? type.type ?? 'text' : type;
      const entry = live(key);
      if (!entry) return null;
      if (kind === 'json') return JSON.parse(entry.value);
      if (kind === 'text') return entry.value;
      throw new TypeError(`fake KV supports only text and json reads, got ${kind}`);
    },
    async put(key, value, {expirationTtl} = {}) {
      checkKey(key);
      if (typeof value !== 'string') throw new TypeError('fake KV stores strings only; JSON.stringify the value first');
      let expiresAt = null;
      if (expirationTtl !== undefined) {
        if (typeof expirationTtl !== 'number' || !Number.isFinite(expirationTtl) || expirationTtl < MIN_TTL_SECONDS) {
          throw new RangeError(`Invalid expiration_ttl of ${expirationTtl}. Expiration TTL must be at least ${MIN_TTL_SECONDS}.`);
        }
        expiresAt = now() + Math.floor(expirationTtl) * 1000;
      }
      store.set(key, {value, expiresAt});
    },
    async delete(key) {
      checkKey(key);
      store.delete(key);
    },
    async list({prefix = ''} = {}) {
      const keys = [...store.keys()].filter((name) => name.startsWith(prefix) && live(name)).sort().map((name) => ({name}));
      return {keys, list_complete: true};
    },
    dump() {
      const out = {};
      for (const name of [...store.keys()].sort()) {
        const entry = live(name);
        if (entry) out[name] = entry.value;
      }
      return out;
    },
  };
}
