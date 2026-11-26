// Pure helpers for the demo pages. No DOM access, so node --test imports this file directly.
// Every text comes from shared/i18n.mjs in the current locale (setLocale); English is the default.
import {LOCALES, getLocale, hasMessage, t} from '../../../../shared/i18n.mjs';

const ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

/** Escape text for HTML element content and quoted attributes. */
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ENTITIES[c]);

const DATE_TEXT = /\d{4}-\d{1,2}-\d{1,2}(?: \d{1,2}:\d{2})?/g;
const SHORT_UNIT = /\d+(?:\.\d+)?\s*[\u4e00-\u9fff]|（[^（）<>]{1,10}）/g;
/** Already-escaped text with a number and its CJK counter word (1 度, 还差 1 位) and short bracketed names (（微信联系人）) kept on one line. */
export const nobrUnits = html => String(html ?? '').replace(SHORT_UNIT, '<span class="nobr">$&</span>');

/** Already-escaped text with every date (and a time right after it) kept on one line. */
export const nobrDates = html => String(html ?? '').replace(DATE_TEXT, '<span class="nobr">$&</span>');
/** esc() plus nobrDates(). */
export const escDates = value => nobrDates(esc(value));

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const isChinese = () => getLocale() === 'zh';

/**
 * Text as a sentence (error bodies, hero subtitles): a closing full stop unless it already ends a sentence, also
 * before a closing quote or bracket (「…好。」). A trailing comma or colon is replaced. In Chinese, text that ends in
 * Latin letters or digits (an English upstream message) is left as it is; in English it gets its full stop.
 */
