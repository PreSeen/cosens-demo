// Step 3 of the investor demo: analyse a new BP with the learned Recipe and the visitor's
// demo memory. Port of the local demo's real/agent.py: same rounds, prompts, de-duplication,
// report validation, single rewrite and source check. No JSON mode: it produced empty objects.
import {kvPutJson} from '../kv.mjs';
import {ServiceError, localized, scrubMessage} from '../http.mjs';
import {DEFAULT_LOCALE, hasMessage, t} from '../../../shared/i18n.mjs';
import {saveRun} from '../runs.mjs';
import {recall} from '../services/memory.mjs';
import {chatStream} from '../services/llm.mjs';
import {finalPrompt, nudgePrompt, systemPrompt, toolsFor, userPrompt} from './prompts.mjs';

export const MAX_ROUNDS = 2;
export const MIN_SEARCHES = 4;
export const TIMEOUT_MS = 300_000;
export const RECALL_TOKEN_BUDGET = 2000;
export const MAX_TOKENS = 16000;
export const TEMPERATURE = 0.2;
const REPORT_ATTEMPTS = 2;

/**
 * A step 3 failure with a stable code for the page (no_search, report_invalid, analysis_timeout).
 * service names the service at fault ('model' for an unusable model answer); null when the analysis itself ran out of time.
 * message is a key of shared/i18n.mjs (rendered in the visitor's language by text()) or plain English text.
 */
export class AnalysisError extends Error {
 constructor(code, message, service = null) {
  super(localized(message));
  this.name = 'AnalysisError';
  this.code = code;
  this.service = service;
  this.key = hasMessage(message) ? message : null;
 }

 text(locale = DEFAULT_LOCALE) {
  return this.key ? localized(this.key, undefined, locale) : this.message;
 }
}

/** The model's report could not be used; the final call is retried once. */
export class ReportError extends Error {
 constructor(message) {
  super(message);
  this.name = 'ReportError';
 }
}

export function analysisKey(accountId, runId) {
 return `analysis:${accountId}:${runId}`;
}

/** File name without its last extension (Python Path.stem), e.g. "锂境科技 BP.md" -> "锂境科技 BP". */
export function bpTitleOf(name, locale = DEFAULT_LOCALE) {
 return String(name ?? '').replace(/\.[^./\\]+$/, '').trim() || t('analyze.new_bp', undefined, locale);
}

/**
 * A model-written recall query as the page shows it: tool-call markup the model leaked into the
 * argument (a closing tag such as `</parameter>`, a bare `</`, `<|...|>` tokens) is dropped and runs of
 * whitespace become one space.
 */
