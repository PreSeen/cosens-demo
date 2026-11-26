import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ServiceError} from '../server/demo/http.mjs';
import {t} from '../shared/i18n.mjs';
import {
  ASSET_BASE, GROUPS, GROUP_IDS, LIMITS, assetUrl, checkMemoryFile, checkProjectFile, fileKind, findDemoFile, ingestContent,
  ingestKey, loadManifest, mimeFor, projectTitle, readDemoFile, stem, validateMethodTarget,
} from '../server/demo/investor/materials.mjs';

/** The message of the error a call raises, in a language. */
const failureText = (call, locale) => {
  try { call(); } catch (err) { return err.text(locale); }
  return null;
};
const failsWith = (status, code) => err => err instanceof ServiceError && err.status === status && err.code === code;
const enc = text => new TextEncoder().encode(text);
const sha = value => createHash('sha256').update(value).digest('hex');

const MANIFEST = {groups: [
  {id: 'memory', files: [
    {name: '微信联系人.md', path: '1-记忆资料/微信联系人.md', size: 30},
    {name: '2026-03-14 腾讯会议纪要 储能材料行业交流.md', path: '1-记忆资料/纪要/2026-03-14 腾讯会议纪要 储能材料行业交流.md', size: 18},
  ]},
  {id: 'method', files: [
    {name: '项目A 衡石动力 BP.md', path: '2-投资方法/项目A 衡石动力 BP.md', size: 12, slot: 'A', role: 'bp'},
  ]},
  {id: 'bp', files: [{name: '锂境科技 BP.md', path: '3-新BP/锂境科技 BP.md', size: 10}]},
]};

function fakeAssets(extra = {}) {
  const files = {
    [`${ASSET_BASE}manifest.json`]: JSON.stringify(MANIFEST),
    [`${ASSET_BASE}1-记忆资料/微信联系人.md`]: '# 微信联系人\n刘静：前同事',
    [`${ASSET_BASE}2-投资方法/项目A 衡石动力 BP.md`]: '# 衡石动力 BP',
    ...extra,
  };
  const seen = [];
  return {seen, fetch: async input => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const path = decodeURIComponent(url.pathname);
    seen.push({origin: url.origin, path});
    return path in files ? new Response(files[path]) : new Response('not found', {status: 404});
  }};
}

test('GROUPS lists the three demo groups in order', () => {
  assert.deepEqual(GROUPS.map(group => [group.id, group.titleKey, group.hintKey]), [
    ['memory', 'group.memory.title', 'group.memory.hint'], ['method', 'group.method.title', 'group.method.hint'], ['bp', 'group.bp.title', 'group.bp.hint']]);
  // The page titles the groups in the visitor's language from those keys.
  assert.deepEqual(GROUPS.map(group => [t(group.titleKey, undefined, 'en'), t(group.hintKey, undefined, 'en')]), [
    ['Memory materials', 'contacts, minutes, chats'], ['Investment method', 'past BPs and recommendations'], ['New BP', 'the project to analyze this time']]);
  assert.deepEqual(GROUPS.map(group => [t(group.titleKey, undefined, 'zh'), t(group.hintKey, undefined, 'zh')]), [
    ['记忆资料', '联系人、纪要、聊天'], ['投资方法', '过往 BP 和建议书'], ['新 BP', '这次要分析的项目']]);
  assert.deepEqual(GROUP_IDS, ['memory', 'method', 'bp']);
});

test('loadManifest reads manifest.json through the asset binding once per binding', async () => {
  const assets = fakeAssets();
  const env = {ASSETS: assets};
  assert.deepEqual(await loadManifest(env, {origin: 'https://cosens.ai'}), MANIFEST);
  assert.deepEqual(await loadManifest(env), MANIFEST);
  assert.deepEqual(assets.seen, [{origin: 'https://cosens.ai', path: '/demo/assets/investor/manifest.json'}]);
});

test('loadManifest answers demo_data_missing when the bundle or binding is absent', async () => {
  await assert.rejects(loadManifest({ASSETS: {fetch: async () => new Response('nf', {status: 404})}}), failsWith(503, 'demo_data_missing'));
  await assert.rejects(loadManifest({ASSETS: {fetch: async () => new Response('{"nope":1}')}}), failsWith(503, 'demo_data_missing'));
  await assert.rejects(loadManifest({}), failsWith(503, 'demo_data_missing'));
});

