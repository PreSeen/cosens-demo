import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig, installFetch, sessionCookie, seedSession} from './helpers/fake-services.mjs';
import {kvGetJson} from '../server/demo/kv.mjs';
import {ServiceError} from '../server/demo/http.mjs';
import {
  LOGIN_ERROR_CODES, clock, decodeJwtPayload, destroySession, ensureClient, finishLogin, getSession,
  THEME_SWITCH_SCRIPT, loginAttemptCookie, loginAttempts, loginErrorPage, loginErrorText, readCookie, readSession, refreshSession,
  safeReturnTo, startLogin, writeSession,
} from '../server/demo/oauth.mjs';

const ORIGIN = 'https://cosens.ai';
const CALLBACK = `${ORIGIN}/api/demo/auth/callback`;
const REGISTER_URL = 'https://account.test/oauth2/register';
const TOKEN_URL = 'https://account.test/oauth2/token';
const REVOKE_URL = 'https://account.test/oauth2/revoke';
const DAY_MS = 24 * 3600 * 1000;
const CLEAR_STATE = 'cs_demo_st=; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

const jwt = (payload) => [{alg: 'RS256', typ: 'JWT'}, payload]
  .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.signature';
const request = (path, {cookie, origin = ORIGIN, method = 'GET'} = {}) =>
  new Request(new URL(path, origin), {method, headers: cookie ? {Cookie: cookie} : {}});
const formOf = (call) => Object.fromEntries(new URLSearchParams(call.body));
const s256 = async (verifier) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
const oauthError = (status, error, description = error) => () =>
  Response.json({error, error_description: description}, {status});

function tokens({sub = 'acct_42', email = 'visitor@example.com', expiresIn = 2592000, refresh = 'mcp_rt_new', idToken = true} = {}) {
  const body = {
    access_token: jwt({sub, token_use: 'mcp_access', exp: Math.floor(Date.now() / 1000) + expiresIn}),
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: 'offline_access memory.read memory.write',
  };
  if (refresh) body.refresh_token = refresh;
  if (idToken) body.id_token = jwt({sub, email});
  return body;
}

