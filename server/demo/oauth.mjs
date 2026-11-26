/**
 * CoSens OAuth login for the demo hub.
 *
 * Public client with PKCE (S256) against the OAuth authorization server, the identity service
 * (`${oauthBase}/oauth2/{authorize,token,register,revoke}`; DEMO_OAUTH_BASE, default the account base),
 * with resource `oauthResource` (DEMO_OAUTH_RESOURCE, default `${memoryBase}/mcp/`). The client is the
 * first-party `DEMO_OAUTH_CLIENT_ID` (cosens-demo-hub): the identity service grants the service
 * scopes (vu.manage, rsi.read, rsi.write, llm.invoke) only to configured first-party clients.
 * Tokens never reach the browser: the Session is sealed (AES-GCM) into KV under `sess:<sid>`,
 * and the browser only holds the random sid in the HttpOnly cookie `cs_demo`.
 * The OAuth state is bound to the browser that started the login through the HttpOnly cookie
 * `cs_demo_st=<state>` (RFC 6749 section 10.12), so a callback link carrying someone else's
 * code and state cannot log this browser into their account.
 */
import {fromB64url, open, pkcePair, randomId, seal} from './crypto.mjs';
import {kvDelete, kvGetJson, kvPutJson} from './kv.mjs';
import {NOINDEX, ServiceError} from './http.mjs';
import {DEFAULT_LOCALE, LANG_TAGS, LOCALES, LOCALE_LABELS, hasLocaleParam, normalizeLocale, t} from '../../shared/i18n.mjs';
import {firstPaint, preferenceKey} from '../../shared/theme.mjs';
import {palettes, themePaintCss} from '../../shared/theme-tokens.mjs';

/** @typedef {import('./config.mjs').Config} Config */
/** @typedef {{accessToken:string, refreshToken:string|null, expiresAt:number, accountId:string, email:string|null, clientId:string, createdAt:number}} Session */

export const COOKIE_NAME = 'cs_demo';
export const LOGIN_ATTEMPT_COOKIE = 'cs_demo_lg';
export const STATE_COOKIE = 'cs_demo_st';
export const MAX_LOGIN_ATTEMPTS = 4;
export const LOGIN_ATTEMPT_WINDOW_SECONDS = 120;
export const SESSION_TTL_SECONDS = 2592000;
export const STATE_TTL_SECONDS = 600;
export const LOCK_TTL_SECONDS = 60;
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const TOKEN_TIMEOUT_MS = 15000;
const REVOKE_TIMEOUT_MS = 5000;
const LOCK_WAIT_MS = 1000;
const AUTH_COOKIE_PATH = '/api/demo/auth/';
const DEFAULT_RETURN = '/demo/';
const RETURN_BASE = 'https://return.invalid';
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_client']);
const SID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** Time source; tests replace `sleep` (and may replace `now`) with mock.method. */
export const clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The codes of `/demo/?login_error=<code>`; their texts are the `login.error.<code>` messages of shared/i18n.mjs, which the hub banner uses too. */
export const LOGIN_ERROR_CODES = Object.freeze(['access_denied', 'authorize_failed', 'state_invalid', 'code_missing', 'token_exchange_failed',
  'client_registration_failed', 'service_unavailable', 'config_missing', 'login_loop', 'unknown']);

/** The message for a login_error code in a language; an unknown code gets the generic one. */
export function loginErrorText(code, locale = DEFAULT_LOCALE) {
  const known = typeof code === 'string' && LOGIN_ERROR_CODES.includes(code);
  return t(`login.error.${known ? code : 'unknown'}`, undefined, locale);
}

/**
 * Only same-site paths under /demo survive; everything else becomes '/demo/'.
 * @param {unknown} value
 * @returns {string}
 */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return DEFAULT_RETURN;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return DEFAULT_RETURN;
  if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_RETURN;
  let url;
  try {
    url = new URL(value, RETURN_BASE);
  } catch {
    return DEFAULT_RETURN;
  }
  if (url.origin !== RETURN_BASE) return DEFAULT_RETURN;
  if (url.pathname !== '/demo' && !url.pathname.startsWith('/demo/')) return DEFAULT_RETURN;
  return url.pathname + url.search + url.hash;
}

/** @param {Request} request */
export function callbackUrl(request) {
  return `${new URL(request.url).origin}/api/demo/auth/callback`;
}

/**
 * @param {Request} request
 * @param {string} name
 * @returns {string|null}
 */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** @param {Request} request */
