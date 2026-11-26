import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const defaultSource = join(root, 'content/demos/investor');
export const defaultTarget = join(root, 'apps/demo/public/assets/investor');
export const zipName = 'demo-data.zip';
export const zipRoot = 'demo-data/';

// Group order is the demo order; directory names on disk carry the step number. The fixture folders and files stay
// Chinese (the sample scenario); the page names each group itself, in the visitor's language (group.<id>.title).
export const groups = [
  { id: 'memory', dir: '1-记忆资料' },
  { id: 'method', dir: '2-投资方法' },
  { id: 'bp', dir: '3-新BP' },
];

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// "项目A 衡石动力 BP.md" -> {slot:'A', role:'bp'}; "项目B 微澜光电 投资建议书.md" -> {slot:'B', role:'proposal'};
// English names work the same way: "Project A Acme BP.md", "Project B Orbit Investment Recommendation.md".
export function parseMethodName(name) {
  const match = /^(?:项目|Project\s*)([AB])(?:\s+.*?)?\s+(BP|投资建议书|(?:Investment\s+)?(?:Recommendation|Proposal|Memo))\.md$/iu.exec(name);
  if (!match) return null;
  return { slot: match[1].toUpperCase(), role: /^BP$/i.test(match[2]) ? 'bp' : 'proposal' };
}

// Files directly in a folder come first, then each subfolder in name order (Python sorted() order).
async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name).sort(byCodePoint);
  const folders = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(byCodePoint);
  const out = files.map(name => prefix + name);
  for (const folder of folders) out.push(...await listFiles(join(directory, folder), `${prefix}${folder}/`));
  return out;
}

export async function buildManifest(source = defaultSource) {
  const manifest = { groups: [] };
  for (const group of groups) {
    const files = [];
    for (const relative of await listFiles(join(source, group.dir))) {
      const path = `${group.dir}/${relative}`;
      const name = relative.split('/').pop();
      const bytes = await readFile(join(source, path));
      const file = { name, path, size: bytes.length };
      if (group.id === 'method') {
        const parsed = parseMethodName(name);
        if (!parsed) throw new Error(`Method file names must look like "项目A <名称> BP.md" or "项目A <名称> 投资建议书.md" (or "Project A <name> BP.md" / "Project A <name> Recommendation.md"): ${path}`);
        Object.assign(file, parsed);
      }
      files.push(file);
    }
    if (files.length === 0) throw new Error(`Demo group ${group.dir} has no files.`);
    if (group.id === 'method') {
      for (const slot of ['A', 'B']) for (const role of ['bp', 'proposal']) {
        const count = files.filter(file => file.slot === slot && file.role === role).length;
        if (count !== 1) throw new Error(`Project ${slot} needs exactly one ${role === 'bp' ? 'BP' : 'investment recommendation'} file, found ${count}.`);
      }
    }
    manifest.groups.push({ id: group.id, files });
  }
  return manifest;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed 2026-01-01 00:00 MS-DOS timestamp, so the archive bytes depend only on the files.
const dosTime = 0;
const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
const utf8Names = 0x0800;
const unixFile = (0o100644 << 16) >>> 0;

// Minimal ZIP writer: STORE method (no compression), UTF-8 names, no ZIP64.
export function createZip(entries) {
  if (entries.length > 0xffff) throw new Error('Too many files for a ZIP without ZIP64.');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Names, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Names, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(unixFile, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, Buffer.from(data));
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
    if (offset > 0xffffffff) throw new Error('Demo data is too large for a ZIP without ZIP64.');
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

export async function buildDemoData({ source = defaultSource, target = defaultTarget } = {}) {
  const manifest = await buildManifest(source);
  const entries = [];
  await rm(target, { recursive: true, force: true });
  for (const file of manifest.groups.flatMap(group => group.files)) {
    const data = await readFile(join(source, file.path));
    await mkdir(dirname(join(target, file.path)), { recursive: true });
    await writeFile(join(target, file.path), data);
    entries.push({ name: zipRoot + file.path, data });
  }
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const zip = createZip(entries);
  await writeFile(join(target, zipName), zip);
  return { manifest, files: entries.length, zipBytes: zip.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildDemoData();
  console.log(`Prepared ${result.files} investor demo files, manifest.json and ${zipName} (${result.zipBytes} bytes).`);
}
