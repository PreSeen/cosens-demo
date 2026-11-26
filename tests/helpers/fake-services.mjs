// Test doubles for the demo server code: a fetch router, SSE and OpenAI stream fixtures,
// a test Config, a seeded session and the Pages env object.
import {readFile} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fakeKv} from './fake-kv.mjs';
import {seal} from '../../server/demo/crypto.mjs';
import {kvPutJson} from '../../server/demo/kv.mjs';

export const TEST_SCOPES = 'openid email offline_access memory.read memory.write memory.document.upload vu.manage rsi.read rsi.write llm.invoke';
export const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const DEFAULT_ASSETS_ROOT = fileURLToPath(new URL('../../apps/demo/public/', import.meta.url));
const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** @returns {import('../../server/demo/config.mjs').Config} */
export function testConfig(overrides = {}) {
  const memoryBase = overrides.memoryBase ?? 'https://memory.test';
  const accountBase = overrides.accountBase ?? 'https://account.test';
  return {
    memoryBase,
    accountBase,
    // The readConfig defaults: OAuth on the account base, resource ${memoryBase}/mcp/, Memory called directly.
    oauthBase: accountBase,
    oauthResource: `${memoryBase}/mcp/`,
    memoryViaGateway: false,
    rsiBase: 'https://rsi.test/api',
    llmBase: 'https://llm.test/v1',
    llmModel: 'test-model',
    scopes: TEST_SCOPES,
    // null exercises the dynamic-registration fallback; deployments set DEMO_OAUTH_CLIENT_ID=cosens-demo-hub.
    clientId: null,
    secret: TEST_SECRET,
    kv: fakeKv(),
    ...overrides,
  };
}

/**
 * Replace globalThis.fetch with a router. First matching route wins.
 * route.url: string = exact origin+pathname (query ignored), RegExp = tested against the full href.
 * route.reply returns a Response, or any other value which is sent as a 200 JSON body.
 */
export function installFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  const unmatched = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.body ? await request.clone().text() : null;
    calls.push({method: request.method, url: url.href, headers: request.headers, body});
    const route = routes.find((r) => r.method.toUpperCase() === request.method
      && (r.url instanceof RegExp ? r.url.test(url.href) : r.url === url.origin + url.pathname));
    if (!route) {
      const message = `unexpected fetch ${request.method} ${url.href}`;
      unmatched.push(message);
      throw new Error(message);
    }
    const reply = await route.reply(request, url);
    if (reply instanceof Response) return reply;
    return Response.json(reply ?? null, {status: 200});
  };
  return {calls, unmatched, restore() { globalThis.fetch = original; }};
}

/**
 * text/event-stream Response with `data: <json>\n\n` per event and a final `data: [DONE]\n\n`.
 * The bytes are delivered in small pieces (default 17 bytes) so that readers must buffer
 * across chunk boundaries, including inside multi-byte UTF-8 characters.
 * options.done = false leaves out the final [DONE] line (an interrupted stream).
 */
export function sseReply(events, {status = 200, chunkBytes = 17, done = true} = {}) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkBytes) controller.enqueue(bytes.slice(i, i + chunkBytes));
      controller.close();
    },
  });
  return new Response(stream, {status, headers: {'Content-Type': 'text/event-stream; charset=utf-8'}});
}

function pieces(text, count = 3) {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const size = Math.ceil(chars.length / count);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/**
 * OpenAI chat.completion.chunk objects for one streamed answer. Reasoning and content are split
 * into three pieces each; each tool call's arguments are split into three pieces mid-string and
 * the calls are interleaved round-robin by index (as parallel tool calls arrive from real
 * providers). Ends with a finish_reason chunk and a usage-only chunk with empty choices.
 * toolCalls: [{id, name, arguments: string}]
 */
export function openAiChunks({content = '', reasoning = '', toolCalls = []} = {}) {
  const base = {id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1795200000, model: 'test-model'};
  const chunk = (delta, finishReason = null) => ({...base, choices: [{index: 0, delta, finish_reason: finishReason}]});
  const out = [chunk({role: 'assistant', content: ''})];
  for (const piece of pieces(reasoning)) out.push(chunk({reasoning_content: piece}));
  for (const piece of pieces(content)) out.push(chunk({content: piece}));
  const split = toolCalls.map((call) => pieces(call.arguments ?? ''));
  const rounds = Math.max(1, ...split.map((parts) => parts.length));
  for (let round = 0; round < rounds; round += 1) {
    toolCalls.forEach((call, index) => {
      const part = split[index][round];
      if (round === 0) {
        out.push(chunk({tool_calls: [{index, id: call.id, type: 'function', function: {name: call.name, arguments: part ?? ''}}]}));
      } else if (part !== undefined) {
        out.push(chunk({tool_calls: [{index, function: {arguments: part}}]}));
      }
    });
  }
  out.push(chunk({}, toolCalls.length ? 'tool_calls' : 'stop'));
  out.push({...base, choices: [], usage: {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30}});
  return out;
}

export function sessionCookie(sid) {
  return `cs_demo=${sid}`;
}

/** Writes a sealed Session to sess:<sid> exactly as oauth.mjs stores it (kvPutJson of the sealed string). */
export async function seedSession(cfg, {
  sid = 'sid-test', accessToken = 'tok', accountId = 'acct_test', email = 't@example.com',
  expiresAt = Date.now() + 3600e3, refreshToken = 'rt-test', clientId = 'client-test',
} = {}) {
  const session = {accessToken, refreshToken, expiresAt, accountId, email, clientId, createdAt: Date.now()};
  await kvPutJson(cfg.kv, `sess:${sid}`, await seal(cfg.secret, session), {ttl: 2592000});
  return sid;
}

/** ASSETS binding double: serves files under root; a leading /demo is stripped (vite base /demo/). */
export function assetsFetcher(root = DEFAULT_ASSETS_ROOT) {
  const base = resolve(root);
  const notFound = () => new Response('Not Found', {status: 404});
  return {
    async fetch(input) {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://assets.local');
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { return notFound(); }
      if (path.startsWith('/demo/')) path = path.slice('/demo'.length);
      const file = resolve(base, `.${path}`);
      if (!file.startsWith(base + sep)) return notFound();
      try {
        const bytes = await readFile(file);
        return new Response(bytes, {status: 200, headers: {'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'}});
      } catch {
        return notFound();
      }
    },
  };
}

export function envFromConfig(cfg, extra = {}) {
  const env = {
    DEMO_KV: cfg.kv,
    DEMO_MEMORY_BASE: cfg.memoryBase,
    DEMO_ACCOUNT_BASE: cfg.accountBase,
    DEMO_RSI_BASE: cfg.rsiBase,
    DEMO_LLM_BASE: cfg.llmBase,
    DEMO_LLM_MODEL: cfg.llmModel,
    DEMO_OAUTH_SCOPES: cfg.scopes,
    DEMO_SESSION_SECRET: cfg.secret,
    ASSETS: assetsFetcher(),
  };
  if (cfg.clientId) env.DEMO_OAUTH_CLIENT_ID = cfg.clientId;
  // Only settings that differ from the readConfig defaults are written, as a deployment would.
  if (cfg.oauthBase && cfg.oauthBase !== cfg.accountBase) env.DEMO_OAUTH_BASE = cfg.oauthBase;
  if (cfg.oauthResource && cfg.oauthResource !== `${cfg.memoryBase}/mcp/`) env.DEMO_OAUTH_RESOURCE = cfg.oauthResource;
  if (cfg.memoryViaGateway) env.DEMO_MEMORY_VIA_GATEWAY = 'true';
  return {...env, ...extra};
}
