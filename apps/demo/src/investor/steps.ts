// Step 1/2/3 renderers for the investor demo (ported from real/static/app.js ingest/learn/analyze, lines 8-128).
import type { GroupId, Manifest, ManifestGroup, Run, Slot } from '../lib/api';
import { t } from '../../../../shared/i18n.mjs';
import { renderMarkdown } from '../lib/markdown';
import { queryHtml } from './report';
import {
  bpTitle, esc, escDates, fmtTime, sentence, stepStates, memoryView, methodFilesComplete, methodStatus, projectOf, projectView, stem,
  type AssignRow, type HeroView, type LiveState, type Stage,
  isTextOnlyRefusal, roleLabel,
} from '../lib/logic.mjs';

const byId = (id: string): HTMLElement => document.getElementById(id)!;

export const groupOf = (manifest: Manifest | null, gid: GroupId): ManifestGroup | null => manifest?.groups.find(g => g.id === gid) ?? null;

/** Step pills from stepStates(), the same statuses the header chips read: a memory still writing is run, never done. */
export function setHero(view: HeroView, stage: Stage): void {
  byId('prompt').textContent = view.prompt;
  byId('sub').innerHTML = escDates(sentence(view.sub));
  byId('mark').classList.toggle('busy', view.spinning);
  byId('hero').classList.toggle('compact', view.cur >= 3);
  const states = stepStates(stage, view.cur);
  [...byId('steps').children].forEach((el, i) => {
    for (const name of ['done', 'cur', 'run', 'fail', 'todo']) el.classList.toggle(name, states[i] === name);
  });
}

/** Steps strip doubles as navigation between the step panels the visitor has reached; ring = the step pill to outline. */
export function setStepButtons(stage: Stage, ring: number): void {
  byId('steps').querySelectorAll<HTMLButtonElement>('button[data-step]').forEach(button => {
    const step = Number(button.dataset.step);
    button.disabled = step > stage.given + 1;
    button.classList.toggle('sel', step === ring);
    button.setAttribute('aria-pressed', String(step === ring));
  });
}

export const fileChips = (names: string[], cls = ''): string => `<div class="files">${names.map(name => `<span class="file ${cls}" title="${esc(name)}">${esc(stem(name))}</span>`).join('')}</div>`;

/**
 * What step 1 can take here, from GET /api/demo/me memory: Memory through the gateway takes no PDF or Word and records
 * no stats. Both stay on until the account reply says otherwise; the server refuses a PDF either way.
 */
export const memoryCaps = { documents: true, stats: true };
export function setMemoryCaps(caps: { documents?: boolean; stats?: boolean } | null | undefined): void {
  memoryCaps.documents = caps?.documents !== false;
  memoryCaps.stats = caps?.stats !== false;
}

const TEXT_ACCEPT = '.md,.markdown,.txt';
const ACCEPT: Record<GroupId, string> = { memory: `${TEXT_ACCEPT},.pdf,.doc,.docx`, method: TEXT_ACCEPT, bp: TEXT_ACCEPT };
export const acceptFor = (gid: GroupId): string => gid === 'memory' && !memoryCaps.documents ? TEXT_ACCEPT : ACCEPT[gid];
// HTML: each file type stays on one line with its own limit, and each hint names its step, so the different limits read as intended.
// One line per file type with its own limit, the step named on the first (kept with what follows), the privacy
// sentence on its own line.
const acceptLine = (key: string): string => `<span class="nobr">${esc(t(`${key}.lead`))}</span> ${esc(t(`${key}.rest`))}`;
const acceptLines = (group: GroupId): string[] => {
  if (group === 'memory') return [acceptLine('upload.memory'), ...(memoryCaps.documents ? [esc(t('upload.memory.docs'))] : [])];
  return [acceptLine(`upload.${group}`)];
};
/** Where the visitor's files go: the run's own new space, or an existing space that everyone it is shared with can read. */
let existingSpace = false;
export function setPrivacy(existing: boolean): void { existingSpace = existing; }
export const privacy = (): string => t(existingSpace ? 'upload.privacy_existing' : 'upload.privacy');

