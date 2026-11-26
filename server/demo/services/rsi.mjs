// RSI client through the gateway (cfg.rsiBase already ends in /api). The visitor's OAuth access
// token is sent with X-Auth-Type: mcp_access_token; the gateway resolves X-Virtual-User-Id.
import {ServiceError, callService} from '../http.mjs';

const SERVICE = 'rsi';
const VU_ID = /^vu_[0-9a-f]{32}$/;
const ROLES = new Set(['input', 'artifact', 'reference', 'feedback', 'recipe']);
const ENCODINGS = new Set(['utf-8', 'base64']);

function check(token, vuId) {
  if (typeof token !== 'string' || token === '') throw new ServiceError('auth', 401, 'not_authenticated', 'err.sign_in_first');
  if (typeof vuId !== 'string' || !VU_ID.test(vuId)) throw new ServiceError(SERVICE, 400, 'invalid_virtual_user_id', 'err.invalid_vu');
}

function headers(token, vuId, json) {
  const h = {
    Authorization: `Bearer ${token}`,
    'X-Auth-Type': 'mcp_access_token',
    'X-Virtual-User-Id': vuId,
    Accept: 'application/json',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function invalidResponse() {
  return new ServiceError(SERVICE, 502, 'invalid_response', 'RSI invalid_response: the reply does not have the expected fields');
}

async function rsiGet(cfg, token, vuId, pathAndQuery) {
  check(token, vuId);
  return callService(SERVICE, `${cfg.rsiBase}${pathAndQuery}`, {method: 'GET', headers: headers(token, vuId, false)});
}

function upload(file, label) {
  if (!file || typeof file.name !== 'string' || file.name === '' || file.name.length > 200) throw new TypeError(`${label}: name must be 1-200 characters`);
  if (typeof file.content !== 'string') throw new TypeError(`${label}: content must be a string`);
  const encoding = file.encoding ?? 'utf-8';
  if (!ENCODINGS.has(encoding)) throw new TypeError(`${label}: encoding must be utf-8 or base64`);
  return {name: file.name, content: file.content, encoding};
}

/**
 * POST /executions {idempotency_key, context, files}. A file with role 'recipe' and recipe_id refines
 * that Recipe into a new version; at most one recipe file is allowed.
 * @param {{idempotencyKey:string, context:{name:string, content:string, encoding?:string}, files:Array<{name:string, content:string, encoding?:string, role:string, recipe_id?:string}>}} body
 */
export async function createExecution(cfg, token, vuId, {idempotencyKey, context, files = []}) {
  check(token, vuId);
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '' || idempotencyKey.length > 256) throw new TypeError('idempotencyKey must be 1-256 characters');
  const staged = files.map((file, index) => {
    if (!ROLES.has(file?.role)) throw new TypeError(`files[${index}]: unknown role ${file?.role}`);
    const out = {...upload(file, `files[${index}]`), role: file.role};
    if (file.recipe_id) {
      if (file.role !== 'recipe') throw new TypeError(`files[${index}]: recipe_id is only allowed on the recipe file`);
      out.recipe_id = file.recipe_id;
    }
    return out;
  });
  if (staged.filter((file) => file.role === 'recipe').length > 1) throw new TypeError('at most one recipe file can be supplied');
  const execution = await callService(SERVICE, `${cfg.rsiBase}/executions`, {
    method: 'POST',
    headers: headers(token, vuId, true),
    body: JSON.stringify({idempotency_key: idempotencyKey, context: upload(context, 'context'), files: staged}),
  });
  if (!execution || typeof execution.id !== 'string') throw invalidResponse();
  return execution;
}

/** GET /executions/{id} -> Execution {id, status, stage, progress_percent, recipe_id, test_results, error, ...} */
export async function getExecution(cfg, token, vuId, id) {
  if (typeof id !== 'string' || id === '') throw new TypeError('execution id is required');
  const execution = await rsiGet(cfg, token, vuId, `/executions/${encodeURIComponent(id)}`);
  if (!execution || typeof execution.id !== 'string') throw invalidResponse();
  return execution;
}

/** GET /recipes?recipe_ids=a,b -> RecipeSummary[] ({recipe_id, name, status, active_version_id, ...}). Empty ids -> []. */
export async function listRecipes(cfg, token, vuId, recipeIds) {
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) return [];
  const list = await rsiGet(cfg, token, vuId, `/recipes?recipe_ids=${recipeIds.map(encodeURIComponent).join(',')}`);
  if (!Array.isArray(list)) throw invalidResponse();
  return list;
}

/** GET /recipes/{id}?version=active|latest|<version_id> -> Recipe {id, name, selected_version:{id, number, content:{name, description, instructions}}, ...} */
export async function getRecipe(cfg, token, vuId, recipeId, version = 'active') {
  if (typeof recipeId !== 'string' || recipeId === '') throw new TypeError('recipeId is required');
  const recipe = await rsiGet(cfg, token, vuId, `/recipes/${encodeURIComponent(recipeId)}?version=${encodeURIComponent(version)}`);
  if (!recipe || typeof recipe.id !== 'string' || !recipe.selected_version?.content) throw invalidResponse();
  return recipe;
}

/** RECIPE.md exactly as the SDK store writes it: JSON-quoted name/description frontmatter, then instructions. */
export function recipeMarkdown({name, description, instructions}) {
  const frontmatter = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n`;
  const markdown = instructions ? `${frontmatter}\n${instructions}` : frontmatter;
  return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
}

/** Upload body for one file: UTF-8 text when the bytes decode strictly, otherwise standard base64. */
export function toUpload(name, bytes) {
  if (typeof bytes === 'string') return {name, content: bytes, encoding: 'utf-8'};
  try {
    return {name, content: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes), encoding: 'utf-8'};
  } catch {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return {name, content: btoa(binary), encoding: 'base64'};
  }
}
