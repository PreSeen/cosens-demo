// One locale module for every page that follows the visitor's language (the login-gated demo hub today).
// English is the default and never comes from the browser language. The locale is resolved in this order:
//   1. ?lang=en|zh on the request,
//   2. the cosens-lang cookie (mirrored in localStorage for the client),
//   3. the configured default (the SITE_DEFAULT_LOCALE variable in wrangler.jsonc), "en" when it is unset or invalid.
// MESSAGES is a flat dictionary: key -> {en, zh}. The zh entries are the original Chinese texts; {name} marks a parameter.
// A key `<key>.one` is used instead of `<key>` when params.n is 1 (the English singular).

export const LOCALES = Object.freeze(['en', 'zh']);
export const DEFAULT_LOCALE = 'en';
export const LOCALE_COOKIE = 'cosens-lang';
export const LOCALE_STORAGE_KEY = 'cosens-lang';
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 3600;
export const LOCALE_PARAM = 'lang';
/** What the switch shows for each locale. The names stay in their own language in both locales. */
export const LOCALE_LABELS = Object.freeze({en: 'EN', zh: '中文'});
/** The BCP 47 tag for <html lang>. */
export const LANG_TAGS = Object.freeze({en: 'en', zh: 'zh-CN'});

/** 'en' | 'zh' for those two values (any case), null for anything else. */
export function normalizeLocale(value) {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return word === 'en' || word === 'zh' ? word : null;
}

/** The configured default from the Pages environment (SITE_DEFAULT_LOCALE); "en" when unset or not en/zh. */
export function defaultLocale(env) {
  return normalizeLocale(env?.SITE_DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
}

/** One cookie value out of a Cookie header (or document.cookie). */
export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

/** ?lang, then the cookie, then the default. Every argument may be missing. */
export function resolveLocale({search, cookie, fallback} = {}) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search ?? ''));
  return normalizeLocale(params.get(LOCALE_PARAM)) ?? normalizeLocale(cookie) ?? normalizeLocale(fallback) ?? DEFAULT_LOCALE;
}

/** The locale of a Request: ?lang, the cosens-lang cookie, then the configured default (env.SITE_DEFAULT_LOCALE). */
export function requestLocale(request, env) {
  const url = new URL(request.url);
  return resolveLocale({search: url.searchParams, cookie: readCookie(request.headers.get('Cookie'), LOCALE_COOKIE), fallback: defaultLocale(env)});
}

/** True when the request names its language with a valid ?lang (the response then stores it in the cookie). */
export function hasLocaleParam(request) {
  return normalizeLocale(new URL(request.url).searchParams.get(LOCALE_PARAM)) !== null;
}