/** The Choose files button opens a long-lived input kept outside #panel (see pickInputs in main.ts), so a re-render cannot drop the picked files. */
export function uploader(group: GroupId, label: string): string {
  return `<div class="drop" data-drop="${group}"><p>${esc(label)}${esc(t('upload.sep'))}<span class="nobr">${esc(t('upload.or'))}<button type="button" class="lnk strong" data-pick="${group}">${esc(t('upload.choose'))}</button></span></p><p class="meta hint-lines">${[...acceptLines(group), esc(privacy())].map(line => `<span>${line}</span>`).join('')}</p></div>`;
}

export const loadingCard = (): string => `<div class="card"><p class="meta plain">${esc(t('common.loading'))}</p></div>`;

export function memoryStartCard(manifest: Manifest | null): string {
  const n = groupOf(manifest, 'memory')?.files.length ?? 0;
  return `<div class="card fade"><h3>${esc(t('step1.title'))}</h3><p class="lead">${esc(t('step1.lead', { n }))}</p><div class="btnrow"><button class="primary" type="button" data-give="memory"${n ? '' : ' disabled'}>${esc(t('common.use_demo'))}</button></div>${uploader('memory', t('upload.label.memory_own'))}</div>`;
}

export function memoryCard(run: Run, canAdd: boolean): string {
  const v = memoryView(run, { stats: memoryCaps.stats });
  const running = v.status === 'running';
  const stat = (value: number | undefined, label: string): string => `<div class="stat"><b>${value == null ? '…' : value}</b><span>${esc(label)}</span></div>`;
  // No stats block at all when there are none to show (none recorded here, or none yet): never empty numbers.
  const stats = v.statsPanel === 'none' ? '' : `<div class="stats">${stat(v.stats?.people, t('stat.people'))}${stat(v.stats?.organizations, t('stat.organizations'))}${stat(v.stats?.relations, t('stat.relations'))}</div>`;
  const chips = v.files.map(f => `<span class="file ${f.state === 'committed' ? 'ok' : f.state === 'failed' ? 'err' : ''}" title="${esc(f.name)}">${esc(f.label)}</span>`).join('');
  const failed = v.files.filter(f => f.state === 'failed');
  const failedList = failed.length ? `<ul class="failed">${failed.map(f => `<li>${esc(f.label)}${esc(t('common.colon'))}${esc(f.error || t('memory.not_written'))}${isTextOnlyRefusal(f.error) ? '' : `<button class="give" type="button" data-retry-file="${esc(f.name)}">${esc(t('common.retry'))}</button>`}</li>`).join('')}</ul>` : '';
  const counts = `${t('memory.counts', { done: v.committed, total: v.total })}${v.failed ? t('memory.counts_failed', { n: v.failed }) : ''}${v.pending ? t('memory.counts_pending', { n: v.pending }) : ''}`;
  const note = running ? t('memory.note_running') : v.stats ? t('memory.note_stats') : '';
  return `<div class="card fade"><h3>${esc(v.title)}</h3><div class="bar"><i style="width:${v.percent}%"></i></div><div class="meta">${counts}</div><div class="files">${chips}</div>${stats}${failedList}${note ? `<p class="meta note">${esc(note)}</p>` : ''}${canAdd ? uploader('memory', t('upload.label.memory_more')) : ''}</div>`;
}

const SLOTS: Slot[] = ['A', 'B'];

export function methodStartCard(run: Run, manifest: Manifest | null): string {
  const n = groupOf(manifest, 'method')?.files.length ?? 0;
  const ready = methodFilesComplete(run);
  const cell = (name: string | null): string => name ? `<span class="slot ok" title="${esc(name)}">${esc(stem(name))}</span>` : `<span class="slot">${esc(t('slot.empty'))}</span>`;
  const rows = SLOTS.map(slot => {
    const p = projectView(projectOf(run, slot), slot);
    // Phones repeat the column heads under each project label; wide screens show them once at the top.
    return `<span class="rowhead">${esc(t('project.label', { slot }))}${esc(slot === 'B' ? t('step2.b_note') : '')}</span><span class="head row-head">${esc(roleLabel('bp'))}</span><span class="head row-head">${esc(roleLabel('proposal'))}</span>${cell(p.bp)}${cell(p.proposal)}`;
  }).join('');
  return `<div class="card fade"><h3>${esc(t('step2.title'))}</h3><p class="lead">${esc(t('step2.lead'))}</p><div class="slots"><span class="corner"></span><span class="head top-head">${esc(roleLabel('bp'))}</span><span class="head top-head">${esc(roleLabel('proposal'))}</span>${rows}</div><div class="btnrow"><button class="${ready ? 'give' : 'primary'}" type="button" data-give="method"${n ? '' : ' disabled'}>${esc(t('common.use_demo'))}</button><button class="${ready ? 'primary' : 'give'}" type="button" data-act="start-method"${ready ? '' : ' disabled'}>${esc(t('step2.start'))}</button>${ready ? '' : `<span class="meta">${esc(t('step2.need_four'))}</span>`}</div>${uploader('method', t('upload.label.method_own'))}</div>`;
}

