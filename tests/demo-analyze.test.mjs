import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installFetch, openAiChunks, sseReply, testConfig} from './helpers/fake-services.mjs';
import {kvGetJson, kvPutJson} from '../server/demo/kv.mjs';
import {ServiceError} from '../server/demo/http.mjs';
import {
 AnalysisError, MAX_ROUNDS, MIN_SEARCHES, RECALL_TOKEN_BUDGET, ReportError, TIMEOUT_MS,
 analysisKey, analyze, bpTitleOf, checkSources, cleanQuery, errorEvent, parseReport, queryOf, titlesOf, validateReport,
} from '../server/demo/investor/analyze.mjs';
import {finalPrompt, nudgePrompt, systemPrompt, toolsFor, userPrompt} from '../server/demo/investor/prompts.mjs';
import {addScrubTerms} from '../server/demo/scrub.mjs';

// The names a deployment would list in DEMO_PRIVATE_NAMES.
addScrubTerms(['acme', 'globex']);

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
const FINAL_PROMPT = finalPrompt('en');
const TOOLS = toolsFor('en');

const ACCOUNT = 'acct_test';
const VU = 'vu_0123456789abcdef0123456789abcdef';
const LLM_URL = 'https://llm.test/v1/chat/completions';
const RECALL_URL = 'https://memory.test/memory/recall';
const BP = {name: '锂境科技 BP.md', text: '# 锂境科技\n\n创始人陈立，曾任蓝岸新能源研发经理。中试良率 90%。天使轮由青禾天使领投。'};
const BP_TITLE = '锂境科技 BP';
const RECIPE = '## 方法\n\n1. 关键指标必须找两位独立专家交叉验证。\n2. 创始人背调至少找三位共事过的人。';
const MATERIALS = '2026-03-14 腾讯会议纪要 储能材料行业交流';
const ITEMS = {
 materials: {id: 'ep-materials', kind: 'episode', text: `资料：${MATERIALS}\n\n赵一凡：硫化物电解质吨级批次良率普遍在 60% 左右。`, score: 0.83},
 contacts: {id: 'ep-contacts', kind: 'episode', text: '资料：微信联系人\n\n刘静，前蓝岸新能源研发总监。', score: 0.7},
};
const SIX = [
 '谁是硫化物固态电解质方面的技术专家？',
 '硫化物电解质中试良率的行业口径一般是多少？',
 '谁在蓝岸新能源和陈立共事过？',
 '陈立在华川大学的同学或校友有谁？',
 '青禾天使投过哪些项目，谁认识他们的合伙人？',
 '谁了解松果创投和锂境科技的关系？',
];
const REPORT = {
 verdict: {title: '暂不投：90% 良率口径未证实', text: 'BP 称中试良率 90%，行业交流里吨级批次约 60%。'},
 top_question: {title: '90% 良率是什么批次口径？', text: '对比行业 60% 口径，请创始人给出批次数据。', sources: ['锂境科技BP', `${MATERIALS}.md`]},
 experts: [{name: '赵一凡', independent: true, role: '华川大学材料学院教授 · 1 度', why: '做过硫化物电解质量产评估', sources: [MATERIALS, '项目A 衡石动力 BP']}],
 expert_gap: '还差 1 位独立专家，可请赵一凡介绍。',
 people: [{name: '刘静', degree: '1 度', relation: '共事过', path: '您 → 刘静 → 创始人', why: '与创始人同公司任职重叠', sources: ['微信联系人', '2026-05-01 内部笔记 不存在的纪要']}],
 people_gap: '共事过的人还差 2 位，可请刘静介绍。',
};
const ORIGINAL_SYSTEM = `你是远川资本合伙人周明远的投资助手。周明远交给你一份新 BP，你要严格按「投资方法」分析它，并从周明远自己的记忆（他的微信联系人、会议纪要、聊天记录和笔记）里找出能帮他验证的人。

做法：
1. 先读 BP 和投资方法，弄清要验证什么：关键技术和指标、创始人经历（学校、前雇主、时间）、过往融资方。
2. 用 memory_recall 工具在周明远的记忆里查，只查一轮：一次性并行发出 6 个调用，每个只问一个具体问题，用完整的自然语言问句（不要堆砌关键词），并写出 BP 里的具体名字（人名、公司名、学校和年级、投资机构名），覆盖：这项技术的专家、关键指标的行业口径、创始人前雇主的人、创始人的同学校友、过往融资方、BP 里提到的其他公司或人。拿到结果后直接输出报告，不要逐条反复复核，简短思考即可。
3. 只用 BP 和记忆里查到的事实。记忆中每份资料的开头写着「资料：<标题>」，引用出处时用这个标题；BP 的出处写「锂境科技 BP」。不要编造人、机构或数字。
4. 判断规则：在周明远联系人或资料里直接出现、和他直接打过交道的人是「1 度」；需要通过 1 度的人才能联系到的是「2 度」。和创始人在同一家公司任职时间重叠、或由创始人推荐的专家，一律不算独立（independent=false）；只是同校、同院系或校友，不影响独立性（independent 仍为 true）。同学、校友只作背调补充，但也要列入 people（relation 写校友）；投资过这家公司或创始人的人同样列入 people（relation 写投资过）。experts 只放技术专家；共事过的人放在 people。记忆里查到的每一位这类人都要列出，不要省略。BP 公司自己的团队成员（创始人、CTO、COO 等）不能作背调对象，不要列入 people。path 只能写记忆里有依据的联系路径，不要推测。
5. 方法要求的人数不够时，在 gap 里说明还差几位、可以请谁介绍。

最后只输出一个 JSON 对象，不要输出其他文字；每个 why 和 text 字段不超过 60 字。字段如下：
{
  "verdict": {"title": "一句话结论", "text": "两三句理由"},
  "top_question": {"title": "首要追问（问句）", "text": "BP 的说法和记忆中的口径对比，以及建议怎么问", "sources": ["出处标题"]},
  "experts": [{"name": "", "independent": true, "role": "身份 · 和周明远的关系", "why": "为什么找他、注意什么", "sources": ["出处标题"]}],
  "expert_gap": "独立专家还差几位、怎么补",
  "people": [{"name": "", "degree": "1 度 或 2 度", "relation": "和创始人的关系（共事过/投资过/校友等）", "path": "您 → … → 陈立", "why": "", "sources": ["出处标题"]}],
  "people_gap": "共事过的人还差几位、怎么补"
}`;

