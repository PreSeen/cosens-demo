// /demo/investor/: page controller (port of real/static/app.js behaviour onto the /api/demo run API).
import '../lib/boot-locale';
import '../styles/demo.css';
import { t } from '../../../../shared/i18n.mjs';
import { mountShell, type Shell } from '../lib/shell';
import {
  analyze, api, codeOf, loadDemoText, loadManifest,
  type Analysis, type GroupId, type Manifest, type ManifestFile, type Role, type Run, type RunReply, type RunSummary, type Slot,
} from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import {
  analysisErrorMessage, analyzedRun, applyLiveEvent, assignMethodFiles, autoFocus, bpTitle, canRetry, chipsFor, classifyFile, deliverCheck, displayRunName, emptyLive, handedGroups,
  errorMessage, esc, fmtTime, guessMethodSlot, heroForRun, isSpaceRefusal, linkedRunPlan, methodFilesComplete, ownFileCheck, pollDelay, projectOf,
  outlinedGroup, ownFiles, reportView, ringStep, runStepText, spaceChoiceView, stageOf, validateAssignments,
  type AssignRow, type Chooser, type HeroView, type LiveState, type Stage,
} from '../lib/logic.mjs';
import { startCard } from './spaces';
import {
  acceptFor, alertCard, assignCard, bpCard, bpStartCard, groupOf, liveCard, liveRows, loadingCard, memoryCaps, memoryCard,
  memoryStartCard, methodCard, methodStartCard, setHero, setMemoryCaps, setPrivacy, setStepButtons, type AlertView,
} from './steps';
import { reportHtml } from './report';
import { closeViewer, markGroups, openViewer, renderMaterials, toggleFold, viewerOpen } from './materials';

// Step 1 files go one at a time: the server's saveRun has no compare-and-set, so parallel writes to one run can conflict or drop a file.
const UPLOAD_CONCURRENCY = 1;
const SLOW_SECONDS = 150;

/**
 * tag: 'link' = about the ?run= link, 'file' = a rejected file (kept when picking that file creates the run).
 * gate: when Retry may start. 'lock' (default) waits until no step is in flight, 'replay' follows Last result, 'none' always.
 * An alert keeps its title key and how to build its message, not the text, so a language switch rewrites it.
 */
type AlertTag = 'link' | 'file' | null;
type AlertGate = 'lock' | 'replay' | 'none';
type TitleParams = Record<string, string | number>;
type Alert = Omit<AlertView, 'title' | 'message'> & { titleKey: string; titleParams?: TitleParams; message: () => string; action: (() => void) | null; tag: AlertTag; gate: AlertGate };
type AlertOptions = { retry?: () => void; replay?: boolean; tag?: AlertTag; gate?: AlertGate; message?: string | (() => string); params?: TitleParams };
type Job = { name: string; send: (runId: string) => Promise<Run> };
type Failure = { job: Job; err: unknown };

const state = {
  shell: null as Shell | null,
  manifest: null as Manifest | null,
  runs: [] as RunSummary[],
  run: null as Run | null,
  loaded: false,
  manual: null as number | null,
  busy: null as string | null,
  creating: false,
  /** Name of the existing space a run is being created in; null while creating a new one. */
  creatingIn: null as string | null,
  /** The start card's choice, kept across renders and runs until a run starts from it. */
  chooser: { mode: 'new', list: null, picked: null, error: null } as Chooser,
  /** The start card is open over a run (Switch → Start in an existing space). */
  choosing: false,
  spacesToken: 0,
  sending: null as { promptKey: string; done: number; total: number; cur: number } | null,
  live: null as (LiveState & { t0: number; bpName: string }) | null,
  liveAbort: null as AbortController | null,
  report: null as { analysis: Analysis; replay: boolean } | null,
  heroOverride: null as (() => HeroView) | null,
  alerts: [] as Alert[],
  nextAlert: 1,
  assign: null as { files: File[]; rows: AssignRow[]; error: string | null } | null,
  ownFiles: new Map<string, File>(),
  textCache: new Map<string, string>(),
  pendingAnalyze: false,
  pollTimer: 0,
  pollFailed: false,
  polling: null as Promise<void> | null,
  refreshAlertId: null as number | null,
  menuOpen: false,
  recipeView: { body: false, desc: false },
  panelKey: '',
  panelHtml: '',
  viewerToken: 0,
};

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const panel = byId('panel'), mats = byId('mats'), hero = byId('hero'), mark = byId('mark');
/**
 * One hidden picker per group for the Choose files buttons, created once outside #panel: render() replaces #panel while
 * step 1 polls, and an input inside it would be detached (dropping its change event) while the file dialog is open.
 * Separate from the six fixed #ownInputs, which keep their own unordered handling.
 */
const pickInputs = (() => {
  const box = document.createElement('div');
  box.id = 'pickInputs';
  box.hidden = true;
  const inputs = {} as Record<GroupId, HTMLInputElement>;
  for (const gid of ['memory', 'method', 'bp'] as const) {
    const input = document.createElement('input');
    Object.assign(input, { type: 'file', accept: acceptFor(gid), multiple: gid !== 'bp' });
    input.dataset.input = gid;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      handleOwnFiles(gid, files);
    });
    box.append(input);
    inputs[gid] = input;
  }
  document.body.append(box);
  return inputs;
})();
// Nothing may act on the run before boot has loaded it: a step picked or a file given meanwhile would be judged
// against an empty run (refused, or worse, a dropped file would create a new run) and boot's setRun would undo the step.
const isLocked = (): boolean => !state.loaded || !!state.busy || state.creating;
const lockHint = (): string => t(state.loaded ? 'hint.busy' : 'hint.loading');
// The slow-analysis hint points at Last result, so that one control stays usable while step 3 streams.
const canUse = (act: string | undefined): boolean => !isLocked() || (act === 'replay' && state.busy === 'analyze');
const isAuth = (err: unknown): boolean => codeOf(err) === 'not_authenticated';

let hintTimer = 0;
function hint(text: string, sticky = false): void {
  byId('hint').textContent = text;
  window.clearTimeout(hintTimer);
  if (text && !sticky) hintTimer = window.setTimeout(() => { byId('hint').textContent = ''; }, 4000);
}

