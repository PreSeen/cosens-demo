import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testConfig, installFetch, sessionCookie, seedSession, envFromConfig} from './helpers/fake-services.mjs';
import {onRequestGet as login} from '../functions/api/demo/auth/login.js';
import {onRequest as pageGate} from '../functions/demo/_middleware.js';
import {onRequest as apiGate} from '../functions/api/demo/_middleware.js';
import {
  DEFAULT_LOCALE, LANG_TAGS, LOCALES, LOCALE_COOKIE, LOCALE_LABELS, LOCALE_STORAGE_KEY, applyLocale, applyStaticTexts, defaultLocale, getLocale, hasLocaleParam,
  hasMessage, initLocale, localeCookie, localeControlHtml, mountLocaleControls, normalizeLocale, persistLocale, readCookie, readPageLocale, requestLocale,
  resolveLocale, setLocale, t,
} from '../shared/i18n.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(join(root, path), 'utf8');
const CJK = /[　-鿿＀-￯]/;
const ORIGIN = 'https://cosens.ai';
const messages = Object.fromEntries((await read('shared/i18n.mjs')).split('\n')
  .filter(line => /^ {2}'[^']+': \{en: /.test(line)).map(line => [line.match(/^ {2}'([^']+)'/)[1], line]));
const keys = Object.keys(messages);

async function* files(directory, accept) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path, accept);
    else if (accept(path)) yield path;
  }
}

// ---- The module ----

test('the locale is ?lang, then the cosens-lang cookie, then the configured default, and English when that is missing or invalid', () => {
  assert.deepEqual(LOCALES, ['en', 'zh']);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual([normalizeLocale('en'), normalizeLocale(' ZH '), normalizeLocale('zh-CN'), normalizeLocale('fr'), normalizeLocale(null), normalizeLocale(5)], ['en', 'zh', null, null, null, null]);
  assert.deepEqual([defaultLocale({SITE_DEFAULT_LOCALE: 'zh'}), defaultLocale({SITE_DEFAULT_LOCALE: 'en'}), defaultLocale({SITE_DEFAULT_LOCALE: 'fr'}), defaultLocale({}), defaultLocale(undefined)], ['zh', 'en', 'en', 'en', 'en']);
  assert.equal(readCookie('a=1; cosens-lang=zh; b=2', 'cosens-lang'), 'zh');
  assert.equal(readCookie('xcosens-lang=zh', 'cosens-lang'), '');
  const order = [
    [{}, 'en'],
    [{fallback: 'zh'}, 'zh'],
    [{cookie: 'zh', fallback: 'en'}, 'zh'],
    [{cookie: 'en', fallback: 'zh'}, 'en'],
    [{search: '?lang=zh', cookie: 'en', fallback: 'en'}, 'zh'],
    [{search: '?lang=en', cookie: 'zh', fallback: 'zh'}, 'en'],
    [{search: '?lang=fr', cookie: 'zh', fallback: 'en'}, 'zh'],
    [{search: '?lang=', cookie: 'junk', fallback: 'zh'}, 'zh'],
    [{search: new URLSearchParams('lang=zh')}, 'zh'],
  ];
  for (const [input, expected] of order) assert.equal(resolveLocale(input), expected, JSON.stringify(input));
});

test('a request is read for ?lang, the cookie and the Pages environment, never for the browser language', () => {
  const ask = (path, headers = {}, env = {}) => requestLocale(new Request(new URL(path, ORIGIN), {headers}), env);
  assert.equal(ask('/demo/'), 'en');
  assert.equal(ask('/demo/', {'Accept-Language': 'zh-CN,zh;q=0.9'}), 'en', 'the browser language is never consulted');
  assert.equal(ask('/demo/', {'Accept-Language': 'zh-CN'}, {SITE_DEFAULT_LOCALE: 'en'}), 'en');
  assert.equal(ask('/demo/', {}, {SITE_DEFAULT_LOCALE: 'zh'}), 'zh');
  assert.equal(ask('/demo/', {Cookie: 'cosens-lang=en'}, {SITE_DEFAULT_LOCALE: 'zh'}), 'en');
  assert.equal(ask('/demo/?lang=zh', {Cookie: 'cosens-lang=en'}), 'zh');
  assert.equal(ask('/demo/?lang=en', {Cookie: 'cosens-lang=zh'}, {SITE_DEFAULT_LOCALE: 'zh'}), 'en');
  assert.equal(hasLocaleParam(new Request(`${ORIGIN}/demo/?lang=zh`)), true);
  assert.equal(hasLocaleParam(new Request(`${ORIGIN}/demo/?lang=fr`)), false);
  assert.equal(hasLocaleParam(new Request(`${ORIGIN}/demo/`)), false);
});