function makeRun() {
 const now = Date.now();
 return {
  id: 'run_analyze000000001', demo: 'investor', version: 1, vuId: VU, vuName: 'CoSens 演示 · 投资人 · 11-20 14:30', createdAt: now, updatedAt: now,
  memory: {files: [], stats: {people: 2, organizations: 1, relations: 3}, startedAt: now, completedAt: now},
  method: {
   projects: [],
   recipe: {recipeId: 'recipe_1', versionId: 'version_1', number: 2, name: '早期硬科技 BP 投资方法', description: '投资建议书写法', instructions: RECIPE, selfTest: 98, rules: ['关键指标找独立专家验证']},
   startedAt: now, completedAt: now, error: null,
  },
  bp: {fileKey: 'bp', name: BP.name}, lastAnalysisAt: null,
 };
}

async function seed(cfg) {
 const run = makeRun();
 await kvPutJson(cfg.kv, `run:${ACCOUNT}:${run.id}`, run);
 await kvPutJson(cfg.kv, `runs:${ACCOUNT}:investor`, [run.id]);
 return run;
}

const toolCall = (n, query) => ({id: `call_${n}`, name: 'memory_recall', arguments: JSON.stringify({query})});

function llmRoute(script) {
 let index = 0;
 return {method: 'POST', url: LLM_URL, reply: async req => {
  const step = script[index];
  index += 1;
  if (!step) throw new Error(`the model was called ${index} times but the script has ${script.length} replies`);
  return typeof step === 'function' ? step(req) : sseReply(openAiChunks(step));
 }};
}

function recallRoute(itemsFor = () => [ITEMS.materials, ITEMS.contacts]) {
 return {method: 'POST', url: RECALL_URL, reply: async req => {
  const body = await req.json();
  return {query: body.query, items: itemsFor(body.query), estimated_tokens: 120};
 }};
}

const finalText = report => `<think>先确认结构 {"draft": true}</think>\n报告如下：\n${JSON.stringify(report)}\n以上。`;
const llmBodies = fake => fake.calls.filter(call => call.url === LLM_URL).map(call => JSON.parse(call.body));