function pushAlert(titleKey: string, err: unknown, options: AlertOptions = {}): void {
  if (isAuth(err)) return;
  const action = options.retry && canRetry(err) ? options.retry : null;
  const { message } = options;
  state.alerts.push({ id: state.nextAlert++, titleKey, titleParams: options.params, message: typeof message === 'function' ? message : () => message ?? errorMessage(err), retry: !!action, replay: !!options.replay, action, tag: options.tag ?? null, gate: options.gate ?? 'lock' });
  render();
}

const alertView = (a: Alert): AlertView => ({ id: a.id, title: t(a.titleKey, a.titleParams), message: a.message(), retry: a.retry, replay: a.replay });

/** A Retry that would be refused right now keeps its alert (dropping it first would lose it). */
const retryBlocked = (a: Alert): boolean => a.gate === 'none' ? false : a.gate === 'replay' ? !canUse('replay') : isLocked();

function dropAlert(id: number): Alert | null {
  const alert = state.alerts.find(a => a.id === id) ?? null;
  state.alerts = state.alerts.filter(a => a.id !== id);
  return alert;
}

/** Keep the newest copy of the current run (responses can arrive out of order). */
function applyRun(run: Run): void {
  if (!state.run || state.run.id !== run.id) return;
  if (run.version >= state.run.version) state.run = run;
}

/** keep: alerts to carry over to the new run (the refresh notice never is; it belongs to the old run). */
function setRun(run: Run | null, keep?: (a: Alert) => boolean): void {
  window.clearTimeout(state.pollTimer);
  const alerts = keep ? state.alerts.filter(a => a.id !== state.refreshAlertId && keep(a)) : [];
  Object.assign(state, { run, report: null, recipeView: { body: false, desc: false }, alerts, manual: null, assign: null, pendingAnalyze: false, heroOverride: null, pollFailed: false, refreshAlertId: null, choosing: false });
  state.ownFiles.clear();
  const url = new URL(location.href);
  if (run) url.searchParams.set('run', run.id); else url.searchParams.delete('run');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  render();
  schedulePoll();
  if (run?.lastAnalysisAt != null) void loadSavedAnalysis(run.id);
}

async function loadSavedAnalysis(id: string): Promise<void> {
  try {
    const analysis = await api.lastAnalysis(id);
    if (state.run?.id !== id || state.live) return;
    state.report = { analysis, replay: true };
    render();
  } catch {
    // "Last result" retries this and explains a missing result.
  }
}

const currentFocus = (): number => state.live ? 3 : state.manual ?? autoFocus(stageOf(state.run));
const liveSub = (): string => t('live.sub', { n: state.live ? Math.round((Date.now() - state.live.t0) / 1000) : 0 });

function heroView(): HeroView {
  const run = state.run;
  if (state.creating) return { prompt: t('hero.creating.prompt'), sub: state.creatingIn ? t('hero.creating.sub_existing', { name: displayRunName(state.creatingIn) }) : t('hero.creating.sub'), cur: 0, spinning: true };
  if (state.choosing) return { prompt: t('hero.choosing.prompt'), sub: t('hero.choosing.sub'), cur: 0, spinning: false };
  if (state.sending) return { prompt: t(state.sending.promptKey), sub: t('hero.sending.sub', { done: state.sending.done, total: state.sending.total }), cur: state.sending.cur, spinning: true };
  if (state.live) return { prompt: t('hero.analyzing.prompt', { title: bpTitle(state.live.bpName) }), sub: liveSub(), cur: 2, spinning: true };
  if (state.heroOverride) return state.heroOverride();
  if (!state.loaded) return { prompt: t('common.loading'), sub: '', cur: 0, spinning: true };
  if (currentFocus() === 3 && state.report) {
    const v = reportView(state.report.analysis, { replay: state.report.replay, bpName: run?.bp?.name ?? '' });
    return { prompt: v.heroTitle, sub: t('hero.report.sub', { note: v.note }), cur: 3, spinning: false };
  }
  return heroForRun(run);
}

function reportActions(stage: Stage): string {
  return `<div class="btnrow center"><button class="give" type="button" data-act="analyze"${stage.ready ? '' : ' disabled'}>${esc(t('act.analyze_again'))}</button><button class="lnk" type="button" data-act="show-bp">${esc(t('act.change_bp'))}</button></div>`;
}

function panelBody(run: Run | null, stage: Stage, focus: number): string {
  if (!state.loaded) return loadingCard();
  if (state.choosing) return startCard(spaceChoiceView(state.chooser), { creating: state.creating, cancel: true });
  if (!run) return startCard(spaceChoiceView(state.chooser), { creating: state.creating }) + memoryStartCard(state.manifest);
  if (focus === 1) {
    if (stage.memory === 'none') return memoryStartCard(state.manifest);
    return memoryCard(run, !state.busy) + (stage.memory === 'done' && stage.method === 'none' ? methodStartCard(run, state.manifest) : '');
  }
  if (focus === 2) {
    if (state.assign) return assignCard(state.assign.rows, state.assign.error, !!state.busy);
    if (['none', 'partial', 'ready'].includes(stage.method)) return methodStartCard(run, state.manifest);
    return methodCard(run, state.recipeView) + (stage.method === 'done' && !run.bp ? bpStartCard(state.manifest) : '');
  }
  if (state.live) return liveCard(state.live.bpName, state.live);
  if (state.report) return reportHtml(reportView(state.report.analysis, { replay: state.report.replay, bpName: run.bp?.name ?? '' }), reportActions(stage));
  return run.bp ? bpCard(run, stage, state.pendingAnalyze) : bpStartCard(state.manifest);
}

function renderMenu(): void {
  const menu = byId('runMenu');
  document.querySelector('#runbar [data-act="switch"]')?.setAttribute('aria-expanded', String(state.menuOpen));
  menu.hidden = !state.menuOpen;
  if (!state.menuOpen) return;
  const runs = state.runs.length
    ? state.runs.map(r => `<button type="button" role="menuitem" data-run="${esc(r.id)}" data-run-id="${esc(r.id)}" class="${r.id === state.run?.id ? 'on' : ''}">${esc(displayRunName(r.vuName))}<span class="meta">${esc(runStepText(r.step))} · ${esc(fmtTime(r.createdAt))}${r.space === 'existing' ? esc(t('menu.existing_suffix')) : ''}</span></button>`).join('')
    : `<p class="meta">${esc(t('menu.empty'))}</p>`;
  menu.innerHTML = `${runs}<button type="button" role="menuitem" class="menu-foot" data-act="choose"${isLocked() ? ' disabled' : ''}>${esc(t('runbar.choose'))}</button>`;
}

