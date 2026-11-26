import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig, installFetch, sessionCookie, seedSession, envFromConfig} from './helpers/fake-services.mjs';
import {kvGetJson} from '../server/demo/kv.mjs';
import {ServiceError} from '../server/demo/http.mjs';
import {readSession, writeSession} from '../server/demo/oauth.mjs';
import {onRequestGet as login} from '../functions/api/demo/auth/login.js';
import {onRequestGet as callback} from '../functions/api/demo/auth/callback.js';
import {onRequestPost as logout} from '../functions/api/demo/auth/logout.js';
import {onRequestGet as me} from '../functions/api/demo/me.js';
import {onRequest as apiGate} from '../functions/api/demo/_middleware.js';
import {onRequest as pageGate} from '../functions/demo/_middleware.js';

const ORIGIN = 'https://cosens.ai';
const REGISTER_URL = 'https://account.test/oauth2/register';
const TOKEN_URL = 'https://account.test/oauth2/token';
const REVOKE_URL = 'https://account.test/oauth2/revoke';
const FIXED = {DEMO_OAUTH_CLIENT_ID: 'client-fixed'};
const DAY_MS = 24 * 3600 * 1000;
const CLEAR_STATE = 'cs_demo_st=; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

const jwt = (payload) => [{alg: 'RS256', typ: 'JWT'}, payload]
  .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.signature';
const oauthError = (status, error, description = error) => () =>
  Response.json({error, error_description: description}, {status});
const formOf = (call) => Object.fromEntries(new URLSearchParams(call.body));

function tokens({sub = 'acct_42', email = 'visitor@example.com', refresh = 'mcp_rt_new'} = {}) {
  return {
    access_token: jwt({sub, token_use: 'mcp_access'}), token_type: 'Bearer', expires_in: 2592000,
    refresh_token: refresh, id_token: jwt({sub, email}),
  };
}

function stored(overrides = {}) {
  return {
    accessToken: jwt({sub: 'acct_42'}), refreshToken: 'mcp_rt_old', expiresAt: Date.now() + 3600e3,
    accountId: 'acct_42', email: 'visitor@example.com', clientId: 'client-fixed', createdAt: 1, ...overrides,
  };
}

async function withFetch(routes, run) {
  const fake = installFetch(routes);
  try {
    return await run(fake);
  } finally {
    fake.restore();
  }
}

const staticPage = async () => new Response('<!doctype html><title>hub</title>', {
  headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600'},
});

function context(cfg, path, {cookie, method = 'GET', env = FIXED, next = staticPage} = {}) {
  const ctx = {
    request: new Request(new URL(path, ORIGIN), {method, headers: cookie ? {Cookie: cookie} : {}}),
    env: envFromConfig(cfg, env),
    params: {},
    data: {},
    waitUntil() {},
  };
  ctx.next = () => next(ctx);
  return ctx;
}

function withoutSecret(ctx) {
  delete ctx.env.DEMO_SESSION_SECRET;
  return ctx;
}

const sidFrom = (response) => /^cs_demo=([A-Za-z0-9_-]+);/.exec(response.headers.get('Set-Cookie'))[1];
const stateOf = (response) => new URL(response.headers.get('Location')).searchParams.get('state');
// What a browser sends back to /api/demo/auth/callback: the cs_demo_st pair from the login response.
const stateCookieFrom = (response) => response.headers.getSetCookie().find((line) => line.startsWith('cs_demo_st=')).split(';')[0];

