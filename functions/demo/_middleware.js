// Page gate for /demo/* (pages, /demo/_app/* bundles and /demo/assets/* demo data).
// No session: 302 to login with return=<path+search>; /demo/?login_error=<code> gets the error page.
// Language: ?lang=en|zh, then the cosens-lang cookie, then SITE_DEFAULT_LOCALE (English). A ?lang is remembered in the
// cookie, and HTML pages get <html lang> and the configured default (read by the page script) filled in.
import {readConfig} from '../../server/demo/config.mjs';
import {NOINDEX} from '../../server/demo/http.mjs';
import {getSession, loginErrorPage} from '../../server/demo/oauth.mjs';
import {LANG_TAGS, defaultLocale, hasLocaleParam, localeCookie, requestLocale} from '../../shared/i18n.mjs';

async function localized(response, {request, env, locale}) {
  if (hasLocaleParam(request)) response.headers.append('Set-Cookie', localeCookie(locale, {secure: new URL(request.url).protocol === 'https:'}));
  // Only a complete HTML page is rewritten (a 304 or a redirect has no body to give back).
  if (response.status !== 200 || !(response.headers.get('Content-Type') ?? '').toLowerCase().includes('text/html')) return response;
  const html = (await response.text())
    .replace(/<html lang="[^"]*"/, `<html lang="${LANG_TAGS[locale]}"`)
    .replace(/(<meta name="cosens-default-locale" content=")[^"]*(")/, `$1${defaultLocale(env)}$2`);
  const headers = new Headers(response.headers);
  // The body is rewritten as plain text, so the headers that describe the original bytes go.
  for (const name of ['Content-Length', 'Content-Encoding', 'ETag']) headers.delete(name);
  return new Response(html, {status: response.status, statusText: response.statusText, headers});
}

export async function onRequest(context) {
  const {request, env, next} = context;
  const url = new URL(request.url);
  const locale = requestLocale(request, env);
  const lang = {request, env, locale};
  let cfg;
  try {
    cfg = readConfig(env);
  } catch {
    return localized(loginErrorPage('config_missing', 500, locale), lang);
  }
  const found = await getSession(cfg, request);
  if (!found) {
    const loginError = url.searchParams.get('login_error');
    if (loginError && (url.pathname === '/demo' || url.pathname === '/demo/')) return localized(loginErrorPage(loginError, 401, locale), lang);
    const login = new URL(`/api/demo/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`, url);
    return localized(new Response(null, {status: 302, headers: {Location: login.href, 'Cache-Control': 'no-store', ...NOINDEX}}), lang);
  }
  context.data.session = found.session;
  context.data.locale = locale;
  const response = await next();
  const out = new Response(response.body, response);
  out.headers.set('Cache-Control', 'private, no-store');
  for (const [name, value] of Object.entries(NOINDEX)) out.headers.set(name, value);
  return localized(out, lang);
}