function render(): void {
  const run = state.run, stage = stageOf(run), focus = currentFocus();
  const chips = chipsFor(run);
  const chip = (id: string, c: { text: string; on: boolean }): string => `<span id="${id}" class="chip${c.on ? ' on' : ''}" title="${esc(c.text)}">${esc(c.text)}</span>`;
  if (state.shell) state.shell.status.innerHTML = chip('memChip', chips.memory) + chip('methodChip', chips.method);
  byId('runName').textContent = run ? displayRunName(run.vuName) : state.loaded ? t('run.not_started') : '…';
  byId('runSpace').hidden = run?.space !== 'existing';
  document.querySelectorAll<HTMLButtonElement>('#runbar button[data-act]').forEach(button => { button.disabled = !canUse(button.dataset.act); });
  const view = heroView();
  setHero(view, stage);
  setStepButtons(stage, state.manual ?? ringStep(stage, focus));
  const liveFailed = state.alerts.some(a => a.titleKey === 'alert.live_failed');
  markGroups(mats, handedGroups(run, state.manifest, liveFailed), ownFiles(run, state.manifest), outlinedGroup(run, state.manifest, view.cur));
  renderMenu();
  // The upload hint speaks of an existing space only once one is picked.
  setPrivacy(run ? run.space === 'existing' : Boolean(chosenSpace()));
  const body = (state.pollFailed ? `<p class="meta pollnote">${esc(t('poll.failed'))}</p>` : '') + state.alerts.map(a => alertCard(alertView(a))).join('') + panelBody(run, stage, focus);
  // Re-renders of the same view (polling) must not replay the fade-in or close an opened <details>.
  const key = [run?.id ?? '', focus, state.live ? 'live' : '', state.report ? 'report' : '', state.assign ? 'assign' : '', state.choosing ? 'choose' : '', state.alerts.length].join('|');
  const html = key === state.panelKey ? body.replace(/ fade(?=")/g, '') : body;
  state.panelKey = key;
  if (html === state.panelHtml) return;
  const open = new Set([...panel.querySelectorAll<HTMLDetailsElement>('details[open][data-key]')].map(d => d.dataset.key));
  panel.innerHTML = html;
  state.panelHtml = html;
  panel.querySelectorAll<HTMLDetailsElement>('details[data-key]').forEach(d => { if (open.has(d.dataset.key)) d.open = true; });
  snapRecipes();
}

/**
 * A collapsed Recipe box ends on a line boundary: max-height drops to the top of any text line the 340 px cap
 * would cut through. Show all shows only when something is hidden. Runs after a render, on opening the details and on resize.
 */
function snapRecipes(): void {
  // The clamped description shows Expand only when the clamp hides text.
  panel.querySelectorAll<HTMLElement>('.rdesc.clamp').forEach(desc => {
    const toggle = desc.nextElementSibling as HTMLElement | null;
    if (toggle?.matches('[data-desc-toggle]')) toggle.hidden = desc.scrollHeight <= desc.clientHeight + 1;
  });
  panel.querySelectorAll<HTMLElement>('.recipe').forEach(box => {
    const toggle = box.nextElementSibling as HTMLElement | null;
    box.style.maxHeight = '';
    if (box.classList.contains('open') || !box.getClientRects().length) return;
    const cap = parseFloat(getComputedStyle(box).maxHeight);
    const top = box.getBoundingClientRect().top;
    const lines: [number, number][] = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) lines.push([rect.top - top, rect.bottom - top]);
    }
    let cut = cap;
    for (let moved = true; moved;) {
      moved = false;
      for (const [a, b] of lines) if (a < cut && b > cut) { cut = a; moved = true; }
    }
    box.style.maxHeight = `${Math.floor(cut)}px`;
    if (toggle?.matches('[data-recipe-toggle]')) toggle.hidden = box.scrollHeight <= box.clientHeight + 1;
  });
}

async function withBusy(name: string, fn: () => Promise<void>): Promise<void> {
  if (isLocked()) { hint(lockHint()); return; }
  state.busy = name;
  render();
  try {
    if (state.polling) await state.polling; // a refresh that already started finishes before the first write
    await fn();
  } finally { state.busy = null; render(); }
}

/** Show GET runs/:id's refreshError as a dismissible notice without Retry; the next clean refresh removes it. */
function noteRefresh(reply: RunReply): void {
  if (state.refreshAlertId != null) { dropAlert(state.refreshAlertId); state.refreshAlertId = null; }
  const err = reply.refreshError;
  if (!err || state.run?.id !== reply.run.id) return;
  state.refreshAlertId = state.nextAlert;
  state.alerts.push({ id: state.nextAlert++, titleKey: 'alert.refresh_failed', message: () => errorMessage(err), retry: false, replay: false, action: null, tag: null, gate: 'none' });
}

/** space: an existing space to write into; without it the server creates a new demo space. */
async function createRun(keep?: (a: Alert) => boolean, space?: { vuId: string; name: string }): Promise<Run> {
  state.creating = true;
  state.creatingIn = space?.name ?? null;
  render();
  try {
    const run = await api.createRun(space?.vuId);
    state.runs = [{ id: run.id, vuId: run.vuId, vuName: run.vuName, space: run.space ?? 'new', createdAt: run.createdAt, step: 0 }, ...state.runs.filter(r => r.id !== run.id)];
    // The choice is used up: the next start card begins at "New demo space" again.
    Object.assign(state, { choosing: false, chooser: { mode: 'new', list: null, picked: null, error: null } });
    setRun(run, keep);
    return run;
  } finally {
    state.creating = false;
    state.creatingIn = null;
    render();
  }
}