async function runAnalyze(cfg, run, extra = {}) {
 const events = [];
 const analysis = await analyze({cfg, token: 'tok', accountId: ACCOUNT, run, bp: BP, ...extra}, event => events.push(event));
 return {events, analysis};
}

test('step 3 keeps the agent.py limits', () => {
 assert.equal(MAX_ROUNDS, 2);
 assert.equal(MIN_SEARCHES, 4);
 assert.equal(TIMEOUT_MS, 300_000);
 assert.equal(RECALL_TOKEN_BUDGET, 2000);
});

test('the Chinese system prompt is agent.py SYSTEM with only the story names generalized', () => {
 const expected = ORIGINAL_SYSTEM
  .replace('你是远川资本合伙人周明远的投资助手。周明远交给你一份新 BP，你要严格按「投资方法」分析它，并从周明远自己的记忆（他的微信联系人、会议纪要、聊天记录和笔记）里找出能帮他验证的人。',
   '你是一位投资人的投资助手。投资人交给你一份新 BP，你要严格按「投资方法」分析它，并从投资人自己的记忆（他的联系人、会议纪要、聊天记录和笔记）里找出能帮他验证的人。报告直接写给投资人看，称他为「你」。')
  .replace('在周明远的记忆里查', '在投资人的记忆里查')
  .replace('BP 的出处写「锂境科技 BP」', 'BP 的出处写「星河储能 BP」')
  .replace('在周明远联系人或资料里', '在投资人的联系人或资料里')
  .replace('身份 · 和周明远的关系', '身份 · 和你的关系')
  .replace('您 → … → 陈立', '你 → … → 创始人');
 assert.equal(systemPrompt('星河储能 BP', 'zh'), expected);
 for (const name of ['周明远', '远川', '锂境', '陈立', '微信']) assert.equal(systemPrompt('星河储能 BP', 'zh').includes(name), false, name);
});

test('the English system prompt carries the same structure, names the BP source and has no Chinese', () => {
 const prompt = systemPrompt('Orbit Energy BP');
 assert.equal(prompt, systemPrompt('Orbit Energy BP', 'en'));
 assert.equal(CJK.test(prompt), false);
 assert.ok(prompt.includes('Every source in memory begins with "Source: <title>"'));
 assert.ok(prompt.includes('for the BP itself write "Orbit Energy BP"'));
 for (const field of ['"verdict"', '"top_question"', '"experts"', '"expert_gap"', '"people"', '"people_gap"', '"independent": true', '"degree"', 'memory_recall']) assert.ok(prompt.includes(field), field);
 assert.equal(prompt.split('\n').length, systemPrompt('Orbit Energy BP', 'zh').split('\n').length, 'same line structure as the Chinese prompt');
});

test('tool, user, nudge and final prompts exist in both languages', () => {
 assert.deepEqual(JSON.parse(JSON.stringify(TOOLS)), [{
  type: 'function',
  function: {
   name: 'memory_recall',
   description: 'Search the investor\'s memory. Returns the relevant source passages; every source begins with "Source: <title>".',
   parameters: {type: 'object', properties: {query: {type: 'string', description: 'One specific search question'}}, required: ['query']},
  },
 }]);
 assert.ok(Object.isFrozen(TOOLS[0].function.parameters));
 assert.deepEqual(JSON.parse(JSON.stringify(toolsFor('zh'))), [{
  type: 'function',
  function: {
   name: 'memory_recall',
   description: '在投资人的记忆中检索。返回相关资料片段，每份资料以「资料：<标题>」开头。',
   parameters: {type: 'object', properties: {query: {type: 'string', description: '一个具体的检索问题'}}, required: ['query']},
  },
 }]);
 assert.equal(userPrompt({recipeText: 'R', bpTitle: 'T', bpText: 'B'}), '## Investment method (the Recipe RSI learned from the investor\'s past projects)\n\nR\n\n## New BP: T\n\nB');
 assert.equal(userPrompt({recipeText: 'R', bpTitle: 'T', bpText: 'B'}, 'zh'), '## 投资方法（RSI 从投资人过往项目学到的 Recipe）\n\nR\n\n## 新 BP：T\n\nB');
 assert.equal(nudgePrompt(2), 'Only 2 questions were searched, which is not enough. Issue 4 more in parallel at once, covering the aspects not yet searched (technical experts, industry definitions, people from the founder\'s former employers, schoolmates and alumni, investment firms).');
 assert.ok(nudgePrompt(1).startsWith('Only 1 question was searched'));
 assert.equal(nudgePrompt(2, 'zh'), '只查了 2 个问题，不够。请再一次性并行补查 4 个，覆盖还没查到的方面（技术专家、行业口径、创始人前雇主的人、同学校友、投资机构）。');
 assert.equal(FINAL_PROMPT, 'The search ends here. Do not re-check item by item; after brief thinking, output the final JSON report directly; every why and text field at most 40 words.');
 assert.equal(finalPrompt('zh'), '检索到此为止。不要再逐条复核，简短思考后直接输出最终 JSON 报告；每个 why 和 text 字段不超过 60 字。');
 for (const text of [FINAL_PROMPT, nudgePrompt(3), userPrompt({recipeText: 'R', bpTitle: 'T', bpText: 'B'}), JSON.stringify(TOOLS)]) assert.equal(CJK.test(text), false);
});