/** Set-Cookie value that remembers the visitor's language: readable by the page script, SameSite=Lax, path=/. */
export function localeCookie(locale, {secure = true} = {}) {
  return `${LOCALE_COOKIE}=${normalizeLocale(locale) ?? DEFAULT_LOCALE}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// The locale the client helpers use when a call does not name one. The server never sets it: server code always passes a locale.
let current = DEFAULT_LOCALE;
export const getLocale = () => current;
export function setLocale(locale) {
  current = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  return current;
}

/** The text for key in locale (default: the current client locale), with {name} parameters filled in. A missing key returns the key. */
export function t(key, params, locale = current) {
  const lang = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const plural = params && params.n === 1 ? MESSAGES[`${key}.one`] : undefined;
  const entry = plural ?? MESSAGES[key];
  if (!entry) return key;
  const text = entry[lang] ?? entry.en;
  return params ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole)) : text;
}

/** True when key is in the dictionary. */
export const hasMessage = key => Object.hasOwn(MESSAGES, key);

// ---- Client: persistence, the page's static texts and the EN/中文 switch (same shape as shared/theme.mjs) ----

/** The locale the page opens in: ?lang, the cookie, localStorage (the cookie's mirror), the configured default, "en". */
export function readPageLocale(win = window) {
  let stored = '';
  try { stored = win.localStorage.getItem(LOCALE_STORAGE_KEY) ?? ''; } catch { /* Storage can be denied. */ }
  const meta = win.document.querySelector('meta[name="cosens-default-locale"]')?.getAttribute('content');
  return resolveLocale({
    search: win.location.search,
    cookie: readCookie(win.document.cookie, LOCALE_COOKIE) || stored,
    fallback: meta,
  });
}

/** Remembers the visitor's choice in the cookie (sent with every API call) and in localStorage. */
export function persistLocale(locale, win = window) {
  const value = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  try { win.document.cookie = localeCookie(value, {secure: win.location.protocol === 'https:'}); } catch { /* Cookies can be denied. */ }
  try { win.localStorage.setItem(LOCALE_STORAGE_KEY, value); } catch { /* Storage can be denied. */ }
}

/**
 * Texts of the static HTML: data-i18n (text), data-i18n-title, data-i18n-aria-label, data-i18n-placeholder,
 * data-i18n-download and data-i18n-alt name a dictionary key. The HTML itself carries the English default.
 */
export function applyStaticTexts(root = document, locale = current) {
  const attributes = ['title', 'aria-label', 'placeholder', 'download', 'alt'];
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.getAttribute('data-i18n'), undefined, locale);
  for (const name of attributes) {
    for (const node of root.querySelectorAll(`[data-i18n-${name}]`)) node.setAttribute(name, t(node.getAttribute(`data-i18n-${name}`), undefined, locale));
  }
}

/** <html lang>, the static texts, the document title and the switch buttons follow the locale. */
export function applyLocale(locale, win = window) {
  const value = setLocale(locale);
  const doc = win.document;
  doc.documentElement.lang = LANG_TAGS[value];
  applyStaticTexts(doc, value);
  const next = value === 'en' ? 'zh' : 'en';
  const label = t('lang.switch_label', undefined, value);
  doc.querySelectorAll('[data-locale-control]').forEach(control => {
    control.setAttribute('aria-label', label);
    control.setAttribute('title', label);
    control.dataset.locale = value;
    control.dataset.next = next;
    control.querySelectorAll('[data-locale-option]').forEach(option => {
      const active = option.getAttribute('data-locale-option') === value;
      option.classList.toggle('on', active);
      if (active) option.setAttribute('aria-current', 'true'); else option.removeAttribute('aria-current');
    });
  });
  win.dispatchEvent(new win.CustomEvent('cosens:localechange', {detail: {locale: value}}));
  return value;
}

/** The markup of the switch: both names, the current one marked. Pages put it next to the theme control. */
export function localeControlHtml() {
  const options = LOCALES.map(locale => `<span data-locale-option="${locale}" lang="${LANG_TAGS[locale]}">${LOCALE_LABELS[locale]}</span>`);
  return `<button class="cs-locale-control" type="button" data-locale-control>${options.join('<span class="sep" aria-hidden="true">/</span>')}</button>`;
}

/** A visitor-driven switch: ?lang leaves the URL (it would win over the new choice on the next load). */
function dropLocaleParam(win) {
  try {
    const url = new URL(win.location.href);
    if (!url.searchParams.has(LOCALE_PARAM)) return;
    url.searchParams.delete(LOCALE_PARAM);
    win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
  } catch { /* Keep the URL as it is. */ }
}

/** Opens the page in its locale: reads it, remembers an explicit ?lang, drops ?lang from the address, applies it. */
export function initLocale(win = window) {
  const locale = readPageLocale(win);
  let stored = '';
  try { stored = win.localStorage.getItem(LOCALE_STORAGE_KEY) ?? ''; } catch { /* Storage can be denied. */ }
  const hasParam = new URLSearchParams(win.location.search).has(LOCALE_PARAM);
  // The server reads the cookie: write it again when only its localStorage mirror survived.
  if (hasParam || (!readCookie(win.document.cookie, LOCALE_COOKIE) && normalizeLocale(stored))) persistLocale(locale, win);
  if (hasParam) dropLocaleParam(win);
  return applyLocale(locale, win);
}

/** Click handling for [data-locale-control] inside root (the page's own mount, like mountThemeControls). Returns a cleanup function. */
export function mountLocaleControls(root = document, win = window) {
  const click = event => {
    if (!event.target.closest?.('[data-locale-control]')) return;
    const next = current === 'en' ? 'zh' : 'en';
    persistLocale(next, win);
    dropLocaleParam(win);
    applyLocale(next, win);
  };
  const storageChange = event => {
    if (event.key === LOCALE_STORAGE_KEY && normalizeLocale(event.newValue) && normalizeLocale(event.newValue) !== current) applyLocale(event.newValue, win);
  };
  root.addEventListener('click', click);
  win.addEventListener('storage', storageChange);
  applyLocale(current, win);
  return () => {
    root.removeEventListener('click', click);
    win.removeEventListener('storage', storageChange);
  };
}

const MESSAGES = {
  'lang.switch_label': {en: 'Language: English. Switch to Chinese.', zh: '语言：中文。切换到 English。'},
  // ---- Server: service names and errors ----
  'service.memory': {en: 'Memory', zh: 'Memory'},
  'service.rsi': {en: 'RSI', zh: 'RSI'},
  'service.model': {en: 'The model service', zh: '模型服务'},
  'service.account': {en: 'The account service', zh: '账号服务'},
  'service.auth': {en: 'The sign-in service', zh: '登录服务'},
  'service.demo': {en: 'The service', zh: '服务'},
  'err.session_expired': {en: 'Your session is no longer valid. Please sign in again.', zh: '登录已失效，请重新登录'},
  'err.login_expired': {en: 'Your login has expired. Please sign in again.', zh: '登录已过期，请重新登录'},
  'err.login_expired_retry': {en: 'Your login has expired. Please sign in again and retry.', zh: '登录已过期，请重新登录后重试。'},
  'err.service_failed': {en: '{service} reported an error.', zh: '{service}出错了'},
  'err.config_incomplete': {en: 'The demo service is not fully configured: {detail}', zh: '演示服务配置不完整：{detail}'},
  'err.internal': {en: 'The demo service hit an error. Please try again shortly.', zh: '演示服务出错了，请稍后重试'},
  'err.http_status': {en: '{service} returned HTTP {status}.', zh: '{service}返回 HTTP {status}'},
  'err.sign_in_first': {en: 'Please sign in first.', zh: '请先登录'},
  'err.invalid_vu': {en: 'The demo Virtual User ID is not valid.', zh: '演示 VU 编号无效'},
  'err.space_invalid': {en: 'The space ID is not valid.', zh: '空间编号无效'},
  'err.space_not_found': {en: 'This space could not be found, or it is not shared with you. Pick another space, or create a new demo space.', zh: '找不到这个空间，或者它没有共享给你。请换一个空间，或新建演示空间'},
  'err.space_read_only': {en: 'You can only read this space, not write to it. Pick another space, or create a new demo space.', zh: '这个空间你只能查看，不能写入。请换一个空间，或新建演示空间'},
  'err.text_only': {en: 'This environment accepts only Markdown and text. Save PDF and Word files as .md or .txt and upload them again.', zh: '这个环境只支持 Markdown 和文本，PDF 和 Word 请另存为 .md 或 .txt 再上传'},
  'err.auth_unreachable': {en: 'The sign-in service cannot be reached right now.', zh: '登录服务暂时无法连接'},
  'err.auth_unparsable': {en: 'The sign-in service returned data that could not be parsed.', zh: '登录服务返回的数据无法解析'},
  'err.auth_no_client_id': {en: 'The sign-in service did not return a client ID.', zh: '登录服务没有返回客户端编号'},
  'err.auth_incomplete_credentials': {en: 'The sign-in service returned incomplete credentials.', zh: '登录服务返回的凭证不完整'},
  'err.unknown': {en: 'Unknown error', zh: '未知错误'},

  // ---- Login error page and banner ----
  'login.error.access_denied': {en: 'You cancelled the sign-in authorization.', zh: '你取消了登录授权。'},
  'login.error.authorize_failed': {en: 'The sign-in service rejected the authorization request. Please sign in again.', zh: '登录服务拒绝了这次授权请求，请重新登录。'},
  'login.error.state_invalid': {en: 'The sign-in request has expired or is not valid. Please sign in again.', zh: '登录请求已过期或无效，请重新登录。'},
  'login.error.code_missing': {en: 'The sign-in service did not return an authorization code. Please sign in again.', zh: '登录服务没有返回授权码，请重新登录。'},
  'login.error.token_exchange_failed': {en: 'Exchanging the authorization for sign-in credentials failed. Please sign in again.', zh: '换取登录凭证失败，请重新登录。'},
  'login.error.client_registration_failed': {en: 'The demo hub cannot register with the sign-in service right now. Please try again later.', zh: '演示中心暂时无法在登录服务注册，请稍后再试。'},
  'login.error.service_unavailable': {en: 'The sign-in service is unavailable right now. Please try again later.', zh: '登录服务暂时不可用，请稍后再试。'},
  'login.error.config_missing': {en: 'The demo hub is not fully configured yet. Please contact us.', zh: '演示中心还没有配置完成，请联系我们。'},
  'login.error.login_loop': {en: 'You signed in, but the demo service still refuses access. Please try again in two minutes; if it keeps happening, contact us.', zh: '登录成功了，但演示服务仍然拒绝访问。请两分钟后再试；如果一直这样，请联系我们。'},
  'login.error.unknown': {en: 'Sign-in was not completed. Please sign in again.', zh: '登录没有完成，请重新登录。'},
  'login.page_title': {en: 'CoSens Demo · Sign-in not completed', zh: 'CoSens 演示 · 登录未完成'},
  'login.heading': {en: 'Sign-in was not completed', zh: '登录没有完成'},
  'login.retry': {en: 'Sign in again', zh: '重新登录'},
  'login.home': {en: 'Back to home', zh: '返回首页'},
  'login.tech': {en: 'Technical details', zh: '技术信息'},
  'login.code': {en: 'Error code: ', zh: '错误代码：'},
  'shell.home_label': {en: 'CoSens home', zh: 'CoSens 首页'},
  'shell.brand_label': {en: 'Demo', zh: '演示'},
  'shell.hub_label': {en: 'CoSens demo home', zh: 'CoSens 演示首页'},
  'lang.nav_label': {en: 'Language', zh: '语言'},
  'theme.toggle': {en: 'Switch between light and dark', zh: '切换浅色或深色'},

  // ---- Server: runs, files, steps ----
  'run.name': {en: 'CoSens Demo · Investor · {time}', zh: 'CoSens 演示 · 投资人 · {time}'},
  'err.run_not_found': {en: 'This demo could not be found.', zh: '找不到这次演示'},
  'err.run_conflict': {en: 'This demo\'s record is being changed at the same time. Please try again shortly.', zh: '这次演示的记录正被同时修改，请稍后再试'},
  'err.request_too_large': {en: 'The request is too large.', zh: '请求内容太大'},
  'err.request_not_json': {en: 'The request body is not valid JSON.', zh: '请求内容不是有效的 JSON'},
  'err.analysis_not_found': {en: 'This demo has no saved analysis yet.', zh: '这次演示还没有保存的分析结果。'},
  'err.upload_unreadable': {en: 'The uploaded form could not be read. Please choose the file again.', zh: '上传的表单无法读取，请重新选择文件'},
  'err.upload_missing': {en: 'Please choose a file to upload.', zh: '请选择要上传的文件'},
  'err.demo_path_missing': {en: 'Please say which demo file to use.', zh: '请指明要使用的演示资料'},
  'err.invalid_group': {en: 'The material group must be memory, method or bp.', zh: '资料分组只能是 memory、method 或 bp'},
  'err.step1_first': {en: 'Finish step 1 first: hand the materials to the AI to remember.', zh: '请先完成第 1 步：把资料交给 AI 记住。'},
  'err.step2_first': {en: 'Finish step 2 first: let the AI learn your investment method.', zh: '请先完成第 2 步：让 AI 学会您的投资方法。'},
  'err.bp_first': {en: 'Hand the new BP to the AI first.', zh: '请先把新 BP 交给 AI。'},
  'err.bp_expired': {en: 'The new BP file has expired. Please add it again.', zh: '新 BP 文件已经过期，请重新放入。'},
  'err.refresh_unresponsive': {en: '{service} is not responding. Progress will update automatically later.', zh: '{service}暂时没有响应，进度稍后会自动更新。'},
  'err.file_name_invalid': {en: 'The file name cannot be empty or longer than 200 characters.', zh: '文件名不能为空，也不能超过 200 个字符'},
  'err.not_utf8': {en: 'Text files must be UTF-8 encoded.', zh: '文本文件需要是 UTF-8 编码'},
  'ingest.marker': {en: 'Source: {title}', zh: '资料：{title}'},
  'err.empty_file': {en: '"{name}" is an empty file.', zh: '「{name}」是空文件'},
  'err.memory_types_all': {en: 'Memory materials must be .md, .markdown, .txt, .pdf, .doc or .docx files.', zh: '记忆资料只支持 .md、.markdown、.txt、.pdf、.doc、.docx'},
  'err.memory_types_text': {en: 'Memory materials must be .md, .markdown or .txt files.', zh: '记忆资料只支持 .md、.markdown、.txt'},
  'err.doc_too_large': {en: 'PDF and Word files cannot exceed 20 MB.', zh: 'PDF 和 Word 文件不能超过 20 MB'},
  'err.text_too_large': {en: 'Markdown and text materials cannot exceed 2 million characters.', zh: 'Markdown 和文本资料不能超过 200 万字'},
  'err.bp_text_only': {en: 'The new BP must be a .md, .markdown or .txt file.', zh: '新 BP 只支持 .md、.markdown、.txt'},
  'err.method_types': {en: 'Investment method files must be .md, .markdown, .txt, .pdf, .doc or .docx files.', zh: '投资方法文件只支持 .md、.markdown、.txt、.pdf、.doc、.docx'},
  'err.file_too_large_4mb': {en: 'A single file cannot exceed 4 MB.', zh: '单个文件不能超过 4 MB'},
  'err.invalid_method_file': {en: 'An investment method file must say whether it belongs to project A or project B, and whether it is a BP or an investment recommendation.', zh: '投资方法文件要说明是项目 A 还是项目 B，是 BP 还是投资建议书'},
  'err.demo_data_missing': {en: 'The demo materials cannot be reached right now. Please try again later.', zh: '演示资料暂时取不到，请稍后再试'},
  'err.demo_file_not_found': {en: 'That demo file could not be found.', zh: '找不到这份演示资料'},
  'group.memory.title': {en: 'Memory materials', zh: '记忆资料'},
  'group.memory.hint': {en: 'contacts, minutes, chats', zh: '联系人、纪要、聊天'},
  'group.method.title': {en: 'Investment method', zh: '投资方法'},
  'group.method.hint': {en: 'past BPs and recommendations', zh: '过往 BP 和建议书'},
  'group.bp.title': {en: 'New BP', zh: '新 BP'},
  'group.bp.hint': {en: 'the project to analyze this time', zh: '这次要分析的项目'},
  'memory.timeout': {en: 'Writing took more than 30 minutes and did not finish. You can add the file again.', zh: '写入超过 30 分钟还没有完成，可以重新添加'},
  'memory.failed': {en: 'The material could not be written. You can add it again.', zh: '资料写入失败，可以重新添加'},
  'memory.doc_missing': {en: 'The uploaded document could not be found. You can add it again.', zh: '找不到上传的文档，可以重新添加'},
  'memory.upload_no_id': {en: 'The document upload returned no ID. You can add it again.', zh: '文档上传没有返回编号，可以重新添加'},
  'memory.job_missing': {en: 'The writing job could not be found. You can add the file again.', zh: '找不到写入任务，可以重新添加'},
  'method.cancelled': {en: 'Learning was cancelled.', zh: '学习被取消了'},
  'method.not_finished_short': {en: 'Learning did not finish.', zh: '学习没有完成'},
  'method.project_not_started': {en: 'Project {slot} did not start learning: {reason}', zh: '项目 {slot} 没有开始学习：{reason}'},
  'method.project_gave_up': {en: 'Project {slot} was tried {attempts} times without finishing: {reason}', zh: '项目 {slot} 学了 {attempts} 次都没有完成：{reason}'},
  'method.recipe_unreadable': {en: 'Project B finished learning, but the learned method could not be retrieved: {reason}', zh: '项目 B 学完了，但拿不到学到的方法：{reason}'},
  'err.recipe_no_id': {en: 'Learning finished, but no method ID was returned.', zh: '学习完成了，但没有返回方法编号'},
  'err.recipe_no_version': {en: 'Learning finished, but there is no usable method version.', zh: '学习完成了，但没有可用的方法版本'},
  'err.project_file_expired': {en: 'The file "{name}" of project {slot} has expired. Please add it again.', zh: '项目 {slot} 的「{name}」已经过期，请重新放入'},
  'err.method_started': {en: 'This demo has already started learning the method. To change the materials, click "Start over".', zh: '这次演示已经开始学习方法，要换资料请点「重新开始」'},
  'err.method_files_missing': {en: '{projects}: still missing a BP or an investment recommendation.', zh: '{projects}还缺 BP 或投资建议书'},
  'project.label': {en: 'Project {slot}', zh: '项目 {slot}'},
  'list.sep': {en: ', ', zh: '、'},
  'analyze.new_bp': {en: 'New BP', zh: '新 BP'},
  'err.analysis_timeout': {en: 'The analysis took more than 5 minutes and did not finish. Retry, or click "Last result".', zh: '分析超过 5 分钟还没有完成，请重试，或点「上次结果」。'},
  'err.no_search': {en: 'The model tried to write the report without searching memory. Such a report has no basis and was rejected. Please retry.', zh: '模型没有在记忆里检索就想直接写报告，这样的报告没有依据，已经拒绝。请重试。'},
  'err.report_invalid': {en: 'The model failed twice to write a complete report (missing the conclusion, the first question, experts or background checks). Please retry.', zh: '模型两次都没有写出完整的报告（缺结论、首要追问、专家或背调），请重试。'},
  'err.analyze_failed': {en: 'The analysis hit an error. Please retry.', zh: '分析出错了，请重试。'},
  'analyze.phase_read': {en: 'Reading the BP: {title}', zh: '读 BP：{title}'},
  'analyze.phase_write': {en: 'Writing the report with your method (about 1 minute)', zh: '按你的方法写报告（约 1 分钟）'},
  'analyze.tool_empty_query': {en: '(The search question was empty, so nothing was searched.)', zh: '（检索问题为空，没有查询）'},
  'analyze.tool_earlier_source': {en: 'a source returned earlier', zh: '前面已返回的资料'},
  'analyze.tool_duplicate': {en: '(Same as "{title}" returned earlier; not repeated.)', zh: '（与前面返回的「{title}」相同，不再重复）'},
  'analyze.tool_none': {en: '(Nothing found.)', zh: '（没有找到）'},

  // ---- Client: errors, hub, hero, step state ----
  'label.memory': {en: 'Memory', zh: 'Memory'},
  'label.rsi': {en: 'RSI', zh: 'RSI'},
  'label.model': {en: 'Model', zh: '模型'},
  'label.account': {en: 'Account service', zh: '账号服务'},
  'label.auth': {en: 'Sign-in', zh: '登录'},
  'code.not_authenticated': {en: 'Your login has expired. Please sign in again.', zh: '登录已过期，请重新登录'},
  'code.run_not_found': {en: 'This demo could not be found. It may belong to another account.', zh: '找不到这次演示，它可能不属于当前登录的账号'},
  'code.step_not_ready': {en: 'The earlier steps are not finished yet.', zh: '前面的步骤还没完成'},
  'code.analysis_not_found': {en: 'This demo has no saved analysis yet.', zh: '这次演示还没有保存的分析结果'},
  'code.network_error': {en: 'The network connection failed. Check your network and retry.', zh: '网络连接失败，请检查网络后重试'},
  'code.stream_broken': {en: 'The connection was interrupted.', zh: '连接中断'},
  'code.bad_event': {en: 'A progress message could not be parsed.', zh: '收到无法解析的进度消息'},
  'code.asset_missing': {en: 'The demo materials did not load.', zh: '演示资料没有加载出来'},
  'code.internal_error': {en: 'The demo service hit an error.', zh: '演示服务出错了'},
  'code.config_missing': {en: 'The demo service is not configured yet.', zh: '演示服务还没有配置好'},
  'analysis.stream_broken': {en: 'Connection interrupted: the model\'s reply was cut off midway, so the report was not finished.', zh: '连接中断：模型的回复中途断开了，报告没有写完'},
  'analysis.network_error': {en: 'The network connection failed and the analysis service could not be reached. Check your network and retry.', zh: '网络连接失败，没能连上分析服务，请检查网络后重试'},
  'analysis.failed': {en: 'Analysis service error: {detail}', zh: '分析服务出错：{detail}'},
  'login.banner_signed_in': {en: 'The last sign-in was not completed: {message} You are still signed in and can open the demos directly; to switch accounts, sign in again.', zh: '上次登录没有完成：{message}你仍处于登录状态，可以直接进入演示；要换账号，请重新登录。'},
  'run.step.0': {en: 'Not started', zh: '还没开始'},
  'run.step.1': {en: 'Reached step 1', zh: '做到第 1 步'},
  'run.step.2': {en: 'Reached step 2', zh: '做到第 2 步'},
  'run.step.3': {en: 'Reached step 3', zh: '做到第 3 步'},
  'hub.no_runs': {en: 'No demos yet. Open one and click "Start demo".', zh: '还没有演示过，进去后点「开始演示」。'},
  'hub.runs': {en: 'You have {n} demos. Latest: {name} ({step}).', zh: '已有 {n} 次演示，最近一次：{name}（{step}）。'},
  'hub.runs.one': {en: 'You have 1 demo. Latest: {name} ({step}).', zh: '已有 {n} 次演示，最近一次：{name}（{step}）。'},
  'role.bp': {en: 'BP', zh: 'BP'},
  'role.proposal': {en: 'Investment recommendation', zh: '投资建议书'},
  'deliver.unknown_group': {en: 'Unknown group of materials.', zh: '不认识这组资料'},
  'deliver.already': {en: '"{group}" has already been handed to me.', zh: '「{group}」已经交给我了'},
  'deliver.first': {en: 'Please hand me "{group}" first.', zh: '请先把「{group}」交给我'},
  'deliver.method_started': {en: 'The method has already started learning. To use different past projects, click "Start over" to begin a new demo.', zh: '方法已经开始学了。想换过往项目，请点「重新开始」新建一次演示'},
  'hero.idle.prompt': {en: 'Drag your materials to me and I will remember them first', zh: '把资料拖给我，我先记住'},
  'hero.idle.sub': {en: 'WeChat contacts, meeting minutes, chat logs, internal notes: as many as you like', zh: '微信联系人、会议纪要、聊天记录、内部笔记，多少都可以'},
  'hero.projects.prompt': {en: 'Hand me two past projects', zh: '把两个过往项目交给我'},
  'hero.projects.sub_ready': {en: 'All four files are in. Click "Start learning".', zh: '四份都放齐了，点「开始学习」'},
  'hero.projects.sub_partial': {en: 'One BP and one investment recommendation per project. Once all four are in, learning can start.', zh: '每个项目一份 BP 和一份投资建议书，放齐四份就可以开始学习'},
  'hero.memory_running.prompt': {en: 'Remembering…', zh: '正在记住…'},
  'hero.memory_running.sub': {en: 'I am reading every file and picking out the people, the companies and the relations between them. You can close the page and come back.', zh: '我在读每一份资料，认出里面的人、公司和他们之间的关系。可以先关掉页面，回来接着看'},
  'hero.memory_failed.prompt': {en: 'Some materials were not remembered', zh: '有资料没记住'},
  'hero.memory_failed.sub': {en: 'See below which file had a problem. You can retry it on its own.', zh: '看看下面是哪份资料出了问题，可以单独重试'},
  'hero.memory_done.prompt': {en: 'Remembered', zh: '记住了'},
  'hero.memory_done.sub': {en: 'Next, hand me two past projects: one BP and one investment recommendation each, four files in all, and I will learn how you judge.', zh: '接下来，把两个过往项目交给我：每个项目一份 BP 和一份投资建议书，一共四份，我来学你的判断方法'},
  'hero.method_running.prompt': {en: 'Learning your method…', zh: '正在学习你的方法…'},
  'hero.method_running.sub': {en: 'I am reading the two past projects, summarizing the rules, and redoing the old BP to test myself (about 16 minutes; you can close the page).', zh: '我在读两个过往项目，总结规矩，再拿旧 BP 重做一遍检验自己（约 16 分钟，可以关掉页面）'},
  'hero.method_failed.prompt': {en: 'The method was not fully learned', zh: '方法没有学完'},
  'hero.method_failed.sub': {en: 'See the cause below. You can retry.', zh: '看看下面的出错原因，可以重试'},
  'hero.method_done.prompt': {en: 'Learned', zh: '学会了'},
  'hero.method_done.sub': {en: 'Now drag the new BP to me.', zh: '现在把新的 BP 拖给我'},
  'hero.bp_received.prompt': {en: 'New BP received', zh: '新 BP 已收到'},
  'hero.bp_memory_failed.sub': {en: 'Some materials were not remembered. Retry them in step 1 first.', zh: '还有资料没记住，先到第 1 步重试'},
  'hero.bp_memory_running.sub': {en: 'The materials are still being remembered. Analysis can start once they are done.', zh: '资料还在记，记完就可以开始分析'},
  'hero.ready.prompt': {en: 'Ready to analyze', zh: '可以开始分析了'},
  'hero.ready.sub': {en: 'Click "Start analysis". It takes about 1.5 to 3 minutes.', zh: '点「开始分析」，大约 1.5 到 3 分钟'},
  'hero.analyzed.prompt': {en: 'Analyzed', zh: '分析过了'},
  'hero.analyzed.sub': {en: 'Click "Last result" to view it, or analyze again.', zh: '点「上次结果」查看，或者再分析一次'},
  'memory.title.none': {en: 'No materials yet', zh: '还没有资料'},
  'memory.title.running': {en: 'Reading {n} files', zh: '正在读 {n} 份资料'},
  'memory.title.running.one': {en: 'Reading 1 file', zh: '正在读 {n} 份资料'},
  'memory.title.done': {en: 'Remembered {n} files', zh: '已记住 {n} 份资料'},
  'memory.title.done.one': {en: 'Remembered 1 file', zh: '已记住 {n} 份资料'},
  'memory.title.failed': {en: '{n} files were not remembered', zh: '{n} 份资料没记住'},
  'memory.title.failed.one': {en: '1 file was not remembered', zh: '{n} 份资料没记住'},
  'chip.memory.empty': {en: 'Memory · empty', zh: '记忆 · 空'},
  'chip.memory.running': {en: 'Memory · remembering {done}/{total}', zh: '记忆 · 正在记 {done}/{total}'},
  'chip.memory.files': {en: 'Memory · {n} files', zh: '记忆 · {n} 份资料'},
  'chip.memory.files.one': {en: 'Memory · 1 file', zh: '记忆 · {n} 份资料'},
  'chip.method.done': {en: 'Method · learned', zh: '方法 · 已学会'},
  'chip.method.running': {en: 'Method · learning', zh: '方法 · 学习中'},
  'chip.method.failed': {en: 'Method · not finished', zh: '方法 · 没学完'},
  'chip.method.none': {en: 'Method · not learned', zh: '方法 · 未学习'},
  'phase.analyze': {en: 'Read the BP and the recommendation', zh: '读懂 BP 和建议书'},
  'phase.generate': {en: 'Summarize the judgment rules', zh: '总结判断规矩'},
  'phase.test': {en: 'Redo this project with the learned method', zh: '用学到的方法重做这个项目'},
  'phase.evaluate': {en: 'Compare and score against the original recommendation point by point', zh: '和当时的建议书逐条比对打分'},
  'project.status.idle': {en: 'Waiting to start', zh: '等待开始'},
  'project.status.queued': {en: 'Queued', zh: '排队中'},
  'project.status.running': {en: 'Learning', zh: '学习中'},
  'project.status.completed': {en: 'Learned', zh: '学完了'},
  'project.status.failed': {en: 'Not finished', zh: '没学完'},
  'project.status.cancelled': {en: 'Cancelled', zh: '已取消'},
  'project.attempt': {en: ' (attempt {n})', zh: '（第 {n} 次尝试）'},
  'assign.pick': {en: 'Choose a project and a type for "{name}"', zh: '请给「{name}」选好项目和类型'},
  'assign.duplicate': {en: 'Two files were put in "{project} · {role}": {first}, {second}', zh: '「{project} · {role}」放了两份文件：{first}、{second}'},
  'file.too_large': {en: '"{name}" cannot exceed {limit}', zh: '「{name}」不能超过 {limit}'},
  'file.text_only': {en: '"{name}" cannot be uploaded: this environment accepts only Markdown and text. Save it as .md or .txt and drag it in again', zh: '「{name}」不能上传：这个环境只支持 Markdown 和文本。请另存为 .md 或 .txt 再拖进来'},
  'file.empty': {en: '"{name}" is an empty file', zh: '「{name}」是空文件'},
  'file.memory_types': {en: '"{name}" cannot be uploaded: only Markdown, text, PDF and Word files are supported. Switch to one of these formats and drag it in again', zh: '「{name}」不能上传：只支持 Markdown、文本、PDF 和 Word 文件。请换成这几种格式再拖进来'},
  'file.text_types': {en: '"{name}" cannot be uploaded: only Markdown and text files are supported. Save it as .md or .txt and drag it in again', zh: '「{name}」不能上传：只支持 Markdown 和文本文件。请另存为 .md 或 .txt 再拖进来'},
  'limit.text_chars': {en: '2 million characters', zh: '200 万字'},
  'report.independent': {en: 'Independent', zh: '独立'},
  'report.maybe_not_independent': {en: 'May not be independent', zh: '可能不独立'},
  'report.hero_title': {en: '{title} · Due diligence advice', zh: '{title} · 尽调建议'},
  'report.hero_title_bare': {en: 'Due diligence advice', zh: '尽调建议'},
  'report.note_replay': {en: 'Result of the last real run ({time})', zh: '上次真实运行结果（{time}）'},
  'report.note_live': {en: 'Live run complete: {seconds} seconds, memory searched {n} times', zh: '现场运行完成，用时 {seconds} 秒，查了 {n} 次记忆'},
  'report.note_live.one': {en: 'Live run complete: {seconds} seconds, memory searched once', zh: '现场运行完成，用时 {seconds} 秒，查了 {n} 次记忆'},
  'live.search': {en: 'Searching memory: {query}', zh: '在记忆里查：{query}'},
  'live.found': {en: 'Found {n} sources', zh: '找到 {n} 份资料'},
  'live.found.one': {en: 'Found 1 source', zh: '找到 {n} 份资料'},
  'live.none': {en: 'Nothing found', zh: '没有找到'},

  // ---- Client: hub, shell and investor page ----
  'common.loading': {en: 'Loading…', zh: '正在加载…'},
  'common.retry': {en: 'Retry', zh: '重试'},
  'common.cancel': {en: 'Cancel', zh: '取消'},
  'common.close': {en: 'Close', zh: '关闭'},
  'common.collapse': {en: 'Collapse', zh: '收起'},
  'common.expand': {en: 'Expand', zh: '展开'},
  'common.show_all': {en: 'Show all', zh: '展开全部'},
  'common.use_demo': {en: 'Use the demo materials', zh: '使用演示资料'},
  'common.colon': {en: ': ', zh: '：'},
  'list.sep_long': {en: '; ', zh: '；'},
  'api.no_stream': {en: 'The analysis endpoint did not return a progress stream.', zh: '分析接口没有返回进度流'},
  'shell.logout': {en: 'Sign out', zh: '退出登录'},
  'hub.page_title': {en: 'CoSens Demo', zh: 'CoSens 演示'},
  'hub.title': {en: 'CoSens Demo', zh: 'CoSens 演示'},
  'hub.sub': {en: 'Pick a demo and try it yourself. A demo creates its own demo space under your account by default; the materials and the learned method live only there and never touch your own memory. You can also pick a space you already have.', zh: '选一个演示亲手试一遍。演示默认在你的账号下新建一个独立的演示空间，资料和学到的方法只存在那里，不会碰到你自己的记忆；也可以选你已有的空间接着用。'},
  'hub.list_label': {en: 'Demo list', zh: '演示列表'},
  'hub.go': {en: 'Open the demo →', zh: '进入演示 →'},
  'hub.runs_failed': {en: 'Earlier demos cannot be read right now.', zh: '暂时读不到之前的演示记录'},
  'demo.investor.title': {en: 'Investor demo', zh: '投资人演示'},
  'demo.investor.summary': {en: 'With the materials of a fictional investor, watch CoSens remember his network, learn his investment method, and then analyze a new BP with that method, giving due diligence advice with sources.', zh: '用一位虚构投资人的资料，看 CoSens 记住他的人脉，学会他的投资方法，再按这套方法分析一份新 BP，给出带出处的尽调建议。'},
  'demo.investor.step1': {en: '1 Remember materials', zh: '1 记住资料'},
  'demo.investor.step2': {en: '2 Learn the method', zh: '2 学会方法'},
  'demo.investor.step3': {en: '3 Analyze the BP', zh: '3 分析 BP'},
  'demo.investor.note': {en: 'The first two steps run on the server and take about 20 minutes in all; you can close the page and come back. Step 3 runs live and takes about 1.5 to 3 minutes. You can also use your own materials.', zh: '前两步在服务端运行，一共约 20 分钟，可以关掉页面回来接着看；第 3 步现场运行，约 1.5 到 3 分钟。也可以换成你自己的资料。'},
  'investor.page_title': {en: 'CoSens Investor Demo', zh: 'CoSens 投资人演示'},
  'runbar.current': {en: 'Current demo', zh: '当前演示'},
  'runbar.restart': {en: 'Start over', zh: '重新开始'},
  'runbar.restart_title': {en: 'Start a new demo. Earlier demos can be found under "Switch".', zh: '新建一次演示，之前的演示可以在「切换」里找回'},
  'runbar.switch': {en: 'Switch', zh: '切换'},
  'runbar.menu_label': {en: 'Earlier demos', zh: '之前的演示'},
  'runbar.replay_title': {en: 'Show the result of the latest real run of this demo', zh: '显示这次演示最近一次真实运行的结果'},
  'runbar.download': {en: 'Download demo materials', zh: '下载演示资料'},
  'runbar.download_name': {en: 'CoSens-Investor-Demo-Materials.zip', zh: 'CoSens-投资人演示资料.zip'},
  'mark.title': {en: 'Drag files here, or click to hand over the next one', zh: '拖文件到这里，或点击交给下一步'},
  'mark.label': {en: 'Hand the next group of demo materials to the AI', zh: '把下一组演示资料交给 AI'},
  'steps.1': {en: '1 Remember materials', zh: '1 记住资料'},
  'steps.2': {en: '2 Learn the method', zh: '2 学会方法'},
  'steps.3': {en: '3 Analyze the BP', zh: '3 分析 BP'},
  'mats.label': {en: 'Demo materials', zh: '演示资料'},
  'own.memory': {en: 'Upload your own memory materials', zh: '上传自己的记忆资料'},
  'own.a_bp': {en: 'BP of project A', zh: '项目 A 的 BP'},
  'own.a_proposal': {en: 'Investment recommendation of project A', zh: '项目 A 的投资建议书'},
  'own.b_bp': {en: 'BP of project B', zh: '项目 B 的 BP'},
  'own.b_proposal': {en: 'Investment recommendation of project B', zh: '项目 B 的投资建议书'},
  'own.bp': {en: 'Upload your own new BP', zh: '上传自己的新 BP'},
  'act.replay': {en: 'Last result', zh: '上次结果'},
  'act.analyze': {en: 'Start analysis', zh: '开始分析'},
  'act.analyze_again': {en: 'Analyze again', zh: '再分析一次'},
  'act.change_bp': {en: 'Use another BP', zh: '换一份 BP'},
  'upload.memory.lead': {en: 'Memory materials: Markdown', zh: '记忆资料：Markdown'},
  'upload.memory.rest': {en: 'and text, up to 2 million characters each', zh: '和文本，每份不超过 200 万字'},
  'upload.memory.docs': {en: 'PDF and Word, up to 20 MB each', zh: 'PDF 和 Word，每份不超过 20 MB'},
  'upload.method.lead': {en: 'Investment method files: Markdown', zh: '投资方法文件：Markdown'},
  'upload.method.rest': {en: 'and text, up to 4 MB each', zh: '和文本，每份不超过 4 MB'},
  'upload.bp.lead': {en: 'New BP: Markdown', zh: '新 BP：Markdown'},
  'upload.bp.rest': {en: 'and text, up to 4 MB', zh: '和文本，不超过 4 MB'},
  'upload.privacy': {en: 'Materials are stored in the demo space under your account, visible only to you.', zh: '资料会存进你账号下的演示空间，只有你能看到。'},
  'upload.sep': {en: ', ', zh: '，'},
  'upload.or': {en: 'or ', zh: '或 '},
  'upload.choose': {en: 'choose files', zh: '选择文件'},
  'upload.label.memory_own': {en: 'You can also drag your own materials here', zh: '也可以把自己的资料拖到这里'},
  'upload.label.memory_more': {en: 'Want to add more? Drag them here', zh: '还想补充资料，拖到这里'},
  'upload.label.method_own': {en: 'You can also drag your own past projects here', zh: '也可以把自己的过往项目拖到这里'},
  'upload.label.bp_own': {en: 'You can also drag your own BP here', zh: '也可以把自己的 BP 拖到这里'},
  'upload.label.bp_replace': {en: 'To use another BP, drag it here', zh: '换一份 BP，拖到这里'},
  'empty.title': {en: 'Start an investor demo', zh: '开始一次投资人演示'},
  // ---- Client: the start card (a new demo space or an existing one) ----
  'space.lead': {en: 'First choose where the materials and the method of this demo go.', zh: '先选这次演示的资料和方法放在哪里。'},
  'space.aria_choice': {en: 'Demo space', zh: '演示空间'},
  'space.aria_list': {en: 'Your spaces', zh: '你的空间'},
  'space.new.title': {en: 'New demo space', zh: '新建演示空间'},
  'space.new.text': {en: 'Creates a separate space under your account. The materials and the method learned in this run live only there and never touch your other memories.', zh: '在你的账号下新建一个独立空间。这次的资料和学到的方法只放在这里，不会碰到你的其他记忆。'},
  'space.existing.title': {en: 'Use an existing space', zh: '使用已有的空间'},
  'space.existing.text': {en: 'Writes this demo into a space you already have, for example an earlier demo space.', zh: '把这次演示写进你已有的一个空间，适合接着用之前的演示空间。'},
  'space.loading': {en: 'Reading your spaces…', zh: '正在读取你的空间…'},
  'space.list_failed': {en: 'Could not read your spaces: {detail}', zh: '没能读取你的空间：{detail}'},
  'space.reload': {en: 'Read again', zh: '重新读取'},
  'space.or_new': {en: 'You can also choose "New demo space"', zh: '也可以改选「新建演示空间」'},
  'space.empty': {en: 'You have no space you can write to yet. Choose "New demo space" to start.', zh: '你还没有可以写入的空间。可以改选「新建演示空间」开始。'},
  'space.count': {en: 'You can write to {n} spaces.', zh: '你能写入的空间有 {n} 个。'},
  'space.count.one': {en: 'You can write to 1 space.', zh: '你能写入的空间有 1 个。'},
  'space.count_scroll': {en: 'You can write to {n} spaces; scroll the list to see them all.', zh: '你能写入的空间有 {n} 个，列表可以滚动。'},
  'space.read_only_note': {en: '{n} more spaces are read-only for you, so they are not listed.', zh: '另有 {n} 个空间你只能查看、不能写入，所以没有列出。'},
  'space.read_only_note.one': {en: '1 more space is read-only for you, so it is not listed.', zh: '另有 1 个空间你只能查看、不能写入，所以没有列出。'},
  'space.created': {en: 'Created {time}', zh: '创建于 {time}'},
  'space.created_unknown': {en: 'Creation time unknown', zh: '创建时间不详'},
  'space.tag_demo': {en: 'Demo space', zh: '演示空间'},
  'space.tag_shared': {en: 'Shared with you', zh: '共享给你'},
  'space.warning': {en: 'The materials and the method learned in this demo are written into the space you pick and stay there.', zh: '演示的资料和学到的方法会写进你选的空间，并一直留在那里。'},
  'space.warning_picked': {en: 'The materials and the method learned in this demo will be written into "{name}" and stay in that space; searches in that space will find them later too.', zh: '这次演示的资料和学到的方法会写进「{name}」，并一直留在那个空间里；以后在这个空间里检索，也会找到它们。'},
  'space.pick_first': {en: 'Pick a space below first, or choose "New demo space"', zh: '先在下面选一个空间，或者改选「新建演示空间」'},
  'space.choosing_hint': {en: 'Pick a space and click "Start demo", or click "Cancel" to go back to this demo', zh: '先选好空间点「开始演示」，或者点「取消」回到这次演示'},
  'hero.choosing.prompt': {en: 'Where should this demo go?', zh: '这次演示放在哪里？'},
  'hero.choosing.sub': {en: 'Create a new demo space, or use one you already have', zh: '新建一个演示空间，或者用你已有的空间'},
  'hero.creating.sub_existing': {en: 'This demo will be written into "{name}"', zh: '这次演示会写进「{name}」'},
  'runbar.choose': {en: 'Start in an existing space…', zh: '在已有空间里开始…'},
  'runbar.existing_tag': {en: 'Existing space', zh: '已有空间'},
  'runbar.existing_title': {en: 'This demo writes into a space you already had', zh: '这次演示写进的是你已有的空间'},
  'menu.existing_suffix': {en: ' · existing space', zh: ' · 已有空间'},
  'alert.space_start_failed': {en: 'Could not start the demo in this space', zh: '没能在这个空间里开始演示'},
  'upload.privacy_existing': {en: 'Materials are stored in the existing space you picked and stay there; everyone that space is shared with can see them.', zh: '资料会存进你选的已有空间，并一直留在那里；这个空间共享给谁，谁就能看到。'},
  'empty.start': {en: 'Start demo', zh: '开始演示'},
  'empty.preparing': {en: 'Preparing…', zh: '正在准备…'},
  'empty.hint': {en: 'Or hand the demo materials above to the AI directly', zh: '也可以直接把上面的演示资料交给 AI'},
  'step1.title': {en: 'Step 1: Remember the materials', zh: '第 1 步：记住资料'},
  'step1.lead': {en: 'Hand the demo materials to CoSens: {n} files of a fictional investor\'s WeChat contacts, meeting minutes, chat logs and internal notes. Writing takes more than ten minutes; you can close the page and come back.', zh: '把演示资料交给 CoSens：{n} 份虚构投资人的微信联系人、会议纪要、聊天记录和内部笔记。写完要十几分钟，可以关掉页面，回来接着看。'},
  'stat.people': {en: 'People found', zh: '认出的人'},
  'stat.organizations': {en: 'Companies and organizations', zh: '公司和机构'},
  'stat.relations': {en: 'Relations between people', zh: '人与人的关系'},
  'memory.not_written': {en: 'Not written to memory', zh: '没有写进记忆'},
  'memory.counts': {en: '{done} / {total} remembered', zh: '{done} / {total} 已记住'},
  'memory.counts_failed': {en: ' · {n} not remembered', zh: ' · {n} 份没记住'},
  'memory.counts_pending': {en: ' · {n} in progress', zh: ' · {n} 份处理中'},
  'memory.note_running': {en: 'CoSens is processing the materials; you can close the page and come back.', zh: '资料在 CoSens 那边处理，可以关掉页面，回来接着看。'},
  'memory.note_stats': {en: 'The numbers above are what CoSens actually recognized in these materials.', zh: '上面是 CoSens 从这些资料里实际认出的结果。'},
  'slot.empty': {en: 'Not added', zh: '未放入'},
  'step2.title': {en: 'Step 2: Learn the method', zh: '第 2 步：学会方法'},
  'step2.lead': {en: 'Hand CoSens two past projects, each with a BP and an investment recommendation. In the demo materials, project A was invested in and project B was not. CoSens RSI learns project A first, then project B on top of the learned method, in about 16 minutes.', zh: '交给 CoSens 两个过往项目，每个一份 BP 和一份投资建议书。演示资料里项目 A 投了、项目 B 没投。CoSens RSI 先学项目 A，再在学到的方法上学项目 B，大约 16 分钟。'},
  'step2.b_note': {en: ' (continues from the method learned on A)', zh: '（在 A 的方法上接着学）'},
  'step2.start': {en: 'Start learning', zh: '开始学习'},
  'step2.need_four': {en: 'Learning can start once all four files are in', zh: '四份都放齐后才能开始'},
  'assign.aria_project': {en: 'Project', zh: '项目'},
  'assign.aria_type': {en: 'Type', zh: '类型'},
  'assign.pick_project': {en: 'Pick a project', zh: '选项目'},
  'assign.pick_type': {en: 'Pick a type', zh: '选类型'},
  'assign.title': {en: 'What are these files?', zh: '这些文件分别是什么？'},
  'assign.lead': {en: 'Each project needs one BP and one investment recommendation. I guessed from the file names; please correct any mistakes.', zh: '每个项目要一份 BP 和一份投资建议书。我先按文件名猜了一下，不对的请改。'},
  'assign.confirm': {en: 'Add', zh: '放入'},
  'recipe.default_name': {en: 'Your investment method', zh: '你的投资方法'},
  'recipe.selftest': {en: 'Self-test {n} points', zh: '自测 {n} 分'},
  'recipe.view_full': {en: 'View the full method RSI learned', zh: '查看 RSI 学到的完整方法'},
  'recipe.learned': {en: 'Learned: {name}', zh: '已学会：{name}'},
  'recipe.when': {en: ' ({time})', zh: '（{time}）'},
  'recipe.note': {en: 'Learned by CoSens RSI from these two projects{when}, version {number}.', zh: '由 CoSens RSI 从这两个项目学出{when}，版本 {number}。'},
  'method.title.done': {en: 'Both projects are learned', zh: '两个项目都学完了'},
  'method.title.failed': {en: 'Learning did not finish', zh: '学习没有完成'},
  'method.title.running': {en: 'Learning your method', zh: '正在学习你的方法'},
  'method.note_running': {en: 'Learning runs on the CoSens RSI side; you can close the page and come back. Project B starts automatically once project A is learned.', zh: '学习在 CoSens RSI 那边进行，可以关掉页面，回来接着看。项目 B 会在项目 A 学完后自动开始。'},
  'step3.title': {en: 'Step 3: Analyze the new BP', zh: '第 3 步：分析新 BP'},
  'step3.lead': {en: 'Hand CoSens a new BP. It reads the BP with the method it just learned, finds in the remembered materials the people who can help verify it, and writes due diligence advice with sources, in about 1.5 to 3 minutes.', zh: '交给 CoSens 一份新 BP。它会按刚学到的方法读 BP，在记住的资料里找能帮忙验证的人，写出带出处的尽调建议，大约 1.5 到 3 分钟。'},
  'step3.use_demo': {en: 'Use the demo BP', zh: '使用演示 BP'},
  'step3.use_demo_named': {en: 'Use the demo BP: {name}', zh: '使用演示 BP：{name}'},
  'bp.title': {en: 'New BP: {title}', zh: '新 BP：{title}'},
  'bp.waiting_memory_failed': {en: 'Some materials were not remembered. Retry them in step 1.', zh: '还有资料没记住，先到第 1 步重试。'},
  'bp.waiting_memory': {en: 'The materials are still being remembered. Analysis can start once they are done.', zh: '资料还在记，记完就可以开始分析。'},
  'bp.waiting_method': {en: 'The method is not learned yet. Analysis can start once it is.', zh: '方法还没学完，学完就可以开始分析。'},
  'bp.auto_start': {en: ' It starts automatically when everything is ready.', zh: '准备好后会自动开始。'},
  'live.title': {en: 'Analyzing', zh: '分析中'},
  'live.search_prefix': {en: 'Searching memory: ', zh: '在记忆里查：'},
  'live.sub': {en: 'Reading the BP with your method while looking in your memory for people who can help verify it (live run, {n} seconds so far).', zh: '按你的方法读 BP，同时在你的记忆里找能帮忙验证的人（现场运行，已用 {n} 秒）。'},
  'hero.creating.prompt': {en: 'Preparing this demo…', zh: '正在准备这次演示…'},
  'hero.creating.sub': {en: 'Creating a separate demo space under your account; the materials and the method live only there', zh: '在你的账号下新建一个独立的演示空间，资料和方法都只存在这里'},
  'hero.sending.sub': {en: '{done} / {total} handed over', zh: '已交 {done} / {total} 份'},
  'hero.analyzing.prompt': {en: 'Analyzing "{title}"…', zh: '正在分析「{title}」…'},
  'hero.report.sub': {en: 'Analyzed with the learned method; every recommendation names its source. {note}', zh: '按学到的方法分析，所有推荐都标了出处。{note}'},
  'hero.live_failed.prompt': {en: 'The live run did not finish', zh: '现场运行没有完成'},
  'hero.live_failed.sub': {en: 'Click "Retry" to run it again, or "Last result" to see the previous result', zh: '可以点「重试」再跑一次，或点「上次结果」看上一次的结果'},
  'hero.live_failed.sub_replay': {en: 'Click "Last result" to see the previous result', zh: '可以点「上次结果」看上一次的结果'},
  'send.memory': {en: 'Handing the materials to CoSens…', zh: '正在把资料交给 CoSens…'},
  'send.method': {en: 'Handing the past projects to CoSens…', zh: '正在把过往项目交给 CoSens…'},
  'send.bp': {en: 'Handing the new BP to CoSens…', zh: '正在把新 BP 交给 CoSens…'},
  'menu.empty': {en: 'No other demos yet', zh: '还没有其他演示'},
  'run.not_started': {en: 'Not started', zh: '还没开始'},
  'poll.failed': {en: 'Refreshing progress failed; trying again shortly', zh: '刷新进度失败，稍后自动再试'},
  'viewer.opening': {en: 'Opening…', zh: '正在打开…'},
  'link.missing_opened': {en: 'The demo in the link does not exist or belongs to another account. The latest demo was opened for you.', zh: '链接里的演示不存在，或者不属于当前登录的账号。已为你打开最近一次演示。'},
  'link.missing_new': {en: 'The demo in the link does not exist or belongs to another account. You can click "Start demo" to begin a new one.', zh: '链接里的演示不存在，或者不属于当前登录的账号。可以点「开始演示」新建一次。'},
  'hint.busy': {en: 'Please wait, the previous step is still running', zh: '请稍等，上一步还在进行'},
  'hint.loading': {en: 'The demo is still loading, please wait', zh: '演示还在加载，请稍等'},
  'hint.materials_not_loaded': {en: 'The demo materials have not loaded yet', zh: '演示资料还没加载出来'},
  'hint.need_four': {en: 'Some past-project files are still missing; learning can start once all four are in', zh: '还差几份过往项目资料，放齐四份才能开始学习'},
  'hint.all_handed': {en: 'All three steps have been handed to me', zh: '三步都已经交给我了'},
  'hint.all_handed_more': {en: 'All three steps have been handed to me. To add materials or change the BP, drag them into the matching box below', zh: '三步都已经交给我了。要补充资料或换 BP，请拖到下面对应的框里'},
  'hint.one_bp': {en: 'Only one new BP at a time; this time "{name}" is used', zh: '新 BP 一次放一份，这次用「{name}」'},
  'hint.four_first': {en: 'Learning can start once all four files are in', zh: '四份都放齐后才能开始学习'},
  'hint.drag_again': {en: 'Please drag "{name}" in again', zh: '请把「{name}」重新拖进来'},
  'hint.bp_first': {en: 'Hand me the new BP first', zh: '先把新 BP 交给我'},
  'hint.auto_analyze': {en: 'Analysis starts automatically once the materials and the method are ready', zh: '资料和方法准备好后会自动开始分析'},
  'hint.slow': {en: 'Slower than usual. You can keep waiting, or click "Last result" above.', zh: '比平时慢。可以继续等，或点上方「上次结果」。'},
  'hint.no_demo': {en: 'No demo yet', zh: '还没有演示'},
  'hint.finish_earlier': {en: 'Please finish the earlier steps first', zh: '请先完成前面的步骤'},
  'alert.live_failed': {en: 'The live run failed', zh: '现场运行失败'},
  'alert.refresh_failed': {en: 'Refreshing progress failed; showing the last saved progress', zh: '刷新进度时出错，先显示上次保存的进度'},
  'alert.create_failed': {en: 'Could not start a new demo', zh: '没能新建演示'},
  'alert.files_failed.memory': {en: '{n} materials could not be handed over', zh: '{n} 份资料没有交上去'},
  'alert.files_failed.memory.one': {en: '1 material could not be handed over', zh: '{n} 份资料没有交上去'},
  'alert.files_failed.method': {en: '{n} past-project files could not be handed over', zh: '{n} 份过往项目资料没有交上去'},
  'alert.files_failed.method.one': {en: '1 past-project file could not be handed over', zh: '{n} 份过往项目资料没有交上去'},
  'alert.files_failed.bp': {en: '{n} BP files could not be handed over', zh: '{n} 份BP没有交上去'},
  'alert.files_failed.bp.one': {en: '1 BP could not be handed over', zh: '{n} 份BP没有交上去'},
  'alert.files_message': {en: '{message} ({names})', zh: '{message}（{names}）'},
  'alert.learn_not_started': {en: 'Learning did not start', zh: '学习没有开始'},
  'alert.file_unusable': {en: '{n} files cannot be used', zh: '{n} 份文件没法用'},
  'alert.file_unusable.one': {en: 'This file cannot be used', zh: '这份文件没法用'},
  'alert.run_not_found': {en: 'This demo could not be found', zh: '找不到这次演示'},
  'alert.replay_failed': {en: 'The last result did not load', zh: '上次结果没有加载出来'},
  'alert.switch_failed': {en: 'Could not switch to this demo', zh: '没能切换到这次演示'},
  'alert.materials_failed': {en: 'The demo materials did not load', zh: '演示资料没有加载出来'},
  'alert.link_failed': {en: 'The demo in the link did not load', zh: '链接里的演示没有加载出来'},
  'alert.link_missing': {en: 'The demo in the link could not be found', zh: '找不到链接里的演示'},
  'alert.latest_failed': {en: 'The latest demo did not load', zh: '最近一次演示没有加载出来'},
  'alert.runs_failed': {en: 'Earlier demos did not load', zh: '之前的演示没有加载出来'},
  'report.unverified_title': {en: 'This source was not found in the memory search results', zh: '记忆检索结果里没有找到这份资料'},
  'report.unverified': {en: ' (unverified)', zh: '（未核实）'},
  'report.sources': {en: 'Sources: ', zh: '出处：'},
  'report.no_queries': {en: 'No searches were recorded this time.', zh: '这次没有记录检索。'},
  'report.unverified_note': {en: '{n} sources were not found in the search results and are marked "unverified".', zh: '有 {n} 处出处在检索结果里没有找到，已标为「未核实」。'},
  'report.unverified_note.one': {en: '1 source was not found in the search results and is marked "unverified".', zh: '有 {n} 处出处在检索结果里没有找到，已标为「未核实」。'},
  'report.verdict': {en: 'Verdict: ', zh: '结论：'},
  'report.top_question': {en: 'First question to ask: ', zh: '首要追问：'},
  'report.experts': {en: 'Technical check: approach these experts', zh: '技术验证：找这些专家'},
  'report.experts_tag': {en: 'The method requires independent experts to cross-check', zh: '方法要求独立专家交叉验证'},
  'report.no_experts': {en: 'No suitable experts were found this time.', zh: '这次没有找到合适的专家。'},
  'report.people': {en: 'Background check: reach these people through your network', zh: '人员背调：通过你的人脉找这些人'},
  'report.people_tag': {en: 'The method requires background checks from people who worked with the founder', zh: '方法要求共事过的人背调'},
  'report.no_people': {en: 'No one who can give a background check was found this time.', zh: '这次没有找到能背调的人。'},
  'report.queries': {en: 'What it searched for in your memory', zh: '它在你的记忆里查了什么'},
  'query.quote': {en: '"{q}"', zh: '「{q}」'},
  'mat.item_title': {en: '{name}: click to preview, or drag to the icon above to hand it to the AI', zh: '{name}：点击预览，拖到上面的图标交给 AI'},
  'mat.expand_all': {en: 'Show all {n}', zh: '展开全部 {n} 份'},
  'mat.count': {en: '{n} files · {hint}', zh: '{n} 份 · {hint}'},
  'mat.count.one': {en: '1 file · {hint}', zh: '{n} 份 · {hint}'},
  'mat.unused': {en: 'The demo materials were not used this time', zh: '演示资料这次没有用上'},
  'mat.give': {en: 'Hand to AI', zh: '交给 AI'},
  'mat.given': {en: 'Handed to AI', zh: '已交给 AI'},
  'mat.own_count': {en: 'Your {n} files', zh: '你的 {n} 份资料'},
  'mat.own_count.one': {en: 'Your 1 file', zh: '你的 {n} 份资料'},
// @@APPEND
};
