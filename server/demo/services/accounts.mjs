// Account service client: Virtual User create/list/get with the visitor's OAuth access token.
// Every response is the envelope {requestId, timestamp, data, error}.
import {ServiceError, callService, upstreamServiceError} from '../http.mjs';

const SERVICE = 'account';
const NAME_MAX = 160;

/** @typedef {{vuId:string, name:string, ownerAccountId:string|null, role:string|null, createdAt:string|null, updatedAt:string|null}} VirtualUser */

function requireToken(token) {
  if (typeof token !== 'string' || token === '') throw new ServiceError('auth', 401, 'not_authenticated', 'err.sign_in_first');
}

function headers(token, json = false) {
  const h = {Authorization: `Bearer ${token}`, Accept: 'application/json'};
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function invalidResponse() {
  return new ServiceError(SERVICE, 502, 'invalid_response', 'Account service invalid_response: the reply does not have the expected fields');
}

function unwrap(body) {
  if (body && typeof body === 'object' && body.error == null && body.data != null) return body.data;
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object' && body.error.code) {
    throw upstreamServiceError(SERVICE, 502, String(body.error.code), String(body.error.message || body.error.code));
  }
  throw invalidResponse();
}

/** @returns {VirtualUser} */
function toVirtualUser(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.vuId !== 'string' || raw.vuId === '') throw invalidResponse();
  return {
    vuId: raw.vuId,
    name: typeof raw.name === 'string' ? raw.name : '',
    ownerAccountId: raw.ownerAccountId ?? null,
    role: raw.role ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

/** POST /virtual-users {name} -> VirtualUser (the caller becomes the owner). */
export async function createVirtualUser(cfg, token, name) {
  requireToken(token);
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || trimmed.length > NAME_MAX) throw new TypeError(`virtual user name must be 1-${NAME_MAX} characters`);
  const body = await callService(SERVICE, `${cfg.accountBase}/virtual-users`, {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify({name: trimmed}),
  });
  return toVirtualUser(unwrap(body));
}

/** GET /virtual-users -> VirtualUser[] (owned and shared, no pagination). */
export async function listVirtualUsers(cfg, token) {
  requireToken(token);
  const body = await callService(SERVICE, `${cfg.accountBase}/virtual-users`, {method: 'GET', headers: headers(token)});
  const data = unwrap(body);
  if (!Array.isArray(data)) throw invalidResponse();
  return data.map(toVirtualUser);
}

/** GET /virtual-users/{vuId} -> VirtualUser (members are dropped). */
export async function getVirtualUser(cfg, token, vuId) {
  requireToken(token);
  if (typeof vuId !== 'string' || vuId === '') throw new TypeError('vuId is required');
  const body = await callService(SERVICE, `${cfg.accountBase}/virtual-users/${encodeURIComponent(vuId)}`, {
    method: 'GET',
    headers: headers(token),
  });
  return toVirtualUser(unwrap(body));
}
