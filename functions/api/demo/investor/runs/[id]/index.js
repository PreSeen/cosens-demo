// GET one run after polling Memory and RSI. A service outage keeps the saved run on screen.
import {ServiceError, json, localized} from '../../../../../../server/demo/http.mjs';
import {getRun, requireRun} from '../../../../../../server/demo/runs.mjs';
import {refreshMemory} from '../../../../../../server/demo/investor/memory-step.mjs';
import {refreshMethod} from '../../../../../../server/demo/investor/method-step.mjs';

const OUTAGE_SERVICES = new Set(['memory', 'rsi', 'model', 'account']);

const isOutage = err => Boolean(err) && OUTAGE_SERVICES.has(err.service) && err.status !== 401;

/** The page's own sentence, then the service's error line as it was passed through. */
function refreshErrorOf(err, locale) {
  const detail = String(err.message ?? '').trim();
  return {code: err.code, message: [localized('err.refresh_unresponsive', {service: err.service}, locale), detail].filter(Boolean).join(' '), service: err.service};
}

export async function onRequestGet(context) {
  const {cfg, session, locale} = context.data;
  let run = await requireRun(cfg, session.accountId, context.params.id);
  try {
    run = await refreshMemory(cfg, session, run, {locale});
    run = await refreshMethod(cfg, session, run, {locale});
  } catch (err) {
    if (!(err instanceof ServiceError) || !isOutage(err)) throw err;
    return json({
      run: (await getRun(cfg, session.accountId, run.id)) ?? run,
      refreshError: refreshErrorOf(err, locale),
    });
  }
  // The step modules report a transient failure as a non-enumerable run.refreshError {service, code}
  // instead of throwing, so it never reaches KV; surface it here as a non-blocking notice.
  if (isOutage(run.refreshError)) return json({run, refreshError: refreshErrorOf(run.refreshError, locale)});
  return json({run});
}
