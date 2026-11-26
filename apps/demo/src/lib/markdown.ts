// Markdown for demo files and learned Recipes. Raw HTML is shown as text, links are limited to safe schemes, images are dropped.
import { Marked, type RendererThis, type Tokens } from 'marked';
import { chineseQuotes, nobrDates } from './logic.mjs';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ENTITIES[c]);
const UNESCAPE: Record<string, string> = { amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' };

const safeUrl = (href: string): string | null => {
  const value = href.trim();
  if (/^(?:https?:|mailto:)/i.test(value)) return value;
  if (/^[#/]/.test(value) && !value.startsWith('//')) return value;
  return null;
};

const SHORT_CELL = 10;
const textLength = (html: string): number => html.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/gi, '.').length;

/**
 * Tables: wrapped so a wide one scrolls sideways on wide screens; every body cell carries its column header in
 * data-label, which phones show in front of the value when they stack each row (see .table-wrap in demo.css).
 * Short cells (names, nicknames, tags such as 唐伟-远川) stay on one line; long ones wrap.
 */
function renderTable(this: RendererThis, token: Tokens.Generic): string {
  const table = token as unknown as Tokens.Table;
  const cell = (tag: 'th' | 'td', item: Tokens.TableCell, i: number): string => {
    const html = this.parser.parseInline(item.tokens);
    const align = table.align[i] ? ` align="${table.align[i]}"` : '';
    const short = textLength(html) <= SHORT_CELL ? ' class="short"' : '';
    const label = tag === 'td' ? ` data-label="${escapeHtml(chineseQuotes(table.header[i]?.text ?? ''))}"` : '';
    return `<${tag}${align}${short}${label}>${html}</${tag}>`;
  };
  const head = `<tr>${table.header.map((item, i) => cell('th', item, i)).join('')}</tr>`;
  const body = table.rows.map(row => `<tr>${row.map((item, i) => cell('td', item, i)).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>`;
}

const parser = new Marked({ gfm: true, async: false });
parser.use({ extensions: [{ name: 'table', renderer: renderTable }] });
parser.use({
  renderer: {
    html(html: string) { return escapeHtml(html); },
    link(href: string, title: string | null | undefined, text: string) {
      // Autolinks (<https://…>) arrive with the href already escaped; undo that so it is escaped exactly once.
      const url = safeUrl(href.replace(/&(amp|quot|#39|lt|gt);/g, (_: string, name: string) => UNESCAPE[name] ?? _));
      if (url === null) return text;
      // marked 12 passes the title already escaped and the href raw.
      return `<a href="${escapeHtml(url)}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(_href: string, _title: string | null, text: string) { return text; },
    // A date such as 2026-11-15 never breaks at its hyphens.
    // Text nodes only (never code spans, code blocks or link targets): straight quotes around Chinese become 「」.
    // marked hands the text over escaped, so the quotes are unescaped for chineseQuotes and the ones it keeps escaped again.
    // After a raw inline tag such as <code> or <kbd>, marked enters raw-block mode and stops escaping the following
    // text; so text is escaped again here, idempotently (an existing entity is left as it is), before anything else.
    text(text: string) {
      const safe = text.replace(/[<>]|&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]*);)/gi, c => ENTITIES[c]);
      const quoted = chineseQuotes(safe.replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
      return nobrDates(quoted.replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
    },
  },
});

export function renderMarkdown(source: string): string {
  return parser.parse(String(source ?? ''), { async: false }) as string;
}
