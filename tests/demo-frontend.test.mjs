import {test} from 'node:test';
import assert from 'node:assert/strict';
import {esc, escDates, nobrDates, nobrUnits, chineseQuotes, sentence, analysisErrorMessage, fmtTime, stem, bpTitle, createSseParser, errorMessage, canRetry, isQuotaError, isTextOnlyRefusal} from '../apps/demo/src/lib/logic.mjs';
import {renderMarkdown} from '../apps/demo/src/lib/markdown.ts';
import {setLocale} from '../shared/i18n.mjs';

// These cases pin the Chinese texts (the original strings, now the zh entries of shared/i18n.mjs). The English default
// is pinned in tests/demo-frontend-en.test.mjs; this file runs in its own process, so the locale set here stays here.
setLocale('zh');

test('escDates keeps dates (and a time right after them) on one line', () => {
 assert.equal(escDates('2026-08-02 微信聊天记录 <钱卫东>'), '<span class="nobr">2026-08-02</span> 微信聊天记录 &lt;钱卫东&gt;');
 assert.equal(nobrDates('上次（2026-11-21 07:48）'), '上次（<span class="nobr">2026-11-21 07:48</span>）');
 assert.equal(escDates('没有日期'), '没有日期');
});

test('chineseQuotes turns straight quotes around Chinese into 「」 and leaves code spans and Latin quotes alone', () => {
 assert.equal(chineseQuotes("他说'融资节奏有点急'。"), '他说「融资节奏有点急」。');
 assert.equal(chineseQuotes('他说"太快了"'), '他说「太快了」');
 assert.equal(chineseQuotes("用 `'急'` 检索，再看'口径'"), "用 `'急'` 检索，再看「口径」");
 assert.equal(chineseQuotes("it's the founder's 'plan'"), "it's the founder's 'plan'");
 assert.equal(chineseQuotes(null), '');
});

test('analysisErrorMessage shows a service error line as the server passed it through, or names the analysis service', () => {
 const credit = 'Model gateway 402 gateway_credit_insufficient: account credit is insufficient; add credit before retrying';
 assert.equal(analysisErrorMessage({code: 'gateway_credit_insufficient', message: credit, service: 'model'}), credit);
 assert.equal(analysisErrorMessage({code: 'RATE_LIMITED', message: 'Memory 429 RATE_LIMITED: slow down', service: 'memory'}), 'Memory 429 RATE_LIMITED: slow down');
 assert.equal(analysisErrorMessage({code: 'stream_broken', message: '连接中断'}), '连接中断：模型的回复中途断开了，报告没有写完');
 assert.equal(analysisErrorMessage({code: 'network_error', message: 'Failed to fetch'}), '网络连接失败，没能连上分析服务，请检查网络后重试');
 assert.equal(analysisErrorMessage({code: 'analysis_timeout', message: '分析超过 5 分钟还没有完成'}), '分析服务出错：分析超过 5 分钟还没有完成');
 assert.equal(analysisErrorMessage({code: 'internal_error', message: '分析出错了'}), '分析服务出错：分析出错了');
 assert.equal(analysisErrorMessage({code: 'internal_error'}), '分析服务出错：演示服务出错了');
});

test('renderMarkdown wraps tables, labels each cell with its column for phones and keeps short cells on one line', () => {
 const html = renderMarkdown('| 备注名 | 备注 "原文" |\n|---|---|\n| 唐伟-远川 | 远川资本创始合伙人，2025-07-01 入职，常一起看材料和能源项目 |');
 assert.match(html, /^<div class="table-wrap"><table><thead><tr><th class="short">备注名<\/th>/);
 assert.ok(html.includes('<td class="short" data-label="备注名">唐伟-远川</td>'));
 assert.ok(html.includes('<td data-label="备注 「原文」">远川资本创始合伙人，<span class="nobr">2025-07-01</span> 入职'));
 assert.ok(!renderMarkdown('| a |\n|---|\n| <img src=x onerror=alert(1)> |').includes('<img'));
});

test('nobrUnits keeps relationship degrees and short bracketed names together', () => {
 assert.equal(nobrUnits('1 度 · 前同事（微信联系人）'), '<span class="nobr">1 度</span> · 前同事<span class="nobr">（微信联系人）</span>');
 assert.equal(nobrUnits('教授 · 2度'), '教授 · <span class="nobr">2度</span>');
 assert.equal(nobrUnits('（这是一段超过十个字的很长的括号说明）'), '（这是一段超过十个字的很长的括号说明）');
});

test('nobrUnits keeps a number with its CJK counter word', () => {
 assert.equal(nobrUnits('还差 1 位，共 12份'), '还差 <span class="nobr">1 位</span>，共 <span class="nobr">12份</span>');
});

test('handedGroups leaves out groups whose step failed', () => {
 const manifest = {groups: [{id: 'memory', files: [{name: 'a.md'}, {name: 'b.md'}]}, {id: 'method', files: [{name: '项目A BP.md'}]}, {id: 'bp', files: [{name: '锂境科技 BP.md'}]}]};
 assert.deepEqual([...handedGroups(runs.analyzed, manifest)], ['memory', 'method', 'bp']);
 assert.deepEqual([...handedGroups(runs.analyzed, manifest, true)], ['memory', 'method']);
 assert.deepEqual([...handedGroups(runs.memFailed, manifest)], []);
});

test('sentence ends text with 。 unless it already ends a sentence', () => {
 assert.equal(sentence('请换成这几种格式再拖进来'), '请换成这几种格式再拖进来。');
 assert.equal(sentence('Memory 出错：upstream timeout（BAD-note.md）'), 'Memory 出错：upstream timeout（BAD-note.md）。');
 assert.equal(sentence('已经结束。'), '已经结束。');
 assert.equal(sentence('模型出错：'), '模型出错。');
 assert.equal(sentence('已经记住；'), '已经记住。');
 assert.equal(sentence('他说“好。”'), '他说“好。”');
 assert.equal(sentence('（请重试。）'), '（请重试。）');
 assert.equal(sentence('Failed to fetch'), 'Failed to fetch');
 assert.equal(sentence('点「开始学习」'), '点「开始学习」。');
 assert.equal(sentence('真的吗？'), '真的吗？');
 assert.equal(sentence(''), '');
});

test('renderMarkdown turns straight quotes around Chinese into 「」 in text, not in code or links', () => {
 const html = renderMarkdown('### 区分"已实现"与"预测"\n\n用 `"原文"` 检索，[链接"说明"](https://x.test/?q="a")\n\n```\n"代码"\n```');
 assert.ok(html.includes('区分「已实现」与「预测」'));
 assert.ok(html.includes('<code>&quot;原文&quot;</code>'));
 assert.ok(html.includes('链接「说明」'));
 assert.ok(html.includes('href="https://x.test/?q=%22a%22"') || html.includes('href="https://x.test/?q=&quot;a&quot;"'));
 assert.ok(html.includes('&quot;代码&quot;'));
});

