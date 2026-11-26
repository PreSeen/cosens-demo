// GET: the run's last saved step 3 result ("Last result").
import {t} from '../../../../../../shared/i18n.mjs';
import {json} from '../../../../../../server/demo/http.mjs';
import {kvGetJson} from '../../../../../../server/demo/kv.mjs';
import {requireRun} from '../../../../../../server/demo/runs.mjs';
import {analysisKey} from '../../../../../../server/demo/investor/analyze.mjs';

export async function onRequestGet(context) {
  const {cfg, session} = context.data;
  const run = await requireRun(cfg, session.accountId, context.params.id);
  const analysis = await kvGetJson(cfg.kv, analysisKey(session.accountId, run.id));
  if (!analysis) return json({error: {code: 'analysis_not_found', message: t('err.analysis_not_found', undefined, context.data.locale)}}, 404);
  return json({analysis});
}
