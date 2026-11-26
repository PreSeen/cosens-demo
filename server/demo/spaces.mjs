// The spaces (Virtual Users) a visitor can start an investor demo in: a fresh one, or one of their own that they may write to.
// The identity service decides the role: the Owner and `write` members may write memory and RSI data, `read` members
// may only read (VirtualUserRole.canWrite there), so a demo run, which writes both, needs one of the first two.
import {ServiceError} from './http.mjs';
import {demoError, listRuns} from './runs.mjs';
import {getVirtualUser, listVirtualUsers} from './services/accounts.mjs';

export const WRITE_ROLES = Object.freeze(['owner', 'write']);
const VU_ID = /^vu_[0-9a-f]{32}$/;

/** True when the visitor's role in this VU lets a demo write memories and methods into it. */
export const canWrite = vu => WRITE_ROLES.includes(vu?.role);

const createdMs = vu => {
  const ms = Date.parse(vu?.createdAt ?? '');
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The writable spaces, newest first: {vuId, name, createdAt (ms or null), role, demo}. demo is true for a VU an
 * investor run of this account was started in. readOnly counts the VUs left out because the visitor may only read them.
 * @returns {Promise<{spaces: Array<{vuId:string, name:string, createdAt:number|null, role:string, demo:boolean}>, readOnly:number}>}
 */
export async function listSpaces(cfg, session) {
  const [vus, runs] = await Promise.all([listVirtualUsers(cfg, session.accessToken), listRuns(cfg, session.accountId)]);
  const demoIds = new Set(runs.map(run => run.vuId));
  const writable = vus.filter(canWrite);
  const spaces = writable
    .map(vu => ({vuId: vu.vuId, name: vu.name, createdAt: createdMs(vu), role: vu.role, demo: demoIds.has(vu.vuId)}))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return {spaces, readOnly: vus.length - writable.length};
}

/**
 * The VU a visitor picked for a new run, read again from the identity service (the list the page showed may be stale).
 * 404 when it does not exist or is not shared with the visitor, 403 when the visitor may only read it.
 */
export async function requireWritableSpace(cfg, session, vuId) {
  if (typeof vuId !== 'string' || !VU_ID.test(vuId)) throw demoError(400, 'invalid_request', 'err.space_invalid');
  let vu;
  try {
    vu = await getVirtualUser(cfg, session.accessToken, vuId);
  } catch (err) {
    if (err instanceof ServiceError && err.service === 'account' && err.status === 404) {
      throw demoError(404, 'space_not_found', 'err.space_not_found');
    }
    throw err;
  }
  if (!canWrite(vu)) throw demoError(403, 'space_read_only', 'err.space_read_only');
  return vu;
}