test('helpers parse titles, queries, BP titles and reports like agent.py', () => {
 assert.deepEqual([...titlesOf([{text: '资料：甲\n\n正文 资料：乙 \n'}, {text: '没有标题'}, {text: '资料： \n'}, {}])], ['甲', '乙']);
 assert.deepEqual([...titlesOf([{text: 'Source: Fund weekly notes\n\nbody mentions Source: not a title'}, {text: 'no title here'}, {text: 'Source:  \n'}, {text: '资料：甲\n\nSource: 乙'}])], ['Fund weekly notes', '甲', '乙']);
 assert.equal(queryOf('{"query":" 谁是专家？ "}'), '谁是专家？');
 for (const bad of ['{}', 'not json', '{"query":5}', undefined, '']) assert.equal(queryOf(bad), '');
 assert.equal(bpTitleOf('锂境科技 BP.md'), '锂境科技 BP');
 assert.equal(bpTitleOf('plan.v2.txt'), 'plan.v2');
 assert.equal(bpTitleOf('BP'), 'BP');
 assert.equal(bpTitleOf('.md'), 'New BP');
 assert.equal(bpTitleOf('.md', 'zh'), '新 BP');
 assert.deepEqual(parseReport(`<think>{"x":1}</think>前言 ${JSON.stringify({a: 1, b: {c: 2}})} 结尾`), {a: 1, b: {c: 2}});
 for (const bad of ['没有 JSON', '{"a": 1,}', '', undefined, '<think>{"a":1}</think>']) assert.throws(() => parseReport(bad), ReportError);
});

test('validateReport rejects every partial report', () => {
 assert.equal(validateReport(REPORT), REPORT);
 const broken = [
  {...REPORT, verdict: undefined}, {...REPORT, verdict: {text: '没有标题'}}, {...REPORT, verdict: ['不投']},
  {...REPORT, top_question: {text: '没有问句'}}, {...REPORT, top_question: null},
  {...REPORT, experts: []}, {...REPORT, experts: undefined}, {...REPORT, people: []}, {...REPORT, people: ['刘静']},
  [REPORT], null, '报告',
 ];
 for (const report of broken) assert.throws(() => validateReport(report), ReportError);
});

test('checkSources flags sources memory never returned and accepts the BP itself', () => {
 const report = structuredClone(REPORT);
 report.people[0].sources.push({title: '微信联系人'}, '', '   ');
 checkSources(report, new Set([MATERIALS, '微信联系人']), BP_TITLE);
 assert.deepEqual(report.top_question.sources, [{title: '锂境科技BP', verified: true}, {title: MATERIALS, verified: true}]);
 assert.deepEqual(report.experts[0].sources, [{title: MATERIALS, verified: true}, {title: '项目A 衡石动力 BP', verified: false}]);
 assert.deepEqual(report.people[0].sources, [
  {title: '微信联系人', verified: true}, {title: '2026-05-01 内部笔记 不存在的纪要', verified: false}, {title: '微信联系人', verified: true},
 ]);
 const partial = checkSources({top_question: {title: 'q'}, experts: [{name: 'x'}], people: []}, new Set(['甲']), BP_TITLE);
 assert.deepEqual(partial.top_question.sources, []);
 assert.deepEqual(partial.experts[0].sources, []);
 const bySubstring = checkSources({experts: [{sources: ['储能材料行业交流', `${MATERIALS}（第 2 段）`]}]}, new Set([MATERIALS]), BP_TITLE);
 assert.deepEqual(bySubstring.experts[0].sources.map(s => s.verified), [true, true]);
});

