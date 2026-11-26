// GET /api/demo/me : the signed-in visitor (the API gate has put the session into context.data) and what step 1 can
// do here: memory.documents (PDF and Word files) and memory.stats (people, organizations and relations counts) are
// false when Memory runs through the gateway, which forwards neither.
import {ServiceError, errorResponse, json} from '../../../server/demo/http.mjs';
import {requestLocale} from '../../../shared/i18n.mjs';

export async function onRequestGet({data, request, env}) {
  const session = data?.session;
  if (!session) return errorResponse(new ServiceError('auth', 401, 'not_authenticated', 'err.login_expired'), data?.locale ?? requestLocale(request, env));
  const direct = !data.cfg?.memoryViaGateway;
  return json({email: session.email ?? null, accountId: session.accountId, memory: {documents: direct, stats: direct}});
}