function stored(overrides = {}) {
  return {
    accessToken: jwt({sub: 'acct_42'}), refreshToken: 'mcp_rt_old', expiresAt: Date.now() + 60e3,
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

async function begin(cfg, {origin = ORIGIN, returnTo = '/demo/investor/?run=run_abc'} = {}) {
  const response = await startLogin(cfg, request('/api/demo/auth/login', {origin}), returnTo);
  const location = new URL(response.headers.get('Location'));
  const state = location.searchParams.get('state');
  return {response, location, state, binding: `cs_demo_st=${state}`};
}

test('safeReturnTo keeps demo paths and rejects everything else', () => {
  const cases = [
    ['/demo/', '/demo/'],
    ['/demo', '/demo'],
    ['/demo/investor/?run=run_abc', '/demo/investor/?run=run_abc'],
    ['/demo/./investor/', '/demo/investor/'],
    ['/demofoo', '/demo/'],
    ['/demo/../api/demo/me', '/demo/'],
    ['/demo/%2e%2e/api', '/demo/'],
    ['//evil.example/demo/', '/demo/'],
    ['/\\evil.example/demo/', '/demo/'],
    ['https://evil.example/demo/', '/demo/'],
    ['/demo/\nSet-Cookie:x', '/demo/'],
    ['/api/demo/me', '/demo/'],
    ['', '/demo/'],
    [null, '/demo/'],
    [undefined, '/demo/'],
    [42, '/demo/'],
    ['/demo/' + 'a'.repeat(3000), '/demo/'],
  ];
  for (const [input, expected] of cases) assert.equal(safeReturnTo(input), expected, JSON.stringify(input));
});

test('decodeJwtPayload reads the payload and returns null for anything malformed', () => {
  assert.deepEqual(decodeJwtPayload(jwt({sub: 'acct_1', email: '访客@example.com'})), {sub: 'acct_1', email: '访客@example.com'});
  const arrayPayload = `x.${Buffer.from('[1]').toString('base64url')}.y`;
  for (const bad of ['', 'abc', 'a.b.c', 'a.!!!.c', arrayPayload, null, 7]) assert.equal(decodeJwtPayload(bad), null, String(bad));
});

test('readCookie and the login attempt counter parse and build cookies', () => {
  const r = request('/demo/', {cookie: 'theme=dark; cs_demo=sid_1; cs_demo_lg=3'});
  assert.equal(readCookie(r, 'cs_demo'), 'sid_1');
  assert.equal(readCookie(r, 'missing'), null);
  assert.equal(readCookie(request('/demo/'), 'cs_demo'), null);
  assert.equal(loginAttempts(r), 3);
  assert.equal(loginAttempts(request('/demo/', {cookie: 'cs_demo_lg=abc'})), 0);
  assert.equal(loginAttempts(request('/demo/')), 0);
  assert.equal(loginAttemptCookie(r, 4), 'cs_demo_lg=4; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=120');
  assert.equal(loginAttemptCookie(request('/x', {origin: 'http://localhost:8788'}), 1),
    'cs_demo_lg=1; Path=/api/demo/auth/; HttpOnly; SameSite=Lax; Max-Age=120');
});

test('ensureClient uses the configured client id without calling upstream', async () => {
  await withFetch([], async (fake) => {
    assert.equal(await ensureClient(testConfig({clientId: 'client-fixed'}), CALLBACK), 'client-fixed');
    assert.equal(fake.calls.length, 0);
  });
});

test('ensureClient registers once per redirect URI and scope set and then reuses the KV cache', async () => {
  const cfg = testConfig();
  let issued = 0;
  const routes = [{method: 'POST', url: REGISTER_URL, reply: () => Response.json({client_id: `client-dcr-${++issued}`, token_endpoint_auth_method: 'none'}, {status: 201})}];
  await withFetch(routes, async (fake) => {
    assert.equal(await ensureClient(cfg, CALLBACK), 'client-dcr-1');
    assert.equal(await ensureClient(cfg, CALLBACK), 'client-dcr-1');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(fake.calls[0].body), {
      client_name: 'CoSens Demo', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', scope: cfg.scopes,
    });
    const cached = await kvGetJson(cfg.kv, `client:${CALLBACK}`);
    assert.equal(cached.clientId, 'client-dcr-1');
    assert.equal(cached.scopes, cfg.scopes);
    assert.equal(typeof cached.registeredAt, 'number');
    assert.equal(await ensureClient({...cfg, scopes: 'openid email offline_access memory.read'}, CALLBACK), 'client-dcr-2');
    assert.equal(fake.calls.length, 2);
  });
});

test('ensureClient surfaces facade and OAuth registration errors and caches nothing', async () => {
  const cfg = testConfig();
  const cases = [
    [() => Response.json({ok: false, error: {code: 'OAUTH_SCOPE_INVALID', message: 'Unsupported OAuth scope: vu.manage'}}, {status: 400}), 400, 'oauth_scope_invalid'],
    [oauthError(400, 'oauth_redirect_uri_invalid', 'OAuth redirect_uri is not allowed for Remote MCP'), 400, 'oauth_redirect_uri_invalid'],
    [() => Response.json({}, {status: 201}), 502, 'registration_invalid'],
    [() => new Response('<html>gateway</html>', {status: 502}), 502, 'http_502'],
    [() => { throw new Error('connection refused'); }, 502, 'upstream_unavailable'],
  ];
  for (const [reply, status, code] of cases) {
    await withFetch([{method: 'POST', url: REGISTER_URL, reply}], async () => {
      await assert.rejects(ensureClient(cfg, CALLBACK),
        (err) => err instanceof ServiceError && err.service === 'auth' && err.status === status && err.code === code);
    });
  }
  assert.equal(await kvGetJson(cfg.kv, `client:${CALLBACK}`), null);
});

test('ensureClient turns an invalid_scope registration answer into a config_missing error naming DEMO_OAUTH_CLIENT_ID', async () => {
  const cfg = testConfig();
  await withFetch([{method: 'POST', url: REGISTER_URL, reply: oauthError(400, 'invalid_scope', 'Scope vu.manage is limited to first-party clients')}], async (fake) => {
    await assert.rejects(ensureClient(cfg, CALLBACK), (err) => err instanceof ServiceError && err.service === 'auth'
      && err.status === 400 && err.code === 'config_missing' && /DEMO_OAUTH_CLIENT_ID must be set/.test(err.message)
      && /cosens-demo-hub/.test(err.message));
    assert.equal(fake.calls.length, 1);
  });
  assert.equal(await kvGetJson(cfg.kv, `client:${CALLBACK}`), null);
});

test('startLogin stores the PKCE state and redirects to the authorization server authorize endpoint', async () => {
  const cfg = testConfig({clientId: 'client-fixed'});
  await withFetch([], async (fake) => {
    const {response, location, state} = await begin(cfg);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    assert.equal(location.origin + location.pathname, 'https://account.test/oauth2/authorize');
    assert.deepEqual([...location.searchParams.keys()].sort(),
      ['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'resource', 'response_type', 'scope', 'state']);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), 'client-fixed');
    assert.equal(location.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('resource'), 'https://memory.test/mcp/');
    assert.equal(location.searchParams.get('scope'), cfg.scopes);
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(response.headers.getSetCookie(), [`cs_demo_st=${state}; Path=/api/demo/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`]);
    const record = await kvGetJson(cfg.kv, `oauth:${state}`);
    assert.equal(record.returnTo, '/demo/investor/?run=run_abc');
    assert.equal(record.redirectUri, CALLBACK);
    assert.equal(record.clientId, 'client-fixed');
    assert.ok(record.verifier.length >= 43);
    assert.equal(location.searchParams.get('code_challenge'), await s256(record.verifier));
    assert.ok(Math.abs(record.createdAt - Date.now()) < 5000);
    assert.equal(fake.calls.length, 0);
  });
});

test('DEMO_OAUTH_BASE and DEMO_OAUTH_RESOURCE move authorize, token, refresh, registration and revocation together', async () => {
  const OAUTH = 'https://oauth.test';
  const RESOURCE = 'https://rsi.test/mcp';
  const moved = (overrides = {}) => testConfig({oauthBase: OAUTH, oauthResource: RESOURCE, memoryBase: 'https://rsi.test/api', memoryViaGateway: true, ...overrides});
  const fixed = moved({clientId: 'client-fixed'});
  const {location, state, binding} = await begin(fixed);
  assert.equal(location.origin + location.pathname, `${OAUTH}/oauth2/authorize`);
  assert.equal(location.searchParams.get('resource'), RESOURCE);
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  await withFetch([{method: 'POST', url: `${OAUTH}/oauth2/token`, reply: () => tokens()}], async (fake) => {
    const response = await finishLogin(fixed, request(`/api/demo/auth/callback?code=code_1&state=${state}`, {cookie: binding}));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://cosens.ai/demo/investor/?run=run_abc');
    assert.equal(formOf(fake.calls[0]).grant_type, 'authorization_code');
  });
  await writeSession(fixed, 'sid-moved', stored());
  await withFetch([{method: 'POST', url: `${OAUTH}/oauth2/token`, reply: () => tokens({refresh: 'mcp_rt_rotated'})}], async (fake) => {
    const found = await getSession(fixed, request('/demo/', {cookie: sessionCookie('sid-moved')}));
    assert.equal(found.session.refreshToken, 'mcp_rt_rotated');
    assert.deepEqual(formOf(fake.calls[0]), {grant_type: 'refresh_token', refresh_token: 'mcp_rt_old', client_id: 'client-fixed'});
  });
  await withFetch([{method: 'POST', url: `${OAUTH}/oauth2/revoke`, reply: () => new Response(null, {status: 200})}], async (fake) => {
    await destroySession(fixed, request('/api/demo/auth/logout', {method: 'POST', cookie: sessionCookie('sid-moved')}), {revoke: true});
    assert.equal(fake.calls.length, 1);
  });
  await withFetch([{method: 'POST', url: `${OAUTH}/oauth2/register`, reply: () => Response.json({client_id: 'client-dcr'}, {status: 201})}], async (fake) => {
    assert.equal(await ensureClient(moved({scopes: 'openid memory.read'}), CALLBACK), 'client-dcr');
    assert.equal(fake.calls.length, 1);
  });
});

test('startLogin falls back to /demo/ for an unsafe return path and uses a fresh state each time', async () => {
  const cfg = testConfig({clientId: 'client-fixed'});
  const first = await begin(cfg, {returnTo: 'https://evil.example/demo/'});
  const second = await begin(cfg, {returnTo: null});
  assert.notEqual(first.state, second.state);
  assert.equal((await kvGetJson(cfg.kv, `oauth:${first.state}`)).returnTo, '/demo/');
  assert.equal((await kvGetJson(cfg.kv, `oauth:${second.state}`)).returnTo, '/demo/');
  const local = await begin(cfg, {origin: 'http://localhost:8788'});
  assert.equal(local.location.searchParams.get('redirect_uri'), 'http://localhost:8788/api/demo/auth/callback');
  assert.deepEqual(local.response.headers.getSetCookie(), [`cs_demo_st=${local.state}; Path=/api/demo/auth/; HttpOnly; SameSite=Lax; Max-Age=600`]);
});

test('finishLogin exchanges the code, seals the session and sets the cookie', async () => {
  const cfg = testConfig({clientId: 'client-fixed'});
  const {state, binding} = await begin(cfg);
  const {verifier} = await kvGetJson(cfg.kv, `oauth:${state}`);
  const before = Date.now();
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: () => tokens()}], async (fake) => {
    const response = await finishLogin(cfg, request(`/api/demo/auth/callback?code=code_123&state=${state}`, {cookie: binding}));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://cosens.ai/demo/investor/?run=run_abc');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const [setCookie, ...rest] = response.headers.getSetCookie();
    const match = /^cs_demo=([A-Za-z0-9_-]{43}); Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/.exec(setCookie);
    assert.ok(match, setCookie);
    assert.deepEqual(rest, [CLEAR_STATE]);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].headers.get('Content-Type'), 'application/x-www-form-urlencoded');
    assert.deepEqual(formOf(fake.calls[0]), {
      grant_type: 'authorization_code', code: 'code_123', redirect_uri: CALLBACK, client_id: 'client-fixed', code_verifier: verifier,
    });
    const sid = match[1];
    const session = await readSession(cfg, sid);
    assert.equal(session.accountId, 'acct_42');
    assert.equal(session.email, 'visitor@example.com');
    assert.equal(session.refreshToken, 'mcp_rt_new');
    assert.equal(session.clientId, 'client-fixed');
    assert.ok(session.expiresAt >= before + 30 * DAY_MS && session.expiresAt <= Date.now() + 30 * DAY_MS);
    const raw = await cfg.kv.get(`sess:${sid}`);
    assert.ok(!raw.includes('mcp_rt_new') && !raw.includes(session.accessToken), 'tokens are sealed, not stored in clear');
    assert.equal(await kvGetJson(cfg.kv, `oauth:${state}`), null);
  });
});

