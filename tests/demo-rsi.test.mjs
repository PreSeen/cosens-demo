import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig, installFetch} from './helpers/fake-services.mjs';
import {createExecution, getExecution, listRecipes, getRecipe, recipeMarkdown, toUpload} from '../server/demo/services/rsi.mjs';
import {ServiceError} from '../server/demo/http.mjs';

const VU = 'vu_0123456789abcdef0123456789abcdef';
const EXECUTION = {id: 'execution_1', base_execution_id: null, status: 'queued', stage: 'queued', progress_percent: 0, recipe_id: 'recipe_a', recipe_version_id: null, test_results: [], result: null, error: null, evidence: []};
const serviceError = (service, status, code) => (err) => {
  assert.ok(err instanceof ServiceError, `expected ServiceError, got ${err}`);
  assert.equal(err.service, service);
  assert.equal(err.status, status);
  if (code) assert.equal(err.code, code);
  return true;
};
const assertRsiHeaders = (call, json) => {
  assert.equal(call.headers.get('authorization'), 'Bearer oauth-token');
  assert.equal(call.headers.get('x-auth-type'), 'mcp_access_token');
  assert.equal(call.headers.get('x-virtual-user-id'), VU);
  if (json) assert.equal(call.headers.get('content-type'), 'application/json');
};

let mock = null;
afterEach(() => { mock?.restore(); mock = null; });

test('createExecution posts idempotency_key, context and files with roles (project A)', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://rsi.test/api/executions', reply: () => EXECUTION}]);
  const out = await createExecution(cfg, 'oauth-token', VU, {
    idempotencyKey: `demo-${VU}-method-a-1`,
    context: {name: 'method-context.md', content: '任务：学会写投资建议书。\n'},
    files: [
      {name: '项目A 储能 BP.md', content: '# BP', encoding: 'utf-8', role: 'input'},
      {name: '项目A 储能 投资建议书.md', content: '# 建议书', role: 'artifact'},
    ],
  });
  assert.deepEqual(out, EXECUTION);
  const call = mock.calls[0];
  assert.equal(call.url, 'https://rsi.test/api/executions');
  assertRsiHeaders(call, true);
  assert.deepEqual(JSON.parse(call.body), {
    idempotency_key: `demo-${VU}-method-a-1`,
    context: {name: 'method-context.md', content: '任务：学会写投资建议书。\n', encoding: 'utf-8'},
    files: [
      {name: '项目A 储能 BP.md', content: '# BP', encoding: 'utf-8', role: 'input'},
      {name: '项目A 储能 投资建议书.md', content: '# 建议书', encoding: 'utf-8', role: 'artifact'},
    ],
  });
});

test('createExecution carries role recipe with recipe_id for project B and base64 files', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'POST', url: 'https://rsi.test/api/executions', reply: () => ({...EXECUTION, id: 'execution_2'})}]);
  await createExecution(cfg, 'oauth-token', VU, {
    idempotencyKey: 'k-b-1',
    context: {name: 'method-context.md', content: 'ctx'},
    files: [
      {...toUpload('B.pdf', new Uint8Array([0xff, 0xfe, 0x00])), role: 'input'},
      {name: 'RECIPE.md', content: recipeMarkdown({name: 'n', description: 'd', instructions: 'i'}), role: 'recipe', recipe_id: 'recipe_a'},
    ],
  });
  assert.deepEqual(JSON.parse(mock.calls[0].body).files, [
    {name: 'B.pdf', content: '//4A', encoding: 'base64', role: 'input'},
    {name: 'RECIPE.md', content: '---\nname: "n"\ndescription: "d"\n---\n\ni\n', encoding: 'utf-8', role: 'recipe', recipe_id: 'recipe_a'},
  ]);
});

test('createExecution refuses bad input before calling', async () => {
  const cfg = testConfig();
  mock = installFetch([]);
  const context = {name: 'c.md', content: 'c'};
  await assert.rejects(createExecution(cfg, 'oauth-token', VU, {idempotencyKey: '', context, files: []}), TypeError);
  await assert.rejects(createExecution(cfg, 'oauth-token', VU, {idempotencyKey: 'k', context, files: [{name: 'a', content: 'a', role: 'context'}]}), TypeError);
  await assert.rejects(createExecution(cfg, 'oauth-token', VU, {idempotencyKey: 'k', context, files: [{name: 'a', content: 'a', role: 'input', recipe_id: 'r'}]}), TypeError);
  await assert.rejects(createExecution(cfg, 'oauth-token', VU, {idempotencyKey: 'k', context, files: [{name: 'a', content: 'a', role: 'recipe'}, {name: 'b', content: 'b', role: 'recipe'}]}), /at most one recipe/);
  await assert.rejects(createExecution(cfg, 'oauth-token', 'nope', {idempotencyKey: 'k', context, files: []}), serviceError('rsi', 400, 'invalid_virtual_user_id'));
  await assert.rejects(createExecution(cfg, '', VU, {idempotencyKey: 'k', context, files: []}), serviceError('auth', 401, 'not_authenticated'));
  assert.equal(mock.calls.length, 0);
});

test('createExecution maps idempotency conflicts and validation errors', async () => {
  const cfg = testConfig();
  let reply = Response.json({error: {code: 'conflict', message: 'idempotency key reused with different arguments'}}, {status: 409});
  mock = installFetch([{method: 'POST', url: 'https://rsi.test/api/executions', reply: () => reply}]);
  const args = {idempotencyKey: 'k', context: {name: 'c.md', content: 'c'}, files: []};
  await assert.rejects(createExecution(cfg, 'oauth-token', VU, args), serviceError('rsi', 409, 'conflict'));
  reply = Response.json({detail: [{type: 'extra_forbidden'}]}, {status: 422});
  await assert.rejects(createExecution(cfg, 'oauth-token', VU, args), serviceError('rsi', 422));
});

