// POST: step 3 as a server-sent event stream. The analysis runs as its own promise under
// waitUntil, so the result is still saved when the page disconnects mid-run.
import {t} from '../../../../../../shared/i18n.mjs';
import {ServiceError, json, sseResponse} from '../../../../../../server/demo/http.mjs';
import {getFile, requireRun} from '../../../../../../server/demo/runs.mjs';
import {AnalysisError, analyze, errorEvent} from '../../../../../../server/demo/investor/analyze.mjs';

const notReady = (key, locale) => json({error: {code: 'step_not_ready', message: t(key, undefined, locale)}}, 409);

export async function onRequestPost(context) {
  const {cfg, session, locale} = context.data;
  const run = await requireRun(cfg, session.accountId, context.params.id);
  if (!run.memory?.completedAt) return notReady('err.step1_first', locale);
  if (!run.method?.recipe) return notReady('err.step2_first', locale);
  if (!run.bp) return notReady('err.bp_first', locale);
  const file = await getFile(cfg, session.accountId, run.id, run.bp.fileKey);
  const text = file ? utf8(file.bytes) : null;
  if (text === null) return notReady('err.bp_expired', locale);
  const ctx = {cfg, token: session.accessToken, accountId: session.accountId, run, bp: {name: run.bp.name, text}, locale};

  let sink = null;
  const pending = [];
  const relay = event => (sink ? sink(event) : pending.push(event));
  const job = analyze(ctx, relay).catch(err => {
    if (!(err instanceof AnalysisError) && !(err instanceof ServiceError)) console.error('demo analyze failed', err);
    relay(errorEvent(err, locale));
  });
  context.waitUntil(job);
  return sseResponse(async emit => {
    sink = event => {
      try {
        const written = emit(event);
        if (written && typeof written.catch === 'function') written.catch(() => {});
      } catch {
        // The page went away; the analysis keeps running and is saved.
      }
    };
    for (const event of pending.splice(0)) sink(event);
    await job;
  }, {locale});
}

function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return null;
  }
}
