// GET: the visitor's investor demo runs, newest first. POST: a new run, in a fresh VU ("Start demo", "Start over") or in
// a VU the visitor picked and may write to ("Use an existing space").
// The API middleware has already checked the session and turns a thrown error into a JSON answer.
import {requestLocale} from '../../../../../shared/i18n.mjs';
import {json} from '../../../../../server/demo/http.mjs';
import {checkTimeZone, createRun, demoError, listRuns} from '../../../../../server/demo/runs.mjs';
import {requireWritableSpace} from '../../../../../server/demo/spaces.mjs';

export async function onRequestGet(context) {
  const {cfg, session} = context.data;
  return json({runs: await listRuns(cfg, session.accountId)});
}

/**
 * Body: {timeZone?: IANA zone of the browser, vuId?: an existing VU}. Without vuId a fresh VU is created, named in that
 * zone (UTC when it is unknown or missing). With vuId the run writes into that VU, which must exist, be shared with the
 * visitor and be writable for them (404 space_not_found, 403 space_read_only).
 */
export async function onRequestPost(context) {
  const {cfg, session} = context.data;
  // An empty body is allowed (older pages send none); a body that is present must be JSON.
  const raw = await context.request.text();
  if (raw.length > 4096) throw demoError(413, 'invalid_request', 'err.request_too_large');
  let body = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw demoError(400, 'invalid_request', 'err.request_not_json');
    }
  }
  const vuId = body?.vuId;
  const space = vuId === undefined ? null : await requireWritableSpace(cfg, session, vuId);
  return json({run: await createRun(cfg, session, {timeZone: checkTimeZone(body?.timeZone), locale: context.data.locale ?? requestLocale(context.request, context.env), space})}, 201);
}
