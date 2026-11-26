import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installFetch, testConfig} from './helpers/fake-services.mjs';
import {ServiceError} from '../server/demo/http.mjs';
import {kvGetJson, kvPutJson} from '../server/demo/kv.mjs';
import {fileKvKey, getRun, newRun, runKey, withRefreshError} from '../server/demo/runs.mjs';
import {recipeMarkdown} from '../server/demo/services/rsi.mjs';
import {
  MAX_ATTEMPTS, METHOD_CONTEXT, RULES_PROMPT, fallbackRules, methodContext, parseRules, rulesPrompt, refreshMethod, rulesLockKey, setMethodFile,
  startMethod, summarizeRules,
} from '../server/demo/investor/method-step.mjs';
import {addScrubTerms} from '../server/demo/scrub.mjs';

// The names a deployment would list in DEMO_PRIVATE_NAMES.
addScrubTerms(['acme', 'globex']);

const session = {accessToken: 'tok', accountId: 'acct_test'};
const VU = 'vu_0123456789abcdef0123456789abcdef';
const RUN_ID = 'run_BBBBBBBBBBBBBBBB';
const enc = text => new TextEncoder().encode(text);
const failsWith = (status, code) => err => err instanceof ServiceError && err.status === status && err.code === code;
const RECIPE_CONTENT = {
  name: '早期硬科技 BP 投资建议书写法',
  description: '适用场景：早期硬科技项目的投资建议书',
  instructions: '一、准备\n1. 先核对 BP 里的量产良率\n2. 找独立专家交叉验证关键指标\n3. 找共事过的人做创始人背调\n4. 最关键的数据放在首要追问',
};
const FILES = [
  ['A', 'bp', '项目A 衡石动力 BP.md', '# 衡石动力 BP\n固态电池，良率 85%'],
  ['A', 'proposal', '项目A 衡石动力 投资建议书.md', '# 投资建议书\n建议投资'],
  ['B', 'bp', '项目B 微澜光电 BP.md', '# 微澜光电 BP\n硅光芯片'],
  ['B', 'proposal', '项目B 微澜光电 投资建议书.md', '# 投资建议书\n不投'],
];
const RULES_REPLY = '<think>先想一想 [不是这个]</think>\n["良率先核实","专家要独立","背调找共事过的人","最关键的数据先追问"]';
const FAILED = {status: 'failed', stage: 'failed', progress_percent: 40, error: {code: 'invalid_model_output', stage: 'test', type: 'ModelOutputError'}};

function chatReply(content) {
  return {id: 'chatcmpl-1', object: 'chat.completion', model: 'test-model',
    choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}]};
}

async function seedRun(cfg) {
  const run = newRun({id: RUN_ID, vuId: VU, vuName: 'CoSens 演示 · 投资人 · 11-20 14:30', now: 1000});
  await kvPutJson(cfg.kv, runKey(session.accountId, RUN_ID), run);
  return run;
}

async function seedProjects(cfg) {
  let run = await seedRun(cfg);
  for (const [slot, role, name, text] of FILES) {
    run = await setMethodFile(cfg, session, run, {group: 'method', slot, role, name, bytes: enc(text)});
  }
  return run;
}

