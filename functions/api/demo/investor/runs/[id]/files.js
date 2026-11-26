// POST: give one file to a step. JSON {group, demoPath} picks a bundled demo file listed in the
// manifest; multipart (file, group, slot?, role?) uploads the visitor's own file. Type, size,
// slot and role rules live in materials.mjs and the step modules, which raise the 4xx answers.
import {json} from '../../../../../../server/demo/http.mjs';
import {demoError, requireRun} from '../../../../../../server/demo/runs.mjs';
import {GROUP_IDS, readDemoFile} from '../../../../../../server/demo/investor/materials.mjs';
import {addMemoryFile} from '../../../../../../server/demo/investor/memory-step.mjs';
import {setMethodFile} from '../../../../../../server/demo/investor/method-step.mjs';

export async function onRequestPost(context) {
  const {cfg, session} = context.data;
  const run = await requireRun(cfg, session.accountId, context.params.id);
  const input = await readInput(context.request, context.env);
  const updated = input.group === 'memory'
    ? await addMemoryFile(cfg, session, run, {name: input.name, bytes: input.bytes, source: input.source, locale: context.data.locale})
    : await setMethodFile(cfg, session, run, {group: input.group, slot: input.slot, role: input.role, name: input.name, bytes: input.bytes, locale: context.data.locale});
  return json({run: updated}, 201);
}

async function readInput(request, env) {
  if ((request.headers.get('Content-Type') || '').startsWith('multipart/form-data')) {
    let form;
    try {
      form = await request.formData();
    } catch {
      throw demoError(400, 'invalid_request', 'err.upload_unreadable');
    }
    const group = checkGroup(form.get('group'));
    const file = form.get('file');
    if (!file || typeof file === 'string') throw demoError(400, 'invalid_request', 'err.upload_missing');
    return {
      group, slot: optionalText(form.get('slot')), role: optionalText(form.get('role')),
      name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), source: 'upload',
    };
  }
  let body;
  try {
    body = await request.json();
  } catch {
    throw demoError(400, 'invalid_request', 'err.request_not_json');
  }
  const group = checkGroup(body?.group);
  if (typeof body.demoPath !== 'string' || !body.demoPath) throw demoError(400, 'invalid_request', 'err.demo_path_missing');
  // Only paths listed in this group of the manifest are served; anything else is 404 demo_file_not_found.
  const demo = await readDemoFile(env, group, body.demoPath, {origin: new URL(request.url).origin});
  return {group, slot: demo.slot, role: demo.role, name: demo.name, bytes: demo.bytes, source: 'demo'};
}

function checkGroup(value) {
  if (typeof value !== 'string' || !GROUP_IDS.includes(value)) {
    throw demoError(400, 'invalid_group', 'err.invalid_group');
  }
  return value;
}

function optionalText(value) {
  return typeof value === 'string' && value ? value : null;
}