test('getExecution reads one execution by encoded id', async () => {
  const cfg = testConfig();
  const done = {...EXECUTION, status: 'completed', stage: 'done', progress_percent: 100, test_results: [{score: 0.975, status: 'passed'}]};
  mock = installFetch([{method: 'GET', url: 'https://rsi.test/api/executions/execution_1', reply: () => done}]);
  assert.deepEqual(await getExecution(cfg, 'oauth-token', VU, 'execution_1'), done);
  assertRsiHeaders(mock.calls[0], false);
  assert.equal(mock.calls[0].body, null);
});

test('gateway plain-text 401 and VU errors map to rsi ServiceErrors', async () => {
  const cfg = testConfig();
  let reply = new Response('Unauthorized', {status: 401, headers: {'Content-Type': 'text/plain'}});
  mock = installFetch([{method: 'GET', url: /^https:\/\/rsi\.test\/api\/executions\//, reply: () => reply}]);
  await assert.rejects(getExecution(cfg, 'oauth-token', VU, 'execution_1'), serviceError('rsi', 401));
  reply = Response.json({error: {code: 'VIRTUAL_USER_NOT_FOUND'}}, {status: 404});
  await assert.rejects(getExecution(cfg, 'oauth-token', VU, 'execution_1'), serviceError('rsi', 404, 'VIRTUAL_USER_NOT_FOUND'));
  reply = Response.json({error: {code: 'not_found', message: 'execution not found: execution_1'}}, {status: 404});
  await assert.rejects(getExecution(cfg, 'oauth-token', VU, 'execution_1'), serviceError('rsi', 404, 'not_found'));
});

test('listRecipes sends comma-separated recipe_ids; empty list makes no call', async () => {
  const cfg = testConfig();
  const list = [{recipe_id: 'recipe_a', execution_ids: ['execution_1'], name: '方法', status: 'passed', active_version_id: 'version_2'}];
  mock = installFetch([{method: 'GET', url: 'https://rsi.test/api/recipes', reply: () => list}]);
  assert.deepEqual(await listRecipes(cfg, 'oauth-token', VU, ['recipe_a', 'recipe_b']), list);
  assert.equal(mock.calls[0].url, 'https://rsi.test/api/recipes?recipe_ids=recipe_a,recipe_b');
  assertRsiHeaders(mock.calls[0], false);
  assert.deepEqual(await listRecipes(cfg, 'oauth-token', VU, []), []);
  assert.equal(mock.calls.length, 1);
});

test('getRecipe defaults to the active version and passes an explicit version', async () => {
  const cfg = testConfig();
  const recipe = {id: 'recipe_a', name: '方法', active_version_id: 'version_2', selected_version: {id: 'version_2', number: 2, content: {name: '方法', description: '适用场景：BP', instructions: '一、准备'}}};
  mock = installFetch([{method: 'GET', url: 'https://rsi.test/api/recipes/recipe_a', reply: () => recipe}]);
  assert.deepEqual(await getRecipe(cfg, 'oauth-token', VU, 'recipe_a'), recipe);
  assert.equal(mock.calls[0].url, 'https://rsi.test/api/recipes/recipe_a?version=active');
  await getRecipe(cfg, 'oauth-token', VU, 'recipe_a', 'version_2');
  assert.equal(mock.calls[1].url, 'https://rsi.test/api/recipes/recipe_a?version=version_2');
});

test('getRecipe rejects a recipe without selected_version content', async () => {
  const cfg = testConfig();
  mock = installFetch([{method: 'GET', url: 'https://rsi.test/api/recipes/recipe_a', reply: () => ({id: 'recipe_a', selected_version: null})}]);
  await assert.rejects(getRecipe(cfg, 'oauth-token', VU, 'recipe_a'), serviceError('rsi', 502, 'invalid_response'));
});

test('recipeMarkdown matches the SDK RECIPE.md writer', () => {
  assert.equal(
    recipeMarkdown({name: '早期硬科技 BP 投资建议书', description: '适用场景："BP"', instructions: '一、准备\n1. 拆解'}),
    '---\nname: "早期硬科技 BP 投资建议书"\ndescription: "适用场景：\\"BP\\""\n---\n\n一、准备\n1. 拆解\n',
  );
  assert.equal(recipeMarkdown({name: 'n', description: 'd', instructions: ''}), '---\nname: "n"\ndescription: "d"\n---\n');
  assert.equal(recipeMarkdown({name: 'n', description: 'd', instructions: 'x\n'}), '---\nname: "n"\ndescription: "d"\n---\n\nx\n');
});

test('toUpload keeps valid UTF-8 as text and base64-encodes anything else', () => {
  assert.deepEqual(toUpload('a.md', new TextEncoder().encode('# 锂境科技')), {name: 'a.md', content: '# 锂境科技', encoding: 'utf-8'});
  assert.deepEqual(toUpload('a.md', '# text'), {name: 'a.md', content: '# text', encoding: 'utf-8'});
  assert.deepEqual(toUpload('b.bin', new Uint8Array([0xff, 0xfe, 0x00])), {name: 'b.bin', content: '//4A', encoding: 'base64'});
  const big = new Uint8Array(0x8000 * 2 + 5);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 7 + 0x80) & 0xff;
  const out = toUpload('big.pdf', big);
  assert.equal(out.encoding, 'base64');
  assert.equal(out.content, Buffer.from(big).toString('base64'));
});