function rsiStack({llm = [chatReply(RULES_REPLY)], createErrors = {}, activeVersion = 'version_2', createStatus = {}} = {}) {
  const s = {created: [], execs: new Map(), llmBodies: [], getError: null, recipeError: null};
  let llmCalls = 0;
  s.fetch = installFetch([
    {method: 'POST', url: 'https://rsi.test/api/executions', reply: async req => {
      const body = JSON.parse(await req.text());
      s.created.push({body, key: body.idempotency_key ?? req.headers.get('idempotency-key')});
      const n = s.created.length;
      if (createErrors[n]) return createErrors[n]();
      // RSI adds a version only to a Recipe that has an available (active) version; else it refuses the recipe_id.
      if (!activeVersion && body.files?.some(file => file.role === 'recipe' && file.recipe_id)) {
        return Response.json({error: {code: 'invalid_state', message: 'base Recipe has no available version'}}, {status: 409});
      }
      const exec = {id: `execution_${n}`, status: 'queued', stage: 'queued', progress_percent: 0, recipe_id: 'recipe_1',
        recipe_version_id: null, test_results: [], error: null, ...(createStatus[n] || {})};
      s.execs.set(exec.id, exec);
      return exec;
    }},
    {method: 'GET', url: /^https:\/\/rsi\.test\/api\/executions\/execution_\d+$/, reply: (req, url) => {
      if (s.getError) return s.getError();
      const exec = s.execs.get(url.pathname.split('/').pop());
      return exec || Response.json({error: {code: 'not_found', message: 'execution not found'}}, {status: 404});
    }},
    // Shapes as RSI returns them: list rows carry the Recipe's own `id`; an unqualified Recipe has no
    // active version, so ?version=active selects nothing while the produced version is still readable.
    {method: 'GET', url: /^https:\/\/rsi\.test\/api\/recipes\?/, reply: () => s.recipeError?.() || [{id: 'recipe_1', execution_ids: ['execution_1'],
      name: RECIPE_CONTENT.name, latest_version_id: 'version_2', active_version_id: activeVersion}]},
    {method: 'GET', url: /^https:\/\/rsi\.test\/api\/recipes\/recipe_1(\?|$)/, reply: (req, url) => {
      if (s.recipeError) return s.recipeError();
      const wanted = url.searchParams.get('version') || 'active';
      const id = wanted === 'active' ? activeVersion : wanted === 'latest' ? 'version_2' : wanted;
      return {id: 'recipe_1', name: RECIPE_CONTENT.name, latest_version_id: 'version_2', active_version_id: activeVersion,
        selected_version: id === 'version_2' ? {id: 'version_2', object_id: 'recipe_1', number: 2, content: RECIPE_CONTENT, archived: false} : null};
    }},
    {method: 'POST', url: 'https://llm.test/v1/chat/completions', reply: async req => {
      s.llmBodies.push(JSON.parse(await req.text()));
      const next = llm[Math.min(llmCalls, llm.length - 1)];
      llmCalls += 1;
      return typeof next === 'function' ? next() : next;
    }},
  ]);
  s.exec = (id, fields) => Object.assign(s.execs.get(id), fields);
  return s;
}

async function learnA(cfg, s) {
  let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
  s.exec('execution_1', {status: 'completed', stage: 'done', progress_percent: 100, test_results: [{score: 0.9857, status: 'passed'}]});
  run = await refreshMethod(cfg, session, run, {now: () => 3000});
  return run;
}

test('setMethodFile stores project files and names the project from the BP', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    const run = await seedProjects(cfg);
    assert.equal(s.fetch.calls.length, 0);
    const [a, b] = run.method.projects;
    assert.deepEqual([a.title, a.bp, a.proposal], ['项目A 衡石动力', {fileKey: 'method-A-bp', name: '项目A 衡石动力 BP.md'},
      {fileKey: 'method-A-proposal', name: '项目A 衡石动力 投资建议书.md'}]);
    assert.equal(b.title, '项目B 微澜光电');
    const stored = await kvGetJson(cfg.kv, fileKvKey(session.accountId, RUN_ID, 'method-B-proposal'));
    assert.deepEqual(stored, {name: '项目B 微澜光电 投资建议书.md', mime: 'text/markdown; charset=utf-8', encoding: 'utf-8', content: FILES[3][3]});
    assert.equal(run.method.startedAt, null);
  } finally {
    s.fetch.restore();
  }
});

test('setMethodFile validates slot, role, kind and size, and stores the new BP for step 3', async () => {
  const cfg = testConfig();
  let run = await seedRun(cfg);
  await assert.rejects(setMethodFile(cfg, session, run, {group: 'method', role: 'bp', name: 'x.md', bytes: enc('x')}), failsWith(400, 'invalid_method_file'));
  await assert.rejects(setMethodFile(cfg, session, run, {group: 'method', slot: 'A', role: 'deck', name: 'x.md', bytes: enc('x')}), failsWith(400, 'invalid_method_file'));
  await assert.rejects(setMethodFile(cfg, session, run, {group: 'method', slot: 'A', role: 'bp', name: 'x.pptx', bytes: enc('x')}), failsWith(415, 'unsupported_file'));
  await assert.rejects(setMethodFile(cfg, session, run, {group: 'method', slot: 'A', role: 'bp', name: 'big.md',
    bytes: new Uint8Array(4 * 1024 * 1024 + 1).fill(0x61)}), failsWith(413, 'file_too_large'));
  await assert.rejects(setMethodFile(cfg, session, run, {group: 'bp', name: '锂境科技 BP.pdf', bytes: enc('x')}), failsWith(415, 'unsupported_file'));
  await assert.rejects(setMethodFile(cfg, session, run, {group: 'memory', name: 'a.md', bytes: enc('x')}), failsWith(400, 'invalid_group'));
  run = await setMethodFile(cfg, session, run, {group: 'bp', name: '锂境科技 BP.md', bytes: enc('# 锂境科技 BP')});
  assert.deepEqual(run.bp, {fileKey: 'bp', name: '锂境科技 BP.md'});
  assert.equal((await kvGetJson(cfg.kv, fileKvKey(session.accountId, RUN_ID, 'bp'))).content, '# 锂境科技 BP');
  run = await setMethodFile(cfg, session, run, {group: 'method', slot: 'B', role: 'proposal', name: '决策.pdf', bytes: new Uint8Array([0x25, 0xff])});
  assert.equal((await kvGetJson(cfg.kv, fileKvKey(session.accountId, RUN_ID, 'method-B-proposal'))).encoding, 'base64');
  assert.equal(run.method.projects[1].title, '决策');
});