test('readDemoFile reads only files listed in the manifest group', async () => {
  const env = {ASSETS: fakeAssets()};
  const file = await readDemoFile(env, 'memory', '1-记忆资料/微信联系人.md', {origin: 'https://cosens.ai'});
  assert.equal(file.name, '微信联系人.md');
  assert.equal(file.path, '1-记忆资料/微信联系人.md');
  assert.equal(new TextDecoder().decode(file.bytes), '# 微信联系人\n刘静：前同事');
  assert.equal(file.mime, 'text/markdown; charset=utf-8');
  assert.equal(file.slot, null);
  const method = await readDemoFile(env, 'method', '2-投资方法/项目A 衡石动力 BP.md');
  assert.deepEqual([method.slot, method.role], ['A', 'bp']);
  await assert.rejects(readDemoFile(env, 'memory', '../manifest.json'), failsWith(404, 'demo_file_not_found'));
  await assert.rejects(readDemoFile(env, 'memory', '2-投资方法/项目A 衡石动力 BP.md'), failsWith(404, 'demo_file_not_found'));
  await assert.rejects(readDemoFile(env, 'nope', '1-记忆资料/微信联系人.md'), failsWith(404, 'demo_file_not_found'));
  await assert.rejects(readDemoFile(env, 'memory', '1-记忆资料/纪要/2026-03-14 腾讯会议纪要 储能材料行业交流.md'),
    failsWith(503, 'demo_data_missing'));
  assert.throws(() => findDemoFile(MANIFEST, 'bp', '锂境科技 BP.md'), failsWith(404, 'demo_file_not_found'));
  assert.equal(findDemoFile(MANIFEST, 'bp', '3-新BP/锂境科技 BP.md').name, '锂境科技 BP.md');
});

test('assetUrl encodes every segment and keeps absolute paths', () => {
  assert.equal(assetUrl('1-记忆资料/微信联系人.md', 'https://cosens.ai/'),
    `https://cosens.ai/demo/assets/investor/${encodeURIComponent('1-记忆资料')}/${encodeURIComponent('微信联系人.md')}`);
  assert.equal(assetUrl('/demo/assets/investor/demo-data.zip', 'https://cosens.ai'), 'https://cosens.ai/demo/assets/investor/demo-data.zip');
});

test('ingestKey hashes name plus content, and documents by their bytes', async () => {
  assert.equal(await ingestKey('微信联系人.md', '刘静'), `demo-${sha('微信联系人.md\n刘静').slice(0, 40)}`);
  assert.notEqual(await ingestKey('a.md', '同一段话'), await ingestKey('b.md', '同一段话'));
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(await ingestKey('deck.pdf', bytes), `demo-${sha(`deck.pdf\n${sha(Buffer.from(bytes))}`).slice(0, 40)}`);
  assert.match(await ingestKey('x.md', 'y'), /^demo-[0-9a-f]{40}$/);
});

test('ingestContent prefixes the file stem the way the source check expects', () => {
  assert.equal(ingestContent('2026-06-20 饭局笔记 与孙蕾.md', '正文'), 'Source: 2026-06-20 饭局笔记 与孙蕾\n\n正文');
  assert.equal(ingestContent('2026-06-20 饭局笔记 与孙蕾.md', '正文', 'zh'), '资料：2026-06-20 饭局笔记 与孙蕾\n\n正文');
  assert.equal(ingestContent('Fund weekly notes.md', 'body', 'en'), 'Source: Fund weekly notes\n\nbody');
  assert.equal(stem('纪要/a.b.md'), 'a.b');
  assert.equal(stem('README'), 'README');
});

