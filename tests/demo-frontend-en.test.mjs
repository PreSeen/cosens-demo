import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisErrorMessage, analyzedRun, displayRunName, applyLiveEvent, assignMethodFiles, bpTitle, canRetry, chineseQuotes, chipsFor, classifyFile, createSseParser, deliverCheck,
  emptyLive, errorMessage, guessMethodSlot, heroForRun, hubRunsText, isTextOnlyRefusal, loginErrorBanner, loginErrorMessage, memoryView, methodPhases,
  ownFileCheck, projectPhases, projectView, reportView, roleLabel, runStepText, sentence, serviceLabel, stageOf, validateAssignments,
} from '../apps/demo/src/lib/logic.mjs';
import {renderMarkdown} from '../apps/demo/src/lib/markdown.ts';
import {getLocale, setLocale} from '../shared/i18n.mjs';

// The default: English, never taken from anything but the configured default. This file pins the English texts;
// tests/demo-frontend.test.mjs pins the Chinese ones in its own process.
const CJK = /[　-鿿＀-￯]/;
const noCjk = (value, label = '') => assert.equal(CJK.test(JSON.stringify(value)), false, `${label} ${JSON.stringify(value).slice(0, 160)}`);

const file = (name, state = 'committed', extra = {}) => ({key: name, name, source: 'demo', kind: 'text', state, jobId: 'j', documentId: null, error: null, addedAt: 1, ...extra});
const project = (slot, extra = {}) => ({slot, title: '', bp: null, proposal: null, executionId: null, attempt: 0, status: 'idle', stage: null, progress: 0, error: null, ...extra});
const run = (extra = {}) => ({
  id: 'run_x', version: 1, vuName: 'CoSens Demo · Investor · 11-20 14:30',
  memory: {files: [], stats: null, startedAt: null, completedAt: null},
  method: {projects: [project('A'), project('B')], recipe: null, startedAt: null, completedAt: null, error: null},
  bp: null, lastAnalysisAt: null, ...extra,
});
const withMemory = (state, completedAt = null) => run({memory: {files: [file('a.md', state)], stats: null, startedAt: 1, completedAt}});
const filled = slot => project(slot, {bp: {fileKey: 'k', name: 'bp.md'}, proposal: {fileKey: 'p', name: 'p.md'}});

test('the default locale is English', () => {
  assert.equal(getLocale(), 'en');
});

test('hero texts, step pills and chips are English in every state', () => {
  const states = {
    none: run(),
    memoryRunning: withMemory('pending'),
    memoryFailed: withMemory('failed'),
    memoryDone: withMemory('committed', 5),
    methodReady: {...withMemory('committed', 5), method: {projects: [filled('A'), filled('B')], recipe: null, startedAt: null, completedAt: null, error: null}},
    methodPartial: {...withMemory('committed', 5), method: {projects: [filled('A'), project('B')], recipe: null, startedAt: null, completedAt: null, error: null}},
    methodRunning: {...withMemory('committed', 5), method: {projects: [filled('A'), filled('B')], recipe: null, startedAt: 6, completedAt: null, error: null}},
    methodFailed: {...withMemory('committed', 5), method: {projects: [filled('A'), filled('B')], recipe: null, startedAt: 6, completedAt: null, error: 'x'}},
    methodDone: {...withMemory('committed', 5), method: {projects: [filled('A'), filled('B')], recipe: {name: 'm'}, startedAt: 6, completedAt: 9, error: null}},
  };
  states.bpReady = {...states.methodDone, bp: {fileKey: 'bp', name: 'Orbit BP.md'}};
  states.analyzed = {...states.bpReady, lastAnalysisAt: 12};
  const heroes = Object.fromEntries(Object.entries(states).map(([name, r]) => [name, heroForRun(r)]));
  noCjk(heroes);
  assert.equal(heroForRun(null).prompt, 'Drag your materials to me and I will remember them first');
  assert.equal(heroes.memoryRunning.prompt, 'Remembering…');
  assert.equal(heroes.memoryDone.prompt, 'Remembered');
  assert.equal(heroes.methodReady.sub, 'All four files are in. Click "Start learning".');
  assert.equal(heroes.methodRunning.prompt, 'Learning your method…');
  assert.equal(heroes.bpReady.prompt, 'Ready to analyze');
  assert.equal(heroes.analyzed.sub, 'Click "Last result" to view it, or analyze again.');
  noCjk(Object.values(states).map(r => chipsFor(r)), 'chips');
  assert.deepEqual(chipsFor(run()), {memory: {text: 'Memory · empty', on: false}, method: {text: 'Method · not learned', on: false}});
  assert.equal(chipsFor(withMemory('pending')).memory.text, 'Memory · remembering 0/1');
  assert.equal(chipsFor(withMemory('committed', 5)).memory.text, 'Memory · 1 file');
  assert.equal(chipsFor(states.methodDone).method.text, 'Method · learned');
  assert.equal(stageOf(states.bpReady).ready, true);
});