test('startMethod refuses until both projects have a BP and a proposal', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    let run = await seedRun(cfg);
    run = await setMethodFile(cfg, session, run, {group: 'method', slot: 'A', role: 'bp', name: FILES[0][2], bytes: enc(FILES[0][3])});
    run = await setMethodFile(cfg, session, run, {group: 'method', slot: 'A', role: 'proposal', name: FILES[1][2], bytes: enc(FILES[1][3])});
    await assert.rejects(startMethod(cfg, session, run), failsWith(409, 'step_not_ready'));
    assert.equal(s.fetch.calls.length, 0);
  } finally {
    s.fetch.restore();
  }
});

test('startMethod creates project A with the generic context and the input and artifact files', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    const run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    assert.equal(s.created.length, 1);
    const {body, key} = s.created[0];
    assert.equal(body.context.name, 'method-context.md');
    assert.equal(body.context.content, methodContext('en'));
    assert.equal(/[\u3000-\u9fff]/.test(body.context.content), false, 'the default context is English');
    for (const text of Object.values(METHOD_CONTEXT)) assert.doesNotMatch(text, /周明远|远川|新能源材料|Zhou Mingyuan/);
    assert.deepEqual(body.files.map(file => [file.name, file.role, file.encoding, file.content]), [
      [FILES[0][2], 'input', 'utf-8', FILES[0][3]], [FILES[1][2], 'artifact', 'utf-8', FILES[1][3]]]);
    assert.match(key, new RegExp(`^demo-${VU}-method-[0-9a-f]{16}-1$`));
    const a = run.method.projects[0];
    assert.deepEqual([a.executionId, a.attempt, a.status, a.stage, a.progress, a.error], ['execution_1', 1, 'queued', 'queued', 0, null]);
    assert.equal(run.method.projects[1].status, 'idle');
    assert.equal(run.method.startedAt, 2000);
    const again = await startMethod(cfg, session, run, {now: () => 2500});
    assert.equal(again.version, run.version);
    assert.equal(s.created.length, 1);
    await assert.rejects(setMethodFile(cfg, session, run, {group: 'method', slot: 'B', role: 'bp', name: 'new.md', bytes: enc('x')}),
      failsWith(409, 'step_not_ready'));
  } finally {
    s.fetch.restore();
  }
});

test('refreshMethod copies stage and progress and skips the write when nothing changed', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    s.exec('execution_1', {status: 'running', stage: 'generate', progress_percent: 25});
    run = await refreshMethod(cfg, session, run, {now: () => 3000});
    const a = run.method.projects[0];
    assert.deepEqual([a.status, a.stage, a.progress], ['running', 'generate', 25]);
    const same = await refreshMethod(cfg, session, run, {now: () => 4000});
    assert.equal(same.version, run.version);
  } finally {
    s.fetch.restore();
  }
});

