// Demo run records. One Run is one attempt at a demo, bound to a Virtual User in the visitor's own account: a fresh
// one (space 'new'), or one the visitor picked and may write to (space 'existing', see spaces.mjs).
// Records live in KV; saves are optimistic (re-read, version check, read-back), so every mutate callback must be an idempotent merge.
import {DEFAULT_LOCALE, t} from '../../shared/i18n.mjs';
import {randomId} from './crypto.mjs';
import {ServiceError} from './http.mjs';
import {kvGetJson, kvPutJson} from './kv.mjs';
import {createVirtualUser} from './services/accounts.mjs';

export const RUN_INDEX_MAX = 50;
export const SAVE_RETRIES = 3;
export const FILE_TTL_SECONDS = 30 * 24 * 3600;
export const KV_WRITE_RETRIES = 3;
export const KV_WRITE_BACKOFF_MS = 1100;
const RUN_ID = /^run_[A-Za-z0-9_-]{16}$/;
const FILE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Site-side error with the standard {error:{code,message}} body and no upstream service. message is a key of shared/i18n.mjs (or English text). */
export function demoError(status, code, message, params) {
  return new ServiceError(null, status, code, message, params);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isRateLimited = err => /429|Too Many Requests/i.test(String(err?.message ?? ''));

/**
 * kvPutJson that survives Workers KV's one-write-per-second-per-key limit: a write refused with
 * "429 Too Many Requests" waits KV_WRITE_BACKOFF_MS and is retried up to KV_WRITE_RETRIES times.
 */
export async function putJsonPaced(kv, key, value, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await kvPutJson(kv, key, value, options);
    } catch (err) {
      if (attempt >= KV_WRITE_RETRIES || !isRateLimited(err)) throw err;
      await sleep(KV_WRITE_BACKOFF_MS);
    }
  }
}

/**
 * Marks a run returned by a poll with the first transient service failure. The property is
 * non-enumerable, so it never reaches KV or a plain JSON body; routes read it explicitly.
 */
export function withRefreshError(run, err) {
  if (!err || run.refreshError) return run;
  const copy = {...run};
  Object.defineProperty(copy, 'refreshError', {value: {service: err.service, code: err.code, message: err.message}, enumerable: false});
  return copy;
}

export const runKey = (accountId, runId) => `run:${accountId}:${runId}`;
export const indexKey = accountId => `runs:${accountId}:investor`;
export const fileKvKey = (accountId, runId, fileKey) => `file:${accountId}:${runId}:${fileKey}`;

/**
 * The visitor's IANA time zone as the runtime spells it ("asia/shanghai" -> "Asia/Shanghai");
 * anything that is not a zone the runtime knows becomes UTC.
 * @param {unknown} value
 */
export function checkTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', {timeZone: value}).resolvedOptions().timeZone;
  } catch {
    return 'UTC'; // RangeError: not a time zone
  }
}