test('memory titles, project labels, learning phases and role names are English', () => {
  assert.equal(memoryView(run()).title, 'No materials yet');
  assert.equal(memoryView(withMemory('pending')).title, 'Reading 1 file');
  assert.equal(memoryView(withMemory('committed', 5)).title, 'Remembered 1 file');
  assert.equal(memoryView(withMemory('failed')).title, '1 file was not remembered');
  const three = run({memory: {files: [file('a.md'), file('b.md'), file('c.md')], stats: null, startedAt: 1, completedAt: 5}});
  assert.equal(memoryView(three).title, 'Remembered 3 files');
  assert.deepEqual(methodPhases().map(([key]) => key), ['analyze', 'generate', 'test', 'evaluate']);
  noCjk(methodPhases());
  assert.deepEqual(projectPhases(project('A', {status: 'running', stage: 'generate'})).map(p => p.state), ['ok', 'run', '', '']);
  const view = projectView(project('A', {status: 'running', attempt: 2}), 'A');
  assert.deepEqual([view.title, view.heading, view.label], ['Project A', 'Project A', 'Learning (attempt 2)']);
  assert.equal(projectView(project('B', {title: 'Project B Orbit Energy'}), 'B').heading, 'Project B · Orbit Energy');
  assert.equal(projectView(project('B', {title: '项目B 微澜光电'}), 'B').heading, 'Project B · 微澜光电', 'a Chinese fixture title keeps its name');
  assert.deepEqual(['idle', 'queued', 'completed', 'failed', 'cancelled'].map(status => projectView(project('A', {status}), 'A').label),
    ['Waiting to start', 'Queued', 'Learned', 'Not finished', 'Cancelled']);
  assert.deepEqual([roleLabel('bp'), roleLabel('proposal')], ['BP', 'Investment recommendation']);
});

test('errors are English: services, codes, quota and the analysis stream', () => {
  assert.equal(serviceLabel('model'), 'Model');
  assert.equal(serviceLabel('nobody'), '');
  assert.equal(errorMessage({code: 'run_not_found', message: 'run missing'}), 'This demo could not be found. It may belong to another account.');
  // A service error is the line the server passed through in the service's own words.
  assert.equal(errorMessage({code: 'http_502', service: 'rsi', message: 'RSI 502 http_502: upstream timeout'}), 'RSI 502 http_502: upstream timeout');
  assert.equal(errorMessage({code: 'http_503', service: 'memory', message: ''}), 'memory http_503');
  assert.equal(errorMessage({code: 'insufficient_quota', service: 'model', message: 'Model gateway 402 insufficient_quota: balance is empty'}), 'Model gateway 402 insufficient_quota: balance is empty');
  assert.equal(errorMessage({code: 'http_502', status: 502, message: 'Bad Gateway'}), 'HTTP 502: Bad Gateway');
  assert.equal(errorMessage({code: 'network_error', message: 'Failed to fetch'}), 'The network connection failed. Check your network and retry.');
  assert.equal(errorMessage({code: 'weird', message: 'odd'}), 'odd');
  assert.equal(errorMessage(null), 'Unknown error');
  assert.equal(analysisErrorMessage({code: 'stream_broken'}), 'Connection interrupted: the model\'s reply was cut off midway, so the report was not finished.');
  assert.equal(analysisErrorMessage({code: 'network_error'}), 'The network connection failed and the analysis service could not be reached. Check your network and retry.');
  assert.equal(analysisErrorMessage({code: 'internal_error', message: 'x'}), 'Analysis service error: x');
  assert.equal(analysisErrorMessage({code: 'internal_error'}), 'Analysis service error: The demo service hit an error.');
  assert.equal(analysisErrorMessage({code: 'step_not_ready'}), 'The earlier steps are not finished yet.');
  assert.equal(analysisErrorMessage({code: 'analysis_timeout', message: 'took too long'}), 'Analysis service error: took too long');
  assert.equal(analysisErrorMessage({code: 'http_502', message: 'Memory 502 http_502: recall failed', service: 'memory'}), 'Memory 502 http_502: recall failed');
  assert.equal(canRetry({code: 'run_not_found'}), false);
  assert.deepEqual(createSseParser().push('data: {oops}\n\n'), [{type: 'error', code: 'bad_event', message: 'A progress message could not be parsed.'}]);
  for (const code of ['not_authenticated', 'run_not_found', 'step_not_ready', 'analysis_not_found', 'network_error', 'stream_broken', 'bad_event', 'asset_missing', 'internal_error', 'config_missing']) {
    noCjk(errorMessage({code}), code);
  }
});