test('refreshMethod starts B with A\'s Recipe file once A completes', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    const run = await learnA(cfg, s);
    assert.equal(s.created.length, 2);
    const {body, key} = s.created[1];
    assert.deepEqual(body.files.map(file => [file.name, file.role]), [[FILES[2][2], 'input'], [FILES[3][2], 'artifact'], ['RECIPE.md', 'recipe']]);
    const recipeFile = body.files[2];
    assert.equal(recipeFile.recipe_id, 'recipe_1');
    assert.equal(recipeFile.encoding, 'utf-8');
    assert.equal(recipeFile.content, recipeMarkdown(RECIPE_CONTENT));
    assert.ok(recipeFile.content.startsWith(`---\nname: ${JSON.stringify(RECIPE_CONTENT.name)}\n`));
    assert.match(key, /-1$/);
    assert.notEqual(key, s.created[0].key);
    assert.ok(s.fetch.calls.some(call => call.url.includes('recipe_ids=recipe_1')));
    assert.ok(s.fetch.calls.some(call => call.url.includes('/recipes/recipe_1') && call.url.includes('version=version_2')));
    const [a, b] = run.method.projects;
    assert.deepEqual([a.status, a.progress, a.error], ['completed', 100, null]);
    assert.deepEqual([b.executionId, b.attempt, b.status], ['execution_2', 1, 'queued']);
    assert.equal(run.method.recipe, null);
  } finally {
    s.fetch.restore();
  }
});

test('English file names title the project and fill its slot', async () => {
  const cfg = testConfig();
  let run = await seedRun(cfg);
  run = await setMethodFile(cfg, session, run, {group: 'method', slot: 'A', role: 'bp', name: 'Project A Orbit Energy BP.md', bytes: enc('# Orbit Energy')});
  assert.equal(run.method.projects[0].title, 'Project A Orbit Energy');
  run = await setMethodFile(cfg, session, run, {group: 'method', slot: 'B', role: 'bp', name: 'BP.md', bytes: enc('# x')});
  assert.equal(run.method.projects[1].title, '', 'no name left: the page shows "Project B"');
});

test('refreshMethod retries a failed execution with a new key, stops after 3 attempts, and 重试 starts again', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      s.exec(`execution_${attempt}`, FAILED);
      run = await refreshMethod(cfg, session, run, {now: () => 3000 + attempt});
      assert.equal(s.created.length, attempt + 1);
      assert.match(s.created[attempt].key, new RegExp(`-${attempt + 1}$`));
      assert.deepEqual([run.method.projects[0].attempt, run.method.projects[0].status], [attempt + 1, 'queued']);
    }
    assert.equal(new Set(s.created.map(call => call.key)).size, 3);
    s.exec('execution_3', FAILED);
    run = await refreshMethod(cfg, session, run, {now: () => 5000});
    assert.equal(s.created.length, 3);
    assert.equal(run.method.projects[0].status, 'failed');
    // RSI's own failure record (code and stage) is passed through to the page.
    assert.equal(run.method.projects[0].error, 'RSI execution execution_3 failed at test: invalid_model_output');
    assert.match(run.method.error, /^Project A was tried 3 times without finishing/);
    const stopped = await refreshMethod(cfg, session, run, {now: () => 6000});
    assert.equal(stopped.version, run.version);
    assert.equal(s.created.length, 3);
    run = await startMethod(cfg, session, run, {now: () => 7000});
    assert.equal(s.created.length, 4);
    assert.match(s.created[3].key, /-4$/);
    assert.equal(run.method.error, null);
    assert.deepEqual([run.method.projects[0].attempt, run.method.projects[0].status, run.method.projects[0].executionId], [4, 'queued', 'execution_4']);
  } finally {
    s.fetch.restore();
  }
});

test('refreshMethod builds the Recipe view, self-test score and rules when B completes', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    let run = await learnA(cfg, s);
    s.exec('execution_2', {status: 'completed', stage: 'done', progress_percent: 100, recipe_id: 'recipe_1',
      test_results: [{score: 0.5, status: 'failed'}, {score: 0.975, status: 'passed'}]});
    run = await refreshMethod(cfg, session, run, {now: () => 9000});
    assert.deepEqual(run.method.recipe, {recipeId: 'recipe_1', versionId: 'version_2', number: 2, name: RECIPE_CONTENT.name,
      description: RECIPE_CONTENT.description, instructions: RECIPE_CONTENT.instructions, selfTest: 98,
      rules: ['良率先核实', '专家要独立', '背调找共事过的人', '最关键的数据先追问']});
    assert.equal(run.method.completedAt, 9000);
    assert.equal(run.method.error, null);
    assert.deepEqual([run.method.projects[1].status, run.method.projects[1].progress], ['completed', 100]);
    assert.equal(s.llmBodies.length, 1);
    assert.equal(s.llmBodies[0].messages[0].content, rulesPrompt('en') + RECIPE_CONTENT.instructions);
    assert.equal(s.llmBodies[0].max_tokens, 16000);
    assert.equal(await kvGetJson(cfg.kv, rulesLockKey(session.accountId, RUN_ID)), null);
    const callsBefore = s.fetch.calls.length;
    const done = await refreshMethod(cfg, session, run, {now: () => 9500});
    assert.equal(done.version, run.version);
    assert.equal(s.fetch.calls.length, callsBefore);
    const startedAgain = await startMethod(cfg, session, run, {now: () => 9600});
    assert.equal(startedAgain.version, run.version);
    assert.equal(s.created.length, 2);
  } finally {
    s.fetch.restore();
  }
});

