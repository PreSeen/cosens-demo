// POST /api/demo/auth/logout : end the session, revoke its grant, clear the cookies.
import {readConfig} from '../../../../server/demo/config.mjs';
import {NOINDEX, errorResponse} from '../../../../server/demo/http.mjs';
import {requestLocale} from '../../../../shared/i18n.mjs';
import {clearLoginAttemptCookie, destroySession} from '../../../../server/demo/oauth.mjs';

export async function onRequestPost({request, env}) {
  let cfg;
  try {
    cfg = readConfig(env);
  } catch (err) {
    return errorResponse(err, requestLocale(request, env));
  }
  const clearSession = await destroySession(cfg, request, {revoke: true});
  const headers = new Headers({'Cache-Control': 'private, no-store', ...NOINDEX});
  headers.append('Set-Cookie', clearSession);
  headers.append('Set-Cookie', clearLoginAttemptCookie(request));
  return new Response(null, {status: 204, headers});
}