/** The space the start card points at: null for a new one, undefined while "Use an existing space" has none picked. */
function chosenSpace(): { vuId: string; name: string } | null | undefined {
  const c = state.chooser;
  if (c.mode === 'new') return null;
  const list = c.list?.status === 'ready' ? c.list.spaces : [];
  const space = list.find(s => s.vuId === c.picked);
  return space ? { vuId: space.vuId, name: space.name || space.vuId } : undefined;
}

/** "Start demo" on the start card. A refused space (read-only, or gone) stays on the card with the reason, and the list reloads. */
function startChosen(): void {
  if (isLocked()) { hint(lockHint()); return; }
  const space = chosenSpace();
  if (space === undefined) { hint(t('space.pick_first')); return; }
  state.chooser.error = null;
  createRun(undefined, space ?? undefined).catch(err => {
    if (space && isSpaceRefusal(err)) {
      Object.assign(state.chooser, { error: errorMessage(err), picked: null });
      loadSpaces();
      return;
    }
    pushAlert(space ? 'alert.space_start_failed' : 'alert.create_failed', err, { retry: startChosen });
  });
}

function loadSpaces(): void {
  const token = ++state.spacesToken;
  state.chooser.list = { status: 'loading' };
  render();
  api.listSpaces().then(
    list => { if (token === state.spacesToken) { state.chooser.list = { status: 'ready', spaces: list.spaces, readOnly: list.readOnly }; render(); } },
    err => { if (token === state.spacesToken && !isAuth(err)) { state.chooser.list = { status: 'failed', error: err }; render(); } },
  );
}

function setSpaceMode(mode: 'new' | 'existing'): void {
  state.chooser.mode = mode;
  state.chooser.error = null;
  if (mode === 'existing' && (!state.chooser.list || state.chooser.list.status === 'failed')) loadSpaces();
  else render();
}

/** Switch → "Start in an existing space": the start card over the current run, with "Use an existing space" picked and a fresh list. */
function openChooser(): void {
  state.menuOpen = false;
  if (isLocked()) { hint(lockHint()); render(); return; }
  Object.assign(state, { choosing: true, assign: null, manual: null });
  state.chooser = { mode: 'existing', list: null, picked: null, error: null };
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadSpaces();
}

