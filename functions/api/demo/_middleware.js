// API gate for /api/demo/*: everything except /api/demo/auth/* needs a session.
// Downstream handlers find {cfg, session, sid, locale} in context.data and may throw ServiceError. The locale is
// ?lang, then the cosens-lang cookie, then SITE_DEFAULT_LOCALE (English); error texts are written in it.
import {readConfig} from '../../../server/demo/config.mjs';
import {NOINDEX, ServiceError, errorResponse} from '../../../server/demo/http.mjs';
import {getSession} from '../../../server/demo/oauth.mjs';
import {requestLocale} from '../../../shared/i18n.mjs';

const AUTH_PREFIX = '/api/demo/auth/';

function withApiHeaders(response) {
  const out = new Response(response.body, response);
  if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'private, no-store');
  for (const [name, value] of Object.entries(NOINDEX)) out.headers.set(name, value);
  return out;
}

export async function onRequest(context) {
  const {request, env, next} = context;
  if (new URL(request.url).pathname.startsWith(AUTH_PREFIX)) return withApiHeaders(await next());
  const locale = requestLocale(request, env);
  context.data.locale = locale;
  try {
    const cfg = readConfig(env);
    const found = await getSession(cfg, request);
    if (!found) return errorResponse(new ServiceError('auth', 401, 'not_authenticated', 'err.login_expired'), locale);
    context.data.cfg = cfg;
    context.data.session = found.session;
    context.data.sid = found.sid;
    return withApiHeaders(await next());
  } catch (err) {
    return errorResponse(err, locale);
  }
}