test('finishLogin replaces an older session, omits Secure on http://localhost and tolerates a missing id_token', async () => {
  const cfg = testConfig({clientId: 'client-fixed'});
  await writeSession(cfg, 'sid-old', stored());
  const {state, binding} = await begin(cfg, {origin: 'http://localhost:8788'});
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: () => tokens({idToken: false})}], async (fake) => {
    const response = await finishLogin(cfg, request(`/api/demo/auth/callback?code=c&state=${state}`,
      {origin: 'http://localhost:8788', cookie: `${sessionCookie('sid-old')}; ${binding}`}));
    assert.equal(response.headers.get('Location'), 'http://localhost:8788/demo/investor/?run=run_abc');
    const [setCookie, ...rest] = response.headers.getSetCookie();
    const match = /^cs_demo=([A-Za-z0-9_-]{43}); Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/.exec(setCookie);
    assert.ok(match, setCookie);
    assert.deepEqual(rest, ['cs_demo_st=; Path=/api/demo/auth/; HttpOnly; SameSite=Lax; Max-Age=0']);
    assert.equal(formOf(fake.calls[0]).redirect_uri, 'http://localhost:8788/api/demo/auth/callback');
    assert.equal(await readSession(cfg, 'sid-old'), null);
    assert.equal((await readSession(cfg, match[1])).email, null);
  });
});