test('sentences end with a full stop in English, and quotes around Chinese stay as written', () => {
  assert.equal(sentence('Choose the file again'), 'Choose the file again.');
  assert.equal(sentence('Failed to fetch'), 'Failed to fetch.');
  assert.equal(sentence('Already done.'), 'Already done.');
  assert.equal(sentence('Retry:'), 'Retry.');
  assert.equal(sentence('Really?'), 'Really?');
  assert.equal(sentence(''), '');
  assert.equal(chineseQuotes('He said "融资节奏有点急".'), 'He said "融资节奏有点急".');
  assert.equal(renderMarkdown('### Split "done" from "forecast"').includes('Split &quot;done&quot; from &quot;forecast&quot;'), true);
});

test('login errors, the banner and the hub runs line are English', () => {
  for (const code of ['access_denied', 'authorize_failed', 'state_invalid', 'code_missing', 'token_exchange_failed', 'client_registration_failed', 'service_unavailable', 'config_missing', 'login_loop', 'nope', undefined]) {
    noCjk([loginErrorMessage(code), loginErrorBanner(code, true), loginErrorBanner(code, false)], String(code));
  }
  assert.equal(loginErrorMessage('access_denied'), 'You cancelled the sign-in authorization.');
  assert.equal(loginErrorMessage('x'), 'Sign-in was not completed. Please sign in again.');
  assert.equal(loginErrorBanner('state_invalid', false), 'The sign-in request has expired or is not valid. Please sign in again.');
  assert.equal(loginErrorBanner('state_invalid', true), 'The last sign-in was not completed: The sign-in request has expired or is not valid. You are still signed in and can open the demos directly; to switch accounts, sign in again.');
  assert.deepEqual([0, 1, 2, 3, 9].map(runStepText), ['Not started', 'Reached step 1', 'Reached step 2', 'Reached step 3', 'Reached step 3']);
  assert.equal(hubRunsText([]), 'No demos yet. Open one and click "Start demo".');
  assert.equal(hubRunsText([{vuName: 'CoSens Demo · Investor · 11-20 14:30', step: 2}]), 'You have 1 demo. Latest: CoSens Demo · Investor · 11-20 14:30 (Reached step 2).');
  assert.equal(hubRunsText([{vuName: 'N', step: 0}, {vuName: 'M', step: 3}]), 'You have 2 demos. Latest: N (Not started).');
});

