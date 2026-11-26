// Step 2 of the investor demo: RSI learns the investor's method from project A, then project B
// refines the same Recipe (role "recipe" + recipe_id; when A's Recipe did not qualify, RSI takes no
// recipe_id and B starts a new Recipe from A's text). Requests only submit and poll; RSI does
// the long work. Concurrent polls are safe because every create uses a deterministic
// idempotency key: same project files and attempt number -> same execution.
import {sha256Hex} from '../crypto.mjs';
import {ServiceError, scrubMessage} from '../http.mjs';
import {DEFAULT_LOCALE, normalizeLocale, t} from '../../../shared/i18n.mjs';
import {kvDelete, kvGetJson, kvPutJson} from '../kv.mjs';
import {demoError, getFile, putFile, saveRun, withRefreshError} from '../runs.mjs';
import {chat} from '../services/llm.mjs';
import {createExecution, getExecution, getRecipe, listRecipes, recipeMarkdown, toUpload} from '../services/rsi.mjs';
import {baseName, checkProjectFile, mimeFor, projectTitle, validateMethodTarget} from './materials.mjs';

export const MAX_ATTEMPTS = 3;
export const RULES_LOCK_TTL_SECONDS = 300;
/** The task text sent with every learning run; the learned method (name, description, full text) is written in its language. */
export const METHOD_CONTEXT = Object.freeze({
  en: 'Task: an investor makes early-stage investments. After receiving a startup\'s BP (business plan), the investment manager has to write '
    + 'an investment recommendation following this investor\'s method: judge whether the core technology and business can actually be delivered '
    + '(for example, whether it can be mass-produced), decide which independent experts to ask to verify the key metrics, which people who have '
    + 'worked with the founder to ask for founder background checks, which figures in the BP to question first, and finally give a recommendation '
    + 'to invest or to pass.\n'
    + 'In the attachments, "input" is the BP of that time and "artifact" is the final investment recommendation this investor approved.\n'
    + 'Write the learned method (its name, description and full text) in English.\n',
  zh: '任务：一位投资人做早期项目投资。投资经理拿到创业公司的 BP 后，要按这位投资人的方法写一份投资建议书：'
    + '判断核心技术和业务能否落地（例如能否量产）、需要找哪些独立专家验证关键指标、找哪些共事过的人做创始人背调、'
    + 'BP 里哪些数据要首先追问，最后给出投或不投的建议。\n'
    + '附件里 input 是当时的 BP，artifact 是这位投资人认可的最终投资建议书。\n'
    + '学到的方法（名称、说明和全文）一律用中文书写。\n',
});
/** The prompt that asks the model for the 4 to 6 rules of the Recipe card, in a language. */
export const RULES_PROMPT = Object.freeze({
  en: 'Below is the method RSI learned from an investor\'s past investment recommendations. Summarize its most important judgment rules in 4 to 6 items, '
    + 'each at most 20 words, in the investor\'s own voice, written in English. Output only a JSON array of strings.\n\n',
  zh: '下面是 RSI 从一位投资人的过往投资建议书里学到的方法。请用 4 到 6 条概括其中最关键的判断规矩，'
    + '每条不超过 32 个字，用投资人自己的口吻，只输出 JSON 字符串数组。\n\n',
});
export const methodContext = locale => METHOD_CONTEXT[normalizeLocale(locale) ?? DEFAULT_LOCALE];
export const rulesPrompt = locale => RULES_PROMPT[normalizeLocale(locale) ?? DEFAULT_LOCALE];
const ACTIVE = new Set(['queued', 'running']);
const EXECUTION_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

const isAuthError = err => err?.status === 401;
const isTransient = err => err instanceof ServiceError && Boolean(err.service) && !isAuthError(err);
const isClientError = err => Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
// A service error carries its own line (passed through); anything else (a bug, a bad answer) is shown as the demo server's error.
const errorText = (err, locale) => scrubMessage(err instanceof ServiceError ? err.text(locale) : `Demo server ${err?.name ?? 'Error'}: ${err?.message ?? err}`).slice(0, 300);
const projectOf = (run, slot) => run.method.projects.find(project => project.slot === slot);

export const rulesLockKey = (accountId, runId) => `lock:rules:${accountId}:${runId}`;

/** A until it has completed, then B. */
export function nextProject(run) {
  const a = projectOf(run, 'A');
  return a.status === 'completed' ? projectOf(run, 'B') : a;
}

