// GET /api/demo/auth/callback?code&state : finish the CoSens OAuth login.
import {readConfig} from '../../../../server/demo/config.mjs';
import {clearStateCookieHeader, finishLogin, loginErrorRedirect} from '../../../../server/demo/oauth.mjs';

/** Error redirect that also clears the cs_demo_st state binding, like every finishLogin outcome. */
function failure(request, code) {
  const response = loginErrorRedirect(request, code);
  response.headers.append('Set-Cookie', clearStateCookieHeader(request));
  return response;
}

export async function onRequestGet({request, env}) {
  let cfg;
  try {
    cfg = readConfig(env);
  } catch {
    return failure(request, 'config_missing');
  }
  try {
    return await finishLogin(cfg, request);
  } catch {
    return failure(request, 'service_unavailable');
  }
}