test('login, callback, me and logout work end to end', async () => {
  const cfg = testConfig();
  await withFetch([
    {method: 'POST', url: TOKEN_URL, reply: () => tokens()},
    {method: 'POST', url: REVOKE_URL, reply: () => new Response(null, {status: 200})},
  ], async (fake) => {
    const started = await login(context(cfg, '/api/demo/auth/login?return=%2Fdemo%2Finvestor%2F%3Frun%3Drun_abc'));
    assert.equal(started.status, 302);
    const authorize = new URL(started.headers.get('Location'));
    assert.equal(authorize.origin + authorize.pathname, 'https://account.test/oauth2/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'client-fixed');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://cosens.ai/api/demo/auth/callback');
    const state = authorize.searchParams.get('state');
    assert.deepEqual(started.headers.getSetCookie(), [
      `cs_demo_st=${state}; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      'cs_demo_lg=1; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=120',
    ]);

    const done = await callback(context(cfg, `/api/demo/auth/callback?code=code_123&state=${state}`, {cookie: stateCookieFrom(started)}));
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('Location'), 'https://cosens.ai/demo/investor/?run=run_abc');
    const sid = sidFrom(done);
    assert.deepEqual(done.headers.getSetCookie().slice(1), [CLEAR_STATE]);

    const profile = await apiGate(context(cfg, '/api/demo/me', {cookie: sessionCookie(sid), next: (ctx) => me(ctx)}));
    assert.equal(profile.status, 200);
    assert.deepEqual(await profile.json(), {email: 'visitor@example.com', accountId: 'acct_42', memory: {documents: true, stats: true}});
    assert.match(profile.headers.get('Cache-Control'), /no-store/);
    assert.equal(profile.headers.get('X-Robots-Tag'), 'noindex, nofollow');

    const out = await apiGate(context(cfg, '/api/demo/auth/logout', {method: 'POST', cookie: `${sessionCookie(sid)}; cs_demo_lg=1`, next: (ctx) => logout(ctx)}));
    assert.equal(out.status, 204);
    assert.deepEqual(out.headers.getSetCookie(), [
      'cs_demo=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'cs_demo_lg=; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    ]);
    assert.equal(out.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(out.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    assert.equal(await readSession(cfg, sid), null);
    const revoke = fake.calls.find((call) => call.url === REVOKE_URL);
    assert.deepEqual(formOf(revoke), {token: 'mcp_rt_new', token_type_hint: 'refresh_token', client_id: 'client-fixed'});

    const after = await apiGate(context(cfg, '/api/demo/me', {cookie: sessionCookie(sid), next: (ctx) => me(ctx)}));
    assert.equal(after.status, 401);
    assert.equal((await after.json()).error.code, 'not_authenticated');
  });
});

test('login counts attempts and stops a redirect loop at the fourth attempt', async () => {
  const cfg = testConfig();
  const again = await login(context(cfg, '/api/demo/auth/login', {cookie: 'cs_demo_lg=2'}));
  assert.equal(new URL(again.headers.get('Location')).pathname, '/oauth2/authorize');
  assert.deepEqual(again.headers.getSetCookie(), [
    `cs_demo_st=${stateOf(again)}; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    'cs_demo_lg=3; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=120',
  ]);
  const looped = await login(context(cfg, '/api/demo/auth/login', {cookie: 'cs_demo_lg=4'}));
  assert.equal(looped.status, 302);
  assert.equal(looped.headers.get('Location'), 'https://cosens.ai/demo/?login_error=login_loop');
  assert.deepEqual((await cfg.kv.list({prefix: 'oauth:'})).keys.length, 1, 'the blocked attempt stores no state');
});

test('login keeps only a safe return path', async () => {
  const cfg = testConfig();
  const started = await login(context(cfg, '/api/demo/auth/login?return=https%3A%2F%2Fevil.example%2Fdemo%2F'));
  const state = new URL(started.headers.get('Location')).searchParams.get('state');
  assert.equal((await kvGetJson(cfg.kv, `oauth:${state}`)).returnTo, '/demo/');
  const plain = await login(context(cfg, '/api/demo/auth/login'));
  const plainState = new URL(plain.headers.get('Location')).searchParams.get('state');
  assert.equal((await kvGetJson(cfg.kv, `oauth:${plainState}`)).returnTo, '/demo/');
});

test('login maps configuration and registration failures to login_error codes (invalid_scope means DEMO_OAUTH_CLIENT_ID is missing)', async () => {
  const cfg = testConfig();
  const missing = await login(withoutSecret(context(cfg, '/api/demo/auth/login')));
  assert.equal(missing.headers.get('Location'), 'https://cosens.ai/demo/?login_error=config_missing');
  const cases = [
    [() => Response.json({ok: false, error: {code: 'OAUTH_SCOPE_INVALID', message: 'Unsupported OAuth scope: vu.manage'}}, {status: 400}), 'client_registration_failed'],
    [oauthError(400, 'oauth_redirect_uri_invalid'), 'client_registration_failed'],
    [oauthError(400, 'invalid_scope', 'Scope vu.manage is limited to first-party clients'), 'config_missing'],
    [oauthError(503, 'temporarily_unavailable'), 'service_unavailable'],
    [() => { throw new Error('connection refused'); }, 'service_unavailable'],
  ];
  for (const [reply, code] of cases) {
    await withFetch([{method: 'POST', url: REGISTER_URL, reply}], async () => {
      const response = await login(context(cfg, '/api/demo/auth/login', {env: {}}));
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('Location'), `https://cosens.ai/demo/?login_error=${code}`);
      assert.equal(response.headers.get('Set-Cookie'), null);
    });
  }
});

test('login registers the client dynamically when no client id is configured', async () => {
  const cfg = testConfig();
  await withFetch([{method: 'POST', url: REGISTER_URL, reply: () => Response.json({client_id: 'client-dcr'}, {status: 201})}], async (fake) => {
    const response = await login(context(cfg, '/api/demo/auth/login', {env: {}}));
    assert.equal(new URL(response.headers.get('Location')).searchParams.get('client_id'), 'client-dcr');
    assert.deepEqual(JSON.parse(fake.calls[0].body).redirect_uris, ['https://cosens.ai/api/demo/auth/callback']);
  });
});

test('callback rejects a state mismatch, an unbound state, a missing code and an upstream 400, clearing the state cookie', async () => {
  const cfg = testConfig();
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: oauthError(400, 'invalid_grant', 'OAuth authorization code is invalid')}], async (fake) => {
    const mismatch = await callback(context(cfg, '/api/demo/auth/callback?code=c&state=not-a-stored-state-123', {cookie: 'cs_demo_st=not-a-stored-state-123'}));
    assert.equal(mismatch.headers.get('Location'), 'https://cosens.ai/demo/?login_error=state_invalid');
    const first = await login(context(cfg, '/api/demo/auth/login'));
    const unbound = await callback(context(cfg, `/api/demo/auth/callback?code=c&state=${stateOf(first)}`));
    assert.equal(unbound.headers.get('Location'), 'https://cosens.ai/demo/?login_error=state_invalid', 'a callback without the binding cookie is refused');
    const noCode = await callback(context(cfg, `/api/demo/auth/callback?state=${stateOf(first)}`, {cookie: stateCookieFrom(first)}));
    assert.equal(noCode.headers.get('Location'), 'https://cosens.ai/demo/?login_error=code_missing');
    const second = await login(context(cfg, '/api/demo/auth/login'));
    const rejected = await callback(context(cfg, `/api/demo/auth/callback?code=c&state=${stateOf(second)}`, {cookie: stateCookieFrom(second)}));
    assert.equal(rejected.headers.get('Location'), 'https://cosens.ai/demo/?login_error=token_exchange_failed');
    for (const response of [mismatch, unbound, noCode, rejected]) {
      assert.equal(response.status, 302);
      assert.deepEqual(response.headers.getSetCookie(), [CLEAR_STATE]);
    }
    assert.equal(fake.calls.length, 1);
    assert.deepEqual((await cfg.kv.list({prefix: 'sess:'})).keys, []);
  });
  const missing = await callback(withoutSecret(context(cfg, '/api/demo/auth/callback?code=c&state=abc', {cookie: 'cs_demo_st=abc'})));
  assert.equal(missing.headers.get('Location'), 'https://cosens.ai/demo/?login_error=config_missing');
  assert.deepEqual(missing.headers.getSetCookie(), [CLEAR_STATE]);
  const broken = testConfig();
  const started = await login(context(broken, '/api/demo/auth/login'));
  broken.kv.get = async () => { throw new Error('KV unavailable'); };
  const down = await callback(context(broken, `/api/demo/auth/callback?code=c&state=${stateOf(started)}`, {cookie: stateCookieFrom(started)}));
  assert.equal(down.headers.get('Location'), 'https://cosens.ai/demo/?login_error=service_unavailable');
  assert.deepEqual(down.headers.getSetCookie(), [CLEAR_STATE]);
});

