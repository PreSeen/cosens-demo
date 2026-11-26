// GET: the spaces (Virtual Users) the visitor may start an investor demo in, besides a new one: every VU they own or
// may write to, newest first, each marked when an earlier investor run used it. VUs they may only read are counted, not listed.
import {json} from '../../../../server/demo/http.mjs';
import {listSpaces} from '../../../../server/demo/spaces.mjs';

export async function onRequestGet(context) {
  const {cfg, session} = context.data;
  return json(await listSpaces(cfg, session));
}
