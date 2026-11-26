// Step 3 report cards (port of real/static/app.js personCard/renderReport, lines 67-88).
import { t } from '../../../../shared/i18n.mjs';
import { chineseQuotes, esc, escDates, nobrUnits, queryTerms, type PersonView, type ReportView, type SourceView } from '../lib/logic.mjs';

/** Model-written text: in Chinese, straight quotes around Chinese become 「」; dates stay on one line. */
const text = (value: string): string => nobrUnits(escDates(chineseQuotes(value)));

/** A recall query as the model wrote it: keyword chips (repeats folded for display), or one quoted sentence; the full text is the title. */
export function queryHtml(query: string): string {
  const terms = queryTerms(query);
  const body = terms.length ? terms.map(term => `<span class="qterm">${esc(term)}</span>`).join('') : t('query.quote', { q: esc(query) });
  return `<span class="query" data-query="${esc(query)}" title="${esc(query)}">${body}</span>`;
}

/**
 * Each source is one unbreakable item (it wraps inside only when longer than the line); the separator dot ends the
 * item before it, so a line breaks after the dot and never starts with one.
 */
export const sourcesHtml = (list: SourceView[]): string => list
  .map((s, i) => {
    const dot = i < list.length - 1 ? '\u00a0·' : '';
    const title = s.verified ? esc(s.title) : `<span class="unv" title="${esc(t('report.unverified_title'))}">${esc(s.title)}${esc(t('report.unverified'))}</span>`;
    // The "Sources:" label sits inside the first item, so it always wraps together with the first source.
    return `<span class="srcitem">${i === 0 ? `<span class="srclabel">${esc(t('report.sources'))}</span>` : ''}${title}${dot}</span>`;
  })
  .join(' ');

export function personCard(p: PersonView): string {
  const tag = p.tag.text ? `<span class="tag ${p.tag.tone}">${text(p.tag.text)}</span>` : '';
  const src = sourcesHtml(p.sources);
  return `<div class="person"><div class="av">${esc(p.initial)}</div><div><div class="name">${esc(p.name)}${tag}</div>${p.line ? `<p class="path">${text(p.line)}</p>` : ''}${p.why ? `<p>${text(p.why)}</p>` : ''}${src ? `<div class="src">${src}</div>` : ''}</div></div>`;
}

export function reportHtml(v: ReportView, actions: string): string {
  const tq = sourcesHtml(v.topQuestion.sources);
  const people = (list: PersonView[], empty: string): string => list.length ? list.map(personCard).join('') : `<p class="meta plain">${esc(empty)}</p>`;
  const queries = v.queries.length
    ? `<ol class="qlog">${v.queries.map(q => `<li>${queryHtml(q.query)}<span class="meta">→ ${q.titles.length ? escDates(q.titles.join(t('list.sep'))) : `<span class="nobr">${esc(t('live.none'))}</span>`}</span></li>`).join('')}</ol>`
    : `<p class="meta plain">${esc(t('report.no_queries'))}</p>`;
  const unverified = v.unverified ? `<p class="meta note">${esc(t('report.unverified_note', { n: v.unverified }))}</p>` : '';
  return `<div class="card verdict fade"><h3>${esc(t('report.verdict'))}${text(v.verdict.title)}</h3><p class="plain">${text(v.verdict.text)}</p></div>`
    + `<div class="card alert fade"><h3>${esc(t('report.top_question'))}${text(v.topQuestion.title)}</h3><p>${text(v.topQuestion.text)}</p>${tq ? `<div class="src note">${tq}</div>` : ''}</div>`
    + `<div class="card fade"><h3>${esc(t('report.experts'))} <span class="tag blue">${esc(t('report.experts_tag'))}</span></h3>${people(v.experts, t('report.no_experts'))}${v.expertGap ? `<div class="gap">${text(v.expertGap)}</div>` : ''}</div>`
    + `<div class="card fade"><h3>${esc(t('report.people'))} <span class="tag blue">${esc(t('report.people_tag'))}</span></h3>${people(v.people, t('report.no_people'))}${v.peopleGap ? `<div class="gap">${text(v.peopleGap)}</div>` : ''}</div>`
    + `<div class="card fade"><h3>${esc(t('report.queries'))}</h3>${queries}${unverified}</div>`
    + actions;
}
