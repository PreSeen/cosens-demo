import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {NOINDEX, json, ServiceError, errorBody, errorResponse, scrubMessage, callService, sseResponse} from '../server/demo/http.mjs';
import {ConfigError} from '../server/demo/config.mjs';
import {envFromConfig, testConfig} from './helpers/fake-services.mjs';
import {addScrubTerms} from '../server/demo/scrub.mjs';

// The names a deployment would list in DEMO_PRIVATE_NAMES.
addScrubTerms(['acme', 'globex']);

const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhY2N0XzEifQ.c2lnbmF0dXJl';

function stubFetch(handler) {
  const calls = [];
  const stub = mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({url: String(url), init});
    return handler(String(url), init);
  });
  return {calls, restore: () => stub.mock.restore()};
}

function parseEvents(text) {
  const events = [];
  const comments = [];
  for (const block of text.split('\n\n').filter(Boolean)) {
    if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
    else if (block.startsWith(':')) comments.push(block);
    else throw new Error(`unexpected SSE block ${block}`);
  }
  if (text) assert.ok(text.endsWith('\n\n'), 'every SSE block ends with a blank line');
  return {events, comments};
}

async function readEvents(response) {
  return parseEvents(await response.text());
}

async function readRest(reader) {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, {stream: true});
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('NOINDEX keeps demo responses out of search engines', () => {
  assert.deepEqual(NOINDEX, {'X-Robots-Tag': 'noindex, nofollow'});
});

test('json sets status, private no-store caching, noindex and extra headers', async () => {
  const response = json({run: {id: 'run_1'}}, 201, {'Set-Cookie': 'cs_demo=x; Path=/'});
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('Set-Cookie'), 'cs_demo=x; Path=/');
  assert.deepEqual(await response.json(), {run: {id: 'run_1'}});
  const plain = json({ok: true});
  assert.equal(plain.status, 200);
  assert.equal(json({}, 200, {'Cache-Control': 'no-store'}).headers.get('Cache-Control'), 'no-store');
});

test('ServiceError carries service, status, code and message', () => {
  const err = new ServiceError('rsi', 409, 'conflict', 'execution is running');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ServiceError');
  assert.equal(err.service, 'rsi');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'conflict');
  assert.equal(err.message, 'execution is running');
});

test('errorResponse maps service errors to the browser status table', async () => {
  const cases = [
    [new ServiceError('auth', 400, 'invalid_grant', 'refresh failed'), 401, {code: 'invalid_grant', message: 'refresh failed', service: 'auth'}],
    [new ServiceError('auth', 0, 'not_authenticated', 'err.sign_in_first'), 401, {code: 'not_authenticated', message: 'Please sign in first.', service: 'auth'}],
    [new ServiceError('memory', 401, 'INVALID_TOKEN', 'Token is invalid'), 401, {code: 'not_authenticated', message: 'Your session is no longer valid. Please sign in again.', service: 'memory'}],
    [new ServiceError('rsi', 401, 'http_401', 'Unauthorized'), 401, {code: 'not_authenticated', message: 'Your session is no longer valid. Please sign in again.', service: 'rsi'}],
    [new ServiceError('account', 403, 'permission_denied', 'no access'), 403, {code: 'permission_denied', message: 'no access', service: 'account'}],
    [new ServiceError('model', 402, 'insufficient_balance', 'Insufficient balance'), 402, {code: 'insufficient_balance', message: 'Insufficient balance', service: 'model'}],
    [new ServiceError('account', 404, 'virtual_user_not_found', 'not found'), 404, {code: 'virtual_user_not_found', message: 'not found', service: 'account'}],
    [new ServiceError('rsi', 422, 'invalid_request', 'bad role'), 422, {code: 'invalid_request', message: 'bad role', service: 'rsi'}],
    [new ServiceError('memory', 429, 'RATE_LIMITED', 'slow down'), 429, {code: 'RATE_LIMITED', message: 'slow down', service: 'memory'}],
    [new ServiceError('rsi', 500, 'internal', 'boom'), 502, {code: 'internal', message: 'boom', service: 'rsi'}],
    [new ServiceError('rsi', 503, 'dependency_unavailable', 'model not configured'), 502, {code: 'dependency_unavailable', message: 'model not configured', service: 'rsi'}],
    [new ServiceError('model', 0, 'upstream_timeout', 'Model gateway timeout: The operation was aborted due to timeout'), 502, {code: 'upstream_timeout', message: 'Model gateway timeout: The operation was aborted due to timeout', service: 'model'}],
    [new ServiceError('memory', 302, 'http_302', 'err.http_status', {service: 'memory', status: 302}), 502, {code: 'http_302', message: 'Memory returned HTTP 302.', service: 'memory'}],
    [new ServiceError(null, 404, 'run_not_found', 'err.run_not_found'), 404, {code: 'run_not_found', message: 'This demo could not be found.'}],
    [new ServiceError(null, 409, 'step_not_ready', 'err.step1_first'), 409, {code: 'step_not_ready', message: 'Finish step 1 first: hand the materials to the AI to remember.'}],
    [new ServiceError(null, 415, 'unsupported_file', 'This file type is not supported'), 415, {code: 'unsupported_file', message: 'This file type is not supported'}],
    [new ServiceError(null, 413, 'file_too_large', 'The file is too large'), 413, {code: 'file_too_large', message: 'The file is too large'}],
    [new ServiceError(null, 0, 'odd', 'odd'), 500, {code: 'odd', message: 'odd'}],
  ];
  for (const [err, status, error] of cases) {
    const response = errorResponse(err);
    assert.equal(response.status, status, err.code);
    assert.deepEqual(await response.json(), {error}, err.code);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  }
});

