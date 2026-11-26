import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read = path => readFile(new URL('../dist/' + path, import.meta.url), 'utf8');

const pages = [
 {file: 'demo/index.html', title: 'CoSens Demo', titleKey: 'hub.page_title', markers: ['id="shell"', 'id="demos"', 'id="loginError"']},
 {file: 'demo/investor/index.html', title: 'CoSens Investor Demo', titleKey: 'investor.page_title', markers: ['id="runbar"', 'data-act="restart"', 'data-act="switch"', 'data-act="replay"', 'href="/demo/assets/investor/demo-data.zip"', 'data-step="3"', 'id="mats"', 'id="viewer"', 'id="ownInputs"', 'data-group="memory"', 'data-group="method" data-slot="A" data-role="bp"', 'data-group="method" data-slot="A" data-role="proposal"', 'data-group="method" data-slot="B" data-role="bp"', 'data-group="method" data-slot="B" data-role="proposal"', 'data-group="bp"']},
];

for (const page of pages) {
 test(`${page.file} is a noindex English-default page with one theme bootstrap and its own theme mount`, async () => {
  const html = await read(page.file);
  assert.ok(html.includes('<html lang="en">'));
  assert.equal(html.includes('zh-CN'), false);
  assert.ok(html.includes(`<title data-i18n="${page.titleKey}">${page.title}</title>`));
  assert.ok(html.includes('<meta name="cosens-default-locale" content="en">'), 'the configured default is filled in by the page gate');
  assert.ok(html.includes('name="robots" content="noindex, nofollow"'));
  assert.equal(html.match(/id="theme-bootstrap"/g)?.length, 1);
  assert.ok(html.includes('id="root"'), 'id="root" keeps the build from injecting a second theme-control listener');
  assert.equal(html.includes('mountThemeControls();'), false);
  assert.match(html, /<script type="module" crossorigin src="\/demo\/_app\/[^"]+\.js"><\/script>/);
  for (const marker of page.markers) assert.ok(html.includes(marker), marker);
 });
}