function isLocalHttp(request) {
  const url = new URL(request.url);
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

function cookie(request, name, value, path, maxAge) {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly'];
  if (!isLocalHttp(request)) parts.push('Secure');
  parts.push('SameSite=Lax', `Max-Age=${maxAge}`);
  return parts.join('; ');
}

/** @param {Request} request @param {string} sid */
export function sessionCookieHeader(request, sid) {
  return cookie(request, COOKIE_NAME, sid, '/', SESSION_TTL_SECONDS);
}

/** @param {Request} request */
export function clearSessionCookieHeader(request) {
  return cookie(request, COOKIE_NAME, '', '/', 0);
}

/** @param {Request} request @returns {number} */
export function loginAttempts(request) {
  const value = readCookie(request, LOGIN_ATTEMPT_COOKIE);
  return value && /^\d{1,3}$/.test(value) ? Number(value) : 0;
}

/** @param {Request} request @param {number} count */
export function loginAttemptCookie(request, count) {
  return cookie(request, LOGIN_ATTEMPT_COOKIE, String(count), AUTH_COOKIE_PATH, LOGIN_ATTEMPT_WINDOW_SECONDS);
}

/** @param {Request} request */
export function clearLoginAttemptCookie(request) {
  return cookie(request, LOGIN_ATTEMPT_COOKIE, '', AUTH_COOKIE_PATH, 0);
}

/** Binds the OAuth state to this browser for the life of the state record. @param {Request} request @param {string} state */
export function stateCookieHeader(request, state) {
  return cookie(request, STATE_COOKIE, state, AUTH_COOKIE_PATH, STATE_TTL_SECONDS);
}

/** @param {Request} request */
export function clearStateCookieHeader(request) {
  return cookie(request, STATE_COOKIE, '', AUTH_COOKIE_PATH, 0);
}

/**
 * @param {Request} request
 * @param {string} location absolute URL or a path on the request origin
 * @param {string[]} [setCookies]
 */
function redirectTo(request, location, setCookies = []) {
  const headers = new Headers({Location: new URL(location, request.url).href, 'Cache-Control': 'no-store', ...NOINDEX});
  for (const value of setCookies) headers.append('Set-Cookie', value);
  return new Response(null, {status: 302, headers});
}

/** The ?lang the request carried is passed on, so the error page opens in the language the visitor asked for. */
function withLang(request, path) {
  const lang = hasLocaleParam(request) ? normalizeLocale(new URL(request.url).searchParams.get('lang')) : null;
  return lang ? `${path}&lang=${lang}` : path;
}

/** @param {Request} request @param {string} code */
export function loginErrorRedirect(request, code) {
  return redirectTo(request, withLang(request, `/demo/?login_error=${encodeURIComponent(code)}`));
}

const THEME_ICON = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const SUN = `<svg ${THEME_ICON}><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const MOON = `<svg ${THEME_ICON}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
const THEME_BACKGROUNDS = {light: palettes.light.bg, dark: palettes.dark.bg};

/**
 * Inline theme switch for the error page: same stored preference and storage sync as the hub's
 * mountThemeControls. It is a literal string, not Function#toString: wrangler's bundler wraps inner
 * functions in a __name helper that does not exist in the browser.
 */
export const THEME_SWITCH_SCRIPT = `(function (key, backgrounds) {
  function apply(theme) {
    var root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = backgrounds[theme];
  }
  document.querySelector('[data-theme-control]').addEventListener('click', function () {
    var theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    apply(theme);
    try { localStorage.setItem(key, theme); } catch (error) { /* Storage can be denied; the switch still applies to this page. */ }
  });
  addEventListener('storage', function (event) {
    if (event.key === key || event.key === null) apply(event.newValue === 'light' ? 'light' : 'dark');
  });
})`;

/**
 * Self-contained page for `/demo/?login_error=<code>` when there is no session: no app bundle and nothing
 * else from /demo, because everything under /demo is gated. It inlines the site palette and theme switch,
 * and shows the public site logo from /assets/, so its header matches the hub's.
 * It is rendered in `locale` (default English) and offers the EN/中文 switch as two links: each reloads the page with
 * ?lang=, which the page gate turns into the cosens-lang cookie.
 * @param {unknown} code
 * @param {number} [status]
 * @param {string} [locale]
 */
export function loginErrorPage(code, status = 401, locale = DEFAULT_LOCALE) {
  const lang = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const shownCode = typeof code === 'string' && CODE_PATTERN.test(code) ? code : 'unknown';
  const message = loginErrorText(code, lang);
  const text = key => t(key, undefined, lang);
  const switcher = LOCALES.map(option => `<a${option === lang ? ' aria-current="true" class="on"' : ''} href="/demo/?login_error=${shownCode}&amp;lang=${option}" hreflang="${LANG_TAGS[option]}" lang="${LANG_TAGS[option]}">${LOCALE_LABELS[option]}</a>`).join('<span aria-hidden="true">/</span>');
  const html = `<!doctype html>
<html lang="${LANG_TAGS[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${THEME_BACKGROUNDS.dark}">
<title>${text('login.page_title')}</title>
<style>${themePaintCss}</style>
<script>(${firstPaint.toString()})(${JSON.stringify(preferenceKey)},${JSON.stringify(THEME_BACKGROUNDS)});</script>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--palette-bg);color:var(--palette-ink);font:15px/1.7 -apple-system,"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:8px 24px;border-bottom:1px solid var(--palette-line)}
.brand{display:flex;align-items:center;gap:10px;flex:none;color:var(--palette-muted);text-decoration:none;font-size:14px}
.brand img{width:auto;height:26px}
.brand span{padding-left:10px;border-left:1px solid var(--palette-line)}
.logo-dark{display:none}
:root:not([data-theme=light]) .logo-light{display:none}
:root:not([data-theme=light]) .logo-dark{display:block}
.langs{display:flex;align-items:center;gap:4px;margin-left:auto;font-size:14px;color:var(--palette-muted)}
.langs a{display:inline-block;padding:10px 6px;color:var(--palette-muted);text-decoration:none}
.langs a.on{color:var(--palette-ink);font-weight:600}
.langs a:focus-visible{outline:3px solid var(--palette-accent);outline-offset:2px}
.theme{display:grid;place-items:center;width:44px;height:44px;padding:0;border:1px solid transparent;border-radius:50%;background:transparent;color:var(--palette-ink);font:inherit;cursor:pointer}
.theme:hover{background:var(--palette-hover)}
.theme:focus-visible{outline:3px solid var(--palette-accent);outline-offset:3px}
.theme>span{grid-area:1/1;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}
:root[data-theme=light] .icon-dark,:root:not([data-theme=light]) .icon-light{display:none}
main{width:min(440px,calc(100% - 32px));margin:auto;padding:28px;border:1px solid var(--palette-line);border-radius:14px;background:var(--palette-surface)}
h1{margin:0 0 10px;font-size:20px;font-weight:600}
p{margin:0 0 20px;color:var(--palette-muted)}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.actions a{display:inline-block;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:14px;font-weight:600}
a.primary{background:var(--palette-brand);color:var(--palette-on-brand)}
a.secondary{border:1px solid var(--palette-line);color:var(--palette-ink)}
a:focus-visible{outline:3px solid var(--palette-accent);outline-offset:2px}
.tech{margin-top:18px;font-size:12px;color:var(--palette-muted)}
.tech summary{cursor:pointer;width:max-content}
.tech code{font-size:12px}
@media (max-width:600px){header{padding:6px 16px;gap:6px}.brand img{height:22px}.brand span{display:none}main{padding:22px 20px}}
</style>
</head>
<body>
<header><a class="brand" href="/" aria-label="${text('shell.home_label')}"><img class="logo-light" src="/assets/cosens-logo.png" width="132" height="32" alt="CoSens"><img class="logo-dark" src="/assets/cosens-logo-on-dark.png" width="132" height="32" alt="CoSens"><span>${text('shell.brand_label')}</span></a><nav class="langs" aria-label="${text('lang.nav_label')}">${switcher}</nav><button class="theme" type="button" data-theme-control aria-label="${text('theme.toggle')}" title="${text('theme.toggle')}"><span class="icon-light">${SUN}</span><span class="icon-dark">${MOON}</span></button></header>
<main>
<h1>${text('login.heading')}</h1>
<p>${message}</p>
<div class="actions"><a class="primary" href="/api/demo/auth/login?return=%2Fdemo%2F">${text('login.retry')}</a><a class="secondary" href="/">${text('login.home')}</a></div>
<details class="tech"><summary>${text('login.tech')}</summary>${text('login.code')}<code>${shownCode}</code></details>
</main>
<script>${THEME_SWITCH_SCRIPT}(${JSON.stringify(preferenceKey)},${JSON.stringify(THEME_BACKGROUNDS)});</script>
</body>
</html>
`;
  return new Response(html, {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...NOINDEX}});
}