test('config errors become 500 config errors that name the setting', async () => {
  const response = errorResponse(new ConfigError('config_missing', 'missing setting DEMO_KV'));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {error: {code: 'config_missing', message: 'The demo service is not fully configured: missing setting DEMO_KV'}});
});

test('unexpected errors become 500 internal_error without their message', async () => {
  const log = mock.method(console, 'error', () => {});
  try {
    const response = errorResponse(new Error(`token ${jwt} at https://memory.test/memory/recall`));
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {error: {code: 'internal_error', message: 'The demo service hit an error. Please try again shortly.'}});
    assert.equal(body.includes(jwt), false);
    assert.equal(body.includes('memory.test'), false);
    assert.equal(errorBody('a string').status, 500);
    assert.equal(log.mock.callCount(), 2);
  } finally {
    log.mock.restore();
  }
});

test('error messages never leak URLs, tokens or internal names', async () => {
  const err = new ServiceError('account', 403, 'denied', `Bearer ${jwt} rejected by https://api.internal.example/virtual-users (Acme) refresh mcp_rt_${'a'.repeat(64)} GLOBEX`);
  const text = await errorResponse(err).text();
  for (const leak of [jwt, 'https://', 'internal.example', 'mcp_rt_', 'Acme', 'GLOBEX']) assert.equal(text.includes(leak), false, leak);
  assert.equal(scrubMessage(`see https://x.test/a?b=1 now`), 'see [url] now');
  assert.equal(scrubMessage(`Authorization: Bearer abc.def`), 'Authorization: Bearer [redacted]');
  assert.equal(scrubMessage(jwt), '[token]');
  assert.equal(scrubMessage('acme-service down'), '[private]-service down');
  assert.equal(scrubMessage('x'.repeat(900)).length, 500);
  assert.equal(scrubMessage(undefined), '');
});

test('callService returns parsed JSON and forwards method, headers and body with manual redirects', async () => {
  const f = stubFetch(() => Response.json({data: {vuId: 'vu_1'}, error: null}));
  try {
    const data = await callService('account', 'https://account.test/virtual-users', {
      method: 'POST', headers: {Authorization: 'Bearer tok', 'Content-Type': 'application/json'}, body: '{"name":"n"}',
    });
    assert.deepEqual(data, {data: {vuId: 'vu_1'}, error: null});
    assert.equal(f.calls.length, 1);
    const {url, init} = f.calls[0];
    assert.equal(url, 'https://account.test/virtual-users');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer tok');
    assert.equal(init.body, '{"name":"n"}');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal('timeoutMs' in init, false);
    assert.equal('raw' in init, false);
  } finally {
    f.restore();
  }
});

