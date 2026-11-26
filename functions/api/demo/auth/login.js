// GET /api/demo/auth/login?return=/demo/... : start the CoSens OAuth login.
import {readConfig} from '../../../../server/demo/config.mjs';
import {ServiceError} from '../../../../server/demo/http.mjs';
import {MAX_LOGIN_ATTEMPTS, loginAttemptCookie, loginAttempts, loginErrorRedirect, startLogin} from '../../../../server/demo/oauth.mjs';

export async function onRequestGet({request, env}) {
  let cfg;
  try {
    cfg = readConfig(env);
  } catch {
    return loginErrorRedirect(request, 'config_missing');
  }
  const attempts = loginAttempts(request);
  if (attempts >= MAX_LOGIN_ATTEMPTS) return loginErrorRedirect(request, 'login_loop');
  let response;
  try {
    response = await startLogin(cfg, request, new URL(request.url).searchParams.get('return'));
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'config_missing') return loginErrorRedirect(request, 'config_missing');
    const rejected = err instanceof ServiceError && err.status >= 400 && err.status < 500;
    return loginErrorRedirect(request, rejected ? 'client_registration_failed' : 'service_unavailable');
  }
  response.headers.append('Set-Cookie', loginAttemptCookie(request, attempts + 1));
  return response;
}
