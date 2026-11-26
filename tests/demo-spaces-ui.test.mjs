import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setLocale} from '../shared/i18n.mjs';
import {isSpaceRefusal, spaceChoiceView} from '../apps/demo/src/lib/logic.mjs';

const {startCard} = await import('../apps/demo/src/investor/spaces.ts');

const TZ = 'Asia/Shanghai';
const AT = Date.UTC(2026, 10, 20, 6, 30); // 2026-11-20 14:30 in Shanghai
const space = (n, extra = {}) => ({vuId: `vu_${String(n).repeat(32)}`, name: `Space ${n}`, createdAt: AT, role: 'owner', demo: false, ...extra});
const ready = (spaces, readOnly = 0) => ({status: 'ready', spaces, readOnly});
const chooser = (overrides = {}) => ({mode: 'existing', list: null, picked: null, error: null, ...overrides});
const card = (c, options) => startCard(spaceChoiceView(c, {timeZone: TZ}), options);
const radios = (html, name) => [...html.matchAll(new RegExp(`<input type="radio" name="${name}" value="([^"]+)"( checked)?>`, 'g'))].map(m => [m[1], Boolean(m[2])]);
const startDisabled = html => /data-act="create" disabled/.test(html);
const quoted = text => text.replace(/"/g, '&quot;');

test('the default is a new demo space: no list, no warning, Start demo enabled', () => {
  for (const c of [null, undefined, chooser({mode: 'new'}), {mode: 'nonsense'}]) {
    const v = spaceChoiceView(c);
    assert.equal(v.mode, 'new');
    assert.equal(v.status, 'idle');
    assert.equal(v.canStart, true);
    assert.equal(v.warning, '');
  }
  const html = card(chooser({mode: 'new', list: ready([space(1)])}));
  assert.deepEqual(radios(html, 'space-mode'), [['new', true], ['existing', false]]);
  assert.ok(html.includes('New demo space') && html.includes('Use an existing space'));
  assert.equal(radios(html, 'space-pick').length, 0, 'the list shows only for Use an existing space');
  assert.equal(startDisabled(html), false);
  assert.ok(html.includes('Start demo'));
  assert.ok(html.includes('Or hand the demo materials above to the AI directly'));
  assert.ok(!html.includes('choose-cancel'));
});

test('Use an existing space while the list loads: a loading note, Start demo disabled', () => {
  for (const list of [null, {status: 'loading'}]) {
    const v = spaceChoiceView(chooser({list}));
    assert.equal(v.status, 'loading');
    assert.equal(v.canStart, false);
    const html = startCard(v);
    assert.ok(html.includes('data-spaces="loading"') && html.includes('Reading your spaces'));
    assert.ok(startDisabled(html));
    assert.ok(!html.includes('spacewarn'));
  }
});

test('no writable space: says so, points at New demo space and counts read-only spaces', () => {
  const v = spaceChoiceView(chooser({list: ready([], 2)}));
  assert.equal(v.status, 'empty');
  assert.equal(v.canStart, false);
  assert.equal(v.warning, '');
  const html = startCard(v);
  assert.ok(html.includes('data-spaces="empty"'));
  assert.ok(html.includes('You have no space you can write to yet.'));
  assert.ok(html.includes('2 more spaces are read-only for you, so they are not listed.'));
  assert.ok(startDisabled(html));
  assert.equal(spaceChoiceView(chooser({list: ready([], 1)})).readOnlyNote, '1 more space is read-only for you, so it is not listed.');
  assert.equal(spaceChoiceView(chooser({list: ready([], 0)})).readOnlyNote, '');
});

test('one space: listed with its name and created time, nothing picked until the visitor picks it', () => {
  const one = space(1, {demo: true, name: 'CoSens Demo · Investor · 11-20 14:30'});
  let html = card(chooser({list: ready([one])}));
  assert.deepEqual(radios(html, 'space-pick'), [[one.vuId, false]]);
  assert.ok(html.includes('CoSens Demo · Investor · 11-20 14:30 <span class="tag blue">Demo space</span>'));
  assert.ok(html.includes('Created 2026-11-20 14:30'));
  assert.ok(html.includes('You can write to 1 space.'));
  assert.ok(startDisabled(html), 'an existing space needs an explicit pick');
  assert.ok(html.includes('are written into the space you pick and stay there'));
  html = card(chooser({list: ready([one]), picked: one.vuId}));
  assert.deepEqual(radios(html, 'space-pick'), [[one.vuId, true]]);
  assert.equal(startDisabled(html), false);
  assert.ok(html.includes(quoted('will be written into "CoSens Demo · Investor · 11-20 14:30" and stay in that space')));
});

test('many spaces: every one listed in order, demo and shared spaces tagged, the picked one marked', () => {
  const list = [space(1, {name: 'Team share', role: 'write'}), space(2, {name: 'My work memory'}), space(3, {demo: true, createdAt: null})];
  const v = spaceChoiceView(chooser({list: ready(list, 1), picked: list[1].vuId}), {timeZone: TZ});
  assert.equal(v.status, 'ready');
  assert.deepEqual(v.items.map(i => [i.name, i.demo, i.shared, i.picked, i.created]), [
    ['Team share', false, true, false, 'Created 2026-11-20 14:30'],
    ['My work memory', false, false, true, 'Created 2026-11-20 14:30'],
    ['Space 3', true, false, false, 'Creation time unknown'],
  ]);
  const html = startCard(v);
  assert.deepEqual(radios(html, 'space-pick'), list.map(s => [s.vuId, s.vuId === list[1].vuId]));
  assert.ok(html.includes('Team share <span class="tag">Shared with you</span>'));
  assert.ok(html.includes('1 more space is read-only for you'));
  assert.ok(html.includes('You can write to 3 spaces.'));
  assert.ok(html.includes(quoted('"My work memory"')));
  assert.equal(spaceChoiceView(chooser({list: ready([1, 2, 3, 4, 5].map(n => space(n)))})).countText, 'You can write to 5 spaces; scroll the list to see them all.');
  // A pick that is no longer in the list (it was refused and the list reloaded) does not count.
  assert.equal(spaceChoiceView(chooser({list: ready(list), picked: 'vu_gone'})).canStart, false);
});

test('the list fails: the service line, Read again, and New demo space still possible', () => {
  const v = spaceChoiceView(chooser({list: {status: 'failed', error: {code: 'upstream_unavailable', message: 'Account service unreachable: fetch failed (ECONNREFUSED)', service: 'account'}}}));
  assert.equal(v.status, 'failed');
  assert.equal(v.canStart, false);
  assert.equal(v.warning, '');
  const html = startCard(v);
  assert.ok(html.includes('data-spaces="failed"'));
  assert.ok(html.includes('Could not read your spaces: Account service unreachable: fetch failed (ECONNREFUSED)'));
  assert.ok(html.includes('data-act="spaces-retry"') && html.includes('Read again'));
  assert.ok(html.includes(quoted('You can also choose "New demo space"')));
  assert.ok(radios(html, 'space-mode').some(([value, on]) => value === 'new' && !on));
  // An error the demo itself raised reads through errorMessage in the page language.
  assert.equal(spaceChoiceView(chooser({list: {status: 'failed', error: {code: 'network_error', message: 'Failed to fetch'}}})).listError,
    'Could not read your spaces: The network connection failed. Check your network and retry.');
});

test('a picked space the server refuses: the reason stays on the card, nothing is picked', () => {
  const refusal = {code: 'space_read_only', message: 'You can only read this space, not write to it. Pick another space, or create a new demo space.', status: 403};
  assert.equal(isSpaceRefusal(refusal), true);
  assert.equal(isSpaceRefusal({code: 'space_not_found'}), true);
  assert.equal(isSpaceRefusal({code: 'upstream_unavailable'}), false);
  assert.equal(isSpaceRefusal(null), false);
  const html = card(chooser({list: ready([space(1), space(2)]), picked: null, error: refusal.message}));
  assert.ok(html.includes(`<p class="errtext" role="alert">${refusal.message}</p>`));
  assert.ok(radios(html, 'space-pick').every(([, on]) => !on));
  assert.ok(startDisabled(html));
});

test('opened over a run, the card offers Cancel; while creating, Start demo says so and is disabled', () => {
  const over = card(chooser({mode: 'new'}), {cancel: true});
  assert.ok(over.includes('data-act="choose-cancel"') && over.includes('Cancel'));
  assert.ok(!over.includes('Or hand the demo materials above'));
  const creating = card(chooser({mode: 'new'}), {creating: true});
  assert.ok(creating.includes('Preparing…'));
  assert.ok(startDisabled(creating));
});

test('space names are escaped', () => {
  const html = card(chooser({list: ready([space(1, {name: '<img src=x onerror=alert(1)>'})]), picked: `vu_${'1'.repeat(32)}`}));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('the card follows the Chinese locale', () => {
  setLocale('zh');
  try {
    const one = space(1, {name: '我的工作记忆'});
    const html = card(chooser({list: ready([one], 1), picked: one.vuId}));
    for (const text of ['开始一次投资人演示', '新建演示空间', '使用已有的空间', '你能写入的空间有 1 个。', '创建于 2026-11-20 14:30', '另有 1 个空间你只能查看', '会写进「我的工作记忆」', '开始演示']) {
      assert.ok(html.includes(text), text);
    }
  } finally {
    setLocale('en');
  }
});

test('a demo space with the default run name shows it in the page language, like the run bar', () => {
  const old = space(1, {demo: true, name: 'CoSens 演示 · 投资人 · 11-20 14:30'});
  const v = spaceChoiceView(chooser({list: ready([old]), picked: old.vuId}));
  assert.equal(v.items[0].name, 'CoSens Demo · Investor · 11-20 14:30');
  assert.match(v.warning, /"CoSens Demo · Investor · 11-20 14:30"/);
  assert.equal(spaceChoiceView(chooser({list: ready([space(2, {name: 'My own name'})])})).items[0].name, 'My own name');
});