/**
 * Payload of a JWT without checking the signature (tokens come straight from the token endpoint over TLS).
 * @param {unknown} jwt
 * @returns {Record<string, any>|null}
 */
export function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function oauthError(data, status) {
  if (data && typeof data.error === 'string' && data.error) {
    return {code: data.error.toLowerCase(), message: String(data.error_description || data.error)};
  }
  if (data && data.error && typeof data.error.code === 'string' && data.error.code) {
    return {code: data.error.code.toLowerCase(), message: String(data.error.message || data.error.code)};
  }
  return {code: `http_${status}`, message: 'err.http_status', params: {service: 'auth', status}};
}

/**
 * POST to an OAuth endpoint. Returns the JSON object of a 2xx answer; throws ServiceError('auth', ...).
 * @param {string} url
 * @param {{json?: object, form?: Record<string, string>}} body
 * @param {number} [timeoutMs]
 */
async function oauthPost(url, {json, form}, timeoutMs = TOKEN_TIMEOUT_MS) {
  const headers = {Accept: 'application/json'};
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let response;
  try {
    response = await fetch(url, {method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)});
  } catch {
    throw new ServiceError('auth', 502, 'upstream_unavailable', 'err.auth_unreachable');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const {code, message, params} = oauthError(data, response.status);
    throw new ServiceError('auth', response.status, code, message, params);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ServiceError('auth', 502, 'upstream_invalid_response', 'err.auth_unparsable');
  }
  return data;
}

