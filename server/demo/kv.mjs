// Typed access to the DEMO_KV namespace. Every value is stored as JSON text; sealed sessions are JSON strings.

export const TTL = {
  session: 30 * 24 * 3600,
  oauthState: 600,
  file: 30 * 24 * 3600,
  refreshLock: 60,
};

export const RUN_LIST_MAX = 50;

export const KEYS = {
  session: (sid) => `sess:${sid}`,
  oauthState: (state) => `oauth:${state}`,
  client: (redirectUri) => `client:${redirectUri}`,
  run: (accountId, runId) => `run:${accountId}:${runId}`,
  runList: (accountId, demo = 'investor') => `runs:${accountId}:${demo}`,
  file: (accountId, runId, fileKey) => `file:${accountId}:${runId}:${fileKey}`,
  analysis: (accountId, runId) => `analysis:${accountId}:${runId}`,
  refreshLock: (sid) => `lock:refresh:${sid}`,
};

/** @param {any} kv @param {string} key @returns {Promise<any|null>} null when absent or not valid JSON */
export async function kvGetJson(kv, key) {
  const text = await kv.get(key);
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {any} kv @param {string} key @param {unknown} value @param {{ttl?:number}} [options] ttl in seconds, at least 60 (KV minimum) */
export async function kvPutJson(kv, key, value, {ttl} = {}) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError(`kvPutJson needs a JSON value for ${key}`);
  if (ttl === undefined || ttl === null) return kv.put(key, text);
  if (!Number.isInteger(ttl) || ttl < 60) throw new RangeError(`KV ttl must be an integer of at least 60 seconds, got ${ttl}`);
  return kv.put(key, text, {expirationTtl: ttl});
}

/** @param {any} kv @param {string} key */
export async function kvDelete(kv, key) {
  return kv.delete(key);
}