test('finishLogin rejects unknown, missing, malformed, replayed and cross-origin state without calling upstream', async () => {
  const cfg = testConfig({clientId: 'client-fixed'});
  await withFetch([], async (fake) => {
    const unknown = 'unknown-state-value-123';
    for (const [query, cookie] of [['code=c', undefined], [`code=c&state=${unknown}`, `cs_demo_st=${unknown}`], ['code=c&state=bad*chars', 'cs_demo_st=bad*chars']]) {
      const response = await finishLogin(cfg, request(`/api/demo/auth/callback?${query}`, {cookie}));
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('Location'), 'https://cosens.ai/demo/?login_error=state_invalid');
      assert.deepEqual(response.headers.getSetCookie(), [CLEAR_STATE]);
    }
    const {state, binding} = await begin(cfg);
    const cross = await finishLogin(cfg, request(`/api/demo/auth/callback?code=c&state=${state}`, {origin: 'http://localhost:8788', cookie: binding}));
    assert.equal(cross.headers.get('Location'), 'http://localhost:8788/demo/?login_error=state_invalid');
    const replay = await finishLogin(cfg, request(`/api/demo/auth/callback?code=c&state=${state}`, {cookie: binding}));
    assert.equal(replay.headers.get('Location'), 'https://cosens.ai/demo/?login_error=state_invalid');
    assert.equal(fake.calls.length, 0);
  });
});

test('finishLogin maps authorize errors and a missing code and consumes the state', async () => {
  const cfg = testConfig({clientId: 'client-fixed'});
  await withFetch([], async (fake) => {
    const cases = [['error=access_denied', 'access_denied'], ['error=invalid_scope&error_description=x', 'authorize_failed'], ['', 'code_missing']];
    for (const [query, code] of cases) {
      const {state, binding} = await begin(cfg);
      const response = await finishLogin(cfg, request(`/api/demo/auth/callback?state=${state}${query ? `&${query}` : ''}`, {cookie: binding}));
      assert.equal(response.headers.get('Location'), `https://cosens.ai/demo/?login_error=${code}`);
      assert.deepEqual(response.headers.getSetCookie(), [CLEAR_STATE]);
      assert.equal(await kvGetJson(cfg.kv, `oauth:${state}`), null);
    }
    assert.equal(fake.calls.length, 0);
  });
});