test('the cookie is readable by the page script, Lax and site-wide', () => {
  assert.equal(localeCookie('zh'), 'cosens-lang=zh; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  assert.equal(localeCookie('en', {secure: false}), 'cosens-lang=en; Path=/; Max-Age=31536000; SameSite=Lax');
  assert.equal(localeCookie('fr'), 'cosens-lang=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  assert.doesNotMatch(localeCookie('zh'), /HttpOnly/i, 'the client mirrors it in localStorage and rewrites it');
  assert.equal(LOCALE_COOKIE, 'cosens-lang');
});

test('t fills parameters, picks the singular for n=1, falls back to English and returns the key when it is missing', () => {
  assert.equal(t('project.label', {slot: 'A'}, 'en'), 'Project A');
  assert.equal(t('project.label', {slot: 'A'}, 'zh'), '项目 A');
  assert.equal(t('project.label', {slot: 'A'}, 'fr'), 'Project A');
  assert.equal(t('memory.title.done', {n: 1}, 'en'), 'Remembered 1 file');
  assert.equal(t('memory.title.done', {n: 2}, 'en'), 'Remembered 2 files');
  assert.equal(t('memory.title.done', {n: 1}, 'zh'), '已记住 1 份资料');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(t('project.label', {}, 'en'), 'Project {slot}', 'an unfilled parameter stays visible');
  assert.equal(hasMessage('project.label'), true);
  assert.equal(hasMessage('no.such.key'), false);
  assert.equal(hasMessage('constructor'), false);
});

test('every message has English and Chinese texts with the same parameters, and English never carries Chinese', () => {
  assert.ok(keys.length > 300, `${keys.length} messages`);
  for (const key of keys) {
    const line = messages[key];
    assert.equal(hasMessage(key), true, key);
    const en = t(key, undefined, 'en');
    const zh = t(key, undefined, 'zh');
    assert.ok(en.length > 0 && zh.length > 0, key);
    assert.equal(CJK.test(en), false, `${key} (en): ${en}`);
    assert.equal(CJK.test(zh) || /^[\x20-\x7e ]*$/.test(zh), true, key);
    const params = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
    // The English singular ("Reading 1 file") may leave out the count the Chinese text keeps.
    const same = key.endsWith('.one') ? text => params(text).replace(/(^|,)n(,|$)/, '$1$2').replace(/^,|,$/g, '') : params;
    assert.equal(same(en), same(zh), `${key}: the same {parameters}`);
    if (key.endsWith('.one')) assert.ok(hasMessage(key.slice(0, -4)), `${key} has a plural form`);
  }
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
});

test('every message key the code names exists, and the sources keep Chinese out of their string literals', async () => {
  const sourceFiles = [];
  for (const dir of ['apps/demo/src', 'apps/demo/investor', 'server/demo', 'functions']) {
    for await (const path of files(join(root, dir), p => /\.(?:ts|mjs|js|html)$/.test(p))) sourceFiles.push(path);
  }
  sourceFiles.push(join(root, 'apps/demo/index.html'), join(root, 'scripts/build-demo-data.mjs'));
  // Files that keep Chinese on purpose: the Chinese prompts the model gets in the zh locale, the Chinese-name patterns
  // (slot and role guessing, citation marker, number-and-counter-word units) and the fixture folder names.
  const KEEPS_CHINESE = new Map([
    ['server/demo/investor/prompts.mjs', 'the Chinese prompts'],
    ['server/demo/investor/method-step.mjs', 'the Chinese task and rule prompts, the section-heading pattern'],
    ['server/demo/investor/analyze.mjs', 'the Chinese citation marker pattern'],
    ['server/demo/investor/materials.mjs', 'the Chinese BP and recommendation name suffixes'],
    ['apps/demo/src/lib/logic.mjs', 'Chinese punctuation, unit and name patterns, the zh banner trim'],
    ['scripts/build-demo-data.mjs', 'the fixture folders and the Chinese file-name pattern'],
  ]);
  const used = new Set();
  const offenders = [];
  for (const path of sourceFiles) {
    const name = relative(root, path);
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/'((?:err|memory|method|login|run|analyze|ingest|shell|group|project|list|service|code|alert|hint|hero|upload|mat|report|live|chip|phase|deliver|assign|file|limit|stat|slot|recipe|empty|common|act|api|send|poll|viewer|link|menu|hub|demo|runbar|mark|own|query|role|label|analysis|theme|lang)\.[a-z0-9_.]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/data-i18n(?:-[a-z-]+)?="([\w.]+)"/g)) used.add(match[1]);
    if (KEEPS_CHINESE.has(name)) continue;
    const code = text.split('\n').map(line => line.replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/.*$/, '').replace(/<!--.*?-->/g, ''))
      .filter(line => !/^\s*(\*|\/\*)/.test(line));
    code.forEach((line, i) => { if (CJK.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(offenders, []);
  // A name may be the stem of a pair (upload.memory -> upload.memory.lead and upload.memory.rest) or of a plural (key, key.one).
  const missing = [...used].filter(key => !hasMessage(key) && !hasMessage(`${key}.one`) && !hasMessage(`${key}.lead`));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 100, `${used.size} keys named in the code`);
  // Every dictionary entry that is not built from a prefix is reached from the code (an unused text is dead weight).
  const prefixes = ['login.error.', 'run.step.', 'group.', 'project.status.', 'code.', 'phase.', 'label.', 'service.', 'role.', 'steps.', 'demo.investor.', 'own.', 'alert.files_failed.', 'upload.', 'lang.'];
  const unused = keys.filter(key => !used.has(key) && !used.has(key.replace(/\.one$/, '')) && !used.has(key.replace(/\.[a-z]+$/, '')) && !prefixes.some(prefix => key.startsWith(prefix)));
  assert.deepEqual(unused, []);
});

// ---- The client: opening the page in a locale and switching it ----

function fakeWindow({search = '', cookie = '', stored = null, meta = null, protocol = 'https:'} = {}) {
  const listeners = {};
  const store = new Map(stored === null ? [] : [[LOCALE_STORAGE_KEY, stored]]);
  const controls = [];
  const options = [];
  const nodes = [];
  const node = (attrs, text = '') => {
    const element = {attrs: {...attrs}, textContent: text, dataset: {}, classList: {on: false, toggle(name, on) { this.on = on; }},
      getAttribute(name) { return this.attrs[name] ?? null; }, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
      querySelectorAll: selector => (selector === '[data-locale-option]' ? options : [])};
    nodes.push(element);
    return element;
  };
  const control = node({'data-locale-control': ''});
  controls.push(control);
  for (const locale of LOCALES) options.push(node({'data-locale-option': locale}));
  const heading = node({'data-i18n': 'hub.title'}, 'CoSens Demo');
  const titled = node({'data-i18n-title': 'runbar.restart_title', title: 'x'});
  const labelled = node({'data-i18n-aria-label': 'mats.label'});
  const doc = {
    cookie, documentElement: {lang: ''},
    querySelector: selector => (selector === 'meta[name="cosens-default-locale"]' && meta ? {getAttribute: () => meta} : null),
    querySelectorAll: selector => {
      if (selector === '[data-locale-control]') return controls;
      if (selector === '[data-i18n]') return nodes.filter(n => n.attrs['data-i18n']);
      const attribute = selector.match(/^\[(data-i18n-[a-z-]+)\]$/)?.[1];
      return attribute ? nodes.filter(n => attribute in n.attrs) : [];
    },
    addEventListener: (type, fn) => { listeners[`doc:${type}`] = fn; },
    removeEventListener: type => { delete listeners[`doc:${type}`]; },
  };
  const win = {
    document: doc, location: {search, href: `${ORIGIN}/demo/${search}`, protocol},
    localStorage: {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value)},
    history: {state: null, replaced: [], replaceState(state, title, url) { this.replaced.push(url); }},
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: type => { delete listeners[type]; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent(event) { this.events.push(event); return true; },
    events: [],
  };
  // document.cookie behaves like the browser's: assigning one cookie keeps the others.
  const jar = new Map();
  for (const part of cookie.split(';').map(p => p.trim()).filter(Boolean)) jar.set(part.split('=')[0], part);
  Object.defineProperty(doc, 'cookie', {get: () => [...jar.values()].join('; '), set: value => jar.set(value.split('=')[0], value.split(';')[0])});
  return {win, doc, store, listeners, control, options, heading, titled, labelled};
}

test('the page opens in English by default and never reads the browser language', () => {
  setLocale('en');
  const {win, doc, store} = fakeWindow();
  assert.equal(readPageLocale(win), 'en');
  assert.equal(initLocale(win), 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(store.has(LOCALE_STORAGE_KEY), false, 'nothing is stored until the visitor chooses');
  assert.equal(doc.cookie, '');
});

test('the page honours the configured default, then localStorage, then the cookie, then ?lang', () => {
  assert.equal(readPageLocale(fakeWindow({meta: 'zh'}).win), 'zh', 'the default the page gate filled in');
  assert.equal(readPageLocale(fakeWindow({meta: 'zh', stored: 'en'}).win), 'en');
  assert.equal(readPageLocale(fakeWindow({meta: 'en', stored: 'zh'}).win), 'zh');
  assert.equal(readPageLocale(fakeWindow({meta: 'en', stored: 'zh', cookie: 'cosens-lang=en'}).win), 'en');
  assert.equal(readPageLocale(fakeWindow({meta: 'en', stored: 'en', cookie: 'cosens-lang=en', search: '?lang=zh'}).win), 'zh');
  assert.equal(readPageLocale(fakeWindow({meta: 'zh', search: '?lang=bogus'}).win), 'zh');
});

test('?lang is remembered in the cookie and localStorage and then leaves the address', () => {
  const {win, doc, store} = fakeWindow({search: '?lang=zh&run=run_x'});
  assert.equal(initLocale(win), 'zh');
  assert.equal(doc.documentElement.lang, 'zh-CN');
  assert.match(doc.cookie, /cosens-lang=zh/);
  assert.equal(store.get(LOCALE_STORAGE_KEY), 'zh');
  assert.deepEqual(win.history.replaced, ['/demo/?run=run_x']);
});

test('a surviving localStorage choice is written back to the cookie the server reads', () => {
  const {win, doc} = fakeWindow({stored: 'zh'});
  assert.equal(initLocale(win), 'zh');
  assert.match(doc.cookie, /cosens-lang=zh/);
});

test('applyLocale fills the static texts, the lang attribute and the switch', () => {
  const {win, doc, control, options, heading, titled, labelled} = fakeWindow();
  assert.equal(applyLocale('zh', win), 'zh');
  assert.equal(getLocale(), 'zh');
  assert.equal(doc.documentElement.lang, 'zh-CN');
  assert.equal(heading.textContent, 'CoSens 演示');
  assert.equal(titled.attrs.title, '新建一次演示，之前的演示可以在「切换」里找回');
  assert.equal(labelled.attrs['aria-label'], '演示资料');
  assert.equal(control.attrs['aria-label'], '语言：中文。切换到 English。');
  assert.deepEqual(options.map(o => [o.attrs['data-locale-option'], o.classList.on]), [['en', false], ['zh', true]]);
  assert.equal(win.events.at(-1).type, 'cosens:localechange');
  assert.deepEqual(win.events.at(-1).detail, {locale: 'zh'});
  applyLocale('en', win);
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(heading.textContent, 'CoSens Demo');
  assert.equal(control.attrs['aria-label'], 'Language: English. Switch to Chinese.');
  assert.equal(options.find(o => o.attrs['data-locale-option'] === 'en').attrs['aria-current'], 'true');
  assert.equal(options.find(o => o.attrs['data-locale-option'] === 'zh').attrs['aria-current'], undefined);
  applyStaticTexts(doc, 'zh');
  assert.equal(heading.textContent, 'CoSens 演示');
  setLocale('en');
});

test('clicking the switch toggles the language, remembers it and rewrites the page without a reload', () => {
  setLocale('en');
  const {win, doc, store, listeners, heading} = fakeWindow({search: '?lang=en'});
  const stop = mountLocaleControls(doc, win);
  assert.equal(typeof listeners['doc:click'], 'function');
  const click = () => listeners['doc:click']({target: {closest: selector => (selector === '[data-locale-control]' ? {} : null)}});
  click();
  assert.equal(getLocale(), 'zh');
  assert.equal(heading.textContent, 'CoSens 演示');
  assert.equal(store.get(LOCALE_STORAGE_KEY), 'zh');
  assert.match(doc.cookie, /cosens-lang=zh/);
  assert.deepEqual(win.history.replaced, ['/demo/'], 'a stale ?lang would win on the next load');
  click();
  assert.equal(getLocale(), 'en');
  assert.equal(heading.textContent, 'CoSens Demo');
  assert.match(doc.cookie, /cosens-lang=en/);
  listeners['doc:click']({target: {closest: () => null}});
  assert.equal(getLocale(), 'en', 'other clicks do nothing');
  listeners.storage({key: LOCALE_STORAGE_KEY, newValue: 'zh'});
  assert.equal(getLocale(), 'zh', 'another tab chose Chinese');
  stop();
  assert.equal(listeners['doc:click'], undefined);
  setLocale('en');
});

test('persisting survives denied storage and cookies', () => {
  const win = {document: {get cookie() { return ''; }, set cookie(value) { throw new Error('denied'); }}, location: {protocol: 'https:'}, localStorage: {setItem() { throw new Error('denied'); }, getItem() { throw new Error('denied'); }}};
  assert.doesNotThrow(() => persistLocale('zh', win));
});

test('the switch markup shows both language names, the second in Chinese', () => {
  const html = localeControlHtml();
  assert.ok(html.includes('data-locale-control') && html.includes('data-locale-option="en"') && html.includes('data-locale-option="zh"'));
  assert.ok(html.includes('>EN<') && html.includes('>中文<'));
  assert.deepEqual(LOCALE_LABELS, {en: 'EN', zh: '中文'});
  assert.deepEqual(LANG_TAGS, {en: 'en', zh: 'zh-CN'});
});

// ---- The Pages gates ----

const hubPage = async () => new Response('<!doctype html>\n<html lang="en">\n<head><meta name="cosens-default-locale" content="en"><title data-i18n="hub.page_title">CoSens Demo</title></head><body>hub</body></html>', {
  headers: {'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '999', ETag: '"x"'},
});
const script = async () => new Response('console.log(1)', {headers: {'Content-Type': 'text/javascript'}});

function pageContext(cfg, path, {cookie, env = {}, next = hubPage} = {}) {
  return {request: new Request(new URL(path, ORIGIN), {headers: cookie ? {Cookie: cookie} : {}}), env: envFromConfig(cfg, env), params: {}, data: {}, next};
}

test('the page gate fills <html lang> and the configured default into a signed-in HTML page', async () => {
  const cfg = testConfig();
  await seedSession(cfg);
  const cookie = sessionCookie('sid-test');
  const html = async (path, options = {}) => pageGate(pageContext(cfg, path, {cookie: options.cookie ? `${cookie}; ${options.cookie}` : cookie, env: options.env, next: options.next}));
  const english = await (await html('/demo/')).text();
  assert.ok(english.includes('<html lang="en">') && english.includes('<meta name="cosens-default-locale" content="en">'));
  const zh = await html('/demo/', {cookie: 'cosens-lang=zh'});
  const zhText = await zh.text();
  assert.ok(zhText.includes('<html lang="zh-CN">'));
  assert.ok(zhText.includes('<meta name="cosens-default-locale" content="en">'), 'the cookie is the visitor\'s choice; the default stays what it is');
  assert.equal(zh.headers.get('Set-Cookie'), null, 'a cookie that is already there is not set again');
  const configured = await (await html('/demo/', {env: {SITE_DEFAULT_LOCALE: 'zh'}})).text();
  assert.ok(configured.includes('<html lang="zh-CN">') && configured.includes('<meta name="cosens-default-locale" content="zh">'));
  const switched = await html('/demo/?lang=zh');
  assert.match(switched.headers.get('Set-Cookie'), /^cosens-lang=zh; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
  assert.ok((await switched.text()).includes('<html lang="zh-CN">'));
  const back = await html('/demo/?lang=en', {cookie: 'cosens-lang=zh', env: {SITE_DEFAULT_LOCALE: 'zh'}});
  assert.match(back.headers.get('Set-Cookie'), /^cosens-lang=en;/);
  assert.ok((await back.text()).includes('<html lang="en">'));
  const invalid = await html('/demo/?lang=fr');
  assert.equal(invalid.headers.get('Set-Cookie'), null, 'an invalid ?lang is ignored');
  assert.ok((await invalid.text()).includes('<html lang="en">'));
  const asset = await html('/demo/_app/hub.js?lang=zh', {next: script});
  assert.equal(await asset.text(), 'console.log(1)', 'only HTML is rewritten');
  const page = await html('/demo/');
  assert.equal(page.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(page.headers.get('Content-Length'), null);
});

test('the page gate leaves a body-less answer alone and drops the headers that describe the original bytes', async () => {
  const cfg = testConfig();
  await seedSession(cfg);
  const cookie = sessionCookie('sid-test');
  const notModified = await pageGate(pageContext(cfg, '/demo/', {cookie, next: async () => new Response(null, {status: 304, headers: {'Content-Type': 'text/html'}})}));
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), '');
  const encoded = await pageGate(pageContext(cfg, '/demo/', {cookie, next: async () => new Response('<html lang="en"><body>x</body></html>', {headers: {'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': '40'}})}));
  assert.equal(encoded.headers.get('Content-Encoding'), null);
  assert.equal(encoded.headers.get('Content-Length'), null);
  assert.equal(await encoded.text(), '<html lang="en"><body>x</body></html>');
});

test('the login error page and the sign-in redirect follow the language too', async () => {
  const cfg = testConfig();
  const ask = (path, options = {}) => pageGate(pageContext(cfg, path, options));
  const english = await ask('/demo/?login_error=access_denied');
  const text = await english.text();
  assert.equal(english.status, 401);
  assert.ok(text.includes('<html lang="en">') && text.includes('You cancelled the sign-in authorization.'));
  assert.equal(english.headers.get('Set-Cookie'), null);
  const zh = await ask('/demo/?login_error=access_denied&lang=zh');
  assert.ok((await zh.text()).includes('你取消了登录授权。'));
  assert.match(zh.headers.get('Set-Cookie'), /^cosens-lang=zh;/);
  assert.ok((await (await ask('/demo/?login_error=access_denied', {cookie: 'cosens-lang=zh'})).text()).includes('<html lang="zh-CN">'));
  const configured = await ask('/demo/?login_error=access_denied', {env: {SITE_DEFAULT_LOCALE: 'zh'}});
  assert.ok((await configured.text()).includes('你取消了登录授权。'));
  assert.ok((await (await ask('/demo/?login_error=access_denied&lang=en', {env: {SITE_DEFAULT_LOCALE: 'zh'}})).text()).includes('You cancelled the sign-in authorization.'));
  const config = await ask('/demo/', {env: {DEMO_SESSION_SECRET: ''}});
  assert.equal(config.status, 500);
  assert.ok((await config.text()).includes('The demo hub is not fully configured yet. Please contact us.'));
  assert.ok((await (await ask('/demo/?lang=zh', {env: {DEMO_SESSION_SECRET: ''}})).text()).includes('演示中心还没有配置完成，请联系我们。'));
  // Without a session a visitor is sent to sign in, and ?lang is remembered on the way.
  const redirect = await ask('/demo/investor/?lang=zh');
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('Set-Cookie'), /^cosens-lang=zh;/);
  // The sign-in failure redirect carries the language the visitor asked for.
  const failed = await login({request: new Request(`${ORIGIN}/api/demo/auth/login?lang=zh`), env: {}});
  assert.equal(failed.headers.get('Location'), `${ORIGIN}/demo/?login_error=config_missing&lang=zh`);
  const plain = await login({request: new Request(`${ORIGIN}/api/demo/auth/login`), env: {}});
  assert.equal(plain.headers.get('Location'), `${ORIGIN}/demo/?login_error=config_missing`);
});

test('the API gate answers in the language of ?lang, the cookie or the configured default', async () => {
  const cfg = testConfig();
  const ask = async (path, {cookie, env} = {}) => (await (await apiGate({request: new Request(new URL(path, ORIGIN), {headers: cookie ? {Cookie: cookie} : {}}), env: envFromConfig(cfg, env), data: {}, next: async () => new Response('no')})).json()).error.message;
  assert.equal(await ask('/api/demo/me'), 'Your login has expired. Please sign in again.');
  assert.equal(await ask('/api/demo/me', {cookie: 'cosens-lang=zh'}), '登录已过期，请重新登录');
  assert.equal(await ask('/api/demo/me?lang=zh'), '登录已过期，请重新登录');
  assert.equal(await ask('/api/demo/me', {env: {SITE_DEFAULT_LOCALE: 'zh'}}), '登录已过期，请重新登录');
  assert.equal(await ask('/api/demo/me?lang=en', {cookie: 'cosens-lang=zh', env: {SITE_DEFAULT_LOCALE: 'zh'}}), 'Your login has expired. Please sign in again.');
});

// ---- What ships ----

test('the default-locale HTML shells have no Chinese and every data-i18n text equals its English message', async () => {
  for (const page of ['apps/demo/index.html', 'apps/demo/investor/index.html', 'dist/demo/index.html', 'dist/demo/investor/index.html']) {
    const html = await read(page);
    assert.equal(CJK.test(html), false, page);
    assert.ok(html.includes('<html lang="en">'), page);
    assert.ok(html.includes('<meta name="cosens-default-locale" content="en">'), page);
    for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)\bdata-i18n="([\w.]+)"([^>]*)>([^<]*)</g)) {
      const [, , before, key, after, text] = match;
      assert.equal(hasMessage(key), true, `${page}: ${key}`);
      assert.equal(text, t(key, undefined, 'en').replace(/&/g, '&amp;'), `${page}: ${key}`);
    }
    for (const match of html.matchAll(/\s([a-z-]+)="([^"]*)"[^>]*\sdata-i18n-\1="([\w.]+)"|\sdata-i18n-([a-z-]+)="([\w.]+)"[^>]*\s\4="([^"]*)"/g)) {
      const key = match[3] ?? match[5];
      const value = match[2] ?? match[6];
      assert.equal(value.replace(/&quot;/g, '"'), t(key, undefined, 'en'), `${page}: ${key}`);
    }
  }
});

test('the shipped demo bundle carries both languages but the English ones carry no Chinese', async () => {
  const assets = (await readdir(join(root, 'dist/demo/_app'))).filter(name => name.endsWith('.js'));
  const bundle = (await Promise.all(assets.map(name => read(`dist/demo/_app/${name}`)))).join('\n');
  assert.ok(bundle.includes('Project A') || bundle.includes('Project '), 'English texts are in the bundle');
  assert.ok(bundle.includes('投资人演示'), 'and so are the Chinese ones');
  assert.ok(bundle.includes('cosens-lang') && bundle.includes('cosens-default-locale'));
  for (const key of keys) assert.equal(CJK.test(t(key, undefined, 'en')), false, key);
});