test('errorEvent maps failures to the SSE error event', () => {
 assert.deepEqual(errorEvent(new AnalysisError('analysis_timeout', '超时')), {type: 'error', code: 'analysis_timeout', message: '超时'});
 assert.deepEqual(errorEvent(new AnalysisError('no_search', '没有检索', 'model')), {type: 'error', code: 'no_search', message: '没有检索', service: 'model'});
 assert.deepEqual(errorEvent(new ServiceError('memory', 401, 'INVALID_TOKEN', 'Token is invalid')),
  {type: 'error', code: 'not_authenticated', message: 'Your login has expired. Please sign in again and retry.', service: 'memory'});
 assert.equal(errorEvent(new ServiceError('memory', 401, 'INVALID_TOKEN', 'Token is invalid'), 'zh').message, '登录已过期，请重新登录后重试。');
 assert.deepEqual(errorEvent(new ServiceError('model', 429, 'account_concurrency_limit_exceeded', 'too many requests')),
  {type: 'error', code: 'account_concurrency_limit_exceeded', message: 'too many requests', service: 'model'});
 assert.equal(errorEvent(new ServiceError('model', 402, 'insufficient_balance', 'x'.repeat(500))).message.length, 300);
 assert.deepEqual(errorEvent(new TypeError('boom')), {type: 'error', code: 'internal_error', message: 'The analysis hit an error. Please retry.'});
 assert.equal(errorEvent(new TypeError('boom'), 'zh').message, '分析出错了，请重试。');
 assert.equal(errorEvent(new AnalysisError('no_search', 'err.no_search', 'model'), 'zh').message, '模型没有在记忆里检索就想直接写报告，这样的报告没有依据，已经拒绝。请重试。');
 assert.equal(CJK.test(errorEvent(new AnalysisError('report_invalid', 'err.report_invalid', 'model')).message), false);
 assert.equal(CJK.test(errorEvent(new AnalysisError('analysis_timeout', 'err.analysis_timeout')).message), false);
 assert.equal(CJK.test(errorEvent(new ServiceError('model', 502, 'x', 'err.invalid_response', {service: 'model'})).message), false);
});

test('errorEvent scrubs upstream text before it reaches the browser', () => {
 const event = errorEvent(new ServiceError('model', 500, 'provider_error', 'acme-llm upstream http://10.0.3.7:8000/v1 failed, Bearer sk-abc'));
 assert.deepEqual(event, {type: 'error', code: 'provider_error', message: '[private]-llm upstream [url] failed, Bearer [redacted]', service: 'model'});
});

