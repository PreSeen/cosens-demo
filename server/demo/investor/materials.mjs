// Investor demo materials: the three groups, the bundled demo files (served by the Pages
// asset binding, so the /demo page gate is not involved) and the checks every file must pass.
import {sha256Hex} from '../crypto.mjs';
import {demoError} from '../runs.mjs';
import {DEFAULT_LOCALE, t} from '../../../shared/i18n.mjs';

export const ASSET_BASE = '/demo/assets/investor/';
export const DEFAULT_ASSET_ORIGIN = 'https://assets.local';
/** The three groups; the page names them with the `group.<id>.title` and `group.<id>.hint` messages. */
export const GROUPS = Object.freeze(['memory', 'method', 'bp'].map(id => Object.freeze({id, titleKey: `group.${id}.title`, hintKey: `group.${id}.hint`})));
export const GROUP_IDS = Object.freeze(GROUPS.map(group => group.id));
export const SLOTS = Object.freeze(['A', 'B']);
export const ROLES = Object.freeze(['bp', 'proposal']);
export const LIMITS = Object.freeze({
  textChars: 2_000_000,            // Memory ingest content limit, prefix included
  documentBytes: 20 * 1024 * 1024, // site limit for PDF and Word uploads to Memory
  projectBytes: 4 * 1024 * 1024,   // RSI per-file limit after decoding
  nameChars: 200,                  // RSI Upload.name max_length
});

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx']);
const MIME_TYPES = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const manifests = new WeakMap();

export function baseName(name) {
  return String(name ?? '').split(/[\\/]/).pop().trim();
}

export function extension(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function stem(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 'text' for Markdown and plain text, 'document' for PDF and Word, null for anything else. */
export function fileKind(name) {
  const ext = extension(name);
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return null;
}

export function mimeFor(name) {
  return MIME_TYPES[extension(name)] || 'application/octet-stream';
}

export function checkFileName(name) {
  const base = baseName(name);
  if (!base || base.length > LIMITS.nameChars || /[\u0000-\u001f\u007f]/.test(base)) {
    throw demoError(400, 'invalid_file_name', 'err.file_name_invalid');
  }
  return base;
}

export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw demoError(415, 'unsupported_file', 'err.not_utf8');
  }
}

/** The text written to Memory: "Source: <stem>" ("资料：<stem>" in Chinese) heads every source so citations can name it. */
export function ingestContent(name, text, locale = DEFAULT_LOCALE) {
  return `${t('ingest.marker', {title: stem(name)}, locale)}\n\n${text}`;
}

/** Replay-safe Memory key from name plus content; documents hash their bytes first. */
export async function ingestKey(name, content) {
  const body = typeof content === 'string' ? content : await sha256Hex(content);
  return `demo-${(await sha256Hex(`${name}\n${body}`)).slice(0, 40)}`;
}

function emptyFile(name) {
  return demoError(400, 'empty_file', 'err.empty_file', {name});
}

/**
 * Step 1 files: text goes to Memory ingest, PDF and Word to Memory's document upload. documents = false (Memory
 * through the gateway, which does not forward the document upload) refuses PDF and Word.
 */
export function checkMemoryFile(name, bytes, {documents = true, locale = DEFAULT_LOCALE} = {}) {
  const fileName = checkFileName(name);
  const kind = fileKind(fileName);
  if (!kind) throw demoError(415, 'unsupported_file', documents ? 'err.memory_types_all' : 'err.memory_types_text');
  if (kind === 'document' && !documents) throw demoError(415, 'unsupported_file', 'err.text_only');
  if (!bytes || bytes.byteLength === 0) throw emptyFile(fileName);
  if (kind === 'document') {
    if (bytes.byteLength > LIMITS.documentBytes) throw demoError(413, 'file_too_large', 'err.doc_too_large');
    return {kind};
  }
  const text = decodeText(bytes);
  if (!text.trim()) throw emptyFile(fileName);
  if (ingestContent(fileName, text, locale).length > LIMITS.textChars) throw demoError(413, 'file_too_large', 'err.text_too_large');
  return {kind, text};
}

/** Step 2 project files and the step 3 BP: RSI's 4 MiB file limit; the new BP must be text. */
export function checkProjectFile(group, name, bytes) {
  if (group !== 'method' && group !== 'bp') throw demoError(400, 'invalid_group', 'err.invalid_group');
  const fileName = checkFileName(name);
  const kind = fileKind(fileName);
  if (group === 'bp' && kind !== 'text') throw demoError(415, 'unsupported_file', 'err.bp_text_only');
  if (!kind) throw demoError(415, 'unsupported_file', 'err.method_types');
  if (!bytes || bytes.byteLength === 0) throw emptyFile(fileName);
  if (bytes.byteLength > LIMITS.projectBytes) throw demoError(413, 'file_too_large', 'err.file_too_large_4mb');
  if (kind === 'text' && !decodeText(bytes).trim()) throw emptyFile(fileName);
  return {kind};
}

export function validateMethodTarget(slot, role) {
  if (!SLOTS.includes(slot) || !ROLES.includes(role)) {
    throw demoError(400, 'invalid_method_file', 'err.invalid_method_file');
  }
  return {slot, role};
}

/** "项目A 衡石动力 BP.md" -> "项目A 衡石动力", "Project A Acme BP.md" -> "Project A Acme"; '' when nothing is left (the page then shows "Project A"). */
export function projectTitle(slot, name) {
  return stem(name).replace(/[\s_-]*(BP|商业计划书|计划书|投资建议书|建议书|business plan|investment (?:memo|proposal|recommendation)|proposal|recommendation|memo)$/i, '').trim();
}

export function assetUrl(path, origin = DEFAULT_ASSET_ORIGIN) {
  const absolute = path.startsWith('/') ? path : ASSET_BASE + path;
  return origin.replace(/\/+$/, '') + absolute.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function missingData() {
  return demoError(503, 'demo_data_missing', 'err.demo_data_missing');
}

/** manifest.json written by scripts/build-demo-data.mjs; cached per asset binding. */
export async function loadManifest(env, {origin = DEFAULT_ASSET_ORIGIN} = {}) {
  const assets = env?.ASSETS;
  if (!assets || typeof assets.fetch !== 'function') throw missingData();
  const cached = manifests.get(assets);
  if (cached) return cached;
  const response = await assets.fetch(new Request(assetUrl('manifest.json', origin)));
  const data = response.ok ? await response.json().catch(() => null) : null;
  if (!data || !Array.isArray(data.groups)) throw missingData();
  manifests.set(assets, data);
  return data;
}

export function findDemoFile(manifest, group, path) {
  const entry = manifest.groups.find(item => item.id === group);
  const file = entry && Array.isArray(entry.files) ? entry.files.find(item => item.path === path) : null;
  if (!file) throw demoError(404, 'demo_file_not_found', 'err.demo_file_not_found');
  return file;
}

/** Reads one bundled demo file; only paths listed in the manifest group are served. */
export async function readDemoFile(env, group, path, {origin = DEFAULT_ASSET_ORIGIN} = {}) {
  const manifest = await loadManifest(env, {origin});
  const file = findDemoFile(manifest, group, path);
  const response = await env.ASSETS.fetch(new Request(assetUrl(file.path, origin)));
  if (!response.ok) throw missingData();
  return {
    name: baseName(file.name), path: file.path, bytes: new Uint8Array(await response.arrayBuffer()),
    mime: mimeFor(file.name), slot: file.slot ?? null, role: file.role ?? null,
  };
}