export function cleanQuery(text) {
 return String(text ?? '')
  .replace(/<\|[^|]*\|>/g, ' ')
  .replace(/<\/?(?:tool_call|parameter|function|arg_key|arg_value)\b[^>]*>?/gi, ' ')
  .replace(/<\/[^>\s]*>?/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
}

/** The `query` argument of one memory_recall tool call, cleaned; '' when missing or unparsable. */
export function queryOf(args) {
 try {
  const value = JSON.parse(args || '{}');
  return typeof value?.query === 'string' ? cleanQuery(value.query) : '';
 } catch {
  return '';
 }
}

/** Source titles in recall items: every ingested text starts with "Source: <title>" or, in Chinese, "资料：<title>". */
export function titlesOf(items) {
 const found = new Set();
 for (const item of items || []) {
  for (const match of String(item?.text ?? '').matchAll(/资料：([^\n]+)|(?:^|\n)Source: ([^\n]+)/g)) {
   const title = (match[1] ?? match[2]).trim();
   if (title) found.add(title);
  }
 }
 return found;
}

/** Drop <think> blocks, take the first "{" to the last "}" and parse it. */
export function parseReport(text) {
 const cleaned = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
 const match = cleaned.match(/\{[\s\S]*\}/);
 if (!match) throw new ReportError('the model did not return a JSON report');
 try {
  return JSON.parse(match[0]);
 } catch (err) {
  throw new ReportError(`the report is not valid JSON: ${err.message}`);
 }
}

/** Reject empty or partial reports so the page never shows a hollow result. */
export function validateReport(report) {
 const ok = isObject(report)
  && isObject(report.verdict) && Boolean(report.verdict.title)
  && isObject(report.top_question) && Boolean(report.top_question.title)
  && isEntryList(report.experts) && isEntryList(report.people);
 if (!ok) throw new ReportError('the report is missing required sections');
 return report;
}

/**
 * Rewrite every `sources: string[]` into `{title, verified}[]` in place. A source is verified when
 * memory returned it (exact or substring either way) or when it names the BP itself.
 * @param {object} report
 * @param {Set<string>} seen titles memory returned
 * @param {string} bpTitle
 */
export function checkSources(report, seen, bpTitle) {
 const compact = value => value.replace(/\s+/g, '');
 const bp = compact(bpTitle);
 const titles = [...seen];
 const verify = sources => {
  const out = [];
  for (const raw of Array.isArray(sources) ? sources : []) {
   const title = String(isObject(raw) ? raw.title ?? '' : raw ?? '').trim().replace(/\.md$/, '');
   if (!title) continue;
   const short = compact(title);
   const namesBp = short.includes(bp) || (short.length >= 2 && bp.includes(short));
   const ok = seen.has(title) || namesBp || titles.some(t => t.includes(title) || title.includes(t));
   out.push({title, verified: ok});
  }
  return out;
 };
 if (isObject(report.top_question)) report.top_question.sources = verify(report.top_question.sources);
 for (const key of ['experts', 'people']) {
  for (const entry of report[key] || []) if (isObject(entry)) entry.sources = verify(entry.sources);
 }
 return report;
}

/** The SSE error event for any failure of a step 3 run; upstream text is scrubbed because it goes to the browser. */
export function errorEvent(err, locale = DEFAULT_LOCALE) {
 if (err instanceof AnalysisError) return {type: 'error', code: err.code, message: err.text(locale), ...(err.service ? {service: err.service} : {})};
 if (err instanceof ServiceError) {
  if (err.status === 401 || err.service === 'auth') {
   return {type: 'error', code: 'not_authenticated', message: t('err.login_expired_retry', undefined, locale), service: err.service};
  }
  return {type: 'error', code: err.code, message: scrubMessage(err.text(locale)).slice(0, 300), service: err.service};
 }
 return {type: 'error', code: 'internal_error', message: t('err.analyze_failed', undefined, locale)};
}

/**
 * Run step 3 and save the result as the run's last Analysis.
 * @param {{cfg: object, token: string, accountId: string, run: object, bp: {name: string, text: string}, now?: () => number, locale?: string}} ctx
 * @param {(event: object) => void} emit receives phase, recall, recall_done and finally report
 * @returns {Promise<object>} the saved Analysis
 */
export async function analyze(ctx, emit) {
 const {cfg, token, accountId, run, bp} = ctx;
 const locale = ctx.locale ?? DEFAULT_LOCALE;
 const now = ctx.now ?? Date.now;
 const bpTitle = bpTitleOf(bp.name, locale);
 const recipeText = run.method?.recipe?.instructions ?? '';
 const started = now();
 emit({type: 'phase', text: t('analyze.phase_read', {title: bpTitle}, locale)});
 const messages = [
  {role: 'system', content: systemPrompt(bpTitle, locale)},
  {role: 'user', content: userPrompt({recipeText, bpTitle, bpText: bp.text}, locale)},
 ];
 const seen = new Set();
 const sent = new Set();
 const queries = [];
 for (let round = 0; round < MAX_ROUNDS; round += 1) {
  if (now() - started > TIMEOUT_MS) {
   throw new AnalysisError('analysis_timeout', 'err.analysis_timeout');
  }
  const reply = await chatStream(cfg, token, {messages, tools: toolsFor(locale), toolChoice: 'required', maxTokens: MAX_TOKENS, temperature: TEMPERATURE});
  const calls = reply.toolCalls ?? [];
  if (!calls.length) break;
  messages.push({
   role: 'assistant',
   content: reply.content || '',
   tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: call.arguments}})),
  });
  for (const call of calls) {
   const query = queryOf(call.arguments);
   if (!query) {
    messages.push({role: 'tool', tool_call_id: call.id, content: t('analyze.tool_empty_query', undefined, locale)});
    continue;
   }
   emit({type: 'recall', query});
   const result = await recall(cfg, token, run.vuId, query, RECALL_TOKEN_BUDGET);
   const items = Array.isArray(result?.items) ? result.items : [];
   const titles = [...titlesOf(items)].sort();
   for (const title of titles) seen.add(title);
   queries.push({query, titles});
   emit({type: 'recall_done', query, titles});
   messages.push({role: 'tool', tool_call_id: call.id, content: toolContent(items, sent, locale)});
  }
  if (queries.length >= MIN_SEARCHES) break;
  messages.push({role: 'user', content: nudgePrompt(queries.length, locale)});
 }
 if (!queries.length) {
  throw new AnalysisError('no_search', 'err.no_search', 'model');
 }
 emit({type: 'phase', text: t('analyze.phase_write', undefined, locale)});
 messages.push({role: 'user', content: finalPrompt(locale)});
 let report = null;
 for (let attempt = 0; attempt < REPORT_ATTEMPTS && !report; attempt += 1) {
  const reply = await chatStream(cfg, token, {messages, maxTokens: MAX_TOKENS, temperature: TEMPERATURE});
  try {
   report = validateReport(parseReport(reply.content));
  } catch (err) {
   if (!(err instanceof ReportError)) throw err;
  }
 }
 if (!report) {
  throw new AnalysisError('report_invalid', 'err.report_invalid', 'model');
 }
 checkSources(report, seen, bpTitle);
 const at = now();
 // The BP this report is about: a later BP replaces run.bp, and a replay must keep the analyzed company's name.
 const analysis = {at, seconds: Math.round((at - started) / 1000), vuId: run.vuId, bpName: bp.name, queries, report};
 await kvPutJson(cfg.kv, analysisKey(accountId, run.id), analysis);
 await saveRun(cfg, accountId, run.id, current => {
  current.lastAnalysisAt = at;
  return current;
 });
 emit({type: 'report', analysis});
 return analysis;
}

/** Tool message for one recall: items already sent earlier are replaced by a one-line pointer. */
function toolContent(items, sent, locale) {
 const parts = [];
 for (const item of items) {
  const text = String(item?.text ?? '');
  const key = item?.id || text.slice(0, 80);
  if (sent.has(key)) {
   const [title = t('analyze.tool_earlier_source', undefined, locale)] = titlesOf([item]);
   parts.push(t('analyze.tool_duplicate', {title}, locale));
  } else {
   sent.add(key);
   parts.push(text);
  }
 }
 return parts.join('\n\n---\n\n') || t('analyze.tool_none', undefined, locale);
}

function isObject(value) {
 return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEntryList(value) {
 return Array.isArray(value) && value.length > 0 && value.every(isObject);
}