test('analyze searches memory once, writes the report and saves it', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([llmRoute([{toolCalls: SIX.map((q, i) => toolCall(i, q))}, {content: finalText(REPORT), reasoning: '想一想'}]), recallRoute()]);
 try {
  const {events, analysis} = await runAnalyze(cfg, run);
  assert.deepEqual(events.map(e => e.type), ['phase', ...SIX.flatMap(() => ['recall', 'recall_done']), 'phase', 'report']);
  assert.deepEqual(events[0], {type: 'phase', text: 'Reading the BP: 锂境科技 BP'});
  assert.deepEqual(events[1], {type: 'recall', query: SIX[0]});
  assert.deepEqual(events[2], {type: 'recall_done', query: SIX[0], titles: [MATERIALS, '微信联系人']});
  assert.deepEqual(events.at(-2), {type: 'phase', text: 'Writing the report with your method (about 1 minute)'});
  assert.deepEqual(events.at(-1), {type: 'report', analysis});
  assert.equal('model' in analysis, false, 'the saved analysis never names the model');
  assert.equal(analysis.vuId, VU);
  assert.equal(analysis.bpName, '锂境科技 BP.md', 'the saved result names the BP it analyzed');
  assert.equal(typeof analysis.at, 'number');
  assert.equal(typeof analysis.seconds, 'number');
  assert.deepEqual(analysis.queries, SIX.map(query => ({query, titles: [MATERIALS, '微信联系人']})));
  assert.deepEqual(analysis.report.top_question.sources, [{title: '锂境科技BP', verified: true}, {title: MATERIALS, verified: true}]);
  assert.deepEqual(analysis.report.experts[0].sources, [{title: MATERIALS, verified: true}, {title: '项目A 衡石动力 BP', verified: false}]);
  assert.deepEqual(analysis.report.people[0].sources, [{title: '微信联系人', verified: true}, {title: '2026-05-01 内部笔记 不存在的纪要', verified: false}]);
  assert.deepEqual(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), analysis);
  assert.equal((await kvGetJson(cfg.kv, `run:${ACCOUNT}:${run.id}`)).lastAnalysisAt, analysis.at);

  const [first, final] = llmBodies(fake);
  assert.equal(llmBodies(fake).length, 2);
  assert.equal(first.model, 'test-model');
  assert.equal(first.stream, true);
  assert.equal(first.tool_choice, 'required');
  assert.deepEqual(first.tools, JSON.parse(JSON.stringify(TOOLS)));
  assert.equal(first.temperature, 0.2);
  assert.equal(first.max_tokens, 16000);
  assert.equal('response_format' in first, false);
  assert.deepEqual(first.messages, [
   {role: 'system', content: systemPrompt(BP_TITLE)},
   {role: 'user', content: userPrompt({recipeText: RECIPE, bpTitle: BP_TITLE, bpText: BP.text})},
  ]);
  assert.equal(final.stream, true);
  assert.equal('tools' in final, false);
  assert.equal('tool_choice' in final, false);
  assert.equal('response_format' in final, false);
  assert.equal(final.messages.length, 10);
  assert.deepEqual(final.messages[2].tool_calls[0], {id: 'call_0', type: 'function', function: {name: 'memory_recall', arguments: JSON.stringify({query: SIX[0]})}});
  assert.equal(final.messages[2].tool_calls.length, 6);
  const toolMessages = final.messages.filter(m => m.role === 'tool');
  assert.deepEqual(toolMessages.map(m => m.tool_call_id), SIX.map((_, i) => `call_${i}`));
  assert.equal(toolMessages[0].content, `${ITEMS.materials.text}\n\n---\n\n${ITEMS.contacts.text}`);
  assert.equal(toolMessages[1].content, `(Same as "${MATERIALS}" returned earlier; not repeated.)\n\n---\n\n(Same as "微信联系人" returned earlier; not repeated.)`);
  assert.deepEqual(final.messages.at(-1), {role: 'user', content: FINAL_PROMPT});

  const recalls = fake.calls.filter(call => call.url === RECALL_URL);
  assert.equal(recalls.length, 6);
  for (const [i, call] of recalls.entries()) {
   assert.equal(call.headers.get('Authorization'), 'Bearer tok');
   assert.equal(call.headers.get('X-Virtual-User-Id'), VU);
   assert.deepEqual(JSON.parse(call.body), {query: SIX[i], token_budget: 2000});
  }
 } finally {
  fake.restore();
 }
});

test('the Chinese locale runs step 3 with the Chinese prompts, phases and tool messages', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([llmRoute([{toolCalls: SIX.map((q, i) => toolCall(i, q))}, {content: finalText(REPORT)}]), recallRoute()]);
 try {
  const {events} = await runAnalyze(cfg, run, {locale: 'zh'});
  assert.deepEqual(events[0], {type: 'phase', text: '读 BP：锂境科技 BP'});
  assert.deepEqual(events.at(-2), {type: 'phase', text: '按你的方法写报告（约 1 分钟）'});
  const [first, final] = llmBodies(fake);
  assert.deepEqual(first.messages, [
   {role: 'system', content: systemPrompt(BP_TITLE, 'zh')},
   {role: 'user', content: userPrompt({recipeText: RECIPE, bpTitle: BP_TITLE, bpText: BP.text}, 'zh')},
  ]);
  assert.deepEqual(first.tools, JSON.parse(JSON.stringify(toolsFor('zh'))));
  assert.equal(final.messages.filter(m => m.role === 'tool')[1].content, `（与前面返回的「${MATERIALS}」相同，不再重复）\n\n---\n\n（与前面返回的「微信联系人」相同，不再重复）`);
  assert.deepEqual(final.messages.at(-1), {role: 'user', content: finalPrompt('zh')});
 } finally {
  fake.restore();
 }
});