test('refreshMethod waits while another request is summarising the rules', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    let run = await learnA(cfg, s);
    s.exec('execution_2', {status: 'completed', stage: 'done', progress_percent: 100, test_results: [{score: 0.9, status: 'passed'}]});
    await kvPutJson(cfg.kv, rulesLockKey(session.accountId, RUN_ID), {at: 1}, {ttl: 300});
    const waiting = await refreshMethod(cfg, session, run, {now: () => 9000});
    assert.equal(waiting.version, run.version);
    assert.equal(waiting.method.recipe, null);
    assert.equal(s.llmBodies.length, 0);
  } finally {
    s.fetch.restore();
  }
});

test('refreshMethod stops with the service reason when B cannot be created', async () => {
  const cfg = testConfig();
  const s = rsiStack({createErrors: {2: () => Response.json({error: {code: 'invalid_request',
    message: 'bad file at https://rsi-internal.svc/upload via globex, Bearer abc.def'}}, {status: 422})}});
  try {
    let run = await learnA(cfg, s);
    assert.equal(run.method.projects[0].status, 'completed');
    assert.equal(run.method.projects[1].status, 'failed');
    assert.match(run.method.error, /^Project B did not start learning/);
    for (const text of [run.method.error, run.method.projects[1].error]) {
      assert.match(text, /RSI 422 invalid_request: bad file at \[url\] via \[private\], Bearer \[redacted\]/);
      assert.doesNotMatch(text, /https?:|globex|abc\.def/i);
    }
    const stopped = await refreshMethod(cfg, session, run, {now: () => 4000});
    assert.equal(stopped.version, run.version);
    assert.equal(s.created.length, 2);
    run = await startMethod(cfg, session, run, {now: () => 5000});
    assert.equal(s.created.length, 3);
    assert.equal(s.created[2].body.files[2].role, 'recipe');
    assert.deepEqual([run.method.projects[1].status, run.method.projects[1].attempt, run.method.error], ['queued', 2, null]);
  } finally {
    s.fetch.restore();
  }
});

test('an execution failure stores scrubbed error text', async t => {
  const cfg = testConfig();
  const s = rsiStack();
  const logged = [];
  t.mock.method(console, 'warn', (...args) => logged.push(args.join(' ')));
  try {
    let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    s.exec('execution_1', {status: 'failed', stage: 'failed', progress_percent: 10,
      error: {message: 'Acme gateway at http://10.0.0.5:8080/v1 refused eyJhbGciOi.eyJzdWIi.sig', stage: 'test'}});
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) s.exec(`execution_${attempt}`, {status: 'failed', error: {message: 'Acme gateway at http://10.0.0.5:8080/v1 refused'}});
      run = await refreshMethod(cfg, session, run, {now: () => 3000 + attempt});
    }
    const stored = await getRun(cfg, session.accountId, RUN_ID);
    assert.equal(stored.method.error, 'Project A was tried 3 times without finishing: RSI execution execution_3 failed: [private] gateway at [url] refused');
    // The operator log keeps RSI's own record, scrubbed of URLs, tokens and internal names.
    assert.ok(logged.length >= 3 && logged.every(line => line.startsWith('demo: RSI execution failed')), logged.join('\n'));
    assert.match(logged[0], /"stage":"test"/);
    assert.match(logged[0], /\[private\] gateway at \[url\] refused \[token\]/);
    for (const line of logged) assert.doesNotMatch(line, /https?:|acme|10\.0\.0\.5|eyJ/i);
    for (const text of [stored.method.error, stored.method.projects[0].error]) {
      assert.doesNotMatch(text, /https?:|acme|10\.0\.0\.5|eyJ/i);
    }
  } finally {
    s.fetch.restore();
  }
});

