// Memory client (native REST at cfg.memoryBase). Called directly, Memory detects the OAuth access token from its
// claims, so no auth-type header is sent. Through the RSI gateway (cfg.memoryViaGateway, memoryBase = the gateway's
// /api base), the gateway authenticates the token like the RSI calls: X-Auth-Type: mcp_access_token. The gateway
// forwards only /memory/ingest, /memory/recall, /memory/items and /memory/jobs/{id}, so graph stats and the PDF/Word
// document routes are refused here without a call. Every call selects the demo VU.
import {ServiceError, callService} from '../http.mjs';
import {t} from '../../../shared/i18n.mjs';

/** Why a PDF or Word file cannot be remembered when Memory runs through the gateway, in a language. */
export const textOnlyMessage = locale => t('err.text_only', undefined, locale);

const SERVICE = 'memory';
const VU_ID = /^vu_[0-9a-f]{32}$/;
const JOB_STATES = new Set(['pending', 'committed', 'failed']);
const ORG_SUBTYPES = ['organization', 'organisation', 'company', 'institution', 'org'];

function check(token, vuId) {
  if (typeof token !== 'string' || token === '') throw new ServiceError('auth', 401, 'not_authenticated', 'err.sign_in_first');
  if (typeof vuId !== 'string' || !VU_ID.test(vuId)) throw new ServiceError(SERVICE, 400, 'invalid_virtual_user_id', 'err.invalid_vu');
}

function headers(cfg, token, vuId, json) {
  const h = {Authorization: `Bearer ${token}`, 'X-Virtual-User-Id': vuId, Accept: 'application/json'};
  if (cfg.memoryViaGateway) h['X-Auth-Type'] = 'mcp_access_token';
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** Routes the gateway does not forward. */
function directOnly(cfg, what) {
  if (cfg.memoryViaGateway) throw new ServiceError(SERVICE, 501, 'not_available', `${what} is not available through the gateway`);
}

function invalidResponse() {
  return new ServiceError(SERVICE, 502, 'invalid_response', 'Memory invalid_response: the reply does not have the expected fields');
}

async function getJson(cfg, token, vuId, path) {
  check(token, vuId);
  return callService(SERVICE, `${cfg.memoryBase}${path}`, {method: 'GET', headers: headers(cfg, token, vuId, false)});
}

async function postJson(cfg, token, vuId, path, payload) {
  check(token, vuId);
  return callService(SERVICE, `${cfg.memoryBase}${path}`, {
    method: 'POST',
    headers: headers(cfg, token, vuId, true),
    body: JSON.stringify(payload),
  });
}

/**
 * POST /memory/ingest. Replaying the same requestKey with the same body returns the first receipt.
 * @returns {Promise<{source_id:string, revision:number, job_id:string, content_hash:string, state:string}>}
 */
export async function ingest(cfg, token, vuId, {content, requestKey, sourceId = requestKey, sourceKind = 'document'}) {
  if (typeof content !== 'string' || content === '') throw new TypeError('content is required');
  if (typeof requestKey !== 'string' || requestKey === '' || requestKey.length > 256) throw new TypeError('requestKey must be 1-256 characters');
  const receipt = await postJson(cfg, token, vuId, '/memory/ingest', {
    content,
    request_key: requestKey,
    source_id: sourceId,
    source_kind: sourceKind,
    durable: true,
  });
  if (!receipt || typeof receipt.job_id !== 'string') throw invalidResponse();
  return receipt;
}

/** GET /memory/jobs/{jobId} -> {job_id, state:'pending'|'committed'|'failed'} */
export async function getJob(cfg, token, vuId, jobId) {
  if (typeof jobId !== 'string' || jobId === '') throw new TypeError('jobId is required');
  const body = await getJson(cfg, token, vuId, `/memory/jobs/${encodeURIComponent(jobId)}`);
  if (!body || !JOB_STATES.has(body.state)) throw invalidResponse();
  return {job_id: body.job_id ?? jobId, state: body.state};
}

/** POST /memory/recall -> {query, items:[{id, kind, text, score}], estimated_tokens} */
export async function recall(cfg, token, vuId, query, tokenBudget = 2000) {
  if (typeof query !== 'string' || query.trim() === '') throw new TypeError('query is required');
  const body = await postJson(cfg, token, vuId, '/memory/recall', {query, token_budget: tokenBudget});
  if (!body || !Array.isArray(body.items)) throw invalidResponse();
  return {query: body.query ?? query, items: body.items, estimated_tokens: body.estimated_tokens ?? 0};
}

/** GET /memory/items?limit=N -> {sources, experiences, limit} (ingested sources only) */
export async function listItems(cfg, token, vuId, limit = 200) {
  const body = await getJson(cfg, token, vuId, `/memory/items?limit=${encodeURIComponent(String(limit))}`);
  if (!body || !Array.isArray(body.sources)) throw invalidResponse();
  return body;
}

/**
 * POST /v1/graph/types {graph_type:'context'} -> {people, organizations, relations}
 * people = Entity subtype person; organizations = Entity subtypes organization|organisation|company|institution|org;
 * relations = edge types RELATION.
 */
export async function graphStats(cfg, token, vuId) {
  directOnly(cfg, 'graph stats');
  const body = await postJson(cfg, token, vuId, '/v1/graph/types', {graph_type: 'context'});
  const graph = body?.graph ?? {};
  const subtypes = new Map();
  for (const type of graph.nodes?.types ?? []) {
    if (type?.type !== 'Entity') continue;
    for (const sub of type.subtypes ?? []) subtypes.set(sub.type, Number(sub.count) || 0);
  }
  let relations = 0;
  for (const type of graph.edges?.types ?? []) if (type?.type === 'RELATION') relations += Number(type.count) || 0;
  const organizations = ORG_SUBTYPES.reduce((sum, name) => sum + (subtypes.get(name) ?? 0), 0);
  return {people: subtypes.get('person') ?? 0, organizations, relations};
}

/**
 * POST /v1/document/upload multipart (file only; server defaults for the rest).
 * The target graph is the VU's context graph because X-Virtual-User-Id is sent.
 * @returns {Promise<{document_id:string, status:string, stage:string}>}
 */
export async function uploadDocument(cfg, token, vuId, {name, bytes, mime}) {
  if (cfg.memoryViaGateway) throw new ServiceError(SERVICE, 415, 'unsupported_file', 'err.text_only');
  check(token, vuId);
  if (typeof name !== 'string' || name === '') throw new TypeError('name is required');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
  const form = new FormData();
  form.append('file', new Blob([bytes], {type: mime || 'application/octet-stream'}), name);
  const body = await callService(SERVICE, `${cfg.memoryBase}/v1/document/upload`, {
    method: 'POST',
    headers: headers(cfg, token, vuId, false),
    body: form,
  });
  if (!body || typeof body.document_id !== 'string') throw invalidResponse();
  return body;
}

/** POST /v1/document/status {document_ids} -> statuses[] ({document_id, status, stage, recall_ready, ...}) */
export async function documentStatus(cfg, token, vuId, documentIds) {
  if (!Array.isArray(documentIds) || documentIds.length === 0) return [];
  directOnly(cfg, 'document status');
  const body = await postJson(cfg, token, vuId, '/v1/document/status', {document_ids: documentIds});
  if (!body || !Array.isArray(body.statuses)) throw invalidResponse();
  return body.statuses;
}