test('hand-over order hints, file checks and slot assignment speak English', () => {
  const none = stageOf(run());
  assert.deepEqual(deliverCheck(none, 'method'), {ok: false, hint: 'Please hand me "Memory materials" first.'});
  assert.deepEqual(deliverCheck(stageOf(withMemory('committed', 5)), 'memory'), {ok: false, hint: '"Memory materials" has already been handed to me.'});
  assert.deepEqual(deliverCheck(none, 'nope'), {ok: false, hint: 'Unknown group of materials.'});
  assert.deepEqual(deliverCheck(none, 'memory'), {ok: true, hint: ''});
  assert.equal(ownFileCheck(stageOf({...withMemory('committed', 5), method: {projects: [filled('A'), filled('B')], recipe: null, startedAt: 6, completedAt: null, error: null}}), 'method').hint,
    'The method has already started learning. To use different past projects, click "Start over" to begin a new demo.');
  assert.deepEqual(['Project A Acme BP.md', 'Project B Orbit Investment Recommendation.md', 'Project B Orbit Business Plan.md', 'notes.md'].map(guessMethodSlot),
    [{slot: 'A', role: 'bp'}, {slot: 'B', role: 'proposal'}, {slot: 'B', role: 'bp'}, {slot: null, role: null}]);
  assert.deepEqual(['项目A 衡石动力 BP.md', '项目B 微澜光电 投资建议书.md'].map(guessMethodSlot), [{slot: 'A', role: 'bp'}, {slot: 'B', role: 'proposal'}], 'the Chinese names still work');
  const rows = assignMethodFiles(['Project A Acme BP.md', 'Project A Acme Recommendation.md', 'Project B Orbit BP.md', 'Project B Orbit Recommendation.md']);
  assert.deepEqual(rows.map(r => `${r.slot}:${r.role}`), ['A:bp', 'A:proposal', 'B:bp', 'B:proposal']);
  assert.equal(validateAssignments(rows), null);
  assert.equal(validateAssignments([{name: 'x.md', slot: null, role: 'bp'}]), 'Choose a project and a type for "x.md"');
  assert.equal(validateAssignments([{name: 'a.md', slot: 'A', role: 'bp'}, {name: 'b.md', slot: 'A', role: 'bp'}]), 'Two files were put in "Project A · BP": a.md, b.md');
  assert.equal(bpTitle('Orbit Energy Business Plan.md'), 'Orbit Energy');
  assert.equal(bpTitle('Orbit Energy BP.md'), 'Orbit Energy');
});

test('classifyFile refuses with English messages and the limits read in English', () => {
  assert.deepEqual(classifyFile({name: 'a.md', size: 0}, 'memory'), {ok: false, kind: null, code: 'empty_file', message: '"a.md" is an empty file'});
  assert.equal(classifyFile({name: 'a.exe', size: 5}, 'memory').message, '"a.exe" cannot be uploaded: only Markdown, text, PDF and Word files are supported. Switch to one of these formats and drag it in again');
  assert.equal(classifyFile({name: 'a.pdf', size: 5}, 'method').message, '"a.pdf" cannot be uploaded: only Markdown and text files are supported. Save it as .md or .txt and drag it in again');
  assert.equal(classifyFile({name: 'a.pdf', size: 5}, 'memory', {documents: false}).message, '"a.pdf" cannot be uploaded: this environment accepts only Markdown and text. Save it as .md or .txt and drag it in again');
  assert.equal(classifyFile({name: 'big.md', size: 9 * 1024 * 1024}, 'memory').message, '"big.md" cannot exceed 2 million characters');
  assert.equal(classifyFile({name: 'big.pdf', size: 21 * 1024 * 1024}, 'memory').message, '"big.pdf" cannot exceed 20 MB');
  assert.equal(classifyFile({name: 'big.md', size: 5 * 1024 * 1024}, 'bp').message, '"big.md" cannot exceed 4 MB');
  assert.deepEqual(classifyFile({name: 'a.md', size: 5}, 'bp'), {ok: true, kind: 'text', code: null, message: ''});
  // A gateway refusal written in either language is recognized, so no Retry is offered for it.
  assert.equal(isTextOnlyRefusal('This environment accepts only Markdown and text. Save PDF and Word files as .md or .txt and upload them again.'), true);
  assert.equal(isTextOnlyRefusal('这个环境只支持 Markdown 和文本，PDF 和 Word 请另存为 .md 或 .txt 再上传'), true);
  assert.equal(isTextOnlyRefusal('The document could not be processed.'), false);
});