export function assignCard(rows: AssignRow[], error: string | null, busy: boolean): string {
  const select = (i: number, field: 'slot' | 'role', value: string | null, options: [string, string][]): string =>
    `<select data-assign="${i}" data-field="${field}" aria-label="${esc(t(field === 'slot' ? 'assign.aria_project' : 'assign.aria_type'))}"><option value="">${esc(t(field === 'slot' ? 'assign.pick_project' : 'assign.pick_type'))}</option>${options.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  const list = rows.map((row, i) => `<span class="fn" title="${esc(row.name)}">${esc(row.name)}</span>${select(i, 'slot', row.slot, [['A', t('project.label', { slot: 'A' })], ['B', t('project.label', { slot: 'B' })]])}${select(i, 'role', row.role, [['bp', roleLabel('bp')], ['proposal', roleLabel('proposal')]])}`).join('');
  return `<div class="card fade"><h3>${esc(t('assign.title'))}</h3><p class="lead">${esc(t('assign.lead'))}</p><div class="assign">${list}</div>${error ? `<p class="errtext" role="alert">${esc(error)}</p>` : ''}<div class="btnrow"><button class="primary" type="button" data-act="assign-confirm"${busy ? ' disabled' : ''}>${esc(t('assign.confirm'))}</button><button class="give" type="button" data-act="assign-cancel"${busy ? ' disabled' : ''}>${esc(t('common.cancel'))}</button></div><p class="meta note">${esc(privacy())}</p></div>`;
}

export type RecipeView = { body: boolean; desc: boolean };

/** body: the full method shown in full; desc: the RSI-written description shown past its 3-line clamp. */
export function recipeCard(run: Run, view: RecipeView = { body: false, desc: false }): string {
  const open = view.body;
  const k = run.method.recipe;
  if (!k) return '';
  const name = (k.name || t('recipe.default_name')).split(/[\uff08(]/)[0].trim();
  const test = k.selfTest != null ? `<span class="tag ok">${esc(t('recipe.selftest', { n: Math.round(k.selfTest) }))}</span>` : '';
  const rules = k.rules.length ? `<ol class="rules">${k.rules.map(rule => `<li>${esc(rule)}</li>`).join('')}</ol>` : '';
  const full = k.instructions ? `<details class="more" data-key="recipe"><summary class="meta">${esc(t('recipe.view_full'))}</summary><div class="recipe${open ? ' open' : ''}">${renderMarkdown(k.instructions)}</div><button class="lnk" type="button" data-recipe-toggle>${esc(t(open ? 'common.collapse' : 'common.show_all'))}</button></details>` : '';
  const when = run.method.completedAt != null ? t('recipe.when', { time: fmtTime(run.method.completedAt) }) : '';
  return `<div class="card fade"><h3 class="balanced" title="${esc(k.name)}">${esc(t('recipe.learned', { name }))} ${test}</h3>${k.description ? `<p class="rdesc${view.desc ? '' : ' clamp'}">${esc(k.description)}</p><button class="lnk" type="button" data-desc-toggle>${esc(t(view.desc ? 'common.collapse' : 'common.expand'))}</button>` : ''}${rules}${full}<p class="meta note">${esc(t('recipe.note', { when, number: String(k.number ?? '') }))}</p></div>`;
}

export function methodCard(run: Run, recipeView?: RecipeView): string {
  const status = methodStatus(run);
  const block = (slot: Slot): string => {
    const p = projectView(projectOf(run, slot), slot);
    const tone = p.status === 'completed' ? 'ok' : p.status === 'failed' || p.status === 'cancelled' ? 'warn' : 'blue';
    const phases = p.phases.map(ph => `<div class="phase ${ph.state}"><span class="dot">${ph.state === 'ok' ? '✓' : ph.state === 'err' ? '!' : ''}</span>${esc(ph.label)}</div>`).join('');
    return `<div class="project"><h4>${esc(p.heading)}<span class="tag ${tone}">${esc(p.label)}</span></h4>${fileChips([p.bp, p.proposal].filter((n): n is string => !!n), 'ok')}<div class="bar"><i style="width:${p.progress}%"></i></div><div>${phases}</div>${p.error ? `<p class="errtext">${esc(p.error)}</p>` : ''}</div>`;
  };
  const title = t(status === 'done' ? 'method.title.done' : status === 'failed' ? 'method.title.failed' : 'method.title.running');
  const failure = status === 'failed' ? `${run.method.error ? `<p class="errtext">${esc(run.method.error)}</p>` : ''}<div class="btnrow"><button class="give" type="button" data-act="start-method">${esc(t('common.retry'))}</button></div>` : '';
  const note = status === 'running' ? `<p class="meta note">${esc(t('method.note_running'))}</p>` : '';
  return `<div class="card fade"><h3>${esc(title)}</h3>${SLOTS.map(block).join('')}${failure}${note}</div>${recipeCard(run, recipeView)}`;
}

export function bpStartCard(manifest: Manifest | null): string {
  const f = groupOf(manifest, 'bp')?.files[0];
  return `<div class="card fade"><h3>${esc(t('step3.title'))}</h3><p class="lead">${esc(t('step3.lead'))}</p><div class="btnrow"><button class="primary" type="button" data-give="bp"${f ? '' : ' disabled'}>${esc(f ? t('step3.use_demo_named', { name: stem(f.name) }) : t('step3.use_demo'))}</button></div>${uploader('bp', t('upload.label.bp_own'))}</div>`;
}

export function bpCard(run: Run, stage: Stage, pending: boolean): string {
  const name = run.bp?.name ?? '';
  const waiting = stage.memory === 'failed' ? t('bp.waiting_memory_failed')
    : stage.memory !== 'done' ? t('bp.waiting_memory')
    : stage.method !== 'done' ? t('bp.waiting_method') : '';
  const auto = waiting && pending && stage.memory !== 'failed' ? t('bp.auto_start') : '';
  const replay = stage.analyzed ? `<button class="give" type="button" data-act="replay">${esc(t('act.replay'))}</button>` : '';
  return `<div class="card fade"><h3>${esc(t('bp.title', { title: bpTitle(name) }))}</h3>${fileChips([name], 'ok')}${waiting ? `<p class="meta note">${esc(waiting)}${esc(auto)}</p>` : ''}<div class="btnrow"><button class="primary" type="button" data-act="analyze"${stage.ready ? '' : ' disabled'}>${esc(t(stage.analyzed ? 'act.analyze_again' : 'act.analyze'))}</button>${replay}</div>${uploader('bp', t('upload.label.bp_replace'))}</div>`;
}

const rowText = (row: LiveState['rows'][number]): string => row.query != null ? `<span class="ptext">${esc(t('live.search_prefix'))}${queryHtml(row.query)}</span>` : esc(row.text);
export const liveRows = (live: LiveState): string => live.rows.map(row => `<div class="phase ${row.state}"><span class="dot">${row.state === 'ok' ? '✓' : ''}</span>${rowText(row)}<span class="find">${esc(row.find)}</span></div>`).join('');

export function liveCard(bpName: string, live: LiveState): string {
  return `<div class="card fade"><h3>${esc(t('live.title'))}</h3>${fileChips([bpName], 'ok')}<div class="live" id="live">${liveRows(live)}</div></div>`;
}

export type AlertView = { id: number; title: string; message: string; retry: boolean; replay: boolean };

export function alertCard(a: AlertView): string {
  const retry = a.retry ? `<button class="give" type="button" data-retry="${a.id}">${esc(t('common.retry'))}</button>` : '';
  const replay = a.replay ? `<button class="give" type="button" data-act="replay">${esc(t('act.replay'))}</button>` : '';
  return `<div class="card alert fade" role="alert"><h3>${esc(a.title)}</h3><p>${esc(sentence(a.message))}</p><div class="btnrow">${retry}${replay}<button class="give" type="button" data-dismiss="${a.id}">${esc(t('common.close'))}</button></div></div>`;
}