test('callService uses a 60 s AbortSignal.timeout unless the caller gives a signal or timeoutMs', async () => {
  const f = stubFetch(() => Response.json({}));
  const timeout = mock.method(AbortSignal, 'timeout');
  try {
    await callService('memory', 'https://memory.test/a');
    assert.deepEqual(timeout.mock.calls.map((c) => c.arguments), [[60000]]);
    await callService('model', 'https://llm.test/v1/chat/completions', {timeoutMs: 180000});
    assert.deepEqual(timeout.mock.calls.map((c) => c.arguments), [[60000], [180000]]);
    const controller = new AbortController();
    await callService('rsi', 'https://rsi.test/api/executions', {signal: controller.signal});
    assert.equal(timeout.mock.callCount(), 2);
    assert.equal(f.calls[2].init.signal, controller.signal);
  } finally {
    timeout.mock.restore();
    f.restore();
  }
});

test('callService returns null for empty bodies and text for non-JSON bodies', async () => {
  const replies = [new Response(null, {status: 204}), new Response('', {status: 200}), new Response('plain ok', {status: 200}), new Response('null', {status: 200}), new Response('[1,2]', {status: 200})];
  const f = stubFetch(() => replies.shift());
  try {
    assert.equal(await callService('memory', 'https://memory.test/a'), null);
    assert.equal(await callService('memory', 'https://memory.test/a'), null);
    assert.equal(await callService('memory', 'https://memory.test/a'), 'plain ok');
    assert.equal(await callService('memory', 'https://memory.test/a'), null);
    assert.deepEqual(await callService('memory', 'https://memory.test/a'), [1, 2]);
  } finally {
    f.restore();
  }
});

test('callService turns every upstream error envelope into a ServiceError', async () => {
  // The page gets the service's own words: "<service> <status> <code>: <message>", scrubbed (
  // 最好直接穿透底层报错」).
  const cases = [
    ['rsi', Response.json({error: {code: 'not_found', message: 'execution not found'}}, {status: 404}), 404, 'not_found', 'RSI 404 not_found: execution not found'],
    ['memory', Response.json({ok: false, error: {code: 'INVALID_TOKEN', message: 'Token is invalid', details: null}}, {status: 401}), 401, 'INVALID_TOKEN', 'Memory 401 INVALID_TOKEN: Token is invalid'],
    ['account', Response.json({requestId: 'r', data: null, error: {code: 'virtual_user_name_invalid', message: 'name too long'}}, {status: 400}), 400, 'virtual_user_name_invalid', 'Account service 400 virtual_user_name_invalid: name too long'],
    ['auth', Response.json({error: 'invalid_grant', error_description: 'refresh token revoked'}, {status: 400}), 400, 'invalid_grant', 'Login service 400 invalid_grant: refresh token revoked'],
    ['memory', Response.json({detail: 'document not found'}, {status: 404}), 404, 'http_404', 'Memory 404 http_404: document not found'],
    ['memory', Response.json({detail: {code: 'quota_exceeded', message: 'no quota left'}}, {status: 402}), 402, 'quota_exceeded', 'Memory 402 quota_exceeded: no quota left'],
    ['model', Response.json({error: {code: 'gateway_credit_insufficient', message: 'account credit is insufficient; add credit before retrying'}}, {status: 402}), 402, 'gateway_credit_insufficient', 'Model gateway 402 gateway_credit_insufficient: account credit is insufficient; add credit before retrying'],
    ['model', Response.json({error: {code: 'rate_limit_exceeded', message: 'Rate limit reached for requests'}}, {status: 429}), 429, 'rate_limit_exceeded', 'Model gateway 429 rate_limit_exceeded: Rate limit reached for requests'],
    ['model', Response.json({error: {code: 'context_length_exceeded', message: "This model's maximum context length is 131072 tokens"}}, {status: 400}), 400, 'context_length_exceeded', "Model gateway 400 context_length_exceeded: This model's maximum context length is 131072 tokens"],
    ['model', Response.json({error: {code: 'overloaded', message: 'The model is overloaded'}}, {status: 529}), 529, 'overloaded', 'Model gateway 529 overloaded: The model is overloaded'],
    ['rsi', Response.json({detail: [{loc: ['body', 'files'], msg: 'bad role'}]}, {status: 422}), 422, 'http_422', 'RSI 422 http_422'],
    ['rsi', new Response('access_token authentication is not supported yet', {status: 401}), 401, 'http_401', 'RSI 401 http_401: access_token authentication is not supported yet'],
    ['model', new Response('<html><body>502 Bad Gateway</body></html>', {status: 502}), 502, 'http_502', 'Model gateway 502 http_502'],
    ['model', new Response('', {status: 503}), 503, 'http_503', 'Model gateway 503 http_503'],
    ['rsi', Response.json({error: {code: 'internal', message: 'planner crashed at http://10.0.0.5:8080/v1 via globex-gpu4:8900, Bearer abc.def'}}, {status: 500}), 500, 'internal', 'RSI 500 internal: planner crashed at [url] via [private]-[host], Bearer [redacted]'],
    ['memory', new Response(null, {status: 302, headers: {Location: 'https://elsewhere.test/'}}), 302, 'http_302', 'Memory 302 http_302'],
  ];
  for (const [service, reply, status, code, message] of cases) {
    const f = stubFetch(() => reply);
    try {
      await assert.rejects(callService(service, 'https://svc.test/x'), (err) => {
        assert.ok(err instanceof ServiceError, code);
        assert.equal(err.service, service, code);
        assert.equal(err.status, status, code);
        assert.equal(err.code, code, code);
        assert.equal(err.message, message, code);
        return true;
      });
    } finally {
      f.restore();
    }
  }
});

