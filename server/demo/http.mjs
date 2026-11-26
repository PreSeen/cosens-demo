// Response helpers and the one place that calls upstream services and maps their errors for the browser.
import {ConfigError} from './config.mjs';
import {DEFAULT_LOCALE, hasMessage, t} from '../../shared/i18n.mjs';
import {scrubMessage} from './scrub.mjs';

export {scrubMessage};

export const NOINDEX = {'X-Robots-Tag': 'noindex, nofollow'};

const DEFAULT_TIMEOUT_MS = 60000;
const HEARTBEAT_MS = 15000;

/** @param {unknown} data @param {number} [status] @param {Record<string,string>} [headers] */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', ...NOINDEX, ...headers},
  });
}

/** The service named in a message ("Memory", "The model service"), in the visitor's language. */
export function serviceLabel(service, locale = DEFAULT_LOCALE) {
  return t(`service.${service ?? 'demo'}`, undefined, locale);
}

/** A message key's text with its {service} parameter spelled out; plain text (an upstream message) is returned as it is. */
export function localized(message, params, locale = DEFAULT_LOCALE) {
  if (!hasMessage(message)) return String(message ?? '');
  const filled = params && params.service !== undefined ? {...params, service: serviceLabel(params.service, locale)} : params;
  return t(message, filled, locale);
}

export class ServiceError extends Error {
  /**
   * message is English text (an upstream message) or a key of shared/i18n.mjs; a key is rendered in the visitor's
   * language by errorBody. params fills the key's {name} parameters; {service: 'model'} names a service.
   * @param {'memory'|'rsi'|'model'|'account'|'auth'|null} service null = error raised by the demo itself (run_not_found, step_not_ready, ...)
   * @param {number} status upstream HTTP status, 0 for network failure or timeout
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string|number>} [params]
   */
  constructor(service, status, code, message, params) {
    super(localized(message, params));
    this.name = 'ServiceError';
    this.service = service;
    this.status = status;
    this.code = code;
    this.key = hasMessage(message) ? message : null;
    this.params = params;
  }

  /** The message in a language: the key's text, or the upstream text it carries. */
  text(locale = DEFAULT_LOCALE) {
    return this.key ? localized(this.key, this.params, locale) : this.message;
  }
}

// A service's error is shown in its own words, in English in both locales: "<service> <status> <code>: <message>". Only the safety scrub (scrub.mjs) applies.
const SERVICE_NAMES = {memory: 'Memory', rsi: 'RSI', model: 'Model gateway', account: 'Account service', auth: 'Login service'};
const serviceName = service => SERVICE_NAMES[service] ?? 'Service';

// Credit: the model gateway (gateway_credit_insufficient, insufficient_balance) and OpenAI-compatible providers
// (insufficient_quota). The page offers no 重试 for them (a retry cannot add credit).
export const CREDIT_CODES = Object.freeze(['gateway_credit_insufficient', 'insufficient_balance', 'insufficient_quota']);

/** True for an upstream answer that says the account is out of credit (HTTP 402 or a documented credit code). */
export const isCreditError = (status, code) => status === 402 || CREDIT_CODES.includes(String(code ?? '').toLowerCase());

/** "<service> <status> <code>: <message>", e.g. "Model gateway 402 gateway_credit_insufficient: account credit is insufficient". */
export function upstreamText(service, status, code, message) {
  const text = String(message ?? '').trim();
  const head = [serviceName(service), status || null, code || null].filter(Boolean).join(' ');
  return scrubMessage(text && text !== code ? `${head}: ${text}` : head);
}

/** A ServiceError for an upstream error answer: the service's status and code, and its message passed through (scrubbed). */
export function upstreamServiceError(service, status, code, message) {
  return new ServiceError(service, status, code, upstreamText(service, status, code, message));
}

/** A ServiceError for a call that got no (complete) answer: the underlying error and its cause passed through, scrubbed. */
export function transportError(service, err, what = '') {
  const name = err && typeof err === 'object' ? err.name : '';
  const cause = err?.cause ? ` (${[err.cause.code, err.cause.message].filter(Boolean).join(' ')})` : '';
  const detail = `${err?.message ?? err}${cause}`;
  if (name === 'TimeoutError') return new ServiceError(service, 0, 'upstream_timeout', scrubMessage(`${serviceName(service)} timeout${what}: ${detail}`));
  if (name === 'AbortError') return new ServiceError(service, 0, 'upstream_aborted', scrubMessage(`${serviceName(service)} request aborted${what}: ${detail}`));
  return new ServiceError(service, 0, 'upstream_unavailable', scrubMessage(`${serviceName(service)} unreachable${what}: ${detail}`));
}