/**
 * Client id for this redirect URI: DEMO_OAUTH_CLIENT_ID (the first-party cosens-demo-hub client),
 * else a cached or new dynamic registration. Dynamic registration is only a fallback for scope
 * sets without the service scopes: the identity service answers `invalid_scope` when a dynamic
 * client asks for them, and that answer becomes a `config_missing` error naming DEMO_OAUTH_CLIENT_ID.
 * @param {Config} cfg
 * @param {string} redirectUri
 * @returns {Promise<string>}
 */
export async function ensureClient(cfg, redirectUri) {
  if (cfg.clientId) return cfg.clientId;
  const key = `client:${redirectUri}`;
  const cached = await kvGetJson(cfg.kv, key);
  if (cached && typeof cached.clientId === 'string' && cached.clientId && cached.scopes === cfg.scopes) return cached.clientId;
  let data;
  try {
    data = await oauthPost(`${cfg.oauthBase}/oauth2/register`, {json: {
      client_name: 'CoSens Demo',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: cfg.scopes,
    }});
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'invalid_scope') {
      throw new ServiceError('auth', err.status, 'config_missing',
        'DEMO_OAUTH_CLIENT_ID must be set to the first-party client (cosens-demo-hub): dynamic registration cannot get the service scopes');
    }
    throw err;
  }
  if (typeof data.client_id !== 'string' || !data.client_id) {
    throw new ServiceError('auth', 502, 'registration_invalid', 'err.auth_no_client_id');
  }
  await kvPutJson(cfg.kv, key, {clientId: data.client_id, registeredAt: clock.now(), scopes: cfg.scopes});
  return data.client_id;
}

/**
 * Start the authorization-code flow: store {verifier, returnTo, redirectUri, clientId, createdAt}
 * under oauth:<state> for 600 s, bind the state to this browser with the cs_demo_st cookie and
 * redirect to the authorization server's authorize endpoint.
 * @param {Config} cfg
 * @param {Request} request
 * @param {unknown} returnTo
 */
export async function startLogin(cfg, request, returnTo) {
  const redirectUri = callbackUrl(request);
  const clientId = await ensureClient(cfg, redirectUri);
  const {verifier, challenge} = await pkcePair();
  const state = randomId(32);
  await kvPutJson(cfg.kv, `oauth:${state}`, {
    verifier, returnTo: safeReturnTo(returnTo), redirectUri, clientId, createdAt: clock.now(),
  }, {ttl: STATE_TTL_SECONDS});
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: cfg.oauthResource,
    scope: cfg.scopes,
    state,
  });
  return redirectTo(request, `${cfg.oauthBase}/oauth2/authorize?${query}`, [stateCookieHeader(request, state)]);
}

/**
 * @param {Record<string, any>} tokens token endpoint JSON
 * @param {string} clientId
 * @param {Session|null} [previous] session being refreshed
 * @returns {Session}
 */