test('callService maps network failures, timeouts and caller aborts without leaking the URL', async () => {
  let f = stubFetch(() => { throw new TypeError('fetch failed', {cause: Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:8900'), {code: 'ECONNREFUSED'})}); });
  try {
    await assert.rejects(callService('memory', 'https://memory.test/memory/recall'), (err) => {
      assert.ok(err instanceof ServiceError);
      assert.deepEqual([err.service, err.status, err.code], ['memory', 0, 'upstream_unavailable']);
      // The underlying error and its cause pass through; the internal address does not.
      assert.equal(err.message, 'Memory unreachable: fetch failed (ECONNREFUSED connect ECONNREFUSED [host])');
      return true;
    });
  } finally {
    f.restore();
  }
  f = stubFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  // Node unrefs AbortSignal.timeout timers; this keeps the test process alive until the 20 ms timeout fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(callService('rsi', 'https://rsi.test/api/executions', {timeoutMs: 20}), {name: 'ServiceError', status: 0, code: 'upstream_timeout'});
    const controller = new AbortController();
    const pending = callService('model', 'https://llm.test/v1/chat/completions', {signal: controller.signal});
    controller.abort();
    await assert.rejects(pending, {name: 'ServiceError', status: 0, code: 'upstream_aborted', service: 'model'});
  } finally {
    clearInterval(keepAlive);
    f.restore();
  }
});

test('callService raw mode returns the unread 2xx Response and still throws on errors', async () => {
  const replies = [new Response('data: {"a":1}\n\n', {status: 200, headers: {'Content-Type': 'text/event-stream'}}), Response.json({error: {code: 'insufficient_quota', message: 'Insufficient quota'}}, {status: 402})];
  const f = stubFetch(() => replies.shift());
  try {
    const response = await callService('model', 'https://llm.test/v1/chat/completions', {method: 'POST', raw: true});
    assert.ok(response instanceof Response);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), 'data: {"a":1}\n\n');
    await assert.rejects(callService('model', 'https://llm.test/v1/chat/completions', {method: 'POST', raw: true}), {code: 'insufficient_quota', status: 402});
  } finally {
    f.restore();
  }
});

test('sseResponse returns at once with SSE headers and streams events in order', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = false;
  const response = sseResponse(async (emit) => {
    started = true;
    await emit({type: 'phase', text: '读取 BP'});
    await gate;
    await emit({type: 'recall', query: '电池 专家'});
    await emit({type: 'report', analysis: {at: 1}});
  });
  assert.ok(response instanceof Response);
  assert.equal(started, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, 'data: {"type":"phase","text":"读取 BP"}\n\n');
  release();
  const {events} = parseEvents(await readRest(reader));
  assert.deepEqual(events, [{type: 'recall', query: '电池 专家'}, {type: 'report', analysis: {at: 1}}]);
});