test('finishLogin maps token endpoint failures and keeps no session', async () => {
  const cases = [
    [oauthError(400, 'invalid_grant', 'OAuth PKCE verification failed'), 'token_exchange_failed'],
    [() => Response.json({ok: false, error: {code: 'OAUTH_CLIENT_MIGRATION_REQUIRED', message: 'x'}}, {status: 409}), 'token_exchange_failed'],
    [oauthError(503, 'temporarily_unavailable'), 'service_unavailable'],
    [() => new Response('<html>ok</html>', {status: 200, headers: {'Content-Type': 'text/html'}}), 'service_unavailable'],
    [() => { throw new Error('connection reset'); }, 'service_unavailable'],
    [() => ({token_type: 'Bearer', expires_in: 60}), 'token_exchange_failed'],
    [() => ({access_token: 'not-a-jwt', expires_in: 60}), 'token_exchange_failed'],
  ];
  for (const [reply, code] of cases) {
    const cfg = testConfig({clientId: 'client-fixed'});
    const {state, binding} = await begin(cfg);
    await withFetch([{method: 'POST', url: TOKEN_URL, reply}], async () => {
      const response = await finishLogin(cfg, request(`/api/demo/auth/callback?code=c&state=${state}`, {cookie: binding}));
      assert.equal(response.headers.get('Location'), `https://cosens.ai/demo/?login_error=${code}`);
      assert.deepEqual(response.headers.getSetCookie(), [CLEAR_STATE]);
      assert.deepEqual((await cfg.kv.list({prefix: 'sess:'})).keys, []);
    });
  }
});

test('finishLogin forgets a cached registration that the token endpoint no longer knows', async () => {
  const cfg = testConfig();
  await withFetch([
    {method: 'POST', url: REGISTER_URL, reply: () => Response.json({client_id: 'client-stale'}, {status: 201})},
    {method: 'POST', url: TOKEN_URL, reply: oauthError(401, 'invalid_client', 'OAuth client is invalid')},
  ], async () => {
    const {state, binding, location} = await begin(cfg);
    assert.equal(location.searchParams.get('client_id'), 'client-stale');
    assert.equal((await kvGetJson(cfg.kv, `client:${CALLBACK}`)).clientId, 'client-stale');
    const response = await finishLogin(cfg, request(`/api/demo/auth/callback?code=c&state=${state}`, {cookie: binding}));
    assert.equal(response.headers.get('Location'), 'https://cosens.ai/demo/?login_error=token_exchange_failed');
    assert.equal(await kvGetJson(cfg.kv, `client:${CALLBACK}`), null);
  });
});

test('finishLogin refuses a callback whose state this browser did not start (login CSRF)', async () => {
  const cfg = testConfig({clientId: 'client-fixed'});
  await writeSession(cfg, 'sid-victim', stored());
  const attacker = await begin(cfg);
  const victim = await begin(cfg);
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: () => tokens({sub: 'acct_attacker'})}], async (fake) => {
    const cookies = [sessionCookie('sid-victim'), `${sessionCookie('sid-victim')}; ${victim.binding}`,
      `${sessionCookie('sid-victim')}; cs_demo_st=`, `${sessionCookie('sid-victim')}; cs_demo_st=${attacker.state}x`];
    for (const cookie of cookies) {
      const response = await finishLogin(cfg, request(`/api/demo/auth/callback?code=attacker_code&state=${attacker.state}`, {cookie}));
      assert.equal(response.headers.get('Location'), 'https://cosens.ai/demo/?login_error=state_invalid', cookie);
      assert.deepEqual(response.headers.getSetCookie(), [CLEAR_STATE], cookie);
    }
    assert.equal(fake.calls.length, 0);
    assert.equal((await readSession(cfg, 'sid-victim')).accountId, 'acct_42');
    assert.ok(await kvGetJson(cfg.kv, `oauth:${attacker.state}`), 'a refused callback leaves the state for the browser that owns it');
    const owner = await finishLogin(cfg, request(`/api/demo/auth/callback?code=attacker_code&state=${attacker.state}`, {cookie: attacker.binding}));
    assert.equal(owner.headers.get('Location'), 'https://cosens.ai/demo/investor/?run=run_abc');
    assert.equal(fake.calls.length, 1);
  });
});

