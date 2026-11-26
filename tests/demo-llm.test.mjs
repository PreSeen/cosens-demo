import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig, installFetch, sseReply, openAiChunks} from './helpers/fake-services.mjs';
import {chatStream, chat} from '../server/demo/services/llm.mjs';
import {ServiceError} from '../server/demo/http.mjs';

const URL_CHAT = 'https://llm.test/v1/chat/completions';
const MESSAGES = [{role: 'system', content: '你是投资助手'}, {role: 'user', content: '读 BP'}];
const TOOLS = [{type: 'function', function: {name: 'memory_recall', description: '检索', parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']}}}];
const serviceError = (service, status, code) => (err) => {
  assert.ok(err instanceof ServiceError, `expected ServiceError, got ${err}`);
  assert.equal(err.service, service);
  assert.equal(err.status, status);
  if (code) assert.equal(err.code, code);
  return true;
};

let mock = null;
afterEach(() => { mock?.restore(); mock = null; });

test('chatStream sends model, messages, tools, tool_choice, max_tokens, stream and the bearer token', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply(openAiChunks({content: 'ok'}))}]);
  await chatStream(cfg, 'oauth-token', {messages: MESSAGES, tools: TOOLS, toolChoice: 'required', maxTokens: 16000});
  const call = mock.calls[0];
  assert.equal(call.url, URL_CHAT);
  assert.equal(call.headers.get('authorization'), 'Bearer oauth-token');
  assert.equal(call.headers.get('x-auth-type'), 'mcp_access_token');
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.equal(call.headers.get('accept'), 'text/event-stream');
  assert.equal(call.headers.get('x-virtual-user-id'), null);
  assert.deepEqual(JSON.parse(call.body), {model: 'test-model', messages: MESSAGES, temperature: 0.2, max_tokens: 16000, stream: true, tools: TOOLS, tool_choice: 'required'});
});

test('chatStream leaves out tools and tool_choice when no tools are given', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply(openAiChunks({content: 'ok'}))}]);
  await chatStream(cfg, 'oauth-token', {messages: MESSAGES});
  assert.deepEqual(JSON.parse(mock.calls[0].body), {model: 'test-model', messages: MESSAGES, temperature: 0.2, max_tokens: 16000, stream: true});
});

test('chatStream accumulates interleaved tool-call deltas by index and counts reasoning without returning it', async () => {
  const cfg = testConfig();
  const calls = [
    {id: 'chatcmpl-tool-1', name: 'memory_recall', arguments: '{"query": "谁是固态电池电解质方面的独立专家？"}'},
    {id: 'chatcmpl-tool-2', name: 'memory_recall', arguments: '{"query": "锂境科技创始人在宁德时代的同事"}'},
    {id: 'chatcmpl-tool-3', name: 'memory_recall', arguments: '{"query": "x"}'},
  ];
  const reasoning = '先看 BP 的关键指标，再决定检索什么。';
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply(openAiChunks({reasoning, toolCalls: calls}))}]);
  const out = await chatStream(cfg, 'oauth-token', {messages: MESSAGES, tools: TOOLS, toolChoice: 'required'});
  assert.equal(out.content, '');
  assert.equal(out.reasoningLength, reasoning.length);
  assert.deepEqual(out.toolCalls, calls);
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(typeof out.seconds, 'number');
  assert.ok(out.seconds >= 0);
  assert.equal(JSON.stringify(out).includes('先看 BP'), false);
});

test('chatStream joins content split across network chunks inside multi-byte characters', async () => {
  const cfg = testConfig();
  const content = '{"verdict": {"title": "值得继续看", "text": "电解质指标需要核实。"}}';
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply(openAiChunks({content, reasoning: 'abc'}), {chunkBytes: 5})}]);
  const out = await chatStream(cfg, 'oauth-token', {messages: MESSAGES});
  assert.equal(out.content, content);
  assert.equal(out.reasoningLength, 3);
  assert.deepEqual(out.toolCalls, []);
  assert.equal(out.finishReason, 'stop');
});

test('chatStream counts the alternative reasoning field and tolerates CRLF and comment lines', async () => {
  const cfg = testConfig();
  const text = ': keep-alive\r\n\r\n'
    + 'data: {"choices":[{"index":0,"delta":{"reasoning":"abcd"},"finish_reason":null}]}\r\n\r\n'
    + 'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"length"}]}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n';
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => new Response(text, {headers: {'Content-Type': 'text/event-stream'}})}]);
  const out = await chatStream(cfg, 'oauth-token', {messages: MESSAGES});
  assert.equal(out.content, 'hi');
  assert.equal(out.reasoningLength, 4);
  assert.equal(out.finishReason, 'length');
});

test('a mid-stream error chunk becomes a model ServiceError with the gateway code', async () => {
  const cfg = testConfig();
  const events = [...openAiChunks({content: '一半'}).slice(0, 2), {error: {code: 'provider_stream_interrupted', message: 'upstream closed'}}];
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply(events)}]);
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 502, 'provider_stream_interrupted'));
});