test('sseResponse ends with an error event when start throws a ServiceError', async () => {
  const response = sseResponse(async (emit) => {
    await emit({type: 'phase', text: '检索记忆'});
    throw new ServiceError('model', 402, 'insufficient_balance', `额度不足 https://llm.test/v1 Bearer ${jwt}`);
  });
  const {events} = await readEvents(response);
  assert.deepEqual(events, [
    {type: 'phase', text: '检索记忆'},
    {type: 'error', code: 'insufficient_balance', message: '额度不足 [url] Bearer [redacted]', service: 'model'},
  ]);
});

test('sseResponse hides unexpected errors behind internal_error', async () => {
  const log = mock.method(console, 'error', () => {});
  try {
    const {events} = await readEvents(sseResponse(async () => { throw new Error('secret detail'); }));
    assert.deepEqual(events, [{type: 'error', code: 'internal_error', message: 'The demo service hit an error. Please try again shortly.'}]);
  } finally {
    log.mock.restore();
  }
});

test('sseResponse writes keepalive comments while start is busy and stops them afterwards', async () => {
  const response = sseResponse(async (emit) => {
    await wait(60);
    await emit({type: 'phase', text: 'done'});
  }, {heartbeatMs: 10});
  const {events, comments} = await readEvents(response);
  assert.deepEqual(events, [{type: 'phase', text: 'done'}]);
  assert.ok(comments.length >= 2, `expected keepalives, got ${comments.length}`);
  assert.ok(comments.every((c) => c === ': keepalive'));
});

test('sseResponse keeps running after the client disconnects and hands the work to waitUntil', async () => {
  const results = [];
  let task;
  let finished = false;
  const response = sseResponse(async (emit) => {
    results.push(await emit({type: 'phase', text: 'one'}));
    await wait(20);
    results.push(await emit({type: 'phase', text: 'two'}));
    results.push(await emit({type: 'phase', text: 'three'}));
    finished = true;
  }, {waitUntil: (p) => { task = p; }, heartbeatMs: 5});
  assert.ok(task instanceof Promise);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await task;
  assert.equal(finished, true);
  assert.deepEqual(results, [true, false, false]);
});

test('sseResponse without waitUntil still closes the stream when start returns', async () => {
  const {events, comments} = await readEvents(sseResponse(async () => {}));
  assert.deepEqual(events, []);
  assert.deepEqual(comments, []);
});

test('the safety scrub hides secrets, internal names, the configured model id and internal hosts, and keeps the rest', async () => {
  const {readConfig} = await import('../server/demo/config.mjs');
  const {scrubMessage} = await import('../server/demo/scrub.mjs');
  readConfig(envFromConfig(testConfig({llmModel: 'acme/example-9b', memoryBase: 'https://memory-internal.example'})));
  const raw = 'Model gateway 404 model_not_found: acme/example-9b (alias example-9b) at memory-internal.example, '
    + 'globex-gpu4:8900, 10.1.2.3, llm.default.svc.cluster.local, https://x.test/a?k=1, Bearer abc.def, eyJa.eyJb.sig, mcp_rt_0123456789, Acme';
  assert.equal(scrubMessage(raw), 'Model gateway 404 model_not_found: [private] (alias [private]) at [private], '
    + '[private]-[host], [host], [host], [url] Bearer [redacted], [token], [token], [private]');
  assert.equal(scrubMessage('RSI 422 invalid_request: files[0].role must be input'), 'RSI 422 invalid_request: files[0].role must be input');
});
