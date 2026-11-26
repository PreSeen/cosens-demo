// Reads the demo hub settings from the Pages environment. Every service address comes from here.
import {addScrubTerms} from './scrub.mjs';

/**
 * oauthBase: the OAuth authorization server (`/oauth2/{authorize,token,register,revoke}`), default the account base.
 * oauthResource: the OAuth `resource` (token audience), default `${memoryBase}/mcp/`.
 * memoryViaGateway: Memory is reached through the RSI gateway (memoryBase is then the gateway's /api base). The
 * gateway forwards only /memory/ingest, /memory/recall, /memory/items and /memory/jobs/{id}, so the step 1 graph
 * stats and the PDF/Word document upload are not available.
 * @typedef {{memoryBase:string, accountBase:string, oauthBase:string, oauthResource:string, memoryViaGateway:boolean, rsiBase:string, llmBase:string, llmModel:string, scopes:string, clientId:string|null, secret:string, kv:any}} Config
 */

export const DEFAULT_SCOPES = 'openid email offline_access memory.read memory.write memory.document.upload vu.manage rsi.read rsi.write llm.invoke';

const MIN_SECRET_LENGTH = 32;
const BASES = [
  ['memoryBase', 'DEMO_MEMORY_BASE'],
  ['accountBase', 'DEMO_ACCOUNT_BASE'],
  ['rsiBase', 'DEMO_RSI_BASE'],
  ['llmBase', 'DEMO_LLM_BASE'],
];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ConfigError extends Error {
  /** @param {'config_missing'|'config_invalid'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function text(env, name) {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function required(env, name) {
  const value = text(env, name);
  if (!value) throw new ConfigError('config_missing', `missing setting ${name}`);
  return value;
}

function checkedUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new ConfigError('config_invalid', `${name} is not a URL`); }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure) throw new ConfigError('config_invalid', `${name} must use https`);
  if (url.search || url.hash || value.includes('?') || value.includes('#')) throw new ConfigError('config_invalid', `${name} must not carry a query or fragment`);
  return value;
}

function baseUrl(env, name) {
  return checkedUrl(required(env, name).replace(/\/+$/, ''), name);
}

/** true for true/'true'/'1', false for false/''/'false'/'0' (case-insensitive) or unset; anything else is refused. */
function flag(env, name) {
  const value = env[name];
  if (value === true || value === false) return value;
  const word = text(env, name).toLowerCase();
  if (word === 'true' || word === '1') return true;
  if (word === '' || word === 'false' || word === '0') return false;
  throw new ConfigError('config_invalid', `${name} must be true or false`);
}

/** @param {Record<string, any>} env @returns {Config} */
export function readConfig(env) {
  const source = env ?? {};
  /** @type {Record<string, string>} */
  const bases = {};
  for (const [key, name] of BASES) bases[key] = baseUrl(source, name);
  const llmModel = required(source, 'DEMO_LLM_MODEL');
  const secret = required(source, 'DEMO_SESSION_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) throw new ConfigError('config_invalid', `DEMO_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const kv = source.DEMO_KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') throw new ConfigError('config_missing', 'missing binding DEMO_KV');
  const scopes = text(source, 'DEMO_OAUTH_SCOPES').split(/\s+/).filter(Boolean).join(' ') || DEFAULT_SCOPES;
  const clientId = text(source, 'DEMO_OAUTH_CLIENT_ID') || null;
  const oauthBase = text(source, 'DEMO_OAUTH_BASE') ? baseUrl(source, 'DEMO_OAUTH_BASE') : bases.accountBase;
  const memoryViaGateway = flag(source, 'DEMO_MEMORY_VIA_GATEWAY');
  const resource = text(source, 'DEMO_OAUTH_RESOURCE');
  // Through the gateway, ${memoryBase}/mcp/ is not an MCP resource the authorization server knows, so it has no default.
  if (!resource && memoryViaGateway) throw new ConfigError('config_missing', 'missing setting DEMO_OAUTH_RESOURCE (required when DEMO_MEMORY_VIA_GATEWAY is true)');
  const oauthResource = resource ? checkedUrl(resource, 'DEMO_OAUTH_RESOURCE') : `${bases.memoryBase}/mcp/`;
  // Error texts pass through to the page; the model id and the service hosts never do.
  addScrubTerms([...text(source, 'DEMO_PRIVATE_NAMES').split(','), llmModel, llmModel.split('/').pop(), ...[...Object.values(bases), oauthBase].map(base => new URL(base).host)]);
  return {
    memoryBase: bases.memoryBase,
    accountBase: bases.accountBase,
    oauthBase,
    oauthResource,
    memoryViaGateway,
    rsiBase: bases.rsiBase,
    llmBase: bases.llmBase,
    llmModel,
    scopes,
    clientId,
    secret,
    kv,
  };
}