test('a mid-stream error given as a string or without a code still maps to a model error', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply([{error: 'boom'}, {error: {message: 'no code'}}])}]);
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 502, 'boom'));
  mock.restore();
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply([{error: {message: 'no code'}}])}]);
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 502, 'provider_error'));
});

test('a stream that ends without [DONE] or finish_reason is stream_interrupted', async () => {
  const cfg = testConfig();
  const events = openAiChunks({content: 'abc'}).filter((c) => !c.choices.some((ch) => ch.finish_reason));
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply(events, {done: false})}]);
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 502, 'stream_interrupted'));
});

test('a stream that ends with finish_reason but no [DONE] is accepted', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => sseReply(openAiChunks({content: 'abc'}), {done: false})}]);
  const out = await chatStream(cfg, 'oauth-token', {messages: MESSAGES});
  assert.equal(out.content, 'abc');
  assert.equal(out.finishReason, 'stop');
});

test('an unparseable data line is invalid_stream', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => new Response('data: {not json\n\n', {headers: {'Content-Type': 'text/event-stream'}})}]);
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 502, 'invalid_stream'));
});

test('HTTP errors keep the status and the gateway error code', async () => {
  const cfg = testConfig();
  let reply = Response.json({error: {code: 'account_concurrency_limit_exceeded', message: 'too many'}}, {status: 429});
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => reply}]);
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 429, 'account_concurrency_limit_exceeded'));
  reply = Response.json({error: {code: 'billing_account_uninitialized', message: 'no plan'}}, {status: 402});
  await assert.rejects(chat(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 402, 'billing_account_uninitialized'));
  reply = new Response('Unauthorized', {status: 401});
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 401, 'http_401'));
  reply = new Response(null, {status: 302, headers: {Location: 'https://elsewhere.test/'}});
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 302, 'http_302'));
});

test('network failures and timeouts map to model ServiceErrors', async () => {
  const cfg = testConfig();
  mock = installFetch([]);
  await assert.rejects(chatStream(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 0, 'upstream_unavailable'));
  mock.restore();
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => { throw new DOMException('timed out', 'TimeoutError'); }}]);
  await assert.rejects(chat(cfg, 'oauth-token', {messages: MESSAGES}), err => err.service === 'model' && err.code === 'upstream_timeout' && /^Model gateway timeout: timed out$/.test(err.message));
});

test('chatStream accepts a JSON completion when the gateway does not stream', async () => {
  const cfg = testConfig();
  const completion = {id: 'c', choices: [{index: 0, message: {role: 'assistant', content: '', reasoning_content: 'abcdef', tool_calls: [{id: 't1', type: 'function', function: {name: 'memory_recall', arguments: '{"query":"q"}'}}]}, finish_reason: 'tool_calls'}]};
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => completion}]);
  const out = await chatStream(cfg, 'oauth-token', {messages: MESSAGES, tools: TOOLS});
  assert.deepEqual(out.toolCalls, [{id: 't1', name: 'memory_recall', arguments: '{"query":"q"}'}]);
  assert.equal(out.reasoningLength, 6);
  assert.equal(out.finishReason, 'tool_calls');
});

test('chat sends a non-stream request without tools and returns the same shape', async () => {
  const cfg = testConfig();
  const completion = {id: 'c', choices: [{index: 0, message: {role: 'assistant', content: '1. 先看团队\n2. 再看技术', reasoning_content: 'xy'}, finish_reason: 'stop'}]};
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => completion}]);
  const out = await chat(cfg, 'oauth-token', {messages: MESSAGES, maxTokens: 800});
  assert.deepEqual({...out, seconds: 0}, {content: '1. 先看团队\n2. 再看技术', reasoningLength: 2, toolCalls: [], finishReason: 'stop', seconds: 0});
  assert.deepEqual(JSON.parse(mock.calls[0].body), {model: 'test-model', messages: MESSAGES, temperature: 0.2, max_tokens: 800, stream: false});
  assert.equal(mock.calls[0].headers.get('accept'), 'application/json');
  assert.equal(mock.calls[0].headers.get('x-auth-type'), 'mcp_access_token');
  await chat(cfg, 'oauth-token', {messages: MESSAGES});
  assert.equal(JSON.parse(mock.calls[1].body).max_tokens, 4000);
});

test('chat rejects a 200 body that carries an error or no choices', async () => {
  const cfg = testConfig();
  let reply = {error: {code: 'gateway_model_busy', message: 'busy'}};
  mock = installFetch([{method: 'POST', url: URL_CHAT, reply: () => reply}]);
  await assert.rejects(chat(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 502, 'gateway_model_busy'));
  reply = {choices: []};
  await assert.rejects(chat(cfg, 'oauth-token', {messages: MESSAGES}), serviceError('model', 502, 'invalid_response'));
});

test('missing token or messages fail before any request', async () => {
  const cfg = testConfig();
  mock = installFetch([]);
  await assert.rejects(chatStream(cfg, '', {messages: MESSAGES}), serviceError('auth', 401, 'not_authenticated'));
  await assert.rejects(chat(cfg, 'oauth-token', {messages: []}), TypeError);
  assert.equal(mock.calls.length, 0);
});