test('getSession returns null without a usable cookie and never calls upstream', async () => {
  const cfg = testConfig();
  await withFetch([], async (fake) => {
    assert.equal(await getSession(cfg, request('/demo/')), null);
    assert.equal(await getSession(cfg, request('/demo/', {cookie: 'cs_demo='})), null);
    assert.equal(await getSession(cfg, request('/demo/', {cookie: 'cs_demo=../../etc'})), null);
    assert.equal(await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-unknown')})), null);
    assert.equal(fake.calls.length, 0);
  });
});

test('getSession drops a tampered value and a value sealed with another secret', async () => {
  const cfg = testConfig();
  await cfg.kv.put('sess:sid-bad', 'v1.AAAA.BBBB');
  assert.equal(await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-bad')})), null);
  assert.equal(await cfg.kv.get('sess:sid-bad'), null);
  await writeSession({...cfg, secret: 'another-secret-0123456789abcdef0123456789abcdef'}, 'sid-foreign', stored());
  assert.equal(await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-foreign')})), null);
  assert.equal(await cfg.kv.get('sess:sid-foreign'), null);
});

test('getSession returns a fresh session written by seedSession without refreshing', async () => {
  const cfg = testConfig();
  const sid = await seedSession(cfg, {sid: 'sid-seeded', accountId: 'acct_seed', email: 'seed@example.com'});
  await withFetch([], async (fake) => {
    const found = await getSession(cfg, request('/demo/', {cookie: sessionCookie(sid)}));
    assert.equal(found.sid, 'sid-seeded');
    assert.equal(found.session.accountId, 'acct_seed');
    assert.equal(found.session.email, 'seed@example.com');
    assert.equal(found.session.accessToken, 'tok');
    assert.equal(fake.calls.length, 0);
  });
});

test('getSession refreshes a session that expires within five minutes and releases the lock', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-refresh', stored());
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: () => tokens({refresh: 'mcp_rt_rotated', idToken: false})}], async (fake) => {
    const found = await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-refresh')}));
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(formOf(fake.calls[0]), {grant_type: 'refresh_token', refresh_token: 'mcp_rt_old', client_id: 'client-fixed'});
    assert.equal(found.sid, 'sid-refresh');
    assert.equal(found.session.refreshToken, 'mcp_rt_rotated');
    assert.equal(found.session.email, 'visitor@example.com');
    assert.equal(found.session.createdAt, 1);
    assert.ok(found.session.expiresAt > Date.now() + 29 * DAY_MS);
    assert.deepEqual(await readSession(cfg, 'sid-refresh'), found.session);
    assert.equal(await cfg.kv.get('lock:refresh:sid-refresh'), null);
  });
});

test('getSession keeps the old refresh token when the refresh response has none', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-keep', stored({expiresAt: Date.now() - 1000}));
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: () => tokens({refresh: null})}], async () => {
    const found = await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-keep')}));
    assert.equal(found.session.refreshToken, 'mcp_rt_old');
    assert.ok(found.session.expiresAt > Date.now() + 29 * DAY_MS);
  });
});