test('esc escapes every HTML-significant character and tolerates empty values', () => {
 assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
 assert.equal(esc(null), '');
 assert.equal(esc(undefined), '');
 assert.equal(esc(0), '0');
});

test('fmtTime formats in the given time zone and ignores missing values', () => {
 assert.equal(fmtTime(Date.UTC(2026, 10, 20, 6, 30), 'Asia/Shanghai'), '2026-11-20 14:30');
 assert.equal(fmtTime(Date.UTC(2026, 0, 2, 16, 5), 'Asia/Shanghai'), '2026-01-03 00:05');
 assert.equal(fmtTime(null), '');
 assert.equal(fmtTime(undefined), '');
 assert.equal(fmtTime('x'), '');
});

test('stem and bpTitle strip folders, extensions and a trailing BP', () => {
 assert.equal(stem('2-投资方法/项目A 衡石动力 BP.md'), '项目A 衡石动力 BP');
 assert.equal(stem('纪要\\a.docx'), 'a');
 assert.equal(stem('报告.PDF'), '报告');
 assert.equal(stem(null), '');
 assert.equal(bpTitle('锂境科技 BP.md'), '锂境科技');
 assert.equal(bpTitle('新项目商业计划书.pdf'), '新项目');
 assert.equal(bpTitle('BP.md'), 'BP');
 assert.equal(bpTitle(''), '');
});

test('createSseParser joins events split across chunks and skips [DONE]', () => {
 const p = createSseParser();
 assert.deepEqual(p.push('data: {"type":"phase","te'), []);
 assert.deepEqual(p.push('xt":"读 BP"}\n'), []);
 assert.deepEqual(p.push('\ndata: {"type":"recall","query":"q1"}\n\ndata: {"type":"recall_done",'), [{type: 'phase', text: '读 BP'}, {type: 'recall', query: 'q1'}]);
 assert.deepEqual(p.push('"query":"q1","titles":["a"]}\r\n\r\ndata: [DONE]\n\n'), [{type: 'recall_done', query: 'q1', titles: ['a']}]);
 assert.deepEqual(p.end(), []);
});

test('createSseParser handles CRLF split across chunks, comments, multi-line data and an unterminated last event', () => {
 const p = createSseParser();
 assert.deepEqual(p.push(': keep-alive\r'), []);
 assert.deepEqual(p.push('\n\r\ndata: {"type":"phase",\ndata: "text":"x"}\r'), []);
 assert.deepEqual(p.end(), [{type: 'phase', text: 'x'}]);
 assert.deepEqual(createSseParser().push('data: {oops}\n\n'), [{type: 'error', code: 'bad_event', message: '收到无法解析的进度消息'}]);
});

test('errorMessage passes service errors through as the server wrote them and keeps the demo own texts', () => {
 assert.equal(errorMessage({code: 'run_not_found', message: 'run missing'}), '找不到这次演示，它可能不属于当前登录的账号');
 assert.equal(errorMessage({code: 'internal', service: 'rsi', message: 'RSI 500 internal: planner crashed'}), 'RSI 500 internal: planner crashed');
 // A service code that happens to be one of the demo's own codes still shows the service line.
 assert.equal(errorMessage({code: 'internal_error', service: 'rsi', message: 'RSI 500 internal_error: boom'}), 'RSI 500 internal_error: boom');
 assert.equal(errorMessage({code: 'http_503', service: 'memory', message: ''}), 'memory http_503');
 const credit = 'Model gateway 402 gateway_credit_insufficient: account credit is insufficient; add credit before retrying';
 assert.equal(errorMessage({code: 'gateway_credit_insufficient', status: 402, service: 'model', message: credit}), credit);
 // A proxy's error page (no JSON from the demo server): its HTTP status and status text.
 assert.equal(errorMessage({code: 'http_502', status: 502, service: null, message: 'Bad Gateway'}), 'HTTP 502: Bad Gateway');
 assert.equal(errorMessage({code: 'not_authenticated', service: 'auth', message: ''}), '登录已过期，请重新登录');
 assert.equal(errorMessage({code: 'network_error', message: 'Failed to fetch'}), '网络连接失败，请检查网络后重试');
 assert.equal(errorMessage({code: 'weird', message: 'odd'}), 'odd');
 assert.equal(errorMessage({code: 'unsupported_file', message: '「a.xlsx」不能上传：只支持 Markdown 和文本文件'}), '「a.xlsx」不能上传：只支持 Markdown 和文本文件');
 assert.equal(errorMessage({code: 'file_too_large', message: '「big.md」不能超过 2000000 个字符'}), '「big.md」不能超过 2000000 个字符');
 assert.equal(errorMessage(new Error('boom')), 'boom');
 assert.equal(errorMessage('已经是中文'), '已经是中文');
 assert.equal(errorMessage(null), '未知错误');
});

test('canRetry refuses errors a retry cannot fix, credit included', () => {
 assert.equal(canRetry({code: 'gateway_credit_insufficient', service: 'model'}), false);
 assert.equal(canRetry({code: 'insufficient_balance'}), false);
 assert.equal(canRetry({code: 'http_402'}), false);
 assert.equal(canRetry({code: 'rate_limit_exceeded', status: 429, service: 'model'}), true);
 assert.equal(canRetry({code: 'http_502', service: 'rsi'}), true);
 assert.equal(canRetry({code: 'stream_broken'}), true);
 assert.equal(canRetry({code: 'insufficient_quota'}), false);
 assert.equal(canRetry({code: 'http_402', status: 402}), false);
 for (const code of ['unsupported_file', 'empty_file', 'file_too_large', 'run_not_found', 'not_authenticated', 'config_missing']) assert.equal(canRetry({code}), false, code);
 assert.equal(isQuotaError({code: 'billing_blocked'}), false, 'only the documented credit codes and HTTP 402');
 assert.equal(isQuotaError({code: 'http_500'}), false);
});