test('a transient RSI failure while retrying or starting B does not use up an attempt', async () => {
  const cfg = testConfig();
  const down = () => new Response('bad gateway', {status: 503});
  const s = rsiStack({createErrors: {2: down, 3: down, 4: down}});
  try {
    let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    s.exec('execution_1', FAILED);
    for (let poll = 0; poll < 3; poll += 1) {
      const before = JSON.stringify(await getRun(cfg, session.accountId, RUN_ID));
      const seen = await refreshMethod(cfg, session, run, {now: () => 3000 + poll});
      assert.equal(seen.refreshError.service, 'rsi');
      assert.equal(seen.method.error, null);
      assert.equal(seen.method.projects[0].attempt, 1);
      if (poll > 0) assert.equal(JSON.stringify(await getRun(cfg, session.accountId, RUN_ID)), before);
      run = await getRun(cfg, session.accountId, RUN_ID);
    }
    run = await refreshMethod(cfg, session, run, {now: () => 4000});
    assert.equal(run.refreshError, undefined);
    assert.deepEqual([run.method.projects[0].attempt, run.method.projects[0].status, run.method.error], [2, 'queued', null]);
    assert.equal(s.created[1].key, s.created[4].key);
  } finally {
    s.fetch.restore();
  }
});

test('a transient Recipe read failure during the A to B handoff keeps A running and retries later', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    const before = JSON.stringify(await getRun(cfg, session.accountId, RUN_ID));
    s.recipeError = () => new Response('upstream down', {status: 502});
    s.exec('execution_1', {status: 'completed', stage: 'done', progress_percent: 100, test_results: [{score: 0.9, status: 'passed'}]});
    for (let poll = 0; poll < 3; poll += 1) {
      const seen = await refreshMethod(cfg, session, run, {now: () => 3000 + poll});
      assert.equal(seen.refreshError.service, 'rsi');
      assert.equal(seen.method.error, null);
      assert.equal(JSON.stringify(await getRun(cfg, session.accountId, RUN_ID)), before);
    }
    s.recipeError = null;
    run = await refreshMethod(cfg, session, await getRun(cfg, session.accountId, RUN_ID), {now: () => 4000});
    assert.equal(run.refreshError, undefined);
    assert.deepEqual([run.method.projects[0].status, run.method.projects[1].status, run.method.projects[1].attempt], ['completed', 'queued', 1]);
    assert.equal(s.created.length, 2);
  } finally {
    s.fetch.restore();
  }
});

test('refreshMethod keeps the last state on a transient RSI error and passes an expired login through', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    const run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    s.getError = () => new Response('upstream down', {status: 503});
    const same = await refreshMethod(cfg, session, run, {now: () => 3000});
    assert.equal(same.version, run.version);
    assert.equal(s.created.length, 1);
    s.getError = () => new Response('Unauthorized', {status: 401});
    await assert.rejects(refreshMethod(cfg, session, run, {now: () => 3500}), err => err.status === 401);
    s.getError = null;
    s.execs.delete('execution_1');
    const retried = await refreshMethod(cfg, session, run, {now: () => 4000});
    assert.equal(s.created.length, 2);
    assert.equal(retried.method.projects[0].attempt, 2);
  } finally {
    s.fetch.restore();
  }
});

test('RSI down during a poll reports refreshError rsi, keeps the stored run and carries a Memory error forward', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    const run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    const stored = JSON.stringify(await getRun(cfg, session.accountId, RUN_ID));
    s.getError = () => new Response('service unavailable', {status: 503});
    const down = await refreshMethod(cfg, session, run, {now: () => 3000});
    assert.equal(down.refreshError.service, 'rsi');
    assert.equal(typeof down.refreshError.code, 'string');
    assert.equal(down.version, run.version);
    assert.equal(JSON.stringify(await getRun(cfg, session.accountId, RUN_ID)), stored);
    s.getError = null;
    s.exec('execution_1', {status: 'running', stage: 'generate', progress_percent: 30});
    const memoryDown = withRefreshError(run, new ServiceError('memory', 503, 'http_503', 'busy'));
    const moved = await refreshMethod(cfg, session, memoryDown, {now: () => 4000});
    assert.equal(moved.method.projects[0].progress, 30);
    assert.deepEqual(moved.refreshError, {service: 'memory', code: 'http_503', message: 'busy'});
    const clean = await refreshMethod(cfg, session, await getRun(cfg, session.accountId, RUN_ID), {now: () => 5000});
    assert.equal(clean.refreshError, undefined);
  } finally {
    s.fetch.restore();
  }
});

