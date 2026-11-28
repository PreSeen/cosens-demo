import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../apps/demo/src/lib/api.ts';

test('a status poll carries a deadline, and a timed-out poll is an error the page retries', async t => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push(init.signal);
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  await assert.rejects(api.getRun('run_x'), err => err.code === 'network_error');
  assert.ok(seen[0] instanceof AbortSignal);
});

test('step 3 asks for memory searches in the language of the BP, whatever the page language', async () => {
  const {systemPrompt, toolsFor} = await import('../server/demo/investor/prompts.mjs');
  assert.match(systemPrompt('BP', 'en'), /written in the language the BP is written in/);
  assert.match(systemPrompt('BP', 'zh'), /问句用 BP 原文的语言写/);
  assert.match(toolsFor('en')[0].function.parameters.properties.query.description, /language the BP is written in/);
});
