// Model gateway client (OpenAI-compatible Chat Completions at cfg.llmBase). The visitor's OAuth
// access token is sent as the bearer with X-Auth-Type: mcp_access_token.
// chatStream streams so long generations keep the connection alive; tool-call deltas are
// accumulated by index; reasoning text is only counted, never returned.
import {ServiceError, scrubMessage, transportError as serviceTransportError, upstreamServiceError} from '../http.mjs';

const SERVICE = 'model';
const STREAM_TIMEOUT_MS = 300_000;
const CHAT_TIMEOUT_MS = 180_000;
const TEMPERATURE = 0.2;

/** @typedef {{id:string, name:string, arguments:string}} ToolCall */
/** @typedef {{content:string, reasoningLength:number, toolCalls:ToolCall[], finishReason:string|null, seconds:number}} ChatResult */

function requireToken(token) {
  if (typeof token !== 'string' || token === '') throw new ServiceError('auth', 401, 'not_authenticated', 'err.sign_in_first');
}

function headers(token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Auth-Type': 'mcp_access_token',
    'Content-Type': 'application/json',
    Accept: accept,
  };
}

function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

function transportError(err) {
  if (err instanceof ServiceError) return err;
  return serviceTransportError(SERVICE, err);
}

function errorFields(data, fallbackCode, fallbackMessage = '') {
  const error = data && typeof data === 'object' ? data.error : null;
  const code = (error && typeof error === 'object' && error.code ? String(error.code) : null)
    ?? (typeof error === 'string' && error ? error : null)
    ?? fallbackCode;
  const message = (error && typeof error === 'object' && error.message ? String(error.message) : null)
    ?? (data && typeof data === 'object' && typeof data.detail === 'string' ? data.detail : null)
    ?? fallbackMessage;
  return {code, message};
}

async function upstreamError(res) {
  let data = null;
  try { data = JSON.parse(await res.text()); } catch { data = null; }
  const {code, message} = errorFields(data, `http_${res.status}`);
  return upstreamServiceError(SERVICE, res.status, code, message);
}

async function send(cfg, token, body, accept, signal) {
  let res;
  try {
    res = await fetch(`${cfg.llmBase}/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: headers(token, accept),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status < 200 || res.status >= 300) throw await upstreamError(res);
  return res;
}

function reasoningLength(part) {
  let n = 0;
  if (typeof part?.reasoning_content === 'string') n += part.reasoning_content.length;
  if (typeof part?.reasoning === 'string') n += part.reasoning.length;
  return n;
}

function seconds(started) {
  return Math.round((Date.now() - started) / 100) / 10;
}

/** Non-stream completion body -> ChatResult. */
function fromCompletion(data, started) {
  if (data && typeof data === 'object' && data.error) {
    const {code, message} = errorFields(data, 'provider_error');
    throw upstreamServiceError(SERVICE, 502, code, message);
  }
  const choice = data?.choices?.[0];
  if (!choice || typeof choice !== 'object') throw new ServiceError(SERVICE, 502, 'invalid_response', 'Model gateway invalid_response: the reply has no choices');
  const message = choice.message ?? {};
  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    id: call.id ?? '',
    name: call.function?.name ?? '',
    arguments: call.function?.arguments ?? '',
  }));
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoningLength: reasoningLength(message),
    toolCalls,
    finishReason: choice.finish_reason ?? null,
    seconds: seconds(started),
  };
}

/** Applies one SSE line to the accumulator. Returns true on [DONE]. */
function applyLine(line, acc) {
  if (!line.startsWith('data:')) return false;
  const payload = line.slice(5).trim();
  if (payload === '') return false;
  if (payload === '[DONE]') return true;
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    throw new ServiceError(SERVICE, 502, 'invalid_stream', scrubMessage(`Model gateway invalid_stream: a stream line is not JSON: ${payload.slice(0, 120)}`));
  }
  if (chunk && typeof chunk === 'object' && chunk.error) {
    const {code, message} = errorFields(chunk, 'provider_error');
    throw upstreamServiceError(SERVICE, 502, code, message);
  }
  const choice = chunk?.choices?.[0];
  if (!choice) return false;
  const delta = choice.delta ?? {};
  if (typeof delta.content === 'string') acc.content += delta.content;
  acc.reasoningLength += reasoningLength(delta);
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  for (const part of delta.tool_calls ?? []) {
    const index = part.index ?? 0;
    let slot = acc.calls.get(index);
    if (!slot) {
      slot = {id: '', name: '', arguments: ''};
      acc.calls.set(index, slot);
    }
    if (part.id) slot.id = part.id;
    if (part.function?.name) slot.name += part.function.name;
    if (part.function?.arguments) slot.arguments += part.function.arguments;
  }
  return false;
}

/**
 * One streamed chat call. tools/toolChoice are sent only when tools is non-empty.
 * @param {{messages:object[], tools?:object[], toolChoice?:string|object, maxTokens?:number, signal?:AbortSignal}} options
 * @returns {Promise<ChatResult>}
 */
export async function chatStream(cfg, token, {messages, tools = [], toolChoice = 'auto', maxTokens = 16000, signal} = {}) {
  requireToken(token);
  if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages are required');
  const body = {model: cfg.llmModel, messages, temperature: TEMPERATURE, max_tokens: maxTokens, stream: true};
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  const started = Date.now();
  const res = await send(cfg, token, body, 'text/event-stream', signal ?? AbortSignal.timeout(STREAM_TIMEOUT_MS));
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    let data;
    try { data = await res.json(); } catch (err) { throw isTimeout(err) ? transportError(err) : new ServiceError(SERVICE, 502, 'invalid_response', scrubMessage(`Model gateway invalid_response: the reply is not JSON (${err?.message ?? err})`)); }
    return fromCompletion(data, started);
  }
  if (!res.body) throw new ServiceError(SERVICE, 502, 'invalid_stream', 'Model gateway invalid_stream: the streamed reply has no body');
  const acc = {content: '', reasoningLength: 0, finishReason: null, calls: new Map()};
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  try {
    while (!done) {
      const {value, done: ended} = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, {stream: true});
      let newline;
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        done = applyLine(line, acc);
      }
    }
    if (!done) {
      buffer += decoder.decode();
      if (buffer.trim() !== '') done = applyLine(buffer.replace(/\r$/, ''), acc);
    }
  } catch (err) {
    throw transportError(err);
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!done && !acc.finishReason) throw new ServiceError(SERVICE, 502, 'stream_interrupted', 'Model gateway stream_interrupted: the stream ended without [DONE] or a finish reason');
  return {
    content: acc.content,
    reasoningLength: acc.reasoningLength,
    toolCalls: [...acc.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
    finishReason: acc.finishReason,
    seconds: seconds(started),
  };
}

/**
 * One non-stream chat call without tools.
 * @param {{messages:object[], maxTokens?:number, signal?:AbortSignal}} options
 * @returns {Promise<ChatResult>}
 */
export async function chat(cfg, token, {messages, maxTokens = 4000, signal} = {}) {
  requireToken(token);
  if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages are required');
  const started = Date.now();
  const res = await send(cfg, token, {model: cfg.llmModel, messages, temperature: TEMPERATURE, max_tokens: maxTokens, stream: false}, 'application/json', signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS));
  let data;
  try { data = await res.json(); } catch (err) { throw isTimeout(err) ? transportError(err) : new ServiceError(SERVICE, 502, 'invalid_response', scrubMessage(`Model gateway invalid_response: the reply is not JSON (${err?.message ?? err})`)); }
  return fromCompletion(data, started);
}