test('the report view and the live rows are English', () => {
  const analysis = {at: Date.UTC(2026, 10, 20, 6, 30), seconds: 74.4, queries: [{query: 'q1', titles: ['a']}, {query: 'q2', titles: []}],
    bpName: 'Orbit Energy BP.md', report: {
      verdict: {title: 'Pass for now', text: 'The 90% yield is unproven.'}, top_question: {title: 'Which batch?', text: 'Ask for batch data.', sources: ['Orbit Energy BP', {title: 'Missing', verified: false}]},
      experts: [{name: 'Zhao', independent: true, role: 'Professor · 1st degree', why: 'Evaluated mass production', sources: []}, {name: 'Qian', independent: false}],
      people: [{name: 'Liu', degree: '2nd degree', relation: 'worked together', path: 'you → Liu → founder', why: '', sources: []}, {name: 'Sun', degree: '1st degree', relation: 'investor'}],
      expert_gap: '1 more expert', people_gap: '2 more people'}};
  const live = reportView(analysis, {timeZone: 'Asia/Shanghai'});
  noCjk(live);
  assert.equal(live.heroTitle, 'Orbit Energy · Due diligence advice');
  assert.equal(live.note, 'Live run complete: 74 seconds, memory searched 2 times');
  assert.equal(reportView({...analysis, queries: [{query: 'q', titles: []}]}).note, 'Live run complete: 74 seconds, memory searched once');
  assert.equal(reportView(analysis, {replay: true, timeZone: 'Asia/Shanghai'}).note, 'Result of the last real run (2026-11-20 14:30)');
  assert.equal(reportView({report: {}}).heroTitle, 'Due diligence advice');
  assert.deepEqual(live.experts.map(p => p.tag), [{text: 'Independent', tone: 'ok'}, {text: 'May not be independent', tone: 'warn'}]);
  assert.deepEqual(live.people.map(p => p.tag), [{text: '2nd degree · worked together', tone: 'blue'}, {text: '1st degree · investor', tone: 'ok'}]);
  assert.equal(live.unverified, 1);
  let rows = emptyLive();
  for (const event of [{type: 'phase', text: 'Reading the BP: Orbit'}, {type: 'recall', query: 'who is the expert?'}, {type: 'recall_done', query: 'who is the expert?', titles: ['a', 'b']},
    {type: 'recall', query: 'second'}, {type: 'recall_done', query: 'second', titles: []}, {type: 'recall', query: 'third'}, {type: 'recall_done', query: 'third', titles: ['x']}]) rows = applyLiveEvent(rows, event);
  assert.deepEqual(rows.rows.map(r => [r.text, r.find]), [['Reading the BP: Orbit', ''], ['Searching memory: who is the expert?', 'Found 2 sources'], ['Searching memory: second', 'Nothing found'], ['Searching memory: third', 'Found 1 source']]);
  assert.equal(analyzedRun(run(), analysis).lastAnalysisAt, analysis.at);
});

test('a language switch rewrites every text: the same helpers answer in Chinese and then in English again', () => {
  setLocale('zh');
  try {
    assert.equal(heroForRun(null).prompt, '把资料拖给我，我先记住');
    // Service errors stay in the service's own (English) words in both languages; the demo's own texts switch.
    assert.equal(errorMessage({code: 'http_500', service: 'model', message: 'Model gateway 500 http_500: boom'}), 'Model gateway 500 http_500: boom');
    assert.equal(errorMessage({code: 'run_not_found'}), '找不到这次演示，它可能不属于当前登录的账号');
    assert.equal(sentence('Failed to fetch'), 'Failed to fetch');
    assert.equal(chineseQuotes('他说"太快了"'), '他说「太快了」');
  } finally {
    setLocale('en');
  }
  assert.equal(heroForRun(null).prompt, 'Drag your materials to me and I will remember them first');
  assert.equal(chineseQuotes('他说"太快了"'), '他说"太快了"');
  assert.equal(getLocale(), 'en');
});

test('a run stored with the default Chinese or English name is shown in the current language, a custom name is left alone', () => {
  const was = getLocale();
  try {
    setLocale('en');
    assert.equal(displayRunName('CoSens 演示 · 投资人 · 11-22 17:35'), 'CoSens Demo · Investor · 11-22 17:35');
    assert.equal(displayRunName('CoSens Demo · Investor · 11-22 17:35'), 'CoSens Demo · Investor · 11-22 17:35');
    assert.equal(displayRunName('My own run'), 'My own run');
    assert.equal(displayRunName(null), '');
    assert.equal(hubRunsText([{vuName: 'CoSens 演示 · 投资人 · 11-22 17:35', step: 2}]).includes('演示'), false);
    setLocale('zh');
    assert.equal(displayRunName('CoSens Demo · Investor · 11-22 17:35'), 'CoSens 演示 · 投资人 · 11-22 17:35');
  } finally {
    setLocale(was);
  }
});