test('logout without a session still answers 204 and clears both cookies', async () => {
  const cfg = testConfig();
  await withFetch([], async (fake) => {
    const response = await logout(context(cfg, '/api/demo/auth/logout', {method: 'POST'}));
    assert.equal(response.status, 204);
    assert.deepEqual(response.headers.getSetCookie(), [
      'cs_demo=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'cs_demo_lg=; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    ]);
    assert.equal(fake.calls.length, 0);
  });
  const broken = await logout(withoutSecret(context(cfg, '/api/demo/auth/logout', {method: 'POST'})));
  assert.equal(broken.status, 500);
  assert.equal((await broken.json()).error.code, 'config_missing');
});

test('API gate answers 401 JSON without a valid session', async () => {
  const cfg = testConfig();
  let reached = false;
  const next = async () => { reached = true; return new Response('should not run'); };
  for (const cookie of [undefined, 'cs_demo=forged-session-id', 'cs_demo=', 'other=1']) {
    const response = await apiGate(context(cfg, '/api/demo/investor/runs', {cookie, next}));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'not_authenticated');
    assert.equal(body.error.service, 'auth');
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  }
  assert.equal(reached, false);
});

test('API gate lets auth routes through without a session and adds no-store headers', async () => {
  const cfg = testConfig();
  for (const path of ['/api/demo/auth/login', '/api/demo/auth/callback?code=c&state=s', '/api/demo/auth/logout']) {
    const response = await apiGate(context(cfg, path, {next: async () => new Response('auth route')}));
    assert.equal(await response.text(), 'auth route');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  }
  const keeps = await apiGate(context(cfg, '/api/demo/auth/login', {next: async () => new Response(null, {status: 302, headers: {Location: 'https://account.test/oauth2/authorize', 'Cache-Control': 'no-store'}})}));
  assert.equal(keeps.status, 302);
  assert.equal(keeps.headers.get('Cache-Control'), 'no-store');
});

