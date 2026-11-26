// The start card: where this run writes, a new demo space (default) or one of the visitor's own spaces.
import { t } from '../../../../shared/i18n.mjs';
import { esc, type SpaceChoiceView } from '../lib/logic.mjs';

const option = (value: 'new' | 'existing', on: boolean, title: string, text: string): string =>
  `<label class="choice${on ? ' on' : ''}"><input type="radio" name="space-mode" value="${value}"${on ? ' checked' : ''}><span class="choice-body"><b>${esc(title)}</b><span class="meta">${esc(text)}</span></span></label>`;

function spaceList(v: SpaceChoiceView): string {
  if (v.status === 'loading') return `<p class="meta spaces-note" data-spaces="loading">${esc(t('space.loading'))}</p>`;
  if (v.status === 'failed') return `<div class="spaces-note" data-spaces="failed"><p class="errtext">${esc(v.listError)}</p><div class="btnrow"><button class="give" type="button" data-act="spaces-retry">${esc(t('space.reload'))}</button><span class="meta">${esc(t('space.or_new'))}</span></div></div>`;
  const note = v.readOnlyNote ? `<p class="meta spaces-note">${esc(v.readOnlyNote)}</p>` : '';
  if (v.status === 'empty') return `<p class="meta spaces-note" data-spaces="empty">${esc(v.emptyText)}</p>${note}`;
  const rows = v.items.map(item => {
    const tags = (item.demo ? ` <span class="tag blue">${esc(t('space.tag_demo'))}</span>` : '') + (item.shared ? ` <span class="tag">${esc(t('space.tag_shared'))}</span>` : '');
    return `<label class="space${item.picked ? ' on' : ''}"><input type="radio" name="space-pick" value="${esc(item.vuId)}"${item.picked ? ' checked' : ''}><span class="choice-body"><b>${esc(item.name)}${tags}</b><span class="meta">${esc(item.created)}</span></span></label>`;
  }).join('');
  return `<p class="meta spaces-note">${esc(v.countText)}</p><div class="spaces" role="radiogroup" aria-label="${esc(t('space.aria_list'))}" data-spaces="ready">${rows}</div>${note}`;
}

/** cancel: the card was opened over a run (from Switch), so it offers Cancel to go back to that run. */
export function startCard(v: SpaceChoiceView, { creating = false, cancel = false }: { creating?: boolean; cancel?: boolean } = {}): string {
  const existing = v.mode === 'existing';
  const options = option('new', !existing, t('space.new.title'), t('space.new.text')) + option('existing', existing, t('space.existing.title'), t('space.existing.text'));
  const warning = v.warning ? `<p class="spacewarn" role="note">${esc(v.warning)}</p>` : '';
  const error = v.error ? `<p class="errtext" role="alert">${esc(v.error)}</p>` : '';
  const start = `<button class="primary" type="button" data-act="create"${creating || !v.canStart ? ' disabled' : ''}>${esc(t(creating ? 'empty.preparing' : 'empty.start'))}</button>`;
  const extra = cancel ? `<button class="lnk" type="button" data-act="choose-cancel">${esc(t('common.cancel'))}</button>` : `<span class="meta">${esc(t('empty.hint'))}</span>`;
  return `<div class="card fade start"><h3>${esc(t('empty.title'))}</h3><p class="lead">${esc(t('space.lead'))}</p><div class="choices" role="radiogroup" aria-label="${esc(t('space.aria_choice'))}">${options}</div>${existing ? spaceList(v) : ''}${warning}${error}<div class="btnrow">${start}${extra}</div></div>`;
}