function restart(): void {
  state.menuOpen = false;
  if (isLocked()) { hint(lockHint()); render(); return; }
  createRun().catch(err => pushAlert('alert.create_failed', err, { retry: restart }));
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => { while (next < items.length) await worker(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function sendJobs(runId: string, promptKey: string, cur: number, jobs: Job[], concurrency: number): Promise<Failure[]> {
  const failed: Failure[] = [];
  state.sending = { promptKey, done: 0, total: jobs.length, cur };
  render();
  try {
    await pool(jobs, concurrency, async job => {
      try { applyRun(await job.send(runId)); } catch (err) { failed.push({ job, err }); }
      if (state.sending) state.sending.done += 1;
      render();
    });
  } finally {
    state.sending = null;
  }
  return failed;
}

function reportFailed(what: 'memory' | 'method' | 'bp', failed: Failure[], retry: (jobs: Job[]) => void): void {
  if (!failed.length) return;
  const first = failed[0].err;
  const names = failed.map(f => f.job.name);
  pushAlert(`alert.files_failed.${what}`, first, {
    params: { n: failed.length },
    message: () => t('alert.files_message', { message: errorMessage(first), names: names.join(t('list.sep')) }),
    retry: canRetry(first) ? () => retry(failed.map(f => f.job)) : undefined,
  });
}

function demoJob(group: GroupId, file: ManifestFile): Job {
  if (group !== 'method') return { name: file.name, send: id => api.addDemoFile(id, { group, demoPath: file.path }) };
  const guess = guessMethodSlot(file.name);
  const slot = file.slot ?? guess.slot ?? undefined, role = file.role ?? guess.role ?? undefined;
  return { name: file.name, send: id => api.addDemoFile(id, { group, demoPath: file.path, slot, role }) };
}

const uploadJob = (group: GroupId, file: File, slot?: Slot, role?: Role): Job => ({ name: file.name, send: id => api.uploadFile(id, file, { group, slot, role }) });

async function sendMemoryJobs(runId: string, jobs: Job[]): Promise<void> {
  const failed = await sendJobs(runId, 'send.memory', 0, jobs, UPLOAD_CONCURRENCY);
  if (failed.some(f => isAuth(f.err))) return;
  reportFailed('memory', failed, retry => { void withBusy('retry-memory', () => sendMemoryJobs(runId, retry)); });
  schedulePoll();
}

async function startMethodNow(runId: string): Promise<void> {
  try {
    applyRun(await api.startMethod(runId));
    state.manual = null;
  } catch (err) {
    pushAlert('alert.learn_not_started', err, { retry: () => { void withBusy('start-method', () => startMethodNow(runId)); } });
  }
  schedulePoll();
}

async function sendMethodJobs(runId: string, jobs: Job[], start: boolean): Promise<void> {
  const failed = await sendJobs(runId, 'send.method', 1, jobs, 1);
  if (failed.some(f => isAuth(f.err))) return;
  if (failed.length) {
    reportFailed('method', failed, retry => { void withBusy('retry-method', () => sendMethodJobs(runId, retry, start)); });
    return;
  }
  if (start) await startMethodNow(runId);
}

async function sendBpJob(runId: string, job: Job): Promise<void> {
  const failed = await sendJobs(runId, 'send.bp', 2, [job], 1);
  if (failed.some(f => isAuth(f.err))) return;
  if (failed.length) {
    reportFailed('bp', failed, retry => { void withBusy('retry-bp', () => sendBpJob(runId, retry[0])).then(maybeAutoAnalyze); });
    return;
  }
  state.report = null;
  state.pendingAnalyze = true;
  state.manual = 3;
}

function maybeAutoAnalyze(): void {
  if (state.pendingAnalyze && state.run && stageOf(state.run).ready && !isLocked()) void runAnalyze();
}

/** Creating the run for these files keeps their "cannot use this file" notices (setRun clears the others), also when its Retry creates it. */
async function runInRun(fn: (run: Run) => Promise<void>, retry: () => void): Promise<void> {
  // The start card is open over a run: material must not go into that run while the visitor is choosing another space.
  if (state.choosing) { hint(t('space.choosing_hint')); return; }
  let run = state.run;
  if (!run) {
    // Material given before a run exists starts one where the start card points.
    const space = chosenSpace();
    if (space === undefined) { hint(t('space.pick_first')); return; }
    try { run = await createRun(a => a.tag === 'file', space ?? undefined); } catch (err) {
      if (space && isSpaceRefusal(err)) { Object.assign(state.chooser, { error: errorMessage(err), picked: null }); loadSpaces(); return; }
      pushAlert('alert.create_failed', err, { retry });
      return;
    }
  }
  await fn(run);
}

function deliverDemo(gid: GroupId): void {
  if (isLocked()) { hint(lockHint()); return; }
  const group = groupOf(state.manifest, gid);
  if (!group || !group.files.length) { hint(t('hint.materials_not_loaded')); return; }
  const check = deliverCheck(stageOf(state.run), gid);
  if (!check.ok) { hint(check.hint); return; }
  Object.assign(state, { manual: null, heroOverride: null, assign: null });
  void withBusy(`deliver-${gid}`, () => runInRun(async run => {
    if (gid === 'memory') await sendMemoryJobs(run.id, group.files.map(f => demoJob('memory', f)));
    else if (gid === 'method') await sendMethodJobs(run.id, group.files.map(f => demoJob('method', f)), true);
    else await sendBpJob(run.id, demoJob('bp', group.files[0]));
  }, () => deliverDemo(gid))).then(maybeAutoAnalyze);
}

/** The hero icon hands over the next group, like the mock; staged own method files start learning instead. */
function deliverNext(): void {
  const stage = stageOf(state.run);
  if (stage.next === 'method' && stage.method === 'ready') { startMethodClicked(); return; }
  if (stage.next === 'method' && stage.method === 'partial') { hint(t('hint.need_four')); return; }
  if (stage.next) deliverDemo(stage.next);
  else hint(t('hint.all_handed'));
}

function takenCells(run: Run | null): { slot: Slot; role: Role }[] {
  const cells: { slot: Slot; role: Role }[] = [];
  for (const slot of ['A', 'B'] as const) {
    const p = projectOf(run, slot);
    if (p?.bp) cells.push({ slot, role: 'bp' });
    if (p?.proposal) cells.push({ slot, role: 'proposal' });
  }
  return cells;
}

/** ordered = false for the fixed #ownInputs: they accept a file for any step at any time and leave the order to the server. */
function handleOwnFiles(gid: GroupId, list: File[], ordered = true): void {
  if (!list.length) return;
  if (isLocked()) { hint(lockHint()); return; }
  if (ordered) {
    const check = ownFileCheck(stageOf(state.run), gid);
    if (!check.ok) { hint(check.hint); return; }
  }
  const verdicts = list.map(file => ({ file, verdict: classifyFile(file, gid, { documents: memoryCaps.documents }) }));
  const bad = verdicts.filter(v => !v.verdict.ok);
  if (bad.length) pushAlert('alert.file_unusable', bad.map(v => v.verdict.message).join(t('list.sep_long')), { tag: 'file', params: { n: bad.length } });
  let files = verdicts.filter(v => v.verdict.ok).map(v => v.file);
  if (!files.length) return;
  state.heroOverride = null;
  if (gid === 'method') {
    state.assign = { files, rows: assignMethodFiles(files.map(f => f.name), takenCells(state.run)), error: null };
    state.manual = 2;
    render();
    return;
  }
  if (gid === 'bp' && files.length > 1) {
    hint(t('hint.one_bp', { name: files[0].name }));
    files = files.slice(0, 1);
  }
  state.manual = null;
  void withBusy(`upload-${gid}`, () => runInRun(async run => {
    if (gid === 'memory') {
      for (const f of files) state.ownFiles.set(f.name, f);
      await sendMemoryJobs(run.id, files.map(f => uploadJob('memory', f)));
    } else {
      await sendBpJob(run.id, uploadJob('bp', files[0]));
    }
  }, () => handleOwnFiles(gid, files, ordered))).then(maybeAutoAnalyze);
}

/** A fixed #ownInputs method input names its project and role, so the file skips the slot dialog. */
function uploadFixedMethodFile(file: File | undefined, slot: Slot, role: Role): void {
  if (!file) return;
  if (isLocked()) { hint(lockHint()); return; }
  const verdict = classifyFile(file, 'method');
  if (!verdict.ok) { pushAlert('alert.file_unusable', verdict.message, { tag: 'file', params: { n: 1 } }); return; }
  Object.assign(state, { manual: null, heroOverride: null, assign: null });
  void withBusy('upload-method', () => runInRun(
    run => sendMethodJobs(run.id, [uploadJob('method', file, slot, role)], false),
    () => uploadFixedMethodFile(file, slot, role),
  ));
}

function dropOwnFiles(files: File[]): void {
  const next = stageOf(state.run).next;
  if (!next) { hint(t('hint.all_handed_more')); return; }
  handleOwnFiles(next, files);
}

function confirmAssign(): void {
  const a = state.assign, run = state.run;
  if (!a || !run) return;
  const error = validateAssignments(a.rows);
  if (error) { a.error = error; render(); return; }
  const jobs = a.rows.map((row, i) => uploadJob('method', a.files[i], row.slot as Slot, row.role as Role));
  state.assign = null;
  void withBusy('upload-method', () => sendMethodJobs(run.id, jobs, false));
}

function startMethodClicked(): void {
  const run = state.run;
  if (!run) return;
  if (!methodFilesComplete(run)) { hint(t('hint.four_first')); return; }
  void withBusy('start-method', () => startMethodNow(run.id));
}

function retryMemoryFile(name: string): void {
  const run = state.run;
  if (!run) return;
  const entry = run.memory.files.find(f => f.name === name);
  const own = state.ownFiles.get(name);
  const demo = groupOf(state.manifest, 'memory')?.files.find(f => f.name === name);
  const job = entry?.source === 'upload' ? (own ? uploadJob('memory', own) : null) : demo ? demoJob('memory', demo) : own ? uploadJob('memory', own) : null;
  if (!job) { hint(t('hint.drag_again', { name })); return; }
  void withBusy('retry-memory', () => sendMemoryJobs(run.id, [job]));
}

async function recoverAnalysis(id: string, before: number | null): Promise<Analysis | null> {
  try {
    const { run } = await api.getRun(id);
    applyRun(run);
    if (run.lastAnalysisAt != null && run.lastAnalysisAt !== before) return await api.lastAnalysis(id);
  } catch {
    // Nothing saved; the alert below offers Retry and Last result.
  }
  return null;
}

async function runAnalyze(): Promise<void> {
  const run = state.run;
  if (!run) return;
  if (isLocked()) { hint(lockHint()); return; }
  if (!run.bp) { state.manual = 3; render(); hint(t('hint.bp_first')); return; }
  if (!stageOf(run).ready) { state.pendingAnalyze = true; render(); hint(t('hint.auto_analyze')); return; }
  const before = run.lastAnalysisAt, t0 = Date.now();
  Object.assign(state, { pendingAnalyze: false, heroOverride: null, report: null, manual: 3, busy: 'analyze' });
  state.live = { ...emptyLive(), t0, bpName: run.bp.name };
  const controller = new AbortController();
  state.liveAbort = controller;
  const current = (): boolean => state.liveAbort === controller;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  let slow = false, refresh = false;
  const tick = window.setInterval(() => {
    if (!current()) return;
    byId('sub').textContent = liveSub();
    // Re-shown after a passing hint (such as "Last result" finding nothing saved) clears it.
    if (Date.now() - t0 >= SLOW_SECONDS * 1000 && !byId('hint').textContent) { slow = true; hint(t('hint.slow'), true); }
  }, 1000);
  try {
    // Like withBusy: a GET runs/:id refresh that already started finishes before the stream opens.
    if (state.polling) await state.polling;
    if (!current()) return;
    const analysis = await analyze(run.id, event => {
      if (!current() || !state.live) return;
      state.live = { ...state.live, ...applyLiveEvent(state.live, event) };
      const box = document.getElementById('live');
      if (box) box.innerHTML = liveRows(state.live);
    }, controller.signal);
    if (current()) {
      state.report = { analysis, replay: false };
      // The stream returns only the analysis; mark the run analyzed so Analyze again, Last result and the hero follow.
      const latest = state.run?.id === run.id ? analyzedRun(state.run, analysis) : null;
      if (latest) state.run = latest;
      refresh = true; // then the server's copy (new version, saved analysis time) through the usual single refresh
    }
  } catch (err) {
    if (!current()) return; // stopped by Last result, which already shows the saved report
    const recovered = isAuth(err) ? null : await recoverAnalysis(run.id, before);
    if (!current()) return;
    if (recovered) state.report = { analysis: recovered, replay: false };
    else {
      state.heroOverride = () => ({ prompt: t('hero.live_failed.prompt'), sub: t(canRetry(err) ? 'hero.live_failed.sub' : 'hero.live_failed.sub_replay'), cur: 2, spinning: false });
      pushAlert('alert.live_failed', err, { retry: () => { void runAnalyze(); }, replay: true, message: () => analysisErrorMessage(err) });
    }
  } finally {
    window.clearInterval(tick);
    if (current()) {
      if (slow) hint('');
      Object.assign(state, { live: null, liveAbort: null, busy: null });
      render();
      if (refresh) void poll();
    }
  }
}

/** Stop the step 3 stream; runAnalyze then leaves the page state to the caller. */
function stopLive(): void {
  state.liveAbort?.abort();
  Object.assign(state, { live: null, liveAbort: null, busy: null });
  hint('');
}

function schedulePoll(delay: number | null = pollDelay(state.run)): void {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  if (delay == null || !state.run) return;
  state.pollTimer = window.setTimeout(() => { void poll(); }, delay);
}

/** One refresh at a time, and none while a write (files, method, analyze, a new run) is in flight. */
function poll(): Promise<void> {
  if (isLocked()) { schedulePoll(); return Promise.resolve(); }
  state.polling ??= pollOnce().finally(() => { state.polling = null; });
  return state.polling;
}

async function pollOnce(): Promise<void> {
  const id = state.run?.id;
  if (!id || document.hidden) return; // visibilitychange resumes polling
  try {
    const reply = await api.getRun(id);
    if (state.run?.id !== id) return;
    state.pollFailed = false;
    applyRun(reply.run);
    noteRefresh(reply);
    render();
    maybeAutoAnalyze();
    schedulePoll();
  } catch (err) {
    if (isAuth(err) || state.run?.id !== id) return;
    if (codeOf(err) === 'run_not_found') { pushAlert('alert.run_not_found', err); return; }
    state.pollFailed = true;
    render();
    schedulePoll(15000);
  }
}

async function replay(): Promise<void> {
  state.menuOpen = false;
  const run = state.run;
  if (!run) { hint(t('hint.no_demo')); render(); return; }
  if (!canUse('replay')) { hint(lockHint()); return; }
  const live = state.liveAbort;
  try {
    const analysis = await api.lastAnalysis(run.id);
    if (state.run?.id !== run.id) return;
    if (live) {
      // The live run ended while the saved result loaded: keep its fresh report.
      if (state.liveAbort !== live) { if (state.report && !state.report.replay) return; }
      else stopLive();
    }
    Object.assign(state, { report: { analysis, replay: true }, manual: 3, heroOverride: null });
    state.alerts = state.alerts.filter(a => a.titleKey !== 'alert.live_failed');
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    if (codeOf(err) === 'analysis_not_found') { hint(t('code.analysis_not_found')); return; }
    pushAlert('alert.replay_failed', err, { retry: () => { void replay(); }, gate: 'replay' });
  }
}

function switchRun(id: string): void {
  state.menuOpen = false;
  if (id === state.run?.id) { render(); return; }
  void withBusy('switch', async () => {
    try { const reply = await api.getRun(id); setRun(reply.run); noteRefresh(reply); } catch (err) { pushAlert('alert.switch_failed', err, { retry: () => switchRun(id) }); }
  });
}

function toggleMenu(): void {
  state.menuOpen = !state.menuOpen;
  renderMenu();
  if (state.menuOpen) api.listRuns().then(runs => { state.runs = runs; renderMenu(); }, () => undefined);
}

function setFocus(step: number): void {
  if (!state.loaded) { hint(lockHint()); return; }
  const stage = stageOf(state.run);
  if (step > stage.given + 1) { hint(t('hint.finish_earlier')); return; }
  state.manual = step;
  render();
}

async function openFile(gid: GroupId, index: number): Promise<void> {
  const file = groupOf(state.manifest, gid)?.files[index];
  if (!file) return;
  const token = ++state.viewerToken;
  openViewer(file.name, `<p class="meta">${esc(t('viewer.opening'))}</p>`);
  try {
    const text = state.textCache.get(file.path) ?? await loadDemoText(file.path);
    state.textCache.set(file.path, text);
    if (token === state.viewerToken && viewerOpen()) openViewer(file.name, renderMarkdown(text));
  } catch (err) {
    if (token === state.viewerToken && viewerOpen()) openViewer(file.name, `<p class="errtext">${esc(errorMessage(err))}</p>`);
  }
}

function reloadManifest(): void {
  loadManifest().then(manifest => { state.manifest = manifest; renderMaterials(mats, manifest); render(); },
    err => pushAlert('alert.materials_failed', err, { retry: reloadManifest, gate: 'none' }));
}

function onAct(name: string): void {
  if (name === 'restart') restart();
  else if (name === 'switch') toggleMenu();
  else if (name === 'replay') void replay();
  else if (name === 'create') startChosen();
  else if (name === 'choose') openChooser();
  else if (name === 'choose-cancel') { state.choosing = false; render(); }
  else if (name === 'spaces-retry') loadSpaces();
  else if (name === 'start-method') startMethodClicked();
  else if (name === 'analyze') void runAnalyze();
  else if (name === 'assign-confirm') confirmAssign();
  else if (name === 'assign-cancel') { state.assign = null; render(); }
  else if (name === 'show-bp') { state.report = null; state.manual = 3; render(); }
}

document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const hit = <T extends HTMLElement = HTMLElement>(selector: string): T | null => target.closest<T>(selector);
  if (hit('#vclose') || (hit('#viewer') && !hit('.vbox'))) { closeViewer(); return; }
  if (state.menuOpen && !hit('.menu-wrap')) { state.menuOpen = false; renderMenu(); }
  const act = hit('[data-act]');
  if (act) { onAct(act.dataset.act ?? ''); return; }
  const runItem = hit('[data-run]');
  if (runItem) { switchRun(runItem.dataset.run ?? ''); return; }
  const give = hit('[data-give]');
  if (give) { window.scrollTo({ top: 0, behavior: 'smooth' }); deliverDemo(give.dataset.give as GroupId); return; }
  if (hit('[data-recipe-toggle]')) { state.recipeView = { ...state.recipeView, body: !state.recipeView.body }; render(); return; }
  if (hit('[data-desc-toggle]')) { state.recipeView = { ...state.recipeView, desc: !state.recipeView.desc }; render(); return; }
  const more = hit<HTMLButtonElement>('[data-more]');
  if (more) { toggleFold(more); return; }
  const item = hit('.mfiles li');
  if (item) { void openFile(item.dataset.g as GroupId, Number(item.dataset.i)); return; }
  const pick = hit('[data-pick]');
  if (pick) { pickInputs[pick.dataset.pick as GroupId]?.click(); return; }
  const retry = hit('[data-retry]');
  if (retry) {
    const alert = state.alerts.find(a => a.id === Number(retry.dataset.retry));
    if (!alert) return;
    if (retryBlocked(alert)) { hint(lockHint()); return; }
    dropAlert(alert.id);
    alert.action?.();
    render();
    return;
  }
  const dismiss = hit('[data-dismiss]');
  if (dismiss) { dropAlert(Number(dismiss.dataset.dismiss)); render(); return; }
  const retryFile = hit('[data-retry-file]');
  if (retryFile) { retryMemoryFile(retryFile.dataset.retryFile ?? ''); return; }
  const step = hit('#steps [data-step]');
  if (step) setFocus(Number(step.dataset.step));
});

document.addEventListener('change', event => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === 'file' && target.closest('#ownInputs')) {
    // The six fixed inputs: memory, bp, and method with a fixed slot and role.
    const files = Array.from(target.files ?? []);
    target.value = '';
    const gid = target.dataset.group as GroupId;
    if (gid === 'method') uploadFixedMethodFile(files[0], target.dataset.slot as Slot, target.dataset.role as Role);
    else handleOwnFiles(gid, files, false);
  } else if (target instanceof HTMLInputElement && target.type === 'radio' && (target.name === 'space-mode' || target.name === 'space-pick')) {
    if (target.name === 'space-mode') setSpaceMode(target.value === 'existing' ? 'existing' : 'new');
    else { Object.assign(state.chooser, { picked: target.value, error: null }); render(); }
    // render() replaced the card: keep the keyboard focus on the same choice.
    document.querySelector<HTMLInputElement>(`#panel input[name="${target.name}"][value="${CSS.escape(target.value)}"]`)?.focus();
  } else if (target instanceof HTMLSelectElement && target.dataset.assign && state.assign) {
    const row = state.assign.rows[Number(target.dataset.assign)];
    if (!row) return;
    if (target.dataset.field === 'slot') row.slot = (target.value || null) as Slot | null;
    else row.role = (target.value || null) as Role | null;
    if (state.assign.error) { state.assign.error = null; render(); }
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeViewer();
    if (state.menuOpen) { state.menuOpen = false; renderMenu(); }
    return;
  }
  const target = event.target as HTMLElement;
  if (event.key === 'Enter' && target.matches('.mfiles li')) {
    // openViewer moves focus to Close; without preventDefault the same Enter would then click it and close the viewer at once.
    event.preventDefault();
    void openFile(target.dataset.g as GroupId, Number(target.dataset.i));
  }
});