test('API gate puts cfg, session and sid into context.data', async () => {
  const cfg = testConfig();
  const sid = await seedSession(cfg, {sid: 'sid-gate', accountId: 'acct_gate', email: 'gate@example.com'});
  let seen;
  const response = await apiGate(context(cfg, '/api/demo/investor/runs', {cookie: sessionCookie(sid), next: async (ctx) => {
    seen = ctx.data;
    return Response.json({ok: true});
  }}));
  assert.equal(response.status, 200);
  assert.equal(seen.sid, 'sid-gate');
  assert.equal(seen.session.accountId, 'acct_gate');
  assert.equal(seen.session.email, 'gate@example.com');
  assert.equal(seen.cfg.memoryBase, 'https://memory.test');
  assert.equal(seen.cfg.kv, cfg.kv);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('API gate refreshes an expiring session before the handler runs', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-renew', stored({expiresAt: Date.now() + 60e3}));
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: () => tokens({refresh: 'mcp_rt_rotated'})}], async (fake) => {
    let seen;
    const response = await apiGate(context(cfg, '/api/demo/me', {cookie: sessionCookie('sid-renew'), next: async (ctx) => {
      seen = ctx.data.session;
      return me(ctx);
    }}));
    assert.equal(response.status, 200);
    assert.equal(fake.calls.length, 1);
    assert.equal(seen.refreshToken, 'mcp_rt_rotated');
    assert.ok(seen.expiresAt > Date.now() + 29 * DAY_MS);
    assert.equal((await readSession(cfg, 'sid-renew')).refreshToken, 'mcp_rt_rotated');
  });
});

test('API gate answers 401 and deletes the session when refresh fails for good', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-gone', stored({expiresAt: Date.now() - 1000}));
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: oauthError(400, 'invalid_grant', 'OAuth refresh token is invalid')}], async () => {
    const response = await apiGate(context(cfg, '/api/demo/me', {cookie: sessionCookie('sid-gone'), next: (ctx) => me(ctx)}));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'not_authenticated');
    assert.equal(await readSession(cfg, 'sid-gone'), null);
  });
});

test('API gate turns handler errors and configuration errors into JSON errors', async () => {
  const cfg = testConfig();
  const sid = await seedSession(cfg);
  const failing = await apiGate(context(cfg, '/api/demo/investor/runs', {cookie: sessionCookie(sid), next: async () => {
    throw new ServiceError('memory', 503, 'http_503', 'Memory 暂时不可用');
  }}));
  assert.equal(failing.status, 502);
  assert.equal((await failing.json()).error.service, 'memory');
  const broken = await apiGate(withoutSecret(context(cfg, '/api/demo/me', {cookie: sessionCookie(sid)})));
  assert.equal(broken.status, 500);
  assert.equal((await broken.json()).error.code, 'config_missing');
});

test('me tells the page that Memory through the gateway takes no PDF or Word and has no stats', async () => {
  const cfg = testConfig({memoryBase: 'https://rsi.test/api', memoryViaGateway: true, oauthResource: 'https://rsi.test/mcp'});
  const sid = await seedSession(cfg, {sid: 'sid-gw', accountId: 'acct_gw', email: 'gw@example.com'});
  const response = await apiGate(context(cfg, '/api/demo/me', {cookie: sessionCookie(sid), next: (ctx) => me(ctx)}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {email: 'gw@example.com', accountId: 'acct_gw', memory: {documents: false, stats: false}});
});

test('me answers 401 when it is reached without a session', async () => {
  const response = await me({request: new Request('https://cosens.ai/api/demo/me'), env: {}, params: {}, data: {}});
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'not_authenticated');
});