function progressOf(exec) {
  const percent = Math.round(Number(exec?.progress_percent) || 0);
  return {
    status: EXECUTION_STATUSES.has(exec?.status) ? exec.status : 'queued',
    stage: typeof exec?.stage === 'string' ? exec.stage : null,
    progress: Math.max(0, Math.min(100, percent)),
  };
}

function lastScore(exec) {
  const results = Array.isArray(exec?.test_results) ? exec.test_results : [];
  const score = results.length ? results[results.length - 1]?.score : null;
  return typeof score === 'number' ? score : Number.NaN;
}

/** RSI's own failure record (code, stage, message), passed through to the page and logged for operators (scrubbed). */
function describeFailure(exec, locale) {
  if (exec.status === 'cancelled') return t('method.cancelled', undefined, locale);
  const error = exec.error;
  const code = typeof error === 'string' ? error : error?.code;
  const message = typeof error === 'object' && error?.message ? String(error.message) : '';
  console.warn('demo: RSI execution failed', JSON.stringify({execution: exec.id ?? null, code: code ?? null, stage: error?.stage ?? null,
    message: scrubMessage(message).slice(0, 300)}));
  const where = error?.stage ? ` at ${error.stage}` : '';
  const what = [code, message].filter(Boolean).join(': ');
  return scrubMessage(`RSI execution${exec.id ? ` ${exec.id}` : ''} failed${where}${what ? `: ${what}` : ''}`).slice(0, 300);
}

/** demo-<vu>-method-<sha16 of slot + files>-<attempt>; a retry always gets a new attempt number. */
export async function methodKey(vuId, slot, uploads, attempt) {
  const material = uploads.map(file => `${file.role}\n${file.name}\n${file.encoding}\n${file.content}`).join('\n\n');
  return `demo-${vuId}-method-${(await sha256Hex(`${slot}\n${material}`)).slice(0, 16)}-${attempt}`;
}

/**
 * The Recipe version an execution produced. RSI only marks a version active once it qualifies, so a
 * finished execution's own recipe_version_id is the one to read; without it, fall back to the list
 * row's active, then latest version.
 */
async function loadRecipe(cfg, token, vuId, recipeId, versionId) {
  if (!recipeId) throw new ServiceError('rsi', 409, 'recipe_missing', 'err.recipe_no_id');
  let selector = typeof versionId === 'string' && versionId ? versionId : null;
  if (!selector) {
    const list = await listRecipes(cfg, token, vuId, [recipeId]);
    const summary = Array.isArray(list) ? list.find(item => (item?.id ?? item?.recipe_id) === recipeId) : null;
    selector = summary?.active_version_id || summary?.latest_version_id || 'latest';
  }
  const recipe = await getRecipe(cfg, token, vuId, recipeId, selector);
  const version = recipe?.selected_version;
  if (!version?.content) throw new ServiceError('rsi', 409, 'recipe_missing', 'err.recipe_no_version');
  return {recipe, version};
}

/**
 * A's learned method as B's recipe file. RSI adds B's version to A's Recipe only when that Recipe has an
 * available (active, unarchived) version and refuses the recipe_id otherwise ("base Recipe has no available
 * version"). When A's Recipe did not qualify, B therefore starts a new Recipe from A's produced text.
 */
async function recipeFileFor(cfg, token, vuId, recipeId, versionId) {
  const {recipe, version} = await loadRecipe(cfg, token, vuId, recipeId, versionId);
  const available = Boolean(recipe.active_version_id) && !recipe.archived_at;
  return {name: 'RECIPE.md', content: recipeMarkdown(version.content), encoding: 'utf-8', role: 'recipe', ...(available ? {recipe_id: recipeId} : {})};
}

/** Creates one execution; returns the project patch. Throws on any failure. */
async function launch(cfg, session, run, slot, attempt, recipeFile, locale) {
  const project = projectOf(run, slot);
  const uploads = [];
  for (const [ref, role] of [[project.bp, 'input'], [project.proposal, 'artifact']]) {
    const file = await getFile(cfg, session.accountId, run.id, ref.fileKey);
    if (!file) throw demoError(409, 'step_not_ready', 'err.project_file_expired', {slot, name: ref.name});
    uploads.push({...toUpload(ref.name, file.bytes), role});
  }
  if (recipeFile) uploads.push(recipeFile);
  const idempotencyKey = await methodKey(run.vuId, slot, uploads, attempt);
  const exec = await createExecution(cfg, session.accessToken, run.vuId,
    {idempotencyKey, context: {name: 'method-context.md', content: methodContext(locale)}, files: uploads});
  return {executionId: exec.id, attempt, ...progressOf(exec), error: null};
}