/** "CoSens Demo · Investor · MM-DD HH:mm" ("CoSens 演示 · 投资人 · ..." in Chinese) in the visitor's time zone, so it matches the times the page shows. */
export function vuName(now, timeZone = 'UTC', locale = DEFAULT_LOCALE) {
  const parts = {};
  const format = new Intl.DateTimeFormat('en-US', {timeZone: checkTimeZone(timeZone), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  for (const part of format.formatToParts(new Date(now))) parts[part.type] = part.value;
  return t('run.name', {time: `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`}, locale);
}

/** title stays empty until a file names the project; the page then shows "Project A" (or its Chinese name). */
export function emptyProject(slot) {
  return {slot, title: '', bp: null, proposal: null, executionId: null, attempt: 0,
    status: 'idle', stage: null, progress: 0, error: null};
}

/** space: 'new' for a VU created for this run, 'existing' for a VU the visitor already had. */
export function newRun({id, vuId, vuName: name, space = 'new', now}) {
  return {
    id, demo: 'investor', version: 1, vuId, vuName: name, space, createdAt: now, updatedAt: now,
    memory: {files: [], stats: null, startedAt: null, completedAt: null},
    method: {projects: [emptyProject('A'), emptyProject('B')], recipe: null, startedAt: null, completedAt: null, error: null},
    bp: null,
    lastAnalysisAt: null,
  };
}

/**
 * Without space, creates the run's Virtual User first (nothing is stored when that fails); timeZone and locale name it
 * in the visitor's local time and language. With space (a VU requireWritableSpace has checked), the run writes into that VU.
 */
export async function createRun(cfg, session, {now = Date.now, timeZone = 'UTC', locale = DEFAULT_LOCALE, space = null} = {}) {
  const at = now();
  const id = `run_${randomId(12)}`;
  let run;
  if (space) {
    run = newRun({id, vuId: space.vuId, vuName: space.name || space.vuId, space: 'existing', now: at});
  } else {
    const name = vuName(at, timeZone, locale);
    const vu = await createVirtualUser(cfg, session.accessToken, name);
    run = newRun({id, vuId: vu.vuId, vuName: vu.name || name, now: at});
  }
  await putJsonPaced(cfg.kv, runKey(session.accountId, run.id), run);
  const ids = (await kvGetJson(cfg.kv, indexKey(session.accountId))) || [];
  const index = [run.id, ...ids.filter(id => id !== run.id)].slice(0, RUN_INDEX_MAX);
  await putJsonPaced(cfg.kv, indexKey(session.accountId), index);
  return run;
}

export async function getRun(cfg, accountId, runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return null;
  const run = await kvGetJson(cfg.kv, runKey(accountId, runId));
  return run && run.id === runId ? run : null;
}

export async function requireRun(cfg, accountId, runId) {
  const run = await getRun(cfg, accountId, runId);
  if (!run) throw demoError(404, 'run_not_found', 'err.run_not_found');
  return run;
}

/** Highest step the run has reached: 0 nothing yet, 1 memory, 2 method, 3 analysis. */
export function runStep(run) {
  if (run.lastAnalysisAt) return 3;
  if (run.method?.recipe) return 2;
  if (run.memory?.completedAt) return 1;
  return 0;
}

export function runSummary(run) {
  return {id: run.id, vuId: run.vuId, vuName: run.vuName, space: run.space ?? 'new', createdAt: run.createdAt, step: runStep(run)};
}

export async function listRuns(cfg, accountId) {
  const ids = (await kvGetJson(cfg.kv, indexKey(accountId))) || [];
  const runs = await Promise.all(ids.map(id => getRun(cfg, accountId, id)));
  return runs.filter(Boolean).map(runSummary);
}

/**
 * Optimistic save. mutate(draft) edits a copy of the stored run; returning false means "no change".
 * The version must be unchanged between the read and the write and the record must read back as
 * written; otherwise mutate is re-applied to the newer record, up to SAVE_RETRIES more times.
 */
export async function saveRun(cfg, accountId, runId, mutate, {now = Date.now} = {}) {
  const key = runKey(accountId, runId);
  for (let attempt = 0; attempt <= SAVE_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(20 * attempt + Math.floor(Math.random() * 40));
    const current = await getRun(cfg, accountId, runId);
    if (!current) throw demoError(404, 'run_not_found', 'err.run_not_found');
    const draft = structuredClone(current);
    if ((await mutate(draft)) === false) return current;
    const latest = await getRun(cfg, accountId, runId);
    if (!latest || latest.version !== current.version) continue;
    draft.id = current.id;
    draft.version = current.version + 1;
    draft.updatedAt = Math.max(now(), current.updatedAt);
    await putJsonPaced(cfg.kv, key, draft);
    const stored = await kvGetJson(cfg.kv, key);
    if (stored && JSON.stringify(stored) === JSON.stringify(draft)) return draft;
  }
  throw demoError(409, 'run_conflict', 'err.run_conflict');
}

function asBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new TypeError('bytes must be a Uint8Array');
}

export function bytesToBase64(bytes) {
  const view = asBytes(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Stores a project file or BP for 30 days; UTF-8 text stays readable, anything else is base64. */
export async function putFile(cfg, accountId, runId, fileKey, {name, mime, bytes}) {
  if (!FILE_KEY.test(fileKey)) throw new Error(`invalid file key ${fileKey}`);
  const view = asBytes(bytes);
  let record;
  try {
    record = {name, mime: mime || 'application/octet-stream', encoding: 'utf-8',
      content: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(view)};
  } catch {
    record = {name, mime: mime || 'application/octet-stream', encoding: 'base64', content: bytesToBase64(view)};
  }
  await putJsonPaced(cfg.kv, fileKvKey(accountId, runId, fileKey), record, {ttl: FILE_TTL_SECONDS});
  return {fileKey, name};
}

export async function getFile(cfg, accountId, runId, fileKey) {
  if (!FILE_KEY.test(fileKey)) return null;
  const record = await kvGetJson(cfg.kv, fileKvKey(accountId, runId, fileKey));
  if (!record) return null;
  const bytes = record.encoding === 'base64' ? base64ToBytes(record.content) : new TextEncoder().encode(record.content);
  return {...record, bytes};
}