test('by default step 3 sends the model no Chinese except the fixture content', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([llmRoute([{toolCalls: SIX.map((q, i) => toolCall(i, q))}, {content: finalText(REPORT)}]), recallRoute(() => [])]);
 try {
  const ascii = {name: 'Orbit Energy BP.md', text: '# Orbit Energy\n\nFounder Li Chen, formerly R&D manager at Blue Shore.'};
  const events = [];
  await analyze({cfg, token: 'tok', accountId: ACCOUNT, run: {...run, bp: {fileKey: 'bp', name: ascii.name}}, bp: ascii}, e => events.push(e));
  for (const body of llmBodies(fake)) {
   const texts = body.messages.filter(m => m.role !== 'tool' && !(m.role === 'user' && m.content.startsWith('## '))).map(m => String(m.content));
   for (const text of texts) assert.equal(CJK.test(text), false, text.slice(0, 80));
  }
  assert.equal(CJK.test(JSON.stringify(events.filter(e => e.type === 'phase'))), false);
  assert.equal(CJK.test(JSON.stringify(llmBodies(fake)[0].tools)), false);
 } finally {
  fake.restore();
 }
});

test('fewer than four searches gets one more forced round with the nudge', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([
  llmRoute([{toolCalls: SIX.slice(0, 2).map((q, i) => toolCall(i, q))}, {toolCalls: SIX.slice(2, 5).map((q, i) => toolCall(i + 2, q))}, {content: finalText(REPORT)}]),
  recallRoute(query => (query === SIX[1] ? [] : [ITEMS.materials])),
 ]);
 try {
  const {analysis} = await runAnalyze(cfg, run);
  assert.equal(analysis.queries.length, 5);
  assert.deepEqual(analysis.queries[1], {query: SIX[1], titles: []});
  const bodies = llmBodies(fake);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1].tool_choice, 'required');
  assert.deepEqual(bodies[1].messages.at(-1), {role: 'user', content: nudgePrompt(2)});
  assert.equal(bodies[1].messages.filter(m => m.role === 'tool')[1].content, '(Nothing found.)');
  assert.equal(bodies[2].messages.some(m => m.content === nudgePrompt(5)), false);
  assert.deepEqual(bodies[2].messages.at(-1), {role: 'user', content: FINAL_PROMPT});
 } finally {
  fake.restore();
 }
});

test('two short rounds still produce a report from the searches made', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([llmRoute([{toolCalls: [toolCall(0, SIX[0])]}, {toolCalls: [toolCall(1, SIX[1])]}, {content: finalText(REPORT)}]), recallRoute()]);
 try {
  const {analysis} = await runAnalyze(cfg, run);
  assert.equal(analysis.queries.length, 2);
  const bodies = llmBodies(fake);
  assert.equal(bodies.length, 3);
  const userTexts = bodies[2].messages.filter(m => m.role === 'user').map(m => m.content);
  assert.deepEqual(userTexts.slice(1), [nudgePrompt(1), nudgePrompt(2), FINAL_PROMPT]);
 } finally {
  fake.restore();
 }
});

test('a report written without any search is rejected and nothing is saved', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([llmRoute([{content: finalText(REPORT)}]), recallRoute()]);
 try {
  const events = [];
  await assert.rejects(analyze({cfg, token: 'tok', accountId: ACCOUNT, run, bp: BP}, e => events.push(e)),
   err => err instanceof AnalysisError && err.code === 'no_search');
  assert.deepEqual(events.map(e => e.type), ['phase']);
  assert.equal(llmBodies(fake).length, 1);
  assert.equal(fake.calls.filter(call => call.url === RECALL_URL).length, 0);
  assert.equal(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), null);
  assert.equal((await kvGetJson(cfg.kv, `run:${ACCOUNT}:${run.id}`)).lastAnalysisAt, null);
 } finally {
  fake.restore();
 }
});