/**
 * Automatic launch used while polling. A transient service failure (5xx, timeout, network) is
 * reported through note() and returns null: nothing is saved and the attempt is not used up, so
 * the next poll tries the same attempt (same idempotency key) again. A 4xx (for example a quota or
 * validation answer) or a demo error becomes a failed project that stops learning with that reason;
 * any other error becomes a failed project that the next poll retries while attempts remain.
 * execA undefined means "read project A's execution".
 */
async function attemptLaunch(cfg, session, run, slot, attempt, execA, note, locale) {
  try {
    let recipeFile = null;
    if (slot === 'B') {
      const source = execA !== undefined
        ? execA
        : await getExecution(cfg, session.accessToken, run.vuId, projectOf(run, 'A').executionId);
      recipeFile = await recipeFileFor(cfg, session.accessToken, run.vuId, source?.recipe_id ?? null, source?.recipe_version_id);
    }
    return {patch: await launch(cfg, session, run, slot, attempt, recipeFile, locale), stop: null};
  } catch (err) {
    if (isAuthError(err)) throw err;
    if (isTransient(err) && !isClientError(err)) {
      note(err);
      return null;
    }
    const text = errorText(err, locale);
    return {
      patch: {executionId: null, attempt, status: 'failed', stage: null, progress: 0, error: text},
      stop: isClientError(err) ? t('method.project_not_started', {slot, reason: text}, locale) : null,
    };
  }
}

async function retryOrStop(cfg, session, run, project, failure, now, note, locale) {
  if (project.attempt >= MAX_ATTEMPTS) {
    return saveRun(cfg, session.accountId, run.id, draft => {
      const current = projectOf(draft, project.slot);
      if (draft.method.error || current.attempt !== project.attempt || current.executionId !== project.executionId) return false;
      Object.assign(current, {status: 'failed', error: failure});
      draft.method.error = t('method.project_gave_up', {slot: project.slot, attempts: project.attempt, reason: failure}, locale);
      return true;
    }, {now});
  }
  const launched = await attemptLaunch(cfg, session, run, project.slot, project.attempt + 1, undefined, note, locale);
  if (!launched) return run;
  const {patch, stop} = launched;
  return saveRun(cfg, session.accountId, run.id, draft => {
    const current = projectOf(draft, project.slot);
    if (draft.method.error || current.attempt !== project.attempt) return false;
    Object.assign(current, patch);
    draft.method.error = stop;
    return true;
  }, {now});
}

async function completeA(cfg, session, run, a, exec, now, note, locale) {
  const b = projectOf(run, 'B');
  const launched = await attemptLaunch(cfg, session, run, 'B', b.attempt + 1, exec, note, locale);
  if (!launched) return run;
  const {patch, stop} = launched;
  return saveRun(cfg, session.accountId, run.id, draft => {
    const currentA = projectOf(draft, 'A');
    const currentB = projectOf(draft, 'B');
    if (draft.method.error || currentA.executionId !== a.executionId || currentA.status === 'completed'
      || currentB.attempt !== b.attempt) return false;
    Object.assign(currentA, {status: 'completed', stage: exec.stage || 'done', progress: 100, error: null});
    Object.assign(currentB, patch);
    draft.method.error = stop;
    return true;
  }, {now});
}