test('page gate redirects every /demo path to login with path and query', async () => {
  const cfg = testConfig();
  const cases = [
    ['/demo', '%2Fdemo'],
    ['/demo/', '%2Fdemo%2F'],
    ['/demo/investor/?run=run_abc', '%2Fdemo%2Finvestor%2F%3Frun%3Drun_abc'],
    ['/demo/assets/investor/manifest.json', '%2Fdemo%2Fassets%2Finvestor%2Fmanifest.json'],
    ['/demo/assets/investor/demo-data.zip', '%2Fdemo%2Fassets%2Finvestor%2Fdemo-data.zip'],
    ['/demo/_app/hub.js', '%2Fdemo%2F_app%2Fhub.js'],
  ];
  for (const [path, encoded] of cases) {
    for (const cookie of [undefined, 'cs_demo=forged-session-id']) {
      let reached = false;
      const response = await pageGate(context(cfg, path, {cookie, next: async () => { reached = true; return new Response('secret'); }}));
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('Location'), `https://cosens.ai/api/demo/auth/login?return=${encoded}`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
      assert.equal(reached, false);
    }
  }
});

test('page gate serves pages and assets to a signed-in visitor with private no-store noindex headers', async () => {
  const cfg = testConfig();
  const sid = await seedSession(cfg);
  for (const path of ['/demo/', '/demo/investor/?run=run_abc', '/demo/assets/investor/manifest.json', '/demo/?login_error=access_denied']) {
    let seen;
    const response = await pageGate(context(cfg, path, {cookie: sessionCookie(sid), next: async (ctx) => {
      seen = ctx.data.session;
      return staticPage();
    }}));
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), '<!doctype html><title>hub</title>');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(seen.accountId, 'acct_test');
  }
});

test('page gate shows the login error page without a session instead of looping', async () => {
  const cfg = testConfig();
  for (const path of ['/demo/?login_error=access_denied', '/demo?login_error=state_invalid']) {
    let reached = false;
    const response = await pageGate(context(cfg, path, {next: async () => { reached = true; return staticPage(); }}));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    const html = await response.text();
    assert.ok(html.includes('Sign in again'));
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('href="/api/demo/auth/login?return=%2Fdemo%2F"'));
    assert.equal(reached, false);
  }
  const deep = await pageGate(context(cfg, '/demo/investor/?login_error=access_denied'));
  assert.equal(deep.status, 302, 'only the hub path shows the error page');
});

test('page gate refreshes an expiring session or sends the visitor to login when refresh fails', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-page-renew', stored({expiresAt: Date.now() + 60e3}));
  await writeSession(cfg, 'sid-page-dead', stored({expiresAt: Date.now() - 1000, refreshToken: 'mcp_rt_dead'}));
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: (request) => request.text().then((body) =>
    new URLSearchParams(body).get('refresh_token') === 'mcp_rt_dead'
      ? Response.json({error: 'invalid_grant', error_description: 'OAuth refresh token is invalid'}, {status: 400})
      : Response.json(tokens({refresh: 'mcp_rt_page'})))}], async () => {
    const renewed = await pageGate(context(cfg, '/demo/investor/', {cookie: sessionCookie('sid-page-renew')}));
    assert.equal(renewed.status, 200);
    assert.equal((await readSession(cfg, 'sid-page-renew')).refreshToken, 'mcp_rt_page');
    const dead = await pageGate(context(cfg, '/demo/investor/', {cookie: sessionCookie('sid-page-dead')}));
    assert.equal(dead.status, 302);
    assert.equal(dead.headers.get('Location'), 'https://cosens.ai/api/demo/auth/login?return=%2Fdemo%2Finvestor%2F');
    assert.equal(await readSession(cfg, 'sid-page-dead'), null);
  });
});

test('page gate shows a configuration error page when the environment is incomplete', async () => {
  const cfg = testConfig();
  const response = await pageGate(withoutSecret(context(cfg, '/demo/')));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.ok((await response.text()).includes('The demo hub is not fully configured yet. Please contact us.'));
});