test('empty or unparsable tool queries are not sent to memory and do not count as searches', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const junk = [{id: 'call_a', name: 'memory_recall', arguments: '{"query":""}'}, {id: 'call_b', name: 'memory_recall', arguments: 'not json'}];
 const fake = installFetch([llmRoute([{toolCalls: junk}, {toolCalls: junk}]), recallRoute()]);
 try {
  await assert.rejects(runAnalyze(cfg, run), err => err instanceof AnalysisError && err.code === 'no_search');
  const bodies = llmBodies(fake);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['call_a', 'call_b']);
  assert.equal(fake.calls.filter(call => call.url === RECALL_URL).length, 0);
 } finally {
  fake.restore();
 }
});

test('an incomplete report is rewritten once with the same request', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([
  llmRoute([{toolCalls: SIX.slice(0, 4).map((q, i) => toolCall(i, q))}, {content: JSON.stringify({verdict: {title: '不投'}, top_question: {title: '？'}})}, {content: finalText(REPORT)}]),
  recallRoute(),
 ]);
 try {
  const {analysis} = await runAnalyze(cfg, run);
  assert.equal(analysis.report.verdict.title, REPORT.verdict.title);
  const bodies = llmBodies(fake);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[2], bodies[1]);
 } finally {
  fake.restore();
 }
});

test('two unusable reports (partial, then empty after a length cut-off) fail with report_invalid', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([
  llmRoute([{toolCalls: SIX.slice(0, 4).map((q, i) => toolCall(i, q))}, {content: '{"verdict": {"title": "不投"}, "experts": []}'}, {content: '', reasoning: '想'.repeat(200)}]),
  recallRoute(),
 ]);
 try {
  await assert.rejects(runAnalyze(cfg, run), err => err instanceof AnalysisError && err.code === 'report_invalid' && err.service === 'model');
  assert.equal(llmBodies(fake).length, 3);
  assert.equal(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), null);
 } finally {
  fake.restore();
 }
});

test('a round that starts after five minutes stops with analysis_timeout', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 let clock = 1_000_000;
 const fake = installFetch([
  llmRoute([() => {
   clock += TIMEOUT_MS + 1000;
   return sseReply(openAiChunks({toolCalls: [toolCall(0, SIX[0])]}));
  }]),
  recallRoute(),
 ]);
 try {
  await assert.rejects(runAnalyze(cfg, run, {now: () => clock}), err => err instanceof AnalysisError && err.code === 'analysis_timeout');
  assert.equal(llmBodies(fake).length, 1);
  assert.equal(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), null);
 } finally {
  fake.restore();
 }
});

test('a memory failure during recall stops the run with the upstream error', async () => {
 const cfg = testConfig();
 const run = await seed(cfg);
 const fake = installFetch([
  llmRoute([{toolCalls: [toolCall(0, SIX[0])]}]),
  {method: 'POST', url: RECALL_URL, reply: () => Response.json({ok: false, error: {code: 'INVALID_TOKEN', message: 'Token is invalid'}}, {status: 401})},
 ]);
 try {
  let failure;
  await assert.rejects(runAnalyze(cfg, run), err => {
   failure = err;
   return err instanceof ServiceError && err.service === 'memory' && err.status === 401;
  });
  assert.equal(errorEvent(failure).code, 'not_authenticated');
  assert.equal(await kvGetJson(cfg.kv, analysisKey(ACCOUNT, run.id)), null);
 } finally {
  fake.restore();
 }
});

test('cleanQuery drops tool-call markup the model leaked into a query and folds whitespace', () => {
 // Seen live: the 27b model ended a query with a newline and the start of a closing tag.
 assert.equal(queryOf(JSON.stringify({query: '华川大学材料学院博士，有没有认识的校友？\n</'})), '华川大学材料学院博士，有没有认识的校友？');
 assert.equal(cleanQuery('谁是 赵一凡？</parameter>'), '谁是 赵一凡？');
 assert.equal(cleanQuery('<parameter=query>钱卫东 背景</parameter></function>'), '钱卫东 背景');
 assert.equal(cleanQuery('良率 90%  vs\n\t60%<|im_end|>'), '良率 90% vs 60%');
 assert.equal(cleanQuery('a < b 的比较'), 'a < b 的比较', 'a plain < stays');
 assert.equal(cleanQuery('</'), '');
});