function sessionFromTokens(tokens, clientId, previous = null) {
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  const claims = decodeJwtPayload(accessToken);
  const accountId = claims && typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  if (!accessToken || !accountId) throw new ServiceError('auth', 502, 'token_response_invalid', 'err.auth_incomplete_credentials');
  const identity = decodeJwtPayload(tokens.id_token) || {};
  const now = clock.now();
  const expiresIn = Number(tokens.expires_in);
  let expiresAt = now + 3600 * 1000;
  if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = now + expiresIn * 1000;
  else if (Number.isFinite(claims.exp)) expiresAt = claims.exp * 1000;
  return {
    accessToken,
    refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : previous?.refreshToken ?? null,
    expiresAt,
    accountId,
    email: typeof identity.email === 'string' && identity.email ? identity.email : previous?.email ?? null,
    clientId,
    createdAt: previous?.createdAt ?? now,
  };
}

/** @returns {Session|null} */
function normalizeSession(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.accessToken !== 'string' || !value.accessToken) return null;
  if (typeof value.accountId !== 'string' || !value.accountId) return null;
  if (!Number.isFinite(value.expiresAt)) return null;
  return {
    accessToken: value.accessToken,
    refreshToken: typeof value.refreshToken === 'string' && value.refreshToken ? value.refreshToken : null,
    expiresAt: value.expiresAt,
    accountId: value.accountId,
    email: typeof value.email === 'string' && value.email ? value.email : null,
    clientId: typeof value.clientId === 'string' ? value.clientId : '',
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
  };
}

/**
 * Unseal sess:<sid>. A value that cannot be opened (tampered, other secret, bad shape) is deleted.
 * @param {Config} cfg
 * @param {string} sid
 * @returns {Promise<Session|null>}
 */
export async function readSession(cfg, sid) {
  const key = `sess:${sid}`;
  const raw = await cfg.kv.get(key);
  if (raw == null) return null;
  let sealed = raw;
  if (typeof raw === 'string' && raw.startsWith('"')) {
    try {
      sealed = JSON.parse(raw);
    } catch {
      sealed = null;
    }
  }
  const session = normalizeSession(typeof sealed === 'string' ? await open(cfg.secret, sealed) : null);
  if (!session) {
    await kvDelete(cfg.kv, key);
    return null;
  }
  return session;
}

/**
 * @param {Config} cfg
 * @param {string} sid
 * @param {Session} session
 */
export async function writeSession(cfg, sid, session) {
  await kvPutJson(cfg.kv, `sess:${sid}`, await seal(cfg.secret, session), {ttl: SESSION_TTL_SECONDS});
}

async function deleteSessionKeys(cfg, sid) {
  await kvDelete(cfg.kv, `sess:${sid}`);
  await kvDelete(cfg.kv, `lock:refresh:${sid}`);
}

/** Callback failure: /demo/?login_error=<code>, clearing the state binding cookie. */
function callbackError(request, code) {
  return redirectTo(request, withLang(request, `/demo/?login_error=${encodeURIComponent(code)}`), [clearStateCookieHeader(request)]);
}

/**
 * OAuth callback: check that the state is the one this browser started (cs_demo_st), validate and
 * consume it, exchange the code, store the Session, redirect to returnTo with the session cookie.
 * Every failure redirects to /demo/?login_error=<code>; every outcome clears cs_demo_st.
 * @param {Config} cfg
 * @param {Request} request
 */
export async function finishLogin(cfg, request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state || !STATE_PATTERN.test(state) || readCookie(request, STATE_COOKIE) !== state) {
    return callbackError(request, 'state_invalid');
  }
  const record = await kvGetJson(cfg.kv, `oauth:${state}`);
  if (!record || typeof record.verifier !== 'string' || typeof record.clientId !== 'string') {
    return callbackError(request, 'state_invalid');
  }
  await kvDelete(cfg.kv, `oauth:${state}`);
  const redirectUri = callbackUrl(request);
  if (record.redirectUri !== redirectUri) return callbackError(request, 'state_invalid');
  const authorizeError = url.searchParams.get('error');
  if (authorizeError) return callbackError(request, authorizeError === 'access_denied' ? 'access_denied' : 'authorize_failed');
  const code = url.searchParams.get('code');
  if (!code) return callbackError(request, 'code_missing');
  let tokens;
  try {
    tokens = await oauthPost(`${cfg.oauthBase}/oauth2/token`, {form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: record.clientId,
      code_verifier: record.verifier,
    }});
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    if (err.code === 'invalid_client' && !cfg.clientId) await kvDelete(cfg.kv, `client:${redirectUri}`);
    return callbackError(request, err.status >= 500 ? 'service_unavailable' : 'token_exchange_failed');
  }
  let session;
  try {
    session = sessionFromTokens(tokens, record.clientId);
  } catch {
    return callbackError(request, 'token_exchange_failed');
  }
  const previousSid = readCookie(request, COOKIE_NAME);
  if (previousSid && SID_PATTERN.test(previousSid)) await deleteSessionKeys(cfg, previousSid);
  const sid = randomId(32);
  await writeSession(cfg, sid, session);
  return redirectTo(request, safeReturnTo(record.returnTo), [sessionCookieHeader(request, sid), clearStateCookieHeader(request)]);
}