test('getSession destroys the session when the refresh is rejected', async () => {
  const replies = [oauthError(400, 'invalid_grant', 'OAuth refresh token is invalid'), oauthError(401, 'invalid_client', 'OAuth client is invalid')];
  for (const reply of replies) {
    const cfg = testConfig();
    await writeSession(cfg, 'sid-dead', stored({expiresAt: Date.now() - 1000}));
    await withFetch([{method: 'POST', url: TOKEN_URL, reply}], async () => {
      assert.equal(await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-dead')})), null);
      assert.equal(await readSession(cfg, 'sid-dead'), null);
      assert.equal(await cfg.kv.get('lock:refresh:sid-dead'), null);
    });
  }
});

test('getSession rides out a temporary refresh failure only while the token is still valid', async () => {
  const cfg = testConfig();
  const valid = stored();
  await writeSession(cfg, 'sid-flaky', valid);
  await writeSession(cfg, 'sid-flaky-expired', stored({expiresAt: Date.now() - 1000}));
  await withFetch([{method: 'POST', url: TOKEN_URL, reply: oauthError(503, 'temporarily_unavailable')}], async (fake) => {
    const found = await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-flaky')}));
    assert.equal(found.session.accessToken, valid.accessToken);
    assert.equal(found.session.refreshToken, 'mcp_rt_old');
    assert.equal(await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-flaky-expired')})), null);
    assert.notEqual(await readSession(cfg, 'sid-flaky-expired'), null, 'a transient failure keeps the record for the next try');
    assert.equal(fake.calls.length, 2);
  });
});

test('getSession without a refresh token keeps a valid session and drops an expired one', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-norefresh', stored({refreshToken: null}));
  await writeSession(cfg, 'sid-norefresh-expired', stored({refreshToken: null, expiresAt: Date.now() - 1}));
  await withFetch([], async (fake) => {
    assert.equal((await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-norefresh')}))).session.accountId, 'acct_42');
    assert.equal(await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-norefresh-expired')})), null);
    assert.equal(await readSession(cfg, 'sid-norefresh-expired'), null);
    assert.equal(fake.calls.length, 0);
  });
});

test('getSession waits one second for a concurrent refresh that holds the lock and reuses its result', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-lock', stored());
  await cfg.kv.put('lock:refresh:sid-lock', '1', {expirationTtl: 60});
  const fresh = stored({accessToken: jwt({sub: 'acct_42', n: 2}), refreshToken: 'mcp_rt_other', expiresAt: Date.now() + 30 * DAY_MS});
  const waits = [];
  const sleep = mock.method(clock, 'sleep', async (ms) => {
    waits.push(ms);
    await writeSession(cfg, 'sid-lock', fresh);
  });
  try {
    await withFetch([], async (fake) => {
      const found = await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-lock')}));
      assert.deepEqual(waits, [1000]);
      assert.deepEqual(found.session, fresh);
      assert.equal(fake.calls.length, 0);
      assert.equal(await cfg.kv.get('lock:refresh:sid-lock'), '1', 'the lock belongs to the other request');
    });
  } finally {
    sleep.mock.restore();
  }
});

test('getSession refreshes itself when the lock holder has not finished after one second', async () => {
  const cfg = testConfig();
  await writeSession(cfg, 'sid-slow', stored());
  await cfg.kv.put('lock:refresh:sid-slow', '1', {expirationTtl: 60});
  const sleep = mock.method(clock, 'sleep', async () => {});
  try {
    await withFetch([{method: 'POST', url: TOKEN_URL, reply: () => tokens({refresh: 'mcp_rt_same'})}], async (fake) => {
      const found = await getSession(cfg, request('/demo/', {cookie: sessionCookie('sid-slow')}));
      assert.equal(sleep.mock.callCount(), 1);
      assert.equal(fake.calls.length, 1);
      assert.equal(found.session.refreshToken, 'mcp_rt_same');
      assert.equal(await cfg.kv.get('lock:refresh:sid-slow'), '1', 'the lock belongs to the other request');
    });
  } finally {
    sleep.mock.restore();
  }
});

test('refreshSession refuses a session without a refresh token', async () => {
  await assert.rejects(refreshSession(testConfig(), 'sid-x', stored({refreshToken: null})),
    (err) => err instanceof ServiceError && err.service === 'auth' && err.status === 401 && err.code === 'refresh_unavailable');
});

test('destroySession deletes the session, revokes on request and always returns the clearing cookie', async () => {
  const cfg = testConfig();
  const clearing = 'cs_demo=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  await writeSession(cfg, 'sid-out', stored());
  await withFetch([{method: 'POST', url: REVOKE_URL, reply: () => new Response(null, {status: 200})}], async (fake) => {
    const header = await destroySession(cfg, request('/api/demo/auth/logout', {method: 'POST', cookie: sessionCookie('sid-out')}), {revoke: true});
    assert.equal(header, clearing);
    assert.equal(await readSession(cfg, 'sid-out'), null);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].headers.get('Content-Type'), 'application/x-www-form-urlencoded');
    assert.deepEqual(formOf(fake.calls[0]), {token: 'mcp_rt_old', token_type_hint: 'refresh_token', client_id: 'client-fixed'});
  });
  await writeSession(cfg, 'sid-access-only', stored({refreshToken: null}));
  await withFetch([{method: 'POST', url: REVOKE_URL, reply: () => new Response(null, {status: 200})}], async (fake) => {
    await destroySession(cfg, request('/api/demo/auth/logout', {method: 'POST', cookie: sessionCookie('sid-access-only')}), {revoke: true});
    assert.equal(formOf(fake.calls[0]).token_type_hint, 'access_token');
  });
  await writeSession(cfg, 'sid-quiet', stored());
  await withFetch([{method: 'POST', url: REVOKE_URL, reply: () => { throw new Error('network down'); }}], async () => {
    assert.equal(await destroySession(cfg, request('/api/demo/auth/logout', {method: 'POST', cookie: sessionCookie('sid-quiet')}), {revoke: true}), clearing);
    assert.equal(await readSession(cfg, 'sid-quiet'), null);
  });
  await writeSession(cfg, 'sid-local', stored());
  await withFetch([], async (fake) => {
    assert.equal(await destroySession(cfg, request('/api/demo/auth/logout', {method: 'POST', cookie: sessionCookie('sid-local')})), clearing);
    assert.equal(await readSession(cfg, 'sid-local'), null);
    assert.equal(await destroySession(cfg, request('/api/demo/auth/logout', {method: 'POST'}), {revoke: true}), clearing);
    assert.equal(fake.calls.length, 0);
  });
  assert.equal(await destroySession(cfg, request('/x', {origin: 'http://localhost:8788'})), 'cs_demo=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
/** The visible text of the page: the language switch names itself in Chinese on purpose, so it is taken out. */
const visibleText = html => html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '').replace(/<nav class="langs"[\s\S]*?<\/nav>/, '');

test('loginErrorPage renders a self-contained English page by default with a retry link', async () => {
  const page = loginErrorPage('access_denied');
  assert.equal(page.status, 401);
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const html = await page.text();
  assert.ok(html.startsWith('<!doctype html>\n<html lang="en">'));
  assert.ok(html.includes('<title>CoSens Demo · Sign-in not completed</title>'));
  assert.ok(html.includes(loginErrorText('access_denied')));
  assert.ok(html.includes('You cancelled the sign-in authorization.'));
  assert.ok(html.includes('href="/api/demo/auth/login?return=%2Fdemo%2F"'));
  assert.ok(html.includes('Sign in again') && html.includes('Back to home'));
  assert.ok(html.includes('Error code: <code>access_denied</code>'), 'the code is a technical detail');
  assert.equal(CJK.test(visibleText(html)), false, 'no Chinese in the default page');
  assert.ok(!/<script[^>]*\bsrc=|<link/i.test(html), 'no app bundle: everything under /demo is gated; scripts are inline');
  assert.ok(html.includes('data-theme-control') && html.includes('cosens-theme-preference'), 'the hub theme switch and its stored preference');
  const sources = [...html.matchAll(/src="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(sources, ['/assets/cosens-logo.png', '/assets/cosens-logo-on-dark.png'], 'only the public site logo');
  const unknown = await loginErrorPage('<script>alert(1)</script>', 500).text();
  assert.equal(loginErrorPage('x', 500).status, 500);
  assert.ok(unknown.includes(loginErrorText('unknown')));
  assert.ok(unknown.includes('Error code: <code>unknown</code>'));
  assert.ok(!unknown.includes('<script>alert'));
  for (const code of LOGIN_ERROR_CODES) {
    assert.ok((await loginErrorPage(code).text()).includes(loginErrorText(code, 'en')), code);
    assert.equal(CJK.test(loginErrorText(code, 'en')), false, code);
  }
});

test('loginErrorPage renders the same page in Chinese for the zh locale, with the EN/中文 switch as links', async () => {
  const html = await loginErrorPage('access_denied', 401, 'zh').text();
  assert.ok(html.startsWith('<!doctype html>\n<html lang="zh-CN">'));
  assert.ok(html.includes('<title>CoSens 演示 · 登录未完成</title>'));
  assert.ok(html.includes('你取消了登录授权。'));
  assert.ok(html.includes('重新登录') && html.includes('返回首页'));
  assert.ok(html.includes('错误代码：<code>access_denied</code>'));
  assert.ok(html.includes('aria-label="切换浅色或深色"'));
  assert.equal(loginErrorText('login_loop', 'zh'), '登录成功了，但演示服务仍然拒绝访问。请两分钟后再试；如果一直这样，请联系我们。');
  assert.equal(loginErrorText('nope', 'zh'), '登录没有完成，请重新登录。');
  // The switch: each language is a link that reloads the page with ?lang= (the page gate stores it in the cookie).
  const en = await loginErrorPage('access_denied').text();
  for (const page of [html, en]) {
    assert.ok(page.includes('<a href="/demo/?login_error=access_denied&amp;lang=en" hreflang="en" lang="en">EN</a>') || page.includes('class="on" href="/demo/?login_error=access_denied&amp;lang=en" hreflang="en" lang="en">EN</a>'));
    assert.ok(page.includes('href="/demo/?login_error=access_denied&amp;lang=zh"'));
    assert.ok(page.includes('>中文</a>'));
  }
  assert.ok(en.includes('aria-current="true" class="on" href="/demo/?login_error=access_denied&amp;lang=en"'));
  assert.ok(html.includes('aria-current="true" class="on" href="/demo/?login_error=access_denied&amp;lang=zh"'));
  assert.equal(await loginErrorPage('access_denied', 401, 'fr').text(), en, 'an unknown locale is English');
});

test('the error page theme switch is plain script text that runs in a browser-like scope', async () => {
  // Function#toString would carry the bundler's __name helper into the page; the literal cannot.
  assert.doesNotMatch(THEME_SWITCH_SCRIPT, /__name/);
  const html = await loginErrorPage('access_denied').text();
  assert.ok(html.includes(THEME_SWITCH_SCRIPT), 'the page inlines the literal script');
  const listeners = {};
  const stored = {};
  const root = {dataset: {theme: 'dark'}, style: {}};
  const meta = {content: ''};
  const control = {addEventListener: (type, fn) => { listeners.click = fn; }};
  const scope = {
    document: {documentElement: root, querySelector: selector => (selector.startsWith('meta') ? meta : control)},
    localStorage: {setItem: (k, v) => { stored[k] = v; }},
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const run = new Function(...Object.keys(scope), `${THEME_SWITCH_SCRIPT}('pref', {light: '#fff', dark: '#000'});`);
  run(...Object.values(scope));
  listeners.click();
  assert.deepEqual([root.dataset.theme, root.style.colorScheme, meta.content, stored.pref], ['light', 'light', '#fff', 'light']);
  listeners.storage({key: 'pref', newValue: 'dark'});
  assert.equal(root.dataset.theme, 'dark');
});