mats.addEventListener('dragstart', event => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[draggable="true"]');
  if (!item || !event.dataTransfer) return;
  event.dataTransfer.setData('text/plain', `cosens:${item.dataset.g}`);
  event.dataTransfer.effectAllowed = 'copy';
  item.closest('.mgroup')?.classList.add('dragging');
});
mats.addEventListener('dragend', event => { (event.target as HTMLElement).closest('.mgroup')?.classList.remove('dragging'); });
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());

hero.addEventListener('dragover', event => { event.preventDefault(); mark.classList.add('drag'); });
hero.addEventListener('dragleave', event => { if (!hero.contains(event.relatedTarget as Node | null)) mark.classList.remove('drag'); });
hero.addEventListener('drop', event => {
  event.preventDefault();
  mark.classList.remove('drag');
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) { dropOwnFiles(files); return; }
  const data = event.dataTransfer?.getData('text/plain') ?? '';
  if (data.startsWith('cosens:')) deliverDemo(data.slice(7) as GroupId);
});

const zoneOf = (event: Event): HTMLElement | null => (event.target as HTMLElement).closest<HTMLElement>('.drop');
panel.addEventListener('dragover', event => { const zone = zoneOf(event); if (zone) { event.preventDefault(); zone.classList.add('over'); } });
panel.addEventListener('dragleave', event => { const zone = zoneOf(event); if (zone && !zone.contains(event.relatedTarget as Node | null)) zone.classList.remove('over'); });
panel.addEventListener('drop', event => {
  const zone = zoneOf(event);
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('over');
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) { handleOwnFiles(zone.dataset.drop as GroupId, files); return; }
  const data = event.dataTransfer?.getData('text/plain') ?? '';
  if (data.startsWith('cosens:')) deliverDemo(data.slice(7) as GroupId);
});