test('fileKind and mimeFor recognise text and document files', () => {
  assert.equal(fileKind('a.md'), 'text');
  assert.equal(fileKind('a.MARKDOWN'), 'text');
  assert.equal(fileKind('a.txt'), 'text');
  assert.equal(fileKind('a.pdf'), 'document');
  assert.equal(fileKind('a.Docx'), 'document');
  assert.equal(fileKind('a.doc'), 'document');
  assert.equal(fileKind('a.pptx'), null);
  assert.equal(fileKind('.md'), null);
  assert.equal(mimeFor('a.pdf'), 'application/pdf');
  assert.equal(mimeFor('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(mimeFor('a.txt'), 'text/plain; charset=utf-8');
  assert.equal(mimeFor('a.bin'), 'application/octet-stream');
});

test('checkMemoryFile enforces kinds, UTF-8, emptiness and limits', () => {
  assert.deepEqual(checkMemoryFile('a.md', enc('# 你好')), {kind: 'text', text: '# 你好'});
  assert.deepEqual(checkMemoryFile('a.pdf', new Uint8Array([0x25, 0x50])), {kind: 'document'});
  assert.throws(() => checkMemoryFile('a.pptx', enc('x')), failsWith(415, 'unsupported_file'));
  assert.throws(() => checkMemoryFile('a.pptx', enc('x')), /^ServiceError: Memory materials must be \.md/);
  assert.equal(failureText(() => checkMemoryFile('a.pptx', enc('x')), 'zh'), '记忆资料只支持 .md、.markdown、.txt、.pdf、.doc、.docx');
  assert.throws(() => checkMemoryFile('a.md', new Uint8Array([0xff, 0xfe, 0xfd])), failsWith(415, 'unsupported_file'));
  assert.throws(() => checkMemoryFile('a.md', new Uint8Array()), failsWith(400, 'empty_file'));
  assert.throws(() => checkMemoryFile('a.md', enc('  \n ')), failsWith(400, 'empty_file'));
  assert.throws(() => checkMemoryFile('a.txt', enc('a'.repeat(LIMITS.textChars))), failsWith(413, 'file_too_large'));
  assert.throws(() => checkMemoryFile('a.pdf', new Uint8Array(LIMITS.documentBytes + 1)), failsWith(413, 'file_too_large'));
  assert.throws(() => checkMemoryFile(`${'名'.repeat(201)}.md`, enc('x')), failsWith(400, 'invalid_file_name'));
  assert.throws(() => checkMemoryFile('', enc('x')), failsWith(400, 'invalid_file_name'));
});

test('checkProjectFile enforces the RSI file limit and a text-only new BP', () => {
  assert.deepEqual(checkProjectFile('method', '项目A BP.md', enc('x')), {kind: 'text'});
  assert.deepEqual(checkProjectFile('method', '项目A 投资建议书.pdf', new Uint8Array([1])), {kind: 'document'});
  assert.deepEqual(checkProjectFile('bp', '锂境科技 BP.txt', enc('x')), {kind: 'text'});
  assert.throws(() => checkProjectFile('bp', '锂境科技 BP.pdf', new Uint8Array([1])), failsWith(415, 'unsupported_file'));
  assert.throws(() => checkProjectFile('method', 'deck.pptx', new Uint8Array([1])), failsWith(415, 'unsupported_file'));
  assert.throws(() => checkProjectFile('bp', '锂境科技 BP.pdf', new Uint8Array([1])), /^ServiceError: The new BP must be a \.md/);
  assert.throws(() => checkProjectFile('method', 'deck.pptx', new Uint8Array([1])), /^ServiceError: Investment method files must be/);
  assert.equal(failureText(() => checkProjectFile('bp', '锂境科技 BP.pdf', new Uint8Array([1])), 'zh'), '新 BP 只支持 .md、.markdown、.txt');
  assert.throws(() => checkProjectFile('method', 'big.md', new Uint8Array(LIMITS.projectBytes + 1).fill(0x61)), failsWith(413, 'file_too_large'));
  assert.throws(() => checkProjectFile('method', 'empty.md', new Uint8Array()), failsWith(400, 'empty_file'));
  assert.throws(() => checkProjectFile('memory', 'a.md', enc('x')), failsWith(400, 'invalid_group'));
});

test('validateMethodTarget and projectTitle', () => {
  assert.deepEqual(validateMethodTarget('A', 'bp'), {slot: 'A', role: 'bp'});
  assert.deepEqual(validateMethodTarget('B', 'proposal'), {slot: 'B', role: 'proposal'});
  assert.throws(() => validateMethodTarget(undefined, 'bp'), failsWith(400, 'invalid_method_file'));
  assert.throws(() => validateMethodTarget('C', 'bp'), failsWith(400, 'invalid_method_file'));
  assert.throws(() => validateMethodTarget('A', 'deck'), failsWith(400, 'invalid_method_file'));
  assert.equal(projectTitle('A', '项目A 衡石动力 BP.md'), '项目A 衡石动力');
  assert.equal(projectTitle('B', '项目B 微澜光电 投资建议书.md'), '项目B 微澜光电');
  assert.equal(projectTitle('A', 'my-plan.pdf'), 'my-plan');
  assert.equal(projectTitle('B', 'BP.md'), '', 'nothing left: the page then shows "Project B" itself');
  assert.equal(projectTitle('A', 'Project A Orbit Energy BP.md'), 'Project A Orbit Energy');
  assert.equal(projectTitle('B', 'Project B Orbit Energy Investment Recommendation.md'), 'Project B Orbit Energy');
  assert.equal(projectTitle('A', 'Project A Orbit Business Plan.md'), 'Project A Orbit');
});

test('checkMemoryFile refuses PDF and Word when documents are off, and keeps Markdown and text', () => {
  const off = {documents: false};
  assert.deepEqual(checkMemoryFile('a.md', enc('# 你好'), off), {kind: 'text', text: '# 你好'});
  assert.deepEqual(checkMemoryFile('a.txt', enc('你好'), off), {kind: 'text', text: '你好'});
  for (const name of ['a.pdf', 'a.doc', 'a.DOCX']) {
    assert.throws(() => checkMemoryFile(name, new Uint8Array([0x25, 0x50]), off), failsWith(415, 'unsupported_file'));
    assert.throws(() => checkMemoryFile(name, new Uint8Array([0x25, 0x50]), off), /^ServiceError: This environment accepts only Markdown and text\./);
    assert.equal(failureText(() => checkMemoryFile(name, new Uint8Array([0x25, 0x50]), off), 'zh'), '这个环境只支持 Markdown 和文本，PDF 和 Word 请另存为 .md 或 .txt 再上传');
  }
  assert.throws(() => checkMemoryFile('a.pptx', enc('x'), off), /^ServiceError: Memory materials must be \.md, \.markdown or \.txt files\.$/);
  assert.equal(failureText(() => checkMemoryFile('a.pptx', enc('x'), off), 'zh'), '记忆资料只支持 .md、.markdown、.txt');
  assert.deepEqual(checkMemoryFile('a.pdf', new Uint8Array([0x25, 0x50]), {documents: true}), {kind: 'document'});
});
