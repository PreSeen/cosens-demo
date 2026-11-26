import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const pages = [['demo/index.html', 'CoSens Demo'], ['demo/investor/index.html', 'CoSens Investor Demo']];

test('demo pages are static files with noindex, their own titles and a bundled script', async () => {
  for (const [file, title] of pages) {
    const html = await readFile(new URL(file, dist), 'utf8');
    assert.match(html, /^<!doctype html>\s*<html lang="en">\s*<head>/i, file);
    assert.deepEqual([...html.matchAll(/<meta name="robots" content="([^"]*)"\/?>/g)].map(match => match[1]), ['noindex, nofollow'], file);
    assert.match(html, new RegExp(`<title data-i18n="[a-z.]+_title">${title}</title>`), file);
    assert.equal(html.includes('rel="canonical"'), false, file);
    assert.ok(html.includes('id="theme-bootstrap"'), file);
    assert.match(html, /<div id="root">/, file);
    const scripts = [...html.matchAll(/<script type="module" crossorigin src="(\/demo\/_app\/[^"]+\.js)"><\/script>/g)].map(match => match[1]);
    assert.equal(scripts.length, 1, file);
    await access(new URL(`.${scripts[0]}`, dist));
  }
});

test('demo data is published under /demo/assets/investor/', async () => {
  const assets = new URL('demo/assets/investor/', dist);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', assets), 'utf8'));
  assert.deepEqual(manifest.groups.map(group => group.id), ['memory', 'method', 'bp']);
  const files = manifest.groups.flatMap(group => group.files);
  assert.equal(files.length, 29);
  for (const file of files) {
    const published = await readFile(new URL(file.path.split('/').map(encodeURIComponent).join('/'), assets));
    assert.equal(published.length, file.size, file.path);
  }
  await access(new URL('demo-data.zip', assets));
});

