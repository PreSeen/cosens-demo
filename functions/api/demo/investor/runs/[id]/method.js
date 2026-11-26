// POST: start learning the method (project A; project B follows from GET refreshes), or restart
// it by hand after method.error. startMethod answers 409 step_not_ready while a project lacks a file.
import {json} from '../../../../../../server/demo/http.mjs';
import {requireRun} from '../../../../../../server/demo/runs.mjs';
import {startMethod} from '../../../../../../server/demo/investor/method-step.mjs';

export async function onRequestPost(context) {
  const {cfg, session} = context.data;
  const run = await requireRun(cfg, session.accountId, context.params.id);
  return json({run: await startMethod(cfg, session, run, {locale: context.data.locale})}, 202);
}