/** @param {unknown} err @param {string} [locale] @returns {{status:number, body:{error:{code:string, message:string, service?:string}}}} */
export function errorBody(err, locale = DEFAULT_LOCALE) {
  if (err instanceof ServiceError) {
    const service = err.service ?? undefined;
    let status;
    let code = err.code;
    let message = err.text(locale);
    if (!service) status = err.status >= 400 && err.status < 600 ? err.status : 500;
    else if (service === 'auth') status = 401;
    else if (err.status === 401) { status = 401; code = 'not_authenticated'; message = t('err.session_expired', undefined, locale); }
    else if (err.status >= 400 && err.status < 500) status = err.status;
    else status = 502;
    const error = {code, message: scrubMessage(message || t('err.service_failed', {service: serviceLabel(service, locale)}, locale))};
    if (service) error.service = service;
    return {status, body: {error}};
  }
  if (err instanceof ConfigError) {
    return {status: 500, body: {error: {code: err.code, message: scrubMessage(t('err.config_incomplete', {detail: err.message}, locale))}}};
  }
  console.error('demo internal error', err);
  return {status: 500, body: {error: {code: 'internal_error', message: t('err.internal', undefined, locale)}}};
}

/** @param {unknown} err @param {string} [locale] @returns {Response} */
export function errorResponse(err, locale = DEFAULT_LOCALE) {
  const {status, body} = errorBody(err, locale);
  return json(body, status);
}

function upstreamError(service, status, data, text) {
  const err = data && typeof data === 'object' ? data : null;
  const nested = err && typeof err.error === 'object' && err.error !== null ? err.error : null;
  const detail = err ? err.detail : undefined;
  const code = (nested && typeof nested.code === 'string' && nested.code)
    || (err && typeof err.error === 'string' && err.error)
    || (detail && typeof detail === 'object' && !Array.isArray(detail) && typeof detail.code === 'string' && detail.code)
    || `http_${status}`;
  const plain = text.trim();
  const message = (nested && typeof nested.message === 'string' && nested.message)
    || (err && typeof err.error_description === 'string' && err.error_description)
    || (typeof detail === 'string' && detail)
    || (detail && typeof detail === 'object' && !Array.isArray(detail) && typeof detail.message === 'string' && detail.message)
    || (!err && plain && plain.length <= 300 && !plain.startsWith('<') ? plain : '');
  return upstreamServiceError(service, status, code, message);
}

/**
 * Calls an upstream service. Returns parsed JSON, the raw text when the body is not JSON, or null for an empty body.
 * init is a fetch RequestInit plus two demo options that are not sent: timeoutMs (default 60000, ignored when
 * init.signal is given) and raw (true returns the 2xx Response unread, for streams).
 * @param {'memory'|'rsi'|'model'|'account'|'auth'} service @param {string|URL} url @param {RequestInit & {timeoutMs?:number, raw?:boolean}} [init]
 */
export async function callService(service, url, init = {}) {
  const {timeoutMs = DEFAULT_TIMEOUT_MS, raw = false, ...rest} = init;
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {...rest, redirect: 'manual', signal});
  } catch (err) {
    throw transportError(service, err);
  }
  if (raw && response.ok) return response;
  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw transportError(service, err, ' while reading the answer');
  }
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) throw upstreamError(service, response.status, data, text);
  if (!text) return null;
  return data !== null || text.trim() === 'null' ? data : text;
}

/**
 * Streams server-sent events. start(emit) runs in the background; emit(obj) writes `data: <json>\n\n` and resolves
 * false once the client has gone (it never throws). If start throws, a final {type:'error', code, message, service?}
 * event is sent. A `: keepalive` comment is written every heartbeatMs so idle proxies keep the stream open.
 * Pass waitUntil (the Pages context function) so the work finishes even when the client disconnects.
 * locale is the language of that error text.
 * @param {(emit:(event:unknown)=>Promise<boolean>)=>Promise<void>} start
 * @param {{waitUntil?:(p:Promise<unknown>)=>void, heartbeatMs?:number, locale?:string}} [options]
 */
export function sseResponse(start, {waitUntil, heartbeatMs = HEARTBEAT_MS, locale = DEFAULT_LOCALE} = {}) {
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  const write = (chunk) => {
    if (!open) return Promise.resolve(false);
    return writer.write(encoder.encode(chunk)).then(() => true, () => { open = false; return false; });
  };
  const emit = (event) => write(`data: ${JSON.stringify(event)}\n\n`);
  const timer = heartbeatMs > 0 ? setInterval(() => { write(': keepalive\n\n'); }, heartbeatMs) : null;
  const task = (async () => {
    try {
      await start(emit);
    } catch (err) {
      await emit({type: 'error', ...errorBody(err, locale).body.error});
    } finally {
      if (timer) clearInterval(timer);
      if (open) {
        open = false;
        await writer.close().catch(() => {});
      }
    }
  })();
  if (typeof waitUntil === 'function') waitUntil(task);
  return new Response(readable, {
    status: 200,
    headers: {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', ...NOINDEX},
  });
}
