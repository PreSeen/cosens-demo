// Materials panel and file viewer (port of real/static/app.js renderMats/openFile, lines 155-180).
import type { GroupId, Manifest } from '../lib/api';
import { t } from '../../../../shared/i18n.mjs';
import { esc, stem } from '../lib/logic.mjs';

const FOLD_OVER = 6, FOLD_TO = 5;
const demoMeta = (gid: string, n: number): string => t('mat.count', { n, hint: t(`group.${gid}.hint`) });

export function renderMaterials(el: HTMLElement, manifest: Manifest | null): void {
  if (!manifest) { el.innerHTML = ''; return; }
  el.innerHTML = manifest.groups.map((g, gi) => {
    const fold = g.files.length > FOLD_OVER;
    const items = g.files.map((f, i) => `<li draggable="true" data-g="${esc(g.id)}" data-i="${i}" tabindex="0"${fold && i >= FOLD_TO ? ' hidden' : ''} title="${esc(t('mat.item_title', { name: stem(f.name) }))}"><span class="ic">&#9776;</span><span class="fn">${esc(stem(f.name))}</span></li>`).join('');
    const more = fold ? `<button class="lnk" type="button" data-more="${esc(g.id)}">${esc(t('mat.expand_all', { n: g.files.length }))}</button>` : '<span></span>';
    return `<div class="mgroup" draggable="true" data-g="${esc(g.id)}"><div class="mhead"><span class="mnum">${gi + 1}</span><div><b>${esc(t(`group.${g.id}.title`))}</b><span class="meta" data-demo="${esc(demoMeta(g.id, g.files.length))}">${esc(demoMeta(g.id, g.files.length))}</span></div></div><p class="mown" hidden>${esc(t('mat.unused'))}</p><ul class="ownfiles" hidden></ul><ul class="mfiles">${items}</ul><div class="mfoot">${more}<button class="give" type="button" data-give="${esc(g.id)}">${esc(t('mat.give'))}</button></div></div>`;
  }).join('');
}

/**
 * given: groups whose demo files went into the run (their "Hand to AI" button reads "Handed to AI" and is off);
 * own: groups whose step holds only the visitor's files, with their names: the card lists those files instead of
 * the demo set and says the demo files are not in use; cur: the group to hand over now.
 */
export function markGroups(el: HTMLElement, given: Set<GroupId>, own: Map<GroupId, string[]>, cur: GroupId | null): void {
  el.querySelectorAll<HTMLElement>('.mgroup').forEach(box => {
    const g = box.dataset.g as GroupId;
    const names = own.get(g);
    box.classList.toggle('given', given.has(g));
    box.classList.toggle('own', !!names);
    box.classList.toggle('cur', g === cur);
    box.querySelector<HTMLElement>('.mown')!.hidden = !names;
    const meta = box.querySelector<HTMLElement>('.mhead .meta')!;
    meta.textContent = names ? t('mat.own_count', { n: names.length }) : meta.dataset.demo ?? '';
    const list = box.querySelector<HTMLElement>('.ownfiles')!;
    list.hidden = !names;
    const html = (names ?? []).map(name => `<li title="${esc(name)}"><span class="ic">&#9776;</span><span class="fn">${esc(stem(name))}</span></li>`).join('');
    if (list.innerHTML !== html) list.innerHTML = html;
    const give = box.querySelector<HTMLButtonElement>('[data-give]')!;
    give.disabled = given.has(g);
    give.textContent = t(given.has(g) ? 'mat.given' : 'mat.give');
  });
}

export function toggleFold(button: HTMLButtonElement): void {
  const box = button.closest('.mgroup');
  if (!box) return;
  const open = button.dataset.open !== '1';
  const items = box.querySelectorAll<HTMLElement>('li');
  items.forEach((li, i) => { li.hidden = !open && i >= FOLD_TO; });
  button.dataset.open = open ? '1' : '0';
  button.textContent = open ? t('common.collapse') : t('mat.expand_all', { n: items.length });
}

let lastFocus: HTMLElement | null = null;
let lockedScroll = 0;

/** The dialog's top sits one header height (plus a gap) below the viewport top: the same for any scroll position or theme, re-measured on resize. */
function placeViewer(): void {
  const header = document.getElementById('shell');
  document.getElementById('viewer')!.style.paddingTop = `${(header?.offsetHeight ?? 0) + 12}px`;
}
window.addEventListener('resize', () => { if (viewerOpen()) placeViewer(); });

export function openViewer(title: string, html: string): void {
  const viewer = document.getElementById('viewer')!;
  if (viewer.hidden) lastFocus = document.activeElement as HTMLElement | null;
  document.getElementById('vtitle')!.textContent = title;
  const body = document.getElementById('vbody')!;
  body.innerHTML = html;
  body.scrollTop = 0;
  placeViewer();
  if (viewer.hidden) {
    // Scroll lock: the page is fixed at its scroll offset, so the dialog (a full-height sheet on phones) starts at the
    // top of the screen whatever the page was showing, and the page is back where it was on close.
    lockedScroll = window.scrollY;
    document.body.style.top = `-${lockedScroll}px`;
  }
  viewer.hidden = false;
  document.body.classList.add('viewer-open');
  document.getElementById('vclose')!.focus();
}

export function closeViewer(): void {
  const viewer = document.getElementById('viewer')!;
  if (viewer.hidden) return;
  viewer.hidden = true;
  document.body.classList.remove('viewer-open');
  document.body.style.top = '';
  window.scrollTo(0, lockedScroll);
  lastFocus?.focus();
  lastFocus = null;
}

export const viewerOpen = (): boolean => !document.getElementById('viewer')!.hidden;