export function sentence(text) {
  const value = String(text ?? '').trim().replace(/[，、；：,;:]+$/, '');
  if (!value || /[。！？.!?…][」』）)”"’]*$/.test(value)) return value;
  if (isChinese()) return /[A-Za-z0-9]$/.test(value) ? value : `${value}。`;
  return `${value}.`;
}

/** In Chinese, straight quotes the model writes around Chinese text become 「」; code spans (`...`) stay as written. English text is left as written. */
export function chineseQuotes(text) {
  if (!isChinese()) return String(text ?? '');
  return String(text ?? '').split(/(`[^`\n]*`)/).map((part, i) => i % 2 ? part
    : part.replace(/(?<![A-Za-z0-9])'([^'\n]+)'(?![A-Za-z0-9])|(?<![A-Za-z0-9.])"([^"\n]+)"(?![A-Za-z0-9])/g,
      (whole, single, double) => CJK.test(single ?? double) ? `「${single ?? double}」` : whole)).join('');
}

/** Millisecond timestamp -> "YYYY-MM-DD HH:mm" in timeZone (default: the browser's zone). */
export function fmtTime(ms, timeZone) {
  const value = Number(ms);
  if (ms == null || ms === '' || !Number.isFinite(value)) return '';
  const parts = {};
  const format = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  for (const part of format.formatToParts(new Date(value))) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** File name without folders and without a known document extension. */
export const stem = name => String(name ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:md|markdown|txt|pdf|docx?)$/i, '');

/** "锂境科技 BP.md" -> "锂境科技"; falls back to the stem when nothing is left. */
export function bpTitle(name) {
  const base = stem(name).trim();
  return base.replace(/\s*(?:BP|商业计划书|business plan)$/i, '').trim() || base;
}

/** Incremental parser for `data: <json>` server-sent events. push() returns the events completed so far. */
export function createSseParser() {
  let buffer = '';
  const parse = block => {
    const lines = block.split('\n').filter(line => line.startsWith('data:'));
    if (!lines.length) return null;
    const data = lines.map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); }
    catch { return {type: 'error', code: 'bad_event', message: t('code.bad_event')}; }
  };
  const drain = final => {
    // A trailing "\r" may be the first half of "\r\n"; keep it until the next chunk arrives.
    const hold = !final && buffer.endsWith('\r');
    let text = (hold ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
    const events = [];
    let index;
    while ((index = text.indexOf('\n\n')) >= 0) {
      const event = parse(text.slice(0, index));
      text = text.slice(index + 2);
      if (event) events.push(event);
    }
    if (final) {
      const event = parse(text);
      text = '';
      if (event) events.push(event);
    }
    buffer = text + (hold ? '\r' : '');
    return events;
  };
  return {push: chunk => { buffer += String(chunk); return drain(false); }, end: () => drain(true)};
}

/** What an error names as its source ("Memory", "Model"); '' for an unknown service. */
export const serviceLabel = service => (hasMessage(`label.${service}`) ? t(`label.${service}`) : '');
// Codes with a fixed text (code.<code>) when the demo itself raised them (no service). unsupported_file and file_too_large
// are left out on purpose: the server's own text is shown as it is.
const CODE_MESSAGES = new Set(['not_authenticated', 'run_not_found', 'step_not_ready', 'analysis_not_found', 'network_error', 'stream_broken', 'bad_event',
  'asset_missing', 'internal_error', 'config_missing']);

// Same codes as server/demo/http.mjs CREDIT_CODES: a retry cannot add credit, so no 重试 is offered.
const CREDIT_CODES = ['gateway_credit_insufficient', 'insufficient_balance', 'insufficient_quota'];

/** Out of credit: HTTP 402 or one of the services' documented credit codes. */
export function isQuotaError(err) {
  const code = String(err?.code ?? '').toLowerCase();
  // A stream error event has no HTTP status; a 402 without a code of its own arrives as http_402.
  return err?.status === 402 || code === 'http_402' || CREDIT_CODES.includes(code);
}

/**
 * The error line for an ApiError-like value ({code, message, service, status}). A service error is shown as the
 * server passed it through, in the service's own words and in English in both languages ("Model gateway 402
 * gateway_credit_insufficient: ..."). The demo's own errors use the
 * current language, and an answer the demo server did not write (a proxy's error page) shows its HTTP status and text.
 */
export function errorMessage(err) {
  if (err == null) return t('err.unknown');
  if (typeof err === 'string') return err;
  const code = String(err.code ?? '');
  const message = String(err.message ?? '').trim();
  if (code === 'not_authenticated') return t(`code.${code}`);
  if (serviceLabel(err.service)) return message || `${err.service} ${code || 'error'}`;
  if (CODE_MESSAGES.has(code)) return t(`code.${code}`);
  if (/^http_\d{3}$/.test(code)) return `HTTP ${code.slice(5)}${message ? `: ${message}` : ''}`;
  return message || code || t('err.unknown');
}

const REQUEST_CODES = new Set(['step_not_ready', 'run_not_found', 'not_authenticated', 'invalid_request', 'analysis_not_found', 'config_missing']);

/** A live analysis failure names the service at fault; without one it is the demo's own analysis service (which calls the model and Memory). */
export function analysisErrorMessage(err) {
  if (serviceLabel(err?.service)) return errorMessage(err);
  const code = String(err?.code ?? '');
  // The stream carries the model's reply; a failure of Memory or RSI arrives as an error event naming that service.
  if (code === 'stream_broken') return t('analysis.stream_broken');
  if (code === 'network_error') return t('analysis.network_error');
  // The visitor's own request problems (step not ready, unknown run, signed out) keep their plain message.
  if (REQUEST_CODES.has(code)) return errorMessage(err);
  return t('analysis.failed', {detail: String(err?.message ?? '').trim() || errorMessage(err)});
}

/** Retrying cannot fix quota, file-type, size, ownership, login or configuration problems. */
export function canRetry(err) {
  if (isQuotaError(err)) return false;
  return !['unsupported_file', 'empty_file', 'file_too_large', 'run_not_found', 'not_authenticated', 'config_missing'].includes(err?.code);
}

// ---- Hub (W21) ----

// The texts are the login.error.<code> messages, shared with the server's error page (server/demo/oauth.mjs).
const LOGIN_ERROR_CODES = new Set(['access_denied', 'authorize_failed', 'state_invalid', 'code_missing', 'token_exchange_failed',
  'client_registration_failed', 'service_unavailable', 'config_missing', 'login_loop']);

export function loginErrorMessage(code) {
  const key = String(code ?? '').trim();
  return t(`login.error.${LOGIN_ERROR_CODES.has(key) ? key : 'unknown'}`);
}

/** Hub banner text. With a session the visitor is still signed in, so the failure is about the last sign-in attempt only. */
export function loginErrorBanner(code, signedIn) {
  const message = loginErrorMessage(code);
  if (!signedIn) return message;
  // "Sign in again" sits next to the text, so the reason drops its own request to sign in again.
  return t('login.banner_signed_in', {message: message.replace(isChinese() ? /，请重新登录。$/ : / Please sign in again\.$/, isChinese() ? '。' : '')});
}

export function runStepText(step) {
  const n = Math.trunc(Number(step) || 0);
  return t(`run.step.${Math.max(0, Math.min(3, n))}`);
}

// Runs created before the locale work were stored with the Chinese name "CoSens 演示 · 投资人 · MM-DD HH:mm" (and English
// ones with "CoSens Demo · Investor · ..."). Show the default run name in the current language; custom names stay as they are.
const DEFAULT_RUN_NAME = /^CoSens (?:演示 · 投资人|Demo · Investor) · (\d{2}-\d{2} \d{2}:\d{2})$/;
export function displayRunName(name) {
  const m = DEFAULT_RUN_NAME.exec(String(name ?? ''));
  return m ? t('run.name', {time: m[1]}) : String(name ?? '');
}

export function hubRunsText(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (!list.length) return t('hub.no_runs');
  return t('hub.runs', {n: list.length, name: displayRunName(list[0].vuName), step: runStepText(list[0].step)});
}

// ---- Investor demo (W22) ----

// ---- Where a run writes: a new space or one of the visitor's own (spaces) ----

/** The server's refusals of a picked space: the list was stale, so the chooser shows the reason and reloads it. */
export const SPACE_REFUSALS = Object.freeze(['space_read_only', 'space_not_found']);
export const isSpaceRefusal = err => SPACE_REFUSALS.includes(String(err?.code ?? ''));

/**
 * The start card's choice. chooser: {mode: 'new'|'existing', list: null | {status:'loading'} | {status:'failed', error}
 * | {status:'ready', spaces, readOnly}, picked: vuId|null, error: text|null}. canStart is false while the existing
 * choice has no space picked; warning says where the material goes and that it stays there.
 */
export function spaceChoiceView(chooser, {timeZone} = {}) {
  const mode = chooser?.mode === 'existing' ? 'existing' : 'new';
  const list = chooser?.list ?? null;
  const ready = list?.status === 'ready';
  const spaces = ready && Array.isArray(list.spaces) ? list.spaces : [];
  const picked = spaces.find(space => space.vuId === chooser?.picked) ?? null;
  const status = mode === 'new' ? 'idle' : !list || list.status === 'loading' ? 'loading' : list.status === 'failed' ? 'failed' : spaces.length ? 'ready' : 'empty';
  const readOnly = ready ? Math.max(0, Math.trunc(Number(list.readOnly) || 0)) : 0;
  const items = spaces.map(space => ({
    vuId: space.vuId,
    name: displayRunName(space.name) || space.vuId,
    created: space.createdAt == null ? t('space.created_unknown') : t('space.created', {time: fmtTime(space.createdAt, timeZone)}),
    demo: space.demo === true,
    shared: space.role === 'write',
    picked: picked?.vuId === space.vuId,
  }));
  return {
    mode,
    status,
    items,
    listError: status === 'failed' ? t('space.list_failed', {detail: errorMessage(list.error)}) : '',
    countText: status !== 'ready' ? '' : spaces.length > 4 ? t('space.count_scroll', {n: spaces.length}) : t('space.count', {n: spaces.length}),
    emptyText: status === 'empty' ? t('space.empty') : '',
    readOnlyNote: status === 'ready' || status === 'empty' ? (readOnly ? t('space.read_only_note', {n: readOnly}) : '') : '',
    warning: status !== 'ready' ? '' : picked
      ? t('space.warning_picked', {name: displayRunName(picked.name) || picked.vuId})
      : t('space.warning'),
    canStart: mode === 'new' || Boolean(picked),
    error: chooser?.error ? String(chooser.error) : '',
  };
}

export const GROUP_STEP = {memory: 1, method: 2, bp: 3};
export const GROUP_ORDER = ['memory', 'method', 'bp'];
const SLOTS = ['A', 'B'];
const ROLES = ['bp', 'proposal'];
/** The role of a project file as the page names it. */
export const roleLabel = role => t(`role.${role}`);
const MiB = 1024 * 1024;
// memoryText is a byte pre-check: a file over 8 MiB has more than 2,000,000 characters (4 bytes at most per character),
// the server's real text limit, so it is reported as that limit.
export const LIMITS = {memoryText: 8 * MiB, memoryDocument: 20 * MiB, methodOrBp: 4 * MiB};

export const projectOf = (run, slot) => (run?.method?.projects ?? []).find(p => p?.slot === slot) ?? null;

export function memoryStatus(run) {
  const files = run?.memory?.files ?? [];
  if (!files.length) return 'none';
  if (files.some(f => f?.state !== 'committed' && f?.state !== 'failed')) return 'running';
  if (files.some(f => f?.state === 'failed')) return 'failed';
  if (run.memory.completedAt != null) return 'done';
  // A file can commit on receipt; the GET runs/:id refresh (reached by the 5 s poll) then sets completedAt and stats.
  return 'running';
}

export const methodFilesComplete = run => SLOTS.every(slot => {
  const p = projectOf(run, slot);
  return !!(p?.bp && p?.proposal);
});

export function methodStatus(run) {
  const m = run?.method;
  if (!m) return 'none';
  if (m.recipe && m.completedAt != null) return 'done';
  if (m.error) return 'failed';
  if (m.startedAt != null) return 'running';
  if (methodFilesComplete(run)) return 'ready';
  if ((m.projects ?? []).some(p => p?.bp || p?.proposal)) return 'partial';
  return 'none';
}

/** Where a run stands. given = how many groups were handed over in order; next = the group to hand over now. */
export function stageOf(run) {
  const memory = memoryStatus(run), method = methodStatus(run), bp = !!run?.bp, analyzed = run?.lastAnalysisAt != null;
  let given = 0;
  if (memory !== 'none') given = 1;
  if (given === 1 && ['running', 'done', 'failed'].includes(method)) given = 2;
  if (given === 2 && bp) given = 3;
  return {memory, method, bp, analyzed, given, next: GROUP_ORDER[given] ?? null, ready: memory === 'done' && method === 'done' && bp};
}

/** The step pill to ring: a finished step shown above the next step's start card hands the ring to that next step. */
export function ringStep(stage, focus) {
  if (focus === 1 && stage.memory === 'done' && stage.method === 'none') return 2;
  if (focus === 2 && stage.method === 'done' && !stage.bp) return 3;
  return focus;
}

/** Materials groups whose bundled demo files went into the run (own uploads do not count). */
export function demoGroupsUsed(run, manifest) {
  const names = gid => new Set((manifest?.groups ?? []).find(g => g?.id === gid)?.files?.map(f => f.name) ?? []);
  const used = (gid, list) => { const demo = names(gid); return list.some(name => name && demo.has(name)); };
  const projectFiles = (run?.method?.projects ?? []).flatMap(p => [p?.bp?.name, p?.proposal?.name]);
  return new Set([
    ...(used('memory', (run?.memory?.files ?? []).filter(f => f?.source !== 'upload').map(f => f?.name)) ? ['memory'] : []),
    ...(used('method', projectFiles) ? ['method'] : []),
    ...(used('bp', [run?.bp?.name]) ? ['bp'] : []),
  ]);
}

const holdsFiles = (run, gid) => gid === 'memory' ? (run?.memory?.files ?? []).length > 0
  : gid === 'method' ? (run?.method?.projects ?? []).some(p => p?.bp || p?.proposal)
  : !!run?.bp;

/** Materials groups whose step holds only the visitor's own files, so the demo files of that group are not in use. */
export function ownGroups(run, manifest) {
  const used = demoGroupsUsed(run, manifest);
  return new Set(GROUP_ORDER.filter(gid => holdsFiles(run, gid) && !used.has(gid)));
}

/** The visitor's own file names per step that holds only own files (see ownGroups). */
export function ownFiles(run, manifest) {
  const names = {
    memory: () => (run?.memory?.files ?? []).filter(f => f?.source === 'upload').map(f => String(f.name)),
    method: () => (run?.method?.projects ?? []).flatMap(p => [p?.bp?.name, p?.proposal?.name]).filter(Boolean).map(String),
    bp: () => (run?.bp?.name ? [String(run.bp.name)] : []),
  };
  return new Map([...ownGroups(run, manifest)].map(gid => [gid, names[gid]()]));
}

const SENTENCE_MARK = /[？?，,。！!；;：:]/;
/**
 * Keyword chips for a recall query, or [] when it reads as text. The model mostly writes questions, which the page
 * quotes as 「…」; only a true keyword list (3+ space-separated terms, no sentence punctuation) becomes chips.
 * Repeats and terms already contained in a longer term are dropped for display only; the page keeps the full query in a title.
 */
export function queryTerms(query) {
  const text = String(query ?? '');
  const terms = text.split(/\s+/).filter(Boolean);
  if (terms.length < 3 || SENTENCE_MARK.test(text)) return [];
  return terms.filter((term, i) => terms.indexOf(term) === i && !terms.some(other => other !== term && other.includes(term)));
}

/**
 * Step pill states from the same statuses as the header chips: done only when the step is, the hero's step is cur,
 * an earlier step still writing or learning is run, a failed one is fail, and the rest are todo.
 */
export function stepStates(stage, cur) {
  const status = [stage?.memory, stage?.method, stage?.analyzed ? 'done' : 'none'];
  return status.map((value, i) => i === cur ? 'cur' : value === 'done' ? 'done' : value === 'running' ? 'run' : value === 'failed' ? 'fail' : 'todo');
}

/**
 * Groups whose demo files count as handed over (已交给 AI): their step is running or done, not failed.
 * liveFailed: the last live analysis of step 3 failed, so the new BP is not marked as handed over.
 */
export function handedGroups(run, manifest, liveFailed = false) {
  const stage = stageOf(run);
  const failed = {memory: stage.memory === 'failed', method: stage.method === 'failed', bp: liveFailed};
  return new Set([...demoGroupsUsed(run, manifest)].filter(gid => !failed[gid]));
}

/**
 * The materials group to outline for the current step (hero cur, 0-based): it invites a hand-over while the step
 * holds no files, and stays outlined while the step works on demo files; the visitor's own files never outline it.
 */
export function outlinedGroup(run, manifest, cur) {
  const gid = GROUP_ORDER[cur];
  if (!gid) return null;
  return !holdsFiles(run, gid) || demoGroupsUsed(run, manifest).has(gid) ? gid : null;
}

/** The step panel to show when the visitor has not picked one. A finished step stays in view with the next step's start card below it. */
export function autoFocus(stage) {
  if (stage.given === 1 && (stage.method === 'partial' || stage.method === 'ready')) return 2;
  return Math.max(1, stage.given);
}

const titleOf = (titles, id) => titles?.[id] ?? t(`group.${id}.title`);

/** Order check for handing over a bundled demo group (port of app.js deliver()). */
export function deliverCheck(stage, gid, titles = {}) {
  const target = GROUP_STEP[gid];
  if (!target) return {ok: false, hint: t('deliver.unknown_group')};
  if (target <= stage.given) return {ok: false, hint: t('deliver.already', {group: titleOf(titles, gid)})};
  if (target > stage.given + 1) return {ok: false, hint: t('deliver.first', {group: titleOf(titles, GROUP_ORDER[stage.given])})};
  return {ok: true, hint: ''};
}

/** Own files may add to step 1, fill step 2 before learning starts, and replace the step 3 BP. */
export function ownFileCheck(stage, gid, titles = {}) {
  const target = GROUP_STEP[gid];
  if (!target) return {ok: false, hint: t('deliver.unknown_group')};
  if (target > stage.given + 1) return {ok: false, hint: t('deliver.first', {group: titleOf(titles, GROUP_ORDER[stage.given])})};
  if (gid === 'method' && ['running', 'done', 'failed'].includes(stage.method)) return {ok: false, hint: t('deliver.method_started')};
  return {ok: true, hint: ''};
}

/** What boot opens for a ?run= link: only a missing run falls back to the latest one; a transient failure keeps the link for 重试. */
export function linkedRunPlan(wanted, err) {
  if (!wanted) return 'latest';
  if (!err) return 'open';
  return err?.code === 'run_not_found' ? 'latest' : 'keep';
}

/** A copy of the run as saved after a live analysis (the stream returns only the analysis, not the run). Without analysis.at the run is returned as it is. */
export function analyzedRun(run, analysis) {
  if (!run) return null;
  const at = Number(analysis?.at);
  return Number.isFinite(at) && at > 0 ? {...run, lastAnalysisAt: at} : run;
}

const idleHero = () => ({prompt: t('hero.idle.prompt'), sub: t('hero.idle.sub'), cur: 0, spinning: false});

/** Hero text, current step and spinner for a run that is not streaming an analysis or showing a report. */
export function heroForRun(run) {
  if (!run) return idleHero();
  const s = stageOf(run);
  if (s.given === 0) return idleHero();
  if (s.given === 1) {
    if (s.method === 'partial' || s.method === 'ready') return {prompt: t('hero.projects.prompt'), sub: t(s.method === 'ready' ? 'hero.projects.sub_ready' : 'hero.projects.sub_partial'), cur: 1, spinning: false};
    if (s.memory === 'running') return {prompt: t('hero.memory_running.prompt'), sub: t('hero.memory_running.sub'), cur: 0, spinning: true};
    if (s.memory === 'failed') return {prompt: t('hero.memory_failed.prompt'), sub: t('hero.memory_failed.sub'), cur: 0, spinning: false};
    return {prompt: t('hero.memory_done.prompt'), sub: t('hero.memory_done.sub'), cur: 1, spinning: false};
  }
  if (s.method === 'running') return {prompt: t('hero.method_running.prompt'), sub: t('hero.method_running.sub'), cur: 1, spinning: true};
  if (s.method === 'failed') return {prompt: t('hero.method_failed.prompt'), sub: t('hero.method_failed.sub'), cur: 1, spinning: false};
  if (!s.bp) return {prompt: t('hero.method_done.prompt'), sub: t('hero.method_done.sub'), cur: 2, spinning: false};
  if (s.memory === 'failed') return {prompt: t('hero.bp_received.prompt'), sub: t('hero.bp_memory_failed.sub'), cur: 2, spinning: false};
  if (s.memory === 'running') return {prompt: t('hero.bp_received.prompt'), sub: t('hero.bp_memory_running.sub'), cur: 2, spinning: true};
  if (!s.analyzed) return {prompt: t('hero.ready.prompt'), sub: t('hero.ready.sub'), cur: 2, spinning: false};
  return {prompt: t('hero.analyzed.prompt'), sub: t('hero.analyzed.sub'), cur: 3, spinning: false};
}

/**
 * stats = false: this environment records no stats (Memory through the gateway), so a running step 1 shows no
 * placeholder for them. statsPanel: 'values' (show the counts), 'pending' (show … while step 1 runs) or 'none'
 * (no stats block, so a finished step 1 without stats shows its file count and no empty numbers).
 */
export function memoryView(run, {stats: statsOn = true} = {}) {
  const files = (run?.memory?.files ?? []).map(f => ({
    key: String(f?.key ?? ''), name: String(f?.name ?? ''), label: stem(f?.name),
    state: f?.state === 'committed' || f?.state === 'failed' ? f.state : 'pending',
    error: f?.error ? String(f.error) : null, source: f?.source === 'upload' ? 'upload' : 'demo',
  }));
  const count = state => files.filter(f => f.state === state).length;
  const committed = count('committed'), failed = count('failed'), pending = count('pending'), total = files.length;
  const status = memoryStatus(run);
  const title = status === 'none' ? t('memory.title.none') : status === 'running' ? t('memory.title.running', {n: total}) : status === 'done' ? t('memory.title.done', {n: committed}) : t('memory.title.failed', {n: failed});
  const s = run?.memory?.stats;
  const stats = s ? {people: Number(s.people) || 0, organizations: Number(s.organizations) || 0, relations: Number(s.relations) || 0} : null;
  const statsPanel = stats ? 'values' : status === 'running' && statsOn ? 'pending' : 'none';
  return {status, files, total, committed, failed, pending, title, percent: total ? Math.round((committed + failed) / total * 100) : 0, stats, statsPanel};
}

export function chipsFor(run) {
  const view = memoryView(run), method = methodStatus(run);
  const memory = view.total === 0 ? {text: t('chip.memory.empty'), on: false}
    : view.status === 'running' ? {text: t('chip.memory.running', {done: view.committed, total: view.total}), on: false}
    : {text: t('chip.memory.files', {n: view.committed}), on: view.committed > 0};
  const chip = method === 'done' ? {text: t('chip.method.done'), on: true}
    : method === 'running' ? {text: t('chip.method.running'), on: false}
    : method === 'failed' ? {text: t('chip.method.failed'), on: false}
    : {text: t('chip.method.none'), on: false};
  return {memory, method: chip};
}

/** Memory jobs move fast (poll every 5 s); RSI learning takes ~16 min (poll every 15 s); otherwise stop. */
export function pollDelay(run) {
  if (!run) return null;
  if (memoryStatus(run) === 'running') return 5000;
  if (methodStatus(run) === 'running') return 15000;
  return null;
}

const PHASE_KEYS = ['analyze', 'generate', 'test', 'evaluate'];
/** The four learning phases as [stage key, label]. */
export const methodPhases = () => PHASE_KEYS.map(key => [key, t(`phase.${key}`)]);
const PROJECT_STATUSES = new Set(['idle', 'queued', 'running', 'completed', 'failed', 'cancelled']);

export function projectPhases(p) {
  const phases = methodPhases();
  if (p?.status === 'completed') return phases.map(([, label]) => ({label, state: 'ok'}));
  const index = phases.findIndex(([key]) => key === p?.stage);
  const active = p?.status === 'running' || p?.status === 'queued';
  return phases.map(([, label], i) => ({label, state: index < 0 ? '' : i < index ? 'ok' : i === index ? (active ? 'run' : 'err') : ''}));
}

export function projectView(p, slot) {
  const status = PROJECT_STATUSES.has(p?.status) ? p.status : 'idle';
  const attempt = Math.max(1, Math.trunc(Number(p?.attempt) || 1));
  const name = t('project.label', {slot});
  const title = String(p?.title ?? '') || name;
  // Titles taken from file names often start with the project already ("项目A 衡石动力", "Project A Acme"); name it once.
  const rest = title.replace(new RegExp(`^(?:项目|project)\\s*${slot}(?![A-Za-z])[\\s·:：-]*`, 'i'), '').trim();
  return {
    slot, title, heading: rest ? `${name} · ${rest}` : name, status,
    label: t(`project.status.${status}`) + (attempt > 1 ? t('project.attempt', {n: attempt}) : ''),
    progress: status === 'completed' ? 100 : Math.max(0, Math.min(100, Math.round(Number(p?.progress) || 0))),
    phases: projectPhases(p), error: p?.error ? String(p.error) : null,
    bp: p?.bp?.name ?? null, proposal: p?.proposal?.name ?? null,
  };
}

/** Guess project slot and role from a file name ("项目A 衡石动力 BP.md", "Project A Acme BP.md" -> A / bp). */
export function guessMethodSlot(name) {
  const text = stem(name);
  const slot = /项目\s*A|(?:^|[^A-Za-z])A(?:[^A-Za-z]|$)/i.test(text) ? 'A' : /项目\s*B|(?:^|[^A-Za-z])B(?:[^A-Za-z]|$)/i.test(text) ? 'B' : null;
  const role = /建议书|proposal|recommendation|memo|决策|报告/i.test(text) ? 'proposal' : /BP|商业计划|business plan|pitch|deck/i.test(text) ? 'bp' : null;
  return {slot, role};
}

/** Pre-fill the slot dialog: keep confident guesses, then fill unknowns with free cells (cells already holding a file last). */
export function assignMethodFiles(names, taken = []) {
  const cells = SLOTS.flatMap(slot => ROLES.map(role => ({slot, role})));
  const key = c => `${c.slot}:${c.role}`;
  const rows = names.map(name => ({name, ...guessMethodSlot(name)}));
  const used = new Set(rows.filter(r => r.slot && r.role).map(key));
  const occupied = new Set(taken.map(key));
  const fits = row => c => !used.has(key(c)) && (!row.slot || c.slot === row.slot) && (!row.role || c.role === row.role);
  for (const row of rows) {
    if (row.slot && row.role) continue;
    const pick = cells.find(c => fits(row)(c) && !occupied.has(key(c))) ?? cells.find(fits(row));
    if (pick) { row.slot = pick.slot; row.role = pick.role; used.add(key(pick)); }
  }
  return rows;
}

export function validateAssignments(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!SLOTS.includes(row.slot) || !ROLES.includes(row.role)) return t('assign.pick', {name: row.name});
    const k = `${row.slot}:${row.role}`;
    if (seen.has(k)) return t('assign.duplicate', {project: t('project.label', {slot: row.slot}), role: roleLabel(row.role), first: seen.get(k), second: row.name});
    seen.set(k, row.name);
  }
  return null;
}

const TEXT_FILE = /\.(?:md|markdown|txt)$/i, DOCUMENT_FILE = /\.(?:pdf|docx?)$/i;
const tooLarge = (name, limit) => ({ok: false, kind: null, code: 'file_too_large', message: t('file.too_large', {name, limit})});

/** A document the gateway refused as not text: retrying gives the same answer, so step 1 shows no 重试 for it. */
export const isTextOnlyRefusal = error => typeof error === 'string' && LOCALES.some(locale => error.startsWith(t('err.text_only', undefined, locale).split(/[,，.]/)[0]));

const TEXT_ONLY = name => ({ok: false, kind: null, code: 'unsupported_file', message: t('file.text_only', {name})});

/**
 * Client-side pre-check; the server repeats every check and stays authoritative. documents = false (from
 * /api/demo/me memory.documents) refuses PDF and Word in step 1: Memory there takes only Markdown and text.
 */
export function classifyFile(file, group, {documents = true} = {}) {
  const name = String(file?.name ?? ''), size = Number(file?.size ?? 0);
  if (size <= 0) return {ok: false, kind: null, code: 'empty_file', message: t('file.empty', {name})};
  if (group === 'memory') {
    if (TEXT_FILE.test(name)) return size > LIMITS.memoryText ? tooLarge(name, t('limit.text_chars')) : {ok: true, kind: 'text', code: null, message: ''};
    if (!documents) return TEXT_ONLY(name);
    if (DOCUMENT_FILE.test(name)) return size > LIMITS.memoryDocument ? tooLarge(name, `${LIMITS.memoryDocument / MiB} MB`) : {ok: true, kind: 'document', code: null, message: ''};
    return {ok: false, kind: null, code: 'unsupported_file', message: t('file.memory_types', {name})};
  }
  if (TEXT_FILE.test(name)) return size > LIMITS.methodOrBp ? tooLarge(name, `${LIMITS.methodOrBp / MiB} MB`) : {ok: true, kind: 'text', code: null, message: ''};
  return {ok: false, kind: null, code: 'unsupported_file', message: t('file.text_types', {name})};
}

export const sourceList = sources => (Array.isArray(sources) ? sources : [])
  .map(s => typeof s === 'string' ? {title: s, verified: true} : {title: String(s?.title ?? ''), verified: s?.verified !== false})
  .filter(s => s.title);

function personView(p, kind) {
  const name = String(p?.name ?? '');
  const tag = kind === 'expert'
    ? (p?.independent ? {text: t('report.independent'), tone: 'ok'} : {text: t('report.maybe_not_independent'), tone: 'warn'})
    : {text: [p?.degree, p?.relation].filter(Boolean).map(String).join(' · '), tone: /2/.test(String(p?.degree ?? '')) ? 'blue' : 'ok'};
  return {name, initial: name.slice(0, 1), tag, line: String((kind === 'expert' ? p?.role : p?.path) ?? ''), why: String(p?.why ?? ''), sources: sourceList(p?.sources)};
}

/** View model for the report cards (port of app.js renderReport()). */
export function reportView(analysis, {replay = false, bpName: currentBp = '', timeZone} = {}) {
  // A saved analysis names its own BP; only older saves without it fall back to the run's current BP.
  const bpName = typeof analysis?.bpName === 'string' && analysis.bpName ? analysis.bpName : currentBp;
  const r = analysis?.report ?? {};
  const queries = (Array.isArray(analysis?.queries) ? analysis.queries : []).map(q => ({query: String(q?.query ?? ''), titles: Array.isArray(q?.titles) ? q.titles.map(String) : []}));
  const experts = (Array.isArray(r.experts) ? r.experts : []).map(p => personView(p, 'expert'));
  const people = (Array.isArray(r.people) ? r.people : []).map(p => personView(p, 'people'));
  const topSources = sourceList(r.top_question?.sources);
  const unverified = [topSources, ...experts.map(p => p.sources), ...people.map(p => p.sources)].flat().filter(s => !s.verified).length;
  const title = bpTitle(bpName);
  return {
    heroTitle: title ? t('report.hero_title', {title}) : t('report.hero_title_bare'),
    note: replay ? t('report.note_replay', {time: fmtTime(analysis?.at, timeZone)}) : t('report.note_live', {seconds: Math.round(Number(analysis?.seconds) || 0), n: queries.length}),
    verdict: {title: String(r.verdict?.title ?? ''), text: String(r.verdict?.text ?? '')},
    topQuestion: {title: String(r.top_question?.title ?? ''), text: String(r.top_question?.text ?? ''), sources: topSources},
    experts, expertGap: String(r.expert_gap ?? ''), people, peopleGap: String(r.people_gap ?? ''), queries, unverified,
  };
}

export const emptyLive = () => ({rows: []});

/** Fold one step 3 stream event into the live progress rows (port of app.js analyze() row handling). Pure. */
export function applyLiveEvent(live, event) {
  const rows = live.rows.map(row => ({...row}));
  const settle = () => { for (const row of rows) if (row.state === 'run') row.state = 'ok'; };
  const add = (text, query = null) => { settle(); rows.push({text, find: '', state: 'run', query}); };
  if (event?.type === 'phase') add(String(event.text ?? ''));
  else if (event?.type === 'recall') add(t('live.search', {query: event.query}), String(event.query));
  else if (event?.type === 'recall_done') {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].query === String(event.query)) {
        const n = Array.isArray(event.titles) ? event.titles.length : 0;
        rows[i].find = n ? t('live.found', {n}) : t('live.none');
        break;
      }
    }
  } else if (event?.type === 'report') settle();
  return {rows};
}
