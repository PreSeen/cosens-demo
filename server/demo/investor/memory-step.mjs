// Step 1 of the investor demo: write material into the run's Virtual User memory and follow
// each write until Memory has committed it. Long work runs in Memory; requests only submit and poll.
import {ServiceError, scrubMessage} from '../http.mjs';
import {DEFAULT_LOCALE, t} from '../../../shared/i18n.mjs';
import {documentStatus, textOnlyMessage, getJob, graphStats, ingest, uploadDocument} from '../services/memory.mjs';
import {saveRun, withRefreshError} from '../runs.mjs';
import {baseName, checkMemoryFile, ingestContent, ingestKey, mimeFor} from './materials.mjs';

export const JOB_TIMEOUT_MS = 30 * 60e3;
export const MISSING_GRACE_MS = 2 * 60e3;
export const POLL_CONCURRENCY = 6;
const timeoutText = locale => t('memory.timeout', undefined, locale);
const failedText = locale => t('memory.failed', undefined, locale);

const isAuthError = err => err?.status === 401;
const isTransient = err => err instanceof ServiceError && Boolean(err.service) && !isAuthError(err);
const clip = text => String(text).slice(0, 300);
/** Maps a Memory document status to a MemoryFile state. */
export function documentOutcome(status, addedAt, at, locale = DEFAULT_LOCALE) {
  const s = status || {};
  if (s.status === 'missing') {
    return at - addedAt < MISSING_GRACE_MS ? {state: 'pending', error: null} : {state: 'failed', error: t('memory.doc_missing', undefined, locale)};
  }
  if (s.status === 'failed' || s.stage === 'failed') {
    // Memory's own failure record, passed through (scrubbed).
    const reason = [s.failure?.message, s.failure, s.error?.message, s.error, s.failure_kind].find(value => typeof value === 'string' && value.trim());
    return {state: 'failed', error: clip(scrubMessage(`Memory document${s.document_id ? ` ${s.document_id}` : ''} failed${reason ? `: ${reason}` : ''}`))};
  }
  if (s.recall_ready === true || s.status === 'completed') return {state: 'committed', error: null};
  return {state: 'pending', error: null};
}

async function eachLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Adds one file to step 1. The same name and content is added only once; a failed file can be
 * added again. Service failures other than an expired login are kept on the file as its error.
 */
export async function addMemoryFile(cfg, session, run, {name, bytes, source, now = Date.now, locale = DEFAULT_LOCALE}) {
  const fileName = baseName(name);
  const checked = checkMemoryFile(fileName, bytes, {documents: !cfg.memoryViaGateway, locale});
  const key = await ingestKey(fileName, checked.kind === 'text' ? checked.text : bytes);
  const existing = run.memory.files.find(file => file.key === key);
  if (existing && existing.state !== 'failed') return run;
  const at = now();
  const entry = {key, name: fileName, source: source === 'demo' ? 'demo' : 'upload', kind: checked.kind,
    state: 'pending', jobId: null, documentId: null, error: null, addedAt: at};
  try {
    if (checked.kind === 'text') {
      // Memory replays a request key's first receipt, so a failed job needs a fresh key and source.
      const requestKey = existing?.jobId ? `${key}-r${at.toString(36)}` : key;
      const receipt = await ingest(cfg, session.accessToken, run.vuId,
        {content: ingestContent(fileName, checked.text, locale), requestKey, sourceId: requestKey, sourceKind: 'document'});
      entry.jobId = typeof receipt?.job_id === 'string' && receipt.job_id ? receipt.job_id : null;
      if (receipt?.state === 'committed' && entry.jobId) entry.state = 'committed';
      else if (receipt?.state === 'failed' || !entry.jobId) Object.assign(entry, {state: 'failed', error: entry.jobId ? `Memory job ${entry.jobId} failed` : 'Memory ingest returned no job_id'});
    } else {
      const upload = await uploadDocument(cfg, session.accessToken, run.vuId, {name: fileName, bytes, mime: mimeFor(fileName)});
      entry.documentId = typeof upload?.document_id === 'string' && upload.document_id ? upload.document_id : null;
      Object.assign(entry, entry.documentId ? documentOutcome(upload, at, at, locale) : {state: 'failed', error: t('memory.upload_no_id', undefined, locale)});
    }
  } catch (err) {
    if (isAuthError(err)) throw err;
    // A service error carries its own line (passed through); anything else is shown as the demo server's error.
    Object.assign(entry, {state: 'failed', error: clip(scrubMessage(err instanceof ServiceError ? err.text(locale) : `Demo server ${err?.name ?? 'Error'}: ${err?.message ?? err}`))});
  }
  return saveRun(cfg, session.accountId, run.id, draft => {
    const files = draft.memory.files;
    const index = files.findIndex(file => file.key === key);
    if (index >= 0 && files[index].state !== 'failed' && files[index].addedAt !== at) return false;
    if (index >= 0) files[index] = {...entry};
    else files.push({...entry});
    if (draft.memory.startedAt == null) draft.memory.startedAt = at;
    draft.memory.completedAt = null;
    return true;
  }, {now});
}