test('refreshMethod does nothing before learning starts', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    const run = await seedProjects(cfg);
    assert.equal(await refreshMethod(cfg, session, run), run);
    assert.equal(s.fetch.calls.length, 0);
  } finally {
    s.fetch.restore();
  }
});

test('summarizeRules retries without a JSON array and falls back to the Recipe lines', async () => {
  const cfg = testConfig();
  let s = rsiStack({llm: [chatReply('好的，规矩如下：良率先核实。'), chatReply('<think>[x</think>还是没有'), chatReply('没有')]});
  try {
    assert.deepEqual(await summarizeRules(cfg, 'tok', RECIPE_CONTENT.instructions), fallbackRules(RECIPE_CONTENT.instructions));
    assert.equal(s.llmBodies.length, 3);
  } finally {
    s.fetch.restore();
  }
  s = rsiStack({llm: [() => Response.json({error: {code: 'gateway_model_busy', message: 'busy'}}, {status: 429})]});
  try {
    assert.deepEqual(await summarizeRules(cfg, 'tok', RECIPE_CONTENT.instructions), fallbackRules(RECIPE_CONTENT.instructions));
    assert.equal(s.llmBodies.length, 3);
  } finally {
    s.fetch.restore();
  }
  const fence = '`'.repeat(3);
  s = rsiStack({llm: [chatReply('无'), chatReply(`${fence}json\n["一", "二"]\n${fence}`)]});
  try {
    assert.deepEqual(await summarizeRules(cfg, 'tok', RECIPE_CONTENT.instructions), ['一', '二']);
    assert.equal(s.llmBodies.length, 2);
  } finally {
    s.fetch.restore();
  }
  assert.deepEqual(await summarizeRules(cfg, 'tok', '  '), []);
});

test('parseRules and fallbackRules', () => {
  assert.deepEqual(parseRules('<think>[不是]</think>["a", 3, " ", "b "]'), ['a', 'b']);
  assert.deepEqual(parseRules('["1","2","3","4","5","6","7"]'), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(parseRules('no json'), []);
  assert.deepEqual(parseRules('[1, 2'), []);
  assert.deepEqual(parseRules('{"rules": "x"}'), []);
  assert.deepEqual(parseRules(null), []);
  assert.deepEqual(fallbackRules(RECIPE_CONTENT.instructions),
    ['先核对 BP 里的量产良率', '找独立专家交叉验证关键指标', '找共事过的人做创始人背调', '最关键的数据放在首要追问']);
  assert.deepEqual(fallbackRules(`# 标题很长的一节\n- **${'很'.repeat(70)}**`), [`${'很'.repeat(59)}…`], 'a heading is not a rule');
  assert.deepEqual(fallbackRules('## 适用场景\n- 早期硬科技项目的 BP 尽调\n## 步骤：\n1. 先核对量产良率'), ['早期硬科技项目的 BP 尽调', '先核对量产良率']);
  assert.deepEqual(fallbackRules('## 适用场景\n## 尽调步骤'), ['适用场景', '尽调步骤'], 'headings only when nothing else is there');
});

test('an unqualified Recipe (no active version) still hands A\'s produced version to B and to the result', async () => {
  const cfg = testConfig();
  const s = rsiStack({activeVersion: null});
  try {
    let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000});
    s.exec('execution_1', {status: 'completed', stage: 'done', progress_percent: 100, recipe_version_id: 'version_2',
      test_results: [{score: 0.4, status: 'failed'}]});
    run = await refreshMethod(cfg, session, run, {now: () => 3000});
    assert.equal(s.created.length, 2, 'B starts even though no version is active');
    assert.equal(s.created[1].body.files[2].content, recipeMarkdown(RECIPE_CONTENT));
    // A Recipe without an available version cannot take a new version: B starts a new Recipe from A's text.
    assert.equal(s.created[1].body.files[2].role, 'recipe');
    assert.equal(s.created[1].body.files[2].recipe_id, undefined);
    assert.equal(run.method.projects[1].status, 'queued');
    assert.ok(s.fetch.calls.some(call => call.url.includes('/recipes/recipe_1') && call.url.includes('version=version_2')));
    assert.ok(!s.fetch.calls.some(call => call.url.includes('version=active')), 'never asks for the active version');
    assert.equal(run.method.refreshError ?? null, null);
    s.exec('execution_2', {status: 'completed', stage: 'done', progress_percent: 100, recipe_version_id: 'version_2',
      test_results: [{score: 0.5, status: 'failed'}]});
    run = await refreshMethod(cfg, session, run, {now: () => 4000});
    assert.equal(run.method.recipe?.versionId, 'version_2');
    assert.equal(run.method.error, null);
  } finally {
    s.fetch.restore();
  }
});