/**
 * Rotate the tokens with the refresh token and store the new Session.
 * @param {Config} cfg
 * @param {string} sid
 * @param {Session} session
 * @returns {Promise<Session>}
 */
export async function refreshSession(cfg, sid, session) {
  if (!session.refreshToken) throw new ServiceError('auth', 401, 'refresh_unavailable', 'err.login_expired');
  const tokens = await oauthPost(`${cfg.oauthBase}/oauth2/token`, {form: {
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: session.clientId,
  }});
  const next = sessionFromTokens(tokens, session.clientId, session);
  await writeSession(cfg, sid, next);
  return next;
}

/**
 * Best-effort single flight through lock:refresh:<sid>. If another request holds the lock, wait
 * one second and re-read; if the session is still stale, refresh anyway (the authorization server
 * returns the same replacement for a repeated refresh within 30 s).
 */
async function refreshWithLock(cfg, sid, session) {
  const lockKey = `lock:refresh:${sid}`;
  let current = session;
  let ownLock = false;
  if (await cfg.kv.get(lockKey)) {
    await clock.sleep(LOCK_WAIT_MS);
    const reread = await readSession(cfg, sid);
    if (!reread) return null;
    if (reread.expiresAt - clock.now() >= REFRESH_MARGIN_MS) return {sid, session: reread};
    current = reread;
  } else {
    await kvPutJson(cfg.kv, lockKey, '1', {ttl: LOCK_TTL_SECONDS});
    ownLock = true;
  }
  try {
    return {sid, session: await refreshSession(cfg, sid, current)};
  } catch (err) {
    if (!(err instanceof ServiceError)) throw err;
    if (TERMINAL_REFRESH_ERRORS.has(err.code)) {
      await deleteSessionKeys(cfg, sid);
      return null;
    }
    return current.expiresAt > clock.now() ? {sid, session: current} : null;
  } finally {
    if (ownLock) await kvDelete(cfg.kv, lockKey);
  }
}

/**
 * Session behind the request's cookie, refreshed when it expires within 5 minutes.
 * @param {Config} cfg
 * @param {Request} request
 * @returns {Promise<{sid:string, session:Session}|null>}
 */
export async function getSession(cfg, request) {
  const sid = readCookie(request, COOKIE_NAME);
  if (!sid || !SID_PATTERN.test(sid)) return null;
  const session = await readSession(cfg, sid);
  if (!session) return null;
  const now = clock.now();
  if (session.expiresAt - now >= REFRESH_MARGIN_MS) return {sid, session};
  if (!session.refreshToken) {
    if (session.expiresAt > now) return {sid, session};
    await deleteSessionKeys(cfg, sid);
    return null;
  }
  return refreshWithLock(cfg, sid, session);
}

async function revokeTokens(cfg, session) {
  const form = session.refreshToken
    ? {token: session.refreshToken, token_type_hint: 'refresh_token'}
    : {token: session.accessToken, token_type_hint: 'access_token'};
  if (session.clientId) form.client_id = session.clientId;
  try {
    await fetch(`${cfg.oauthBase}/oauth2/revoke`, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
  } catch {
    // Logout must finish locally even when revocation cannot be reached.
  }
}

/**
 * Delete the session behind the cookie (optionally revoking its grant) and return the Set-Cookie
 * value that clears the cookie.
 * @param {Config} cfg
 * @param {Request} request
 * @param {{revoke?: boolean}} [options]
 * @returns {Promise<string>}
 */
export async function destroySession(cfg, request, {revoke = false} = {}) {
  const sid = readCookie(request, COOKIE_NAME);
  if (sid && SID_PATTERN.test(sid)) {
    if (revoke) {
      const session = await readSession(cfg, sid);
      if (session) await revokeTokens(cfg, session);
    }
    await deleteSessionKeys(cfg, sid);
  }
  return clearSessionCookieHeader(request);
}