async function completeB(cfg, session, run, b, exec, now, note, locale) {
  const token = session.accessToken;
  const lockKey = rulesLockKey(session.accountId, run.id);
  if (await kvGetJson(cfg.kv, lockKey)) return run;
  let version;
  try {
    ({version} = await loadRecipe(cfg, token, run.vuId, exec.recipe_id, exec.recipe_version_id));
  } catch (err) {
    if (isAuthError(err)) throw err;
    if (!isClientError(err)) {
      note(err);
      return run;
    }
    return saveRun(cfg, session.accountId, run.id, draft => {
      const current = projectOf(draft, 'B');
      if (draft.method.error || current.executionId !== b.executionId) return false;
      Object.assign(current, {status: 'failed', error: errorText(err, locale)});
      draft.method.error = t('method.recipe_unreadable', {reason: errorText(err, locale)}, locale);
      return true;
    }, {now});
  }
  const at = now();
  await kvPutJson(cfg.kv, lockKey, {at}, {ttl: RULES_LOCK_TTL_SECONDS});
  try {
    let execA = null;
    try {
      execA = await getExecution(cfg, token, run.vuId, projectOf(run, 'A').executionId);
    } catch (err) {
      if (isAuthError(err)) throw err;
    }
    const scores = [lastScore(execA), lastScore(exec)].filter(Number.isFinite);
    const content = version.content;
    const rules = await summarizeRules(cfg, token, content.instructions, locale);
    const recipe = {
      recipeId: exec.recipe_id, versionId: version.id ?? null, number: version.number ?? null,
      name: content.name || '', description: content.description || '', instructions: content.instructions || '',
      selfTest: scores.length ? Math.round(Math.min(...scores) * 100) : null, rules,
    };
    return await saveRun(cfg, session.accountId, run.id, draft => {
      const current = projectOf(draft, 'B');
      if (draft.method.recipe || current.executionId !== b.executionId) return false;
      Object.assign(current, {status: 'completed', stage: exec.stage || 'done', progress: 100, error: null});
      draft.method.recipe = recipe;
      draft.method.completedAt = at;
      draft.method.error = null;
      return true;
    }, {now});
  } finally {
    await kvDelete(cfg.kv, lockKey);
  }
}

function assertMethodEditable(run, slot) {
  const project = projectOf(run, slot);
  if (run.method.recipe || project.status === 'completed' || (run.method.startedAt && !run.method.error)) {
    throw demoError(409, 'step_not_ready', 'err.method_started');
  }
}

/** Stores a step 2 project file (group 'method', slot A|B, role bp|proposal) or the step 3 BP (group 'bp'). */
export async function setMethodFile(cfg, session, run, {group, slot, role, name, bytes, now = Date.now}) {
  const fileName = baseName(name);
  if (group === 'bp') {
    checkProjectFile('bp', fileName, bytes);
    await putFile(cfg, session.accountId, run.id, 'bp', {name: fileName, mime: mimeFor(fileName), bytes});
    return saveRun(cfg, session.accountId, run.id, draft => {
      if (draft.bp?.fileKey === 'bp' && draft.bp.name === fileName) return false;
      draft.bp = {fileKey: 'bp', name: fileName};
      return true;
    }, {now});
  }
  if (group !== 'method') throw demoError(400, 'invalid_group', 'err.invalid_group');
  const target = validateMethodTarget(slot, role);
  checkProjectFile('method', fileName, bytes);
  assertMethodEditable(run, target.slot);
  const fileKey = `method-${target.slot}-${target.role}`;
  await putFile(cfg, session.accountId, run.id, fileKey, {name: fileName, mime: mimeFor(fileName), bytes});
  return saveRun(cfg, session.accountId, run.id, draft => {
    assertMethodEditable(draft, target.slot);
    const project = projectOf(draft, target.slot);
    project[target.role] = {fileKey, name: fileName};
    if (target.role === 'bp' || !project.bp) project.title = projectTitle(target.slot, fileName);
    return true;
  }, {now});
}

/** POST …/method: starts (or, after a stop, restarts by hand) the next project that has not completed. */
export async function startMethod(cfg, session, run, {now = Date.now, locale = DEFAULT_LOCALE} = {}) {
  const missing = run.method.projects.filter(project => !project.bp || !project.proposal).map(project => t('project.label', {slot: project.slot}, locale));
  if (missing.length) throw demoError(409, 'step_not_ready', 'err.method_files_missing', {projects: missing.join(t('list.sep', undefined, locale))});
  if (run.method.recipe) return run;
  const project = nextProject(run);
  if (ACTIVE.has(project.status) || project.status === 'completed') return run;
  const at = now();
  let recipeFile = null;
  if (project.slot === 'B') {
    const execA = await getExecution(cfg, session.accessToken, run.vuId, projectOf(run, 'A').executionId);
    recipeFile = await recipeFileFor(cfg, session.accessToken, run.vuId, execA.recipe_id, execA.recipe_version_id);
  }
  const patch = await launch(cfg, session, run, project.slot, project.attempt + 1, recipeFile, locale);
  return saveRun(cfg, session.accountId, run.id, draft => {
    const current = projectOf(draft, project.slot);
    if (current.attempt !== project.attempt) return false;
    Object.assign(current, patch);
    if (draft.method.startedAt == null) draft.method.startedAt = at;
    draft.method.error = null;
    return true;
  }, {now});
}

