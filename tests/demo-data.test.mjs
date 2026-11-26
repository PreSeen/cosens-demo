import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { buildDemoData, buildManifest, crc32, createZip, defaultSource, parseMethodName, zipName, zipRoot } from '../scripts/build-demo-data.mjs';


async function withTemp(run) {
  const directory = await mkdtemp(join(tmpdir(), 'cosens-demo-data-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function walk(directory, prefix = '') {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...await walk(join(directory, entry.name), `${prefix}${entry.name}/`));
    else out.push(prefix + entry.name);
  }
  return out.sort();
}

// Independent reader: end record -> central directory -> local headers.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory record');
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  let at = buffer.readUInt32LE(end + 16);
  assert.equal(at + size, end, 'central directory ends at the end record');
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, 'central header signature');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const uncompressed = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50, `local header signature for ${name}`);
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const localExtraLength = buffer.readUInt16LE(offset + 28);
    const localName = buffer.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8');
    const start = offset + 30 + localNameLength + localExtraLength;
    entries.push({ name, flags, method, crc, compressed, uncompressed, localName, localFlags: buffer.readUInt16LE(offset + 6), localCrc: buffer.readUInt32LE(offset + 14), data: buffer.subarray(start, start + compressed) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('demo manifest keeps the demo order: contacts first, then minutes by name', async () => {
  const manifest = await buildManifest();
  assert.deepEqual(manifest.groups.map(group => [group.id, group.files.length]), [['memory', 24], ['method', 4], ['bp', 1]]);
  // The manifest names no group: the page titles them in the visitor's language (group.<id>.title), so no Chinese label is baked in.
  for (const group of manifest.groups) assert.deepEqual(Object.keys(group), ['id', 'files']);
  const memory = manifest.groups[0].files;
  assert.deepEqual(memory[0], { name: '微信联系人.md', path: '1-记忆资料/微信联系人.md', size: (await readFile(join(defaultSource, '1-记忆资料/微信联系人.md'))).length });
  const minutes = memory.slice(1).map(file => file.path);
  assert.ok(minutes.every(path => path.startsWith('1-记忆资料/纪要/')));
  assert.deepEqual(minutes, [...minutes].sort());
  assert.equal(minutes[0], '1-记忆资料/纪要/2025-09-18 基金周会纪要 九月第三周项目进展.md');
  assert.equal(minutes.at(-1), '1-记忆资料/纪要/2026-11-06 腾讯会议纪要 星屿宠物B轮跟投讨论.md');
  assert.deepEqual(manifest.groups[2].files, [{ name: '锂境科技 BP.md', path: '3-新BP/锂境科技 BP.md', size: (await readFile(join(defaultSource, '3-新BP/锂境科技 BP.md'))).length }]);
  for (const file of manifest.groups.flatMap(group => group.files)) {
    assert.equal(file.size, (await readFile(join(defaultSource, file.path))).length, file.path);
    assert.equal(file.name, file.path.split('/').pop());
  }
  for (const file of [...manifest.groups[0].files, ...manifest.groups[2].files]) {
    assert.equal('slot' in file, false, file.path);
    assert.equal('role' in file, false, file.path);
  }
});

test('method files carry project slot and role parsed from their names', async () => {
  const manifest = await buildManifest();
  assert.deepEqual(manifest.groups[1].files.map(({ name, path, slot, role }) => ({ name, path, slot, role })), [
    { name: '项目A 衡石动力 BP.md', path: '2-投资方法/项目A 衡石动力 BP.md', slot: 'A', role: 'bp' },
    { name: '项目A 衡石动力 投资建议书.md', path: '2-投资方法/项目A 衡石动力 投资建议书.md', slot: 'A', role: 'proposal' },
    { name: '项目B 微澜光电 BP.md', path: '2-投资方法/项目B 微澜光电 BP.md', slot: 'B', role: 'bp' },
    { name: '项目B 微澜光电 投资建议书.md', path: '2-投资方法/项目B 微澜光电 投资建议书.md', slot: 'B', role: 'proposal' },
  ]);
  assert.deepEqual(parseMethodName('项目A 衡石动力 BP.md'), { slot: 'A', role: 'bp' });
  assert.deepEqual(parseMethodName('项目B 微澜光电 投资建议书.md'), { slot: 'B', role: 'proposal' });
  assert.deepEqual(parseMethodName('项目A BP.md'), { slot: 'A', role: 'bp' });
  // English names work as well (the fixtures themselves stay Chinese).
  assert.deepEqual(parseMethodName('Project A Acme BP.md'), { slot: 'A', role: 'bp' });
  assert.deepEqual(parseMethodName('Project B Orbit Investment Recommendation.md'), { slot: 'B', role: 'proposal' });
  assert.deepEqual(parseMethodName('Project B Orbit Proposal.md'), { slot: 'B', role: 'proposal' });
  assert.equal(parseMethodName('Project C Orbit BP.md'), null);
  for (const name of ['项目C 某公司 BP.md', '衡石动力 BP.md', '项目A 衡石动力 BP.pdf', '项目A 衡石动力 纪要.md', '项目A衡石动力BP.md']) {
    assert.equal(parseMethodName(name), null, name);
  }
});

test('manifest rejects method folders that are not two complete projects', async () => {
  await withTemp(async directory => {
    const source = join(directory, 'source');
    await cp(defaultSource, source, { recursive: true });
    await rename(join(source, '2-投资方法/项目B 微澜光电 投资建议书.md'), join(source, '2-投资方法/微澜光电 建议.md'));
    await assert.rejects(buildManifest(source), /2-投资方法\/微澜光电 建议\.md/);
    await rm(join(source, '2-投资方法/微澜光电 建议.md'));
    await assert.rejects(buildManifest(source), /Project B needs exactly one investment recommendation file, found 0/);
  });
});

test('crc32 matches the standard check value and zlib', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const sample = Buffer.from('资料：微信联系人\n\n周明远 · 投资人 ✓', 'utf8');
  assert.equal(crc32(sample), zlibCrc32(sample));
});

test('build copies 29 files without the story notes, writes the manifest and a readable zip', async () => {
  await withTemp(async directory => {
    const target = join(directory, 'investor');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'stale.txt'), 'left over from an earlier build');
    const result = await buildDemoData({ target });
    assert.equal(result.files, 29);
    const paths = result.manifest.groups.flatMap(group => group.files.map(file => file.path));
    assert.deepEqual(await walk(target), [...paths, 'manifest.json', zipName].sort());
    assert.equal(paths.some(path => path.includes('故事设定')), false);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')), result.manifest);
    for (const path of paths) assert.deepEqual(await readFile(join(target, path)), await readFile(join(defaultSource, path)), path);
    const zip = await readFile(join(target, zipName));
    assert.equal(zip.length, result.zipBytes);
    const entries = readZip(zip);
    assert.deepEqual(entries.map(entry => entry.name), paths.map(path => zipRoot + path));
    for (const entry of entries) {
      const source = await readFile(join(defaultSource, entry.name.slice(zipRoot.length)));
      assert.equal(entry.method, 0, entry.name);
      assert.equal(entry.flags & 0x0800, 0x0800, entry.name);
      assert.equal(entry.localFlags & 0x0800, 0x0800, entry.name);
      assert.equal(entry.localName, entry.name);
      assert.equal(entry.compressed, source.length, entry.name);
      assert.equal(entry.uncompressed, source.length, entry.name);
      assert.equal(entry.crc, zlibCrc32(source), entry.name);
      assert.equal(entry.localCrc, entry.crc, entry.name);
      assert.deepEqual(Buffer.from(entry.data), source, entry.name);
    }
    const again = await buildDemoData({ target });
    assert.equal(again.zipBytes, result.zipBytes);
    assert.deepEqual(await readFile(join(target, zipName)), zip, 'zip bytes are deterministic');
  });
});

test('zip writer handles an empty archive and multi-byte names', () => {
  assert.deepEqual(readZip(createZip([])), []);
  const [entry] = readZip(createZip([{ name: 'demo-data/新 BP/锂境.md', data: Buffer.from('陈立') }]));
  assert.equal(entry.name, 'demo-data/新 BP/锂境.md');
  assert.equal(entry.data.toString('utf8'), '陈立');
});