panel.addEventListener('toggle', snapRecipes, true); // <details> toggle does not bubble
// Phones fire resize when the URL bar shows or hides; only a width change can move the Recipe line breaks.
let snapWidth = window.innerWidth;
let snapFrame = 0;
window.addEventListener('resize', () => {
  if (window.innerWidth === snapWidth || snapFrame) return;
  snapFrame = requestAnimationFrame(() => {
    snapFrame = 0;
    snapWidth = window.innerWidth;
    snapRecipes();
  });
});

mark.addEventListener('click', deliverNext);
mark.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); deliverNext(); } });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollDelay(state.run) != null) { window.clearTimeout(state.pollTimer); void poll(); }
});

const missingLinkText = (opened: boolean): string => t(opened ? 'link.missing_opened' : 'link.missing_new');

/** Open the latest run other than skip, or the empty state (which drops ?run). Returns the error if that run did not load. */
async function openLatest(skip: string | null, keep?: (a: Alert) => boolean): Promise<unknown> {
  const latest = state.runs.find(r => r.id !== skip);
  let reply: RunReply | null = null, failed: unknown = null;
  if (latest) {
    try { reply = await api.getRun(latest.id); } catch (err) { failed = err; }
  }
  state.loaded = true;
  setRun(reply?.run ?? null, keep);
  if (reply) { noteRefresh(reply); render(); }
  return failed;
}