/**
 * Polls pending jobs and documents; completes step 1 and records graph stats when all are committed.
 * Through the gateway there are no graph stats (step 1 completes with stats null) and no document status, so a
 * document still pending from before fails with the text-only message.
 * A transient Memory failure keeps the files as they are and is reported as run.refreshError.
 */
export async function refreshMemory(cfg, session, run, {now = Date.now, locale = DEFAULT_LOCALE} = {}) {
  let failure = null;
  const note = err => {
    if (!failure && isTransient(err)) failure = err;
  };
  const result = await pollMemory(cfg, session, run, now, note, locale);
  return withRefreshError(result, failure);
}

async function pollMemory(cfg, session, run, now, note, locale) {
  const files = run.memory.files;
  if (!files.length) return run;
  const at = now();
  const token = session.accessToken;
  const patches = new Map();
  const pending = files.filter(file => file.state === 'pending');
  const timedOut = file => at - file.addedAt > JOB_TIMEOUT_MS;
  const set = (file, state, error) => patches.set(file.key,
    {jobId: file.jobId, documentId: file.documentId, addedAt: file.addedAt, state, error});

  await eachLimit(pending.filter(file => file.kind === 'text' && file.jobId), POLL_CONCURRENCY, async file => {
    let job;
    try {
      job = await getJob(cfg, token, run.vuId, file.jobId);
    } catch (err) {
      if (isAuthError(err)) throw err;
      if (err?.status === 404) {
        set(file, 'failed', t('memory.job_missing', undefined, locale));
        return;
      }
      note(err);
      if (timedOut(file)) set(file, 'failed', timeoutText(locale));
      return;
    }
    if (job?.state === 'committed') set(file, 'committed', null);
    else if (job?.state === 'failed') set(file, 'failed', `Memory job ${file.jobId} failed`);
    else if (timedOut(file)) set(file, 'failed', timeoutText(locale));
  });

  const documents = pending.filter(file => file.kind === 'document' && file.documentId);
  if (documents.length && cfg.memoryViaGateway) {
    for (const file of documents) set(file, 'failed', textOnlyMessage(locale));
  } else if (documents.length) {
    let statuses = null;
    try {
      statuses = await documentStatus(cfg, token, run.vuId, documents.map(file => file.documentId));
    } catch (err) {
      if (isAuthError(err)) throw err;
      note(err);
    }
    const byId = new Map((Array.isArray(statuses) ? statuses : []).map(status => [status.document_id, status]));
    for (const file of documents) {
      const status = byId.get(file.documentId);
      const outcome = status ? documentOutcome(status, file.addedAt, at, locale) : {state: 'pending', error: null};
      if (outcome.state !== 'pending') set(file, outcome.state, outcome.error);
      else if (timedOut(file)) set(file, 'failed', timeoutText(locale));
    }
  }
  for (const file of pending) if (!file.jobId && !file.documentId) set(file, 'failed', failedText(locale));

  const merged = files.map(file => (patches.has(file.key) ? {...file, ...patches.get(file.key)} : file));
  const allCommitted = merged.every(file => file.state === 'committed');
  let stats = null;
  if (allCommitted && !cfg.memoryViaGateway && (!run.memory.completedAt || !run.memory.stats)) {
    try {
      stats = await graphStats(cfg, token, run.vuId);
    } catch (err) {
      if (isAuthError(err)) throw err;
      note(err);
    }
  }
  if (!patches.size && !stats && !(allCommitted && !run.memory.completedAt)) return run;

  return saveRun(cfg, session.accountId, run.id, draft => {
    let changed = false;
    for (const file of draft.memory.files) {
      const patch = patches.get(file.key);
      if (!patch || file.state !== 'pending' || file.jobId !== patch.jobId
        || file.documentId !== patch.documentId || file.addedAt !== patch.addedAt) continue;
      file.state = patch.state;
      file.error = patch.error;
      changed = true;
    }
    const done = draft.memory.files.length > 0 && draft.memory.files.every(file => file.state === 'committed');
    if (done && !draft.memory.completedAt) {
      draft.memory.completedAt = at;
      changed = true;
    }
    if (done && stats) {
      draft.memory.stats = stats;
      changed = true;
    }
    return changed;
  }, {now});
}