test('without recipe_version_id the Recipe is read at the list row\'s latest version when none is active', async () => {
  const cfg = testConfig();
  const s = rsiStack({activeVersion: null});
  try {
    const run = await learnA(cfg, s);
    assert.equal(s.created.length, 2);
    assert.ok(s.fetch.calls.some(call => call.url.includes('recipe_ids=recipe_1')));
    assert.ok(s.fetch.calls.some(call => call.url.includes('/recipes/recipe_1') && call.url.includes('version=version_2')));
    assert.equal(run.method.projects[1].status, 'queued');
  } finally {
    s.fetch.restore();
  }
});

test('the method context asks RSI to write the learned method in the language of the page', () => {
  // One live run came back with an English Recipe name, description and body on a Chinese page.
  assert.match(METHOD_CONTEXT.zh, /一律用中文书写/);
  assert.match(METHOD_CONTEXT.en, /in English\.\n$/);
  assert.equal(methodContext('zh'), METHOD_CONTEXT.zh);
  assert.equal(methodContext('en'), METHOD_CONTEXT.en);
  assert.equal(methodContext('fr'), METHOD_CONTEXT.en);
  assert.equal(methodContext(), METHOD_CONTEXT.en);
  assert.match(RULES_PROMPT.en, /written in English/);
  assert.match(RULES_PROMPT.zh, /只输出 JSON 字符串数组/);
  assert.equal(rulesPrompt('zh'), RULES_PROMPT.zh);
});

test('with the Chinese locale learning is asked for in Chinese and failures are stored in Chinese', async () => {
  const cfg = testConfig();
  const s = rsiStack();
  try {
    let run = await startMethod(cfg, session, await seedProjects(cfg), {now: () => 2000, locale: 'zh'});
    assert.equal(s.created[0].body.context.content, METHOD_CONTEXT.zh);
    s.exec('execution_1', {status: 'failed', stage: 'failed', progress_percent: 10, error: {message: 'refused', stage: 'test'}});
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) s.exec(`execution_${attempt}`, {status: 'failed', error: {message: 'refused'}});
      run = await refreshMethod(cfg, session, run, {now: () => 3000 + attempt, locale: 'zh'});
    }
    // The surrounding text follows the language; RSI's own record is passed through as it is.
    assert.equal(run.method.error, '项目 A 学了 3 次都没有完成：RSI execution execution_3 failed: refused');
    assert.deepEqual(await Promise.all([1, 2].map(() => startMethod(cfg, session, {...run, method: {...run.method, projects: [{...run.method.projects[0], bp: null}, run.method.projects[1]]}}, {locale: 'zh'}).catch(err => err.text('zh')))),
      ['项目 A还缺 BP 或投资建议书', '项目 A还缺 BP 或投资建议书']);
  } finally {
    s.fetch.restore();
  }
});

test('a project B that the idempotent submission already returns as completed is still finalized', async () => {
  // E.g. B's first submission succeeded but saving the run failed: the retry gets the finished execution back.
  const cfg = testConfig();
  const done = {status: 'completed', stage: 'done', progress_percent: 100, recipe_version_id: 'version_2', test_results: [{score: 0.9, status: 'passed'}]};
  const s = rsiStack({createStatus: {2: done}});
  try {
    let run = await learnA(cfg, s);
    assert.equal(run.method.projects[1].status, 'completed', 'launch stores the completed status');
    assert.equal(run.method.recipe, null);
    run = await refreshMethod(cfg, session, run, {now: () => 4000});
    assert.equal(run.method.recipe?.versionId, 'version_2', 'the next poll finalizes it');
    assert.ok(run.method.completedAt);
    assert.equal(run.method.error, null);
  } finally {
    s.fetch.restore();
  }
});