test('renderMarkdown renders Markdown but escapes raw HTML and drops unsafe links and images', () => {
 const html = renderMarkdown('# 标题\n\n<script>alert(1)</script>\n\n正文 <b onclick="x">粗</b> [坏](javascript:alert(1)) [好](https://cosens.ai/?a=1&b=2) ![图](https://example.com/y.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
 assert.ok(html.includes('<h1>标题</h1>'));
 assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
 assert.ok(html.includes('&lt;b onclick=&quot;x&quot;&gt;粗&lt;/b&gt;'));
 assert.equal(html.includes('<script'), false);
 assert.equal(html.includes('javascript:'), false);
 assert.equal(html.includes('<img'), false);
 assert.ok(html.includes('<a href="https://cosens.ai/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">好</a>'));
 assert.ok(html.includes('<table>'));
 assert.equal(renderMarkdown(''), '');
});

// ---- W21 ----
import {loginErrorMessage, loginErrorBanner, runStepText, hubRunsText} from '../apps/demo/src/lib/logic.mjs';

test('loginErrorMessage uses the callback texts of server/demo/oauth.mjs LOGIN_ERRORS', () => {
 assert.equal(loginErrorMessage('access_denied'), '你取消了登录授权。');
 assert.equal(loginErrorMessage('state_invalid'), '登录请求已过期或无效，请重新登录。');
 assert.equal(loginErrorMessage('login_loop'), '登录成功了，但演示服务仍然拒绝访问。请两分钟后再试；如果一直这样，请联系我们。');
 assert.equal(loginErrorMessage('weird_code'), '登录没有完成，请重新登录。');
 assert.equal(loginErrorMessage(null), '登录没有完成，请重新登录。');
 assert.equal(loginErrorMessage('toString'), '登录没有完成，请重新登录。');
});

test('loginErrorBanner speaks of the last sign-in attempt when a session is still there', () => {
 assert.equal(loginErrorBanner('access_denied', false), '你取消了登录授权。');
 assert.equal(loginErrorBanner('access_denied', true), '上次登录没有完成：你取消了登录授权。你仍处于登录状态，可以直接进入演示；要换账号，请重新登录。');
 assert.equal(loginErrorBanner('state_invalid', true), '上次登录没有完成：登录请求已过期或无效。你仍处于登录状态，可以直接进入演示；要换账号，请重新登录。');
});

test('runStepText and hubRunsText describe earlier runs', () => {
 assert.equal(runStepText(0), '还没开始');
 assert.equal(runStepText(2), '做到第 2 步');
 assert.equal(runStepText(7), '做到第 3 步');
 assert.equal(runStepText('x'), '还没开始');
 assert.equal(hubRunsText([]), '还没有演示过，进去后点「开始演示」。');
 assert.equal(hubRunsText(undefined), '还没有演示过，进去后点「开始演示」。');
 assert.equal(hubRunsText([{id: 'run_b', vuName: 'CoSens 演示 · 投资人 · 11-20 14:30', createdAt: 2, step: 2}, {id: 'run_a', vuName: 'old', createdAt: 1, step: 3}]), '已有 2 次演示，最近一次：CoSens 演示 · 投资人 · 11-20 14:30（做到第 2 步）。');
});

// ---- W22 ----
import {
 stageOf, autoFocus, deliverCheck, ownFileCheck, heroForRun, chipsFor, pollDelay, memoryView, memoryStatus, projectView,
 ringStep, demoGroupsUsed, handedGroups, outlinedGroup, ownGroups, ownFiles, queryTerms, stepStates, guessMethodSlot, assignMethodFiles, validateAssignments, classifyFile, reportView, emptyLive, applyLiveEvent, methodFilesComplete,
} from '../apps/demo/src/lib/logic.mjs';

const baseRun = (patch = {}) => ({
 id: 'run_1', demo: 'investor', version: 1, vuId: 'vu_1', vuName: 'CoSens 演示 · 投资人 · 11-20 14:30', createdAt: 1, updatedAt: 1,
 memory: {files: [], stats: null, startedAt: null, completedAt: null},
 method: {projects: [], recipe: null, startedAt: null, completedAt: null, error: null},
 bp: null, lastAnalysisAt: null, ...patch,
});
const mfile = (name, state) => ({key: `demo-${name}`, name, source: 'demo', kind: 'text', state, jobId: 'job', documentId: null, error: state === 'failed' ? 'ingest failed' : null, addedAt: 1});
const proj = (slot, patch = {}) => ({slot, title: `项目${slot}`, bp: {fileKey: `${slot}bp`, name: `项目${slot} BP.md`}, proposal: {fileKey: `${slot}p`, name: `项目${slot} 投资建议书.md`}, executionId: null, attempt: 0, status: 'idle', stage: null, progress: 0, error: null, ...patch});
const recipe = {recipeId: 'rcp', versionId: 'ver', number: 2, name: '投资方法（第 2 版）', description: '说明', instructions: '# 方法', selfTest: 86, rules: ['规矩一']};
const memRunning = {files: [mfile('a.md', 'committed'), mfile('b.md', 'pending')], stats: null, startedAt: 1, completedAt: null};
const memDone = {files: [mfile('a.md', 'committed'), mfile('b.md', 'committed')], stats: {people: 5, organizations: 3, relations: 7}, startedAt: 1, completedAt: 2};
const memFailed = {files: [mfile('a.md', 'committed'), mfile('b.md', 'failed')], stats: null, startedAt: 1, completedAt: null};
// Every file committed on receipt, before the GET runs/:id refresh sets completedAt and stats.
const memSettling = {files: [mfile('a.md', 'committed'), mfile('b.md', 'committed')], stats: null, startedAt: 1, completedAt: null};
const methodPartial = {projects: [proj('A'), proj('B', {proposal: null})], recipe: null, startedAt: null, completedAt: null, error: null};
const methodReady = {projects: [proj('A'), proj('B')], recipe: null, startedAt: null, completedAt: null, error: null};
const methodRunning = {projects: [proj('A', {status: 'running', stage: 'test', progress: 40, attempt: 1}), proj('B')], recipe: null, startedAt: 3, completedAt: null, error: null};
const methodFailed = {projects: [proj('A', {status: 'completed', progress: 100, attempt: 1}), proj('B', {status: 'failed', stage: 'failed', attempt: 3, error: 'invalid_model_output'})], recipe: null, startedAt: 3, completedAt: null, error: '项目 B 学习失败'};
const methodDone = {projects: [proj('A', {status: 'completed', progress: 100}), proj('B', {status: 'completed', progress: 100})], recipe, startedAt: 3, completedAt: 4, error: null};
const bp = {fileKey: 'bp', name: '锂境科技 BP.md'};
const runs = {
 empty: baseRun(),
 memRunning: baseRun({memory: memRunning}),
 memDone: baseRun({memory: memDone}),
 memFailed: baseRun({memory: memFailed}),
 memSettling: baseRun({memory: memSettling}),
 bpSettling: baseRun({memory: memSettling, method: methodDone, bp}),
 partial: baseRun({memory: memDone, method: methodPartial}),
 ready: baseRun({memory: memDone, method: methodReady}),
 learning: baseRun({memory: memDone, method: methodRunning}),
 learnFailed: baseRun({memory: memDone, method: methodFailed}),
 learned: baseRun({memory: memDone, method: methodDone}),
 bpReady: baseRun({memory: memDone, method: methodDone, bp}),
 bpWaiting: baseRun({memory: memRunning, method: methodDone, bp}),
 analyzed: baseRun({memory: memDone, method: methodDone, bp, lastAnalysisAt: 5}),
};
const titles = {memory: '记忆资料', method: '投资方法', bp: '新 BP'};

test('stageOf walks the whole run lifecycle', () => {
 assert.deepEqual(stageOf(null), {memory: 'none', method: 'none', bp: false, analyzed: false, given: 0, next: 'memory', ready: false});
 assert.deepEqual(stageOf(runs.empty), stageOf(null));
 assert.deepEqual([stageOf(runs.memRunning).memory, stageOf(runs.memRunning).given, stageOf(runs.memRunning).next], ['running', 1, 'method']);
 assert.deepEqual([stageOf(runs.memFailed).memory, stageOf(runs.memFailed).given], ['failed', 1]);
 assert.deepEqual([stageOf(runs.partial).method, stageOf(runs.partial).given], ['partial', 1]);
 assert.deepEqual([stageOf(runs.ready).method, stageOf(runs.ready).given], ['ready', 1]);
 assert.deepEqual([stageOf(runs.learning).method, stageOf(runs.learning).given, stageOf(runs.learning).next], ['running', 2, 'bp']);
 assert.deepEqual([stageOf(runs.learnFailed).method, stageOf(runs.learnFailed).given], ['failed', 2]);
 assert.deepEqual([stageOf(runs.bpReady).given, stageOf(runs.bpReady).next, stageOf(runs.bpReady).ready], [3, null, true]);
 assert.equal(stageOf(runs.bpWaiting).ready, false);
 assert.equal(stageOf(runs.analyzed).analyzed, true);
 assert.equal(methodFilesComplete(runs.partial), false);
 assert.equal(methodFilesComplete(runs.ready), true);
});

test('all files committed before completedAt is set still counts as running, not failed', () => {
 assert.equal(memoryStatus(runs.memSettling), 'running');
 assert.equal(pollDelay(runs.memSettling), 5000);
 assert.notEqual(memoryView(runs.memSettling).title, '0 份资料没记住');
 assert.equal(memoryView(runs.memSettling).title, '正在读 2 份资料');
 assert.equal(heroForRun(runs.memSettling).prompt, '正在记住…');
 assert.equal(heroForRun(runs.bpSettling).sub, '资料还在记，记完就可以开始分析');
 assert.equal(stageOf(runs.bpSettling).ready, false);
 assert.equal(memoryStatus(runs.memFailed), 'failed');
 assert.equal(memoryStatus(runs.memDone), 'done');
});

test('autoFocus opens the panel of the step the visitor is on', () => {
 const focus = name => autoFocus(stageOf(runs[name]));
 assert.equal(autoFocus(stageOf(null)), 1);
 assert.deepEqual(['memRunning', 'memDone', 'memFailed', 'partial', 'learning', 'learnFailed', 'learned', 'analyzed'].map(focus), [1, 1, 1, 2, 2, 2, 2, 3]);
});

test('deliverCheck keeps demo groups in order with the mock hints', () => {
 assert.deepEqual(deliverCheck(stageOf(null), 'memory', titles), {ok: true, hint: ''});
 assert.deepEqual(deliverCheck(stageOf(null), 'method', titles), {ok: false, hint: '请先把「记忆资料」交给我'});
 assert.deepEqual(deliverCheck(stageOf(runs.memRunning), 'memory', titles), {ok: false, hint: '「记忆资料」已经交给我了'});
 assert.deepEqual(deliverCheck(stageOf(runs.memRunning), 'method', titles), {ok: true, hint: ''});
 assert.deepEqual(deliverCheck(stageOf(runs.memRunning), 'bp', titles), {ok: false, hint: '请先把「投资方法」交给我'});
 assert.deepEqual(deliverCheck(stageOf(runs.learned), 'bp', titles), {ok: true, hint: ''});
 assert.deepEqual(deliverCheck(stageOf(runs.analyzed), 'bp', titles), {ok: false, hint: '「新 BP」已经交给我了'});
 assert.deepEqual(deliverCheck(stageOf(null), 'nope', titles), {ok: false, hint: '不认识这组资料'});
});

test('ownFileCheck lets visitors add memory, fill method before learning and replace the BP', () => {
 assert.equal(ownFileCheck(stageOf(runs.memRunning), 'memory', titles).ok, true);
 assert.deepEqual(ownFileCheck(stageOf(null), 'bp', titles), {ok: false, hint: '请先把「记忆资料」交给我'});
 assert.equal(ownFileCheck(stageOf(runs.partial), 'method', titles).ok, true);
 assert.match(ownFileCheck(stageOf(runs.learning), 'method', titles).hint, /^方法已经开始学了/);
 assert.equal(ownFileCheck(stageOf(runs.analyzed), 'bp', titles).ok, true);
});

test('heroForRun matches the mock wording for every stage', () => {
 const hero = name => heroForRun(name ? runs[name] : null);
 assert.deepEqual(hero(null), {prompt: '把资料拖给我，我先记住', sub: '微信联系人、会议纪要、聊天记录、内部笔记，多少都可以', cur: 0, spinning: false});
 assert.deepEqual([hero('memRunning').prompt, hero('memRunning').cur, hero('memRunning').spinning], ['正在记住…', 0, true]);
 assert.deepEqual([hero('memDone').prompt, hero('memDone').cur], ['记住了', 1]);
 assert.equal(hero('memFailed').prompt, '有资料没记住');
 assert.deepEqual([hero('ready').prompt, hero('ready').sub], ['把两个过往项目交给我', '四份都放齐了，点「开始学习」']);
 assert.deepEqual([hero('learning').prompt, hero('learning').cur, hero('learning').spinning], ['正在学习你的方法…', 1, true]);
 assert.equal(hero('learnFailed').prompt, '方法没有学完');
 assert.deepEqual([hero('learned').prompt, hero('learned').sub, hero('learned').cur], ['学会了', '现在把新的 BP 拖给我', 2]);
 assert.deepEqual([hero('bpWaiting').prompt, hero('bpWaiting').spinning], ['新 BP 已收到', true]);
 assert.equal(hero('bpReady').prompt, '可以开始分析了');
 assert.deepEqual([hero('analyzed').prompt, hero('analyzed').cur], ['分析过了', 3]);
});

test('chipsFor and pollDelay follow memory and method progress', () => {
 assert.deepEqual(chipsFor(null), {memory: {text: '记忆 · 空', on: false}, method: {text: '方法 · 未学习', on: false}});
 assert.deepEqual(chipsFor(runs.memRunning).memory, {text: '记忆 · 正在记 1/2', on: false});
 assert.deepEqual(chipsFor(runs.memDone).memory, {text: '记忆 · 2 份资料', on: true});
 assert.deepEqual(chipsFor(runs.learning).method, {text: '方法 · 学习中', on: false});
 assert.deepEqual(chipsFor(runs.learnFailed).method, {text: '方法 · 没学完', on: false});
 assert.deepEqual(chipsFor(runs.learned).method, {text: '方法 · 已学会', on: true});
 assert.deepEqual([null, runs.empty, runs.memRunning, runs.memDone, runs.learning, runs.bpWaiting, runs.learned, runs.learnFailed].map(pollDelay), [null, null, 5000, null, 15000, 5000, null, null]);
});

test('ringStep moves the ring to the next step when its start card follows a finished step', () => {
 assert.equal(ringStep(stageOf(runs.memRunning), 1), 1);
 assert.equal(ringStep(stageOf(runs.memDone), 1), 2);
 assert.equal(ringStep(stageOf(runs.partial), 2), 2);
 assert.equal(ringStep(stageOf(runs.learning), 2), 2);
 assert.equal(ringStep(stageOf(runs.learned), 2), 3);
 assert.equal(ringStep(stageOf(runs.bpReady), 3), 3);
});

test('demoGroupsUsed counts only the bundled demo files a run holds', () => {
 const manifest = {groups: [{id: 'memory', files: [{name: 'a.md'}]}, {id: 'method', files: [{name: '项目A BP.md'}]}, {id: 'bp', files: [{name: '锂境科技 BP.md'}]}]};
 assert.deepEqual([...demoGroupsUsed(runs.empty, manifest)], []);
 assert.deepEqual([...demoGroupsUsed(runs.bpReady, manifest)], ['memory', 'method', 'bp']);
 const own = baseRun({memory: {...memRunning, files: [{...mfile('a.md', 'pending'), source: 'upload'}]}});
 assert.deepEqual([...demoGroupsUsed(own, manifest)], []);
 assert.deepEqual([...demoGroupsUsed(runs.bpReady, null)], []);
});

test('outlinedGroup invites the next hand-over and follows demo files, never the visitor own files', () => {
 const manifest = {groups: [{id: 'memory', files: [{name: 'a.md'}, {name: 'b.md'}]}, {id: 'method', files: [{name: '项目A BP.md'}]}, {id: 'bp', files: [{name: '锂境科技 BP.md'}]}]};
 assert.equal(outlinedGroup(null, manifest, 0), 'memory');
 assert.equal(outlinedGroup(runs.memRunning, manifest, 0), 'memory');
 assert.equal(outlinedGroup(runs.memDone, manifest, 1), 'method');
 assert.equal(outlinedGroup(runs.learning, manifest, 1), 'method');
 assert.equal(outlinedGroup(runs.learned, manifest, 2), 'bp');
 assert.equal(outlinedGroup(runs.analyzed, manifest, 3), null);
 const ownMemory = baseRun({memory: {...memRunning, files: [{...mfile('mine.md', 'pending'), source: 'upload'}]}});
 assert.equal(outlinedGroup(ownMemory, manifest, 0), null);
 const ownMethod = baseRun({memory: memDone, method: {...methodReady, projects: [proj('A', {bp: {fileKey: 'x', name: '甲 BP.md'}, proposal: {fileKey: 'y', name: '甲 建议书.md'}}), proj('B', {bp: null, proposal: null})]}});
 assert.equal(outlinedGroup(ownMethod, manifest, 1), null);
});

test('ownFiles names the visitor files of each step that holds only own files', () => {
 const manifest = {groups: [{id: 'memory', files: [{name: 'a.md'}]}, {id: 'method', files: []}, {id: 'bp', files: []}]};
 const own = baseRun({memory: {...memRunning, files: [{...mfile('mine.md', 'pending'), source: 'upload'}]}});
 assert.deepEqual([...ownFiles(own, manifest)], [['memory', ['mine.md']]]);
 assert.deepEqual([...ownFiles(runs.empty, manifest)], []);
});

test('ownGroups lists the steps that hold only the visitor files', () => {
 const manifest = {groups: [{id: 'memory', files: [{name: 'a.md'}, {name: 'b.md'}]}, {id: 'method', files: [{name: '项目A BP.md'}]}, {id: 'bp', files: [{name: '锂境科技 BP.md'}]}]};
 assert.deepEqual([...ownGroups(null, manifest)], []);
 assert.deepEqual([...ownGroups(runs.bpReady, manifest)], []);
 const own = baseRun({memory: {...memRunning, files: [{...mfile('mine.md', 'pending'), source: 'upload'}]}, bp: {fileKey: 'bp', name: '我的 BP.md'}});
 assert.deepEqual([...ownGroups(own, manifest)], ['memory', 'bp']);
});

test('queryTerms makes chips only of true keyword lists; questions and short queries read as text', () => {
 assert.deepEqual(queryTerms('蓝岸新能源 陈立 共事 同事 陈立 研发经理 固态电解质项目 固态电解质'), ['蓝岸新能源', '陈立', '共事', '同事', '研发经理', '固态电解质项目']);
 assert.deepEqual(queryTerms('清华大学\u3000材料科学与工程 2012级'), ['清华大学', '材料科学与工程', '2012级']);
 assert.deepEqual(queryTerms('有没有做硫化物电解质的专家能判断离子电导率12 mS/cm和中试线良率90%是否合理?'), []);
 assert.deepEqual(queryTerms('陈立 在蓝岸新能源的同事，谁还联系得上'), []);
 assert.deepEqual(queryTerms('  谁懂硫化物电解质？ '), []);
 assert.deepEqual(queryTerms('固态电解质 专家'), []);
 assert.deepEqual(queryTerms(''), []);
});

test('stepStates reads the same statuses as the header chips', () => {
 assert.deepEqual(stepStates(stageOf(null), 0), ['cur', 'todo', 'todo']);
 assert.deepEqual(stepStates(stageOf(runs.memRunning), 0), ['cur', 'todo', 'todo']);
 // Own project files staged while memory still writes: step 1 runs, it is not done.
 assert.deepEqual(stepStates(stageOf(baseRun({memory: memRunning, method: methodReady})), 1), ['run', 'cur', 'todo']);
 assert.deepEqual(stepStates(stageOf(runs.ready), 1), ['done', 'cur', 'todo']);
 assert.deepEqual(stepStates(stageOf(runs.learning), 1), ['done', 'cur', 'todo']);
 assert.deepEqual(stepStates(stageOf(runs.bpWaiting), 2), ['run', 'done', 'cur']);
 assert.deepEqual(stepStates(stageOf(baseRun({memory: memFailed, method: methodDone, bp})), 2), ['fail', 'done', 'cur']);
 assert.deepEqual(stepStates(stageOf(runs.analyzed), 3), ['done', 'done', 'done']);
});

test('memoryView counts files and exposes stats', () => {
 const running = memoryView(runs.memRunning);
 assert.deepEqual([running.status, running.total, running.committed, running.pending, running.failed, running.title, running.percent, running.stats], ['running', 2, 1, 1, 0, '正在读 2 份资料', 50, null]);
 assert.deepEqual(running.files[0], {key: 'demo-a.md', name: 'a.md', label: 'a', state: 'committed', error: null, source: 'demo'});
 const done = memoryView(runs.memDone);
 assert.deepEqual([done.title, done.percent, done.stats], ['已记住 2 份资料', 100, {people: 5, organizations: 3, relations: 7}]);
 const failed = memoryView(runs.memFailed);
 assert.deepEqual([failed.title, failed.failed, failed.files[1].error], ['1 份资料没记住', 1, 'ingest failed']);
 assert.equal(memoryView(null).title, '还没有资料');
});

test('memoryView says where the stats go: values, a pending placeholder, or nothing at all', () => {
 assert.equal(memoryView(runs.memDone).statsPanel, 'values');
 assert.equal(memoryView(runs.memRunning).statsPanel, 'pending');
 assert.equal(memoryView(runs.memRunning, {stats: false}).statsPanel, 'none');
 // Memory through the gateway: step 1 finishes without stats; the card shows the count and no empty numbers.
 const noStats = baseRun({memory: {...runs.memDone.memory, stats: null}});
 const view = memoryView(noStats, {stats: false});
 assert.deepEqual([view.status, view.title, view.stats, view.statsPanel], ['done', '已记住 2 份资料', null, 'none']);
 assert.equal(memoryView(noStats).statsPanel, 'none');
 assert.equal(chipsFor(noStats).memory.text, '记忆 · 2 份资料');
 assert.equal(heroForRun(noStats).prompt, '记住了');
 assert.equal(memoryView(null).statsPanel, 'none');
});

test('projectView maps RSI stages onto the four learning phases', () => {
 const running = projectView(proj('A', {status: 'running', stage: 'test', progress: 40, attempt: 1}), 'A');
 assert.deepEqual([running.label, running.progress, running.phases.map(p => p.state)], ['学习中', 40, ['ok', 'ok', 'run', '']]);
 assert.deepEqual(running.phases.map(p => p.label), ['读懂 BP 和建议书', '总结判断规矩', '用学到的方法重做这个项目', '和当时的建议书逐条比对打分']);
 const failed = projectView(proj('B', {status: 'failed', stage: 'evaluate', attempt: 2, error: 'boom'}), 'B');
 assert.deepEqual([failed.label, failed.phases.map(p => p.state), failed.error], ['没学完（第 2 次尝试）', ['ok', 'ok', 'ok', 'err'], 'boom']);
 const done = projectView(proj('A', {status: 'completed', progress: 90}), 'A');
 assert.deepEqual([done.label, done.progress, done.phases.every(p => p.state === 'ok')], ['学完了', 100, true]);
 const missing = projectView(null, 'B');
 assert.deepEqual([missing.title, missing.label, missing.progress, missing.bp, missing.proposal], ['项目 B', '等待开始', 0, null, null]);
 assert.equal(missing.heading, '项目 B');
 assert.deepEqual(['项目A 衡石动力', '项目 A · 衡石动力', '衡石动力', '项目A'].map(title => projectView(proj('A', {title}), 'A').heading), ['项目 A · 衡石动力', '项目 A · 衡石动力', '项目 A · 衡石动力', '项目 A']);
 assert.equal(projectView(proj('A', {status: 'running', progress: 140}), 'A').progress, 100);
 assert.equal(projectView(proj('A', {status: 'queued', stage: 'queued', progress: -3}), 'A').progress, 0);
 assert.deepEqual(projectView(proj('A', {status: 'queued', stage: 'queued'}), 'A').phases.map(p => p.state), ['', '', '', '']);
});

test('guessMethodSlot, assignMethodFiles and validateAssignments prepare the slot dialog', () => {
 assert.deepEqual(guessMethodSlot('项目A 衡石动力 BP.md'), {slot: 'A', role: 'bp'});
 assert.deepEqual(guessMethodSlot('项目B 微澜光电 投资建议书.md'), {slot: 'B', role: 'proposal'});
 assert.deepEqual(guessMethodSlot('project-b proposal.txt'), {slot: 'B', role: 'proposal'});
 assert.deepEqual(guessMethodSlot('BP.md'), {slot: null, role: 'bp'});
 assert.deepEqual(guessMethodSlot('随手笔记.md'), {slot: null, role: null});
 assert.deepEqual(assignMethodFiles(['项目A 衡石动力 BP.md', '项目A 衡石动力 投资建议书.md', '笔记1.md', '笔记2.md']).map(r => [r.slot, r.role]), [['A', 'bp'], ['A', 'proposal'], ['B', 'bp'], ['B', 'proposal']]);
 assert.deepEqual(assignMethodFiles(['x.md'], [{slot: 'A', role: 'bp'}]).map(r => [r.slot, r.role]), [['A', 'proposal']]);
 assert.deepEqual(assignMethodFiles(['BP.md'], [{slot: 'A', role: 'bp'}]).map(r => [r.slot, r.role]), [['B', 'bp']]);
 assert.deepEqual(assignMethodFiles(['1.md', '2.md', '3.md', '4.md', '5.md'])[4], {name: '5.md', slot: null, role: null});
 const four = assignMethodFiles(['a.md', 'b.md', 'c.md', 'd.md']);
 assert.equal(validateAssignments(four), null);
 assert.equal(validateAssignments([{name: '笔记.md', slot: 'A', role: null}]), '请给「笔记.md」选好项目和类型');
 assert.equal(validateAssignments([{name: 'a.md', slot: 'A', role: 'bp'}, {name: 'b.md', slot: 'A', role: 'bp'}]), '「项目 A · BP」放了两份文件：a.md、b.md');
});

test('classifyFile refuses PDF and Word for step 1 when this environment takes only Markdown and text', () => {
 const off = {documents: false};
 assert.deepEqual(classifyFile({name: 'a.md', size: 10}, 'memory', off), {ok: true, kind: 'text', code: null, message: ''});
 assert.deepEqual(classifyFile({name: 'a.txt', size: 10}, 'memory', off).ok, true);
 for (const name of ['a.pdf', 'b.DOC', 'c.docx']) {
  assert.deepEqual(classifyFile({name, size: 10}, 'memory', off), {ok: false, kind: null, code: 'unsupported_file', message: `「${name}」不能上传：这个环境只支持 Markdown 和文本。请另存为 .md 或 .txt 再拖进来`});
 }
 assert.equal(classifyFile({name: 'a.xlsx', size: 10}, 'memory', off).message, '「a.xlsx」不能上传：这个环境只支持 Markdown 和文本。请另存为 .md 或 .txt 再拖进来');
 assert.equal(classifyFile({name: 'a.pdf', size: 10}, 'memory', {documents: true}).kind, 'document');
 assert.equal(classifyFile({name: 'big.md', size: 8 * 1024 * 1024 + 1}, 'memory', off).code, 'file_too_large');
});

test('classifyFile applies the per-step types and size limits before upload', () => {
 const MiB = 1024 * 1024;
 assert.deepEqual(classifyFile({name: 'a.md', size: 10}, 'memory'), {ok: true, kind: 'text', code: null, message: ''});
 assert.deepEqual(classifyFile({name: 'a.PDF', size: 10}, 'memory'), {ok: true, kind: 'document', code: null, message: ''});
 assert.deepEqual(classifyFile({name: 'a.docx', size: 10}, 'memory').kind, 'document');
 assert.deepEqual(classifyFile({name: 'a.xlsx', size: 10}, 'memory'), {ok: false, kind: null, code: 'unsupported_file', message: '「a.xlsx」不能上传：只支持 Markdown、文本、PDF 和 Word 文件。请换成这几种格式再拖进来'});
 assert.deepEqual(classifyFile({name: 'a.pdf', size: 10}, 'bp'), {ok: false, kind: null, code: 'unsupported_file', message: '「a.pdf」不能上传：只支持 Markdown 和文本文件。请另存为 .md 或 .txt 再拖进来'});
 assert.deepEqual(classifyFile({name: 'big.md', size: 4 * MiB + 1}, 'method'), {ok: false, kind: null, code: 'file_too_large', message: '「big.md」不能超过 4 MB'});
 assert.equal(classifyFile({name: 'big.pdf', size: 20 * MiB + 1}, 'memory').message, '「big.pdf」不能超过 20 MB');
 assert.equal(classifyFile({name: 'big.md', size: 8 * MiB + 1}, 'memory').message, '「big.md」不能超过 200 万字');
 assert.equal(classifyFile({name: 'ok.pdf', size: 20 * MiB}, 'memory').ok, true);
 assert.deepEqual(classifyFile({name: 'empty.md', size: 0}, 'memory'), {ok: false, kind: null, code: 'empty_file', message: '「empty.md」是空文件'});
});

test('reportView builds the report cards, tags and unverified sources', () => {
 const analysis = {
  at: Date.UTC(2026, 10, 20, 13, 21), seconds: 150.4, vuId: 'vu',
  queries: [{query: 'q1', titles: ['纪要甲', '微信联系人']}, {query: 'q2', titles: []}],
  report: {
   verdict: {title: '不投', text: '理由'},
   top_question: {title: '良率口径？', text: '追问', sources: [{title: '锂境科技 BP', verified: true}, {title: '编造的资料', verified: false}]},
   experts: [{name: '赵一凡', independent: true, role: '教授 · 1度', why: '懂', sources: [{title: '微信联系人', verified: true}]}, {name: '钱卫东', independent: false, role: 'r', why: 'w', sources: ['纪要乙']}],
   expert_gap: '差一位',
   people: [{name: '刘静', degree: '1 度', relation: '前同事', path: '您 → 刘静 → 创始人', why: '共事', sources: []}, {name: '王浩', degree: '2 度', relation: '', path: 'p', why: '', sources: [{title: 'x', verified: false}]}],
   people_gap: '还差1位',
  },
 };
 const live = reportView(analysis, {bpName: '锂境科技 BP.md'});
 assert.equal(live.heroTitle, '锂境科技 · 尽调建议');
 // A saved result keeps the BP it analyzed, even after the visitor puts a different BP into the run.
 assert.equal(reportView({...analysis, bpName: '星河储能 BP.md'}, {replay: true, bpName: '锂境科技 BP.md'}).heroTitle, '星河储能 · 尽调建议');
 assert.equal(reportView({...analysis, bpName: ''}, {bpName: '锂境科技 BP.md'}).heroTitle, '锂境科技 · 尽调建议', 'older saves fall back to the current BP');
 assert.equal(live.note, '现场运行完成，用时 150 秒，查了 2 次记忆');
 assert.deepEqual(live.verdict, {title: '不投', text: '理由'});
 assert.deepEqual(live.topQuestion.sources, [{title: '锂境科技 BP', verified: true}, {title: '编造的资料', verified: false}]);
 assert.deepEqual(live.experts.map(p => p.tag), [{text: '独立', tone: 'ok'}, {text: '可能不独立', tone: 'warn'}]);
 assert.deepEqual(live.experts[1].sources, [{title: '纪要乙', verified: true}]);
 assert.equal(live.experts[0].line, '教授 · 1度');
 assert.deepEqual(live.people.map(p => p.tag), [{text: '1 度 · 前同事', tone: 'ok'}, {text: '2 度', tone: 'blue'}]);
 assert.deepEqual([live.people[0].line, live.people[0].initial], ['您 → 刘静 → 创始人', '刘']);
 assert.deepEqual([live.expertGap, live.peopleGap, live.unverified], ['差一位', '还差1位', 2]);
 assert.deepEqual(live.queries, [{query: 'q1', titles: ['纪要甲', '微信联系人']}, {query: 'q2', titles: []}]);
 assert.equal(reportView(analysis, {replay: true, bpName: '锂境科技 BP.md', timeZone: 'Asia/Shanghai'}).note, '上次真实运行结果（2026-11-20 21:21）');
 const empty = reportView({}, {});
 assert.deepEqual([empty.heroTitle, empty.experts, empty.people, empty.note, empty.unverified], ['尽调建议', [], [], '现场运行完成，用时 0 秒，查了 0 次记忆', 0]);
});

test('applyLiveEvent folds stream events into rows without mutating its input', () => {
 let live = emptyLive();
 for (const event of [
  {type: 'phase', text: '读 BP：锂境科技 BP'}, {type: 'recall', query: 'q1'}, {type: 'recall', query: 'q2'},
  {type: 'recall_done', query: 'q1', titles: ['a', 'b']}, {type: 'recall_done', query: 'q2', titles: []}, {type: 'recall_done', query: 'unknown', titles: ['x']},
 ]) live = applyLiveEvent(live, event);
 assert.deepEqual(live.rows.map(r => [r.text, r.find, r.state]), [['读 BP：锂境科技 BP', '', 'ok'], ['在记忆里查：q1', '找到 2 份资料', 'ok'], ['在记忆里查：q2', '没有找到', 'run']]);
 live = applyLiveEvent(live, {type: 'report', analysis: {}});
 assert.equal(live.rows.every(r => r.state === 'ok'), true);
 const before = emptyLive();
 applyLiveEvent(before, {type: 'phase', text: 'x'});
 assert.deepEqual(before.rows, []);
});

// ---- Review round 4 ----
import {linkedRunPlan, analyzedRun} from '../apps/demo/src/lib/logic.mjs';

test('linkedRunPlan falls back to the latest run only when the linked run is gone', () => {
 assert.equal(linkedRunPlan(null, null), 'latest');
 assert.equal(linkedRunPlan('', null), 'latest');
 assert.equal(linkedRunPlan('run_1', null), 'open');
 assert.equal(linkedRunPlan('run_1', {code: 'run_not_found', status: 404}), 'latest');
 // A transient failure keeps ?run and offers 重试 instead of opening (and linking to) another run.
 assert.equal(linkedRunPlan('run_1', {code: 'http_502', status: 502, service: 'memory'}), 'keep');
 assert.equal(linkedRunPlan('run_1', {code: 'network_error'}), 'keep');
 assert.equal(linkedRunPlan('run_1', new Error('boom')), 'keep');
});

test('analyzedRun marks a run analyzed from the live result without mutating it', () => {
 const before = runs.bpReady;
 const after = analyzedRun(before, {at: 9, seconds: 2});
 assert.equal(after.lastAnalysisAt, 9);
 assert.equal(before.lastAnalysisAt, null);
 assert.equal(after.version, before.version);
 assert.equal(stageOf(after).analyzed, true);
 assert.equal(heroForRun(after).prompt, '分析过了');
 // Without the analysis timestamp nothing is made up: the run stays as it is until the server refresh.
 assert.equal(analyzedRun(before, {}), before);
 assert.equal(analyzedRun(before, {at: 'x'}), before);
 assert.equal(analyzedRun(before, null), before);
 assert.equal(analyzedRun(null, {at: 9}), null);
});

test('chineseQuotes leaves English apostrophes and inch marks in mixed text alone', () => {
 assert.equal(chineseQuotes("O'Brien 和 D'Angelo 都在远川"), "O'Brien 和 D'Angelo 都在远川");
 assert.equal(chineseQuotes("CEO's 团队和 CTO's 背景"), "CEO's 团队和 CTO's 背景");
 assert.equal(chineseQuotes('屏幕 6.1" 和 6.7" 两款'), '屏幕 6.1" 和 6.7" 两款');
 assert.equal(chineseQuotes("O'Brien 说'太快了'"), "O'Brien 说「太快了」");
});

test('analysisErrorMessage keeps the plain message for the visitor\'s own request problems', () => {
 assert.equal(analysisErrorMessage({code: 'step_not_ready', message: '还缺 BP'}), errorMessage({code: 'step_not_ready', message: '还缺 BP'}));
 assert.equal(analysisErrorMessage({code: 'run_not_found', message: '找不到这次演示'}), errorMessage({code: 'run_not_found', message: '找不到这次演示'}));
 assert.doesNotMatch(analysisErrorMessage({code: 'step_not_ready', message: '还缺 BP'}), /分析服务/);
 assert.match(analysisErrorMessage({code: 'internal_error', message: 'boom'}), /^分析服务出错：boom$/);
});

test('renderMarkdown never lets raw markup through after a raw inline tag', () => {
 // marked stops escaping text after <code>, <pre>, <kbd> or <script>; learned Recipe text can carry them.
 for (const source of ['<code> <img src=x onerror=alert(1)//', '<code> **<img src=x onerror=alert(1)//**', '<kbd>a</kbd> <b onclick=x>粗</b> & 1 < 2', '<pre> <script>alert(1)</script>']) {
  const html = renderMarkdown(source);
  assert.doesNotMatch(html, /<(?:img|script|b)[\s>]/i, `${source} -> ${html}`);
 }
 const kept = renderMarkdown('&amp; &lt;x&gt; "a" it\'s &#34;中&#34;');
 assert.match(kept, /&amp; &lt;x&gt; &quot;a&quot; it&#39;s/);
 assert.doesNotMatch(kept, /&amp;amp;|&amp;lt;/, 'entities are not escaped twice');
 assert.match(renderMarkdown('[链接](https://a.test/?q="中文")'), /href="https:\/\/a\.test\/\?q=&quot;中文&quot;"/, 'hrefs keep their straight quotes');
});

test('renderMarkdown escapes autolink hrefs once and labels cells with the same quotes as their header', () => {
 assert.match(renderMarkdown('<https://a.test/?q="中文">'), /href="https:\/\/a\.test\/\?q=&quot;中文&quot;"/);
 assert.doesNotMatch(renderMarkdown('<https://a.test/?a=1&b=2>'), /&amp;amp;/);
 const table = renderMarkdown('| 备注 "原文" |\n|---|\n| 值 |');
 assert.match(table, /<th[^>]*>备注 「原文」<\/th>/);
 assert.match(table, /data-label="备注 「原文」"/);
});

test('sourcesHtml puts the 出处 label inside the first source so they wrap together', async () => {
 const {sourcesHtml} = await import('../apps/demo/src/investor/report.ts');
 const html = sourcesHtml([{title: '2026-03-14 腾讯会议纪要 储能材料行业交流', verified: true}, {title: '微信联系人', verified: false}]);
 assert.match(html, /^<span class="srcitem"><span class="srclabel">出处：<\/span>2026-03-14 腾讯会议纪要 储能材料行业交流 ·<\/span> <span class="srcitem"><span class="unv"/);
 assert.equal((html.match(/出处：/g) || []).length, 1);
 assert.equal(sourcesHtml([]), '');
});

test('a gateway text-only refusal is not offered a retry', () => {
  assert.equal(isTextOnlyRefusal('这个环境只支持 Markdown 和文本，PDF 和 Word 请另存为 .md 或 .txt 再上传'), true);
  assert.equal(isTextOnlyRefusal('没有写进记忆'), false);
  assert.equal(isTextOnlyRefusal(undefined), false);
});