/**
 * GET …/runs/:id: polls the active execution, starts B after A, retries failures, finishes the Recipe view.
 * A transient RSI failure keeps the last state and is reported as run.refreshError; an incoming
 * refreshError (from refreshMemory) is carried forward.
 */
export async function refreshMethod(cfg, session, run, {now = Date.now, locale = DEFAULT_LOCALE} = {}) {
  let failure = null;
  const note = err => {
    if (!failure && isTransient(err)) failure = err;
  };
  const result = await pollMethod(cfg, session, run, now, note, locale);
  return withRefreshError(result, run.refreshError || failure);
}

async function pollMethod(cfg, session, run, now, note, locale) {
  if (run.method.recipe || !run.method.startedAt || run.method.error) return run;
  const project = nextProject(run);
  // B can already be completed when it is stored: an idempotent resubmission returns the finished execution.
  // The Recipe is still missing then, so it goes through the same completion path as a polled execution.
  if ((ACTIVE.has(project.status) || (project.slot === 'B' && project.status === 'completed')) && project.executionId) {
    let exec;
    try {
      exec = await getExecution(cfg, session.accessToken, run.vuId, project.executionId);
    } catch (err) {
      if (isAuthError(err)) throw err;
      if (err?.status !== 404) {
        note(err);
        return run;
      }
      exec = {id: project.executionId, status: 'failed', error: {code: 'execution_not_found'}};
    }
    if (exec.status === 'completed') {
      return project.slot === 'A'
        ? completeA(cfg, session, run, project, exec, now, note, locale)
        : completeB(cfg, session, run, project, exec, now, note, locale);
    }
    if (exec.status === 'failed' || exec.status === 'cancelled') {
      return retryOrStop(cfg, session, run, project, describeFailure(exec, locale), now, note, locale);
    }
    const progress = progressOf(exec);
    if (progress.status === project.status && progress.stage === project.stage && progress.progress === project.progress) return run;
    return saveRun(cfg, session.accountId, run.id, draft => {
      const current = projectOf(draft, project.slot);
      if (current.executionId !== project.executionId || !ACTIVE.has(current.status)) return false;
      Object.assign(current, progress);
      return true;
    }, {now});
  }
  if (project.status === 'failed' || (project.slot === 'B' && project.status === 'idle')) {
    return retryOrStop(cfg, session, run, project, project.error || t('method.not_finished_short', undefined, locale), now, note, locale);
  }
  return run;
}

/** Model reply -> up to 6 non-empty strings from the first-to-last bracket JSON array; thinking is ignored. */
export function parseRules(content) {
  const text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 6);
}

/**
 * Used when the model cannot summarise: the first meaningful lines of the Recipe. Section headings (「适用场景」,
 * 「一、准备」) name a part of the method rather than state a rule, so they are used only when the Recipe has nothing else.
 */
export function fallbackRules(instructions) {
  const lines = String(instructions ?? '').split('\n').map(raw => {
    const heading = /^\s*(#{1,6}\s+|[一二三四五六七八九十]+、\s*)/.test(raw);
    const text = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)、]\s*|[一二三四五六七八九十]+、\s*)/, '').replace(/\*\*/g, '').replace(/[:：]\s*$/, '').trim();
    return {heading, text};
  }).filter(line => line.text.length >= 4);
  const rules = lines.filter(line => !line.heading);
  return (rules.length ? rules : lines).slice(0, 6).map(({text}) => (text.length > 60 ? `${text.slice(0, 59)}…` : text));
}

/** 4 to 6 short rules for the recipe card, written by the model from the learned Recipe (3 tries). */
export async function summarizeRules(cfg, token, instructions, locale = DEFAULT_LOCALE) {
  const text = String(instructions ?? '');
  if (!text.trim()) return [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reply = await chat(cfg, token, {messages: [{role: 'user', content: rulesPrompt(locale) + text}], maxTokens: 16000});
      const rules = parseRules(reply?.content);
      if (rules.length) return rules;
    } catch {
      // The summary only decorates the recipe card; any model failure falls through to the next try.
    }
  }
  return fallbackRules(text);
}