/** Retry for a ?run= link that failed to load at boot; the URL keeps that run until it opens or turns out to be gone. */
function openLinkedRun(id: string): void {
  const keep = (a: Alert): boolean => a.tag !== 'link'; // boot notices such as the demo materials failing to load stay
  void withBusy('switch', async () => {
    try {
      const reply = await api.getRun(id);
      setRun(reply.run, keep);
      noteRefresh(reply);
      return;
    } catch (err) {
      if (codeOf(err) !== 'run_not_found') { pushAlert('alert.link_failed', err, { retry: () => openLinkedRun(id), tag: 'link' }); return; }
    }
    // Gone after all: the same fallback as boot.
    const failed = await openLatest(id, keep);
    const opened = !!state.run;
    pushAlert('alert.link_missing', 'link_missing', { message: () => missingLinkText(opened), tag: 'link' });
    if (failed) pushAlert('alert.latest_failed', failed, { retry: () => location.reload(), gate: 'none' });
  });
}

/** Applies what step 1 can take here (GET /api/demo/me memory) to the pickers, the hints and the step 1 card. */
function applyMemoryCaps(caps: { documents?: boolean; stats?: boolean } | null | undefined): void {
  setMemoryCaps(caps);
  pickInputs.memory.accept = acceptFor('memory');
  document.querySelectorAll<HTMLInputElement>('#ownInputs input[data-group="memory"]').forEach(input => { input.accept = acceptFor('memory'); });
  render();
}

async function boot(): Promise<void> {
  state.shell = mountShell(byId('shell'));
  void state.shell.ready.then(me => { if (me?.memory) applyMemoryCaps(me.memory); });
  render();
  const wanted = new URLSearchParams(location.search).get('run');
  const later: [string, unknown, (() => void) | undefined][] = [];
  const [manifest, runs] = await Promise.allSettled([loadManifest(), api.listRuns()]);
  if (manifest.status === 'fulfilled') { state.manifest = manifest.value; renderMaterials(mats, state.manifest); }
  else later.push(['alert.materials_failed', manifest.reason, reloadManifest]);
  if (runs.status === 'fulfilled') state.runs = runs.value;
  else later.push(['alert.runs_failed', runs.reason, () => location.reload()]);
  let reply: RunReply | null = null, missing: unknown = null;
  if (wanted) {
    try { reply = await api.getRun(wanted); } catch (err) { missing = err; }
  }
  const plan = linkedRunPlan(wanted, missing);
  if (plan === 'keep' && wanted) {
    // A transient failure must not open (and link to) another run: keep ?run and offer Retry.
    state.loaded = true;
    render();
    pushAlert('alert.link_failed', missing, { retry: () => openLinkedRun(wanted), tag: 'link' });
  } else if (reply) {
    state.loaded = true;
    setRun(reply.run);
    noteRefresh(reply);
    render();
  } else {
    const failed = await openLatest(wanted);
    if (missing) { const opened = !!state.run; pushAlert('alert.link_missing', 'link_missing', { message: () => missingLinkText(opened), tag: 'link' }); }
    if (failed) later.push(['alert.latest_failed', failed, () => location.reload()]);
  }
  for (const [titleKey, err, retry] of later) pushAlert(titleKey, err, { retry, gate: 'none' });
}

// The EN/中文 switch: every text built by render() and renderMaterials() is rebuilt in the new language.
window.addEventListener('cosens:localechange', () => {
  renderMaterials(mats, state.manifest);
  state.panelHtml = '';
  render();
});

void boot();
