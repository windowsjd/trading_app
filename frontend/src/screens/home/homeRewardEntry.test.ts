import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { setup, account, flush, act } = require('../../../test/homeDiscoveryHarness.cjs');

// The general home's 보상 entry (2026-10-20): the header button and the sheet
// it opens. The sheet's own behaviour is GeneralRewardSheet.test.ts.
const sheets = (h: any) => h.renderer.root.findAll((node: any) => node.type === 'GeneralRewardSheet');
const headerRight = (h: any) => h.headerOptions.at(-1)?.headerRight;

it('보상 sits in the header for a general account only; leaving Home or the account closes its sheet', async t => {
  const h = setup('general', 0); t.after(h.close); await flush();
  assert.equal(typeof headerRight(h), 'function');
  assert.equal(sheets(h).length, 1);
  assert.equal(sheets(h)[0].props.visible, false);
  const button = headerRight(h)();
  assert.equal(button.type, 'HomeRewardButton');
  act(() => button.props.onPress()); await flush();
  assert.equal(sheets(h)[0].props.visible, true);
  assert.equal(sheets(h)[0].props.account.id, 'general');

  // Another tab: closed, and still closed on return (nothing reopens by itself).
  await h.setFocused(false);
  assert.equal(sheets(h)[0].props.visible, false);
  await h.setFocused(true);
  assert.equal(sheets(h)[0].props.visible, false);

  // Season and beginner accounts have no 보상 entry at all.
  act(() => headerRight(h)().props.onPress()); await flush();
  assert.equal(sheets(h)[0].props.visible, true);
  await h.switch(account('season'));
  assert.equal(headerRight(h) === undefined, true);
  assert.equal(sheets(h).length, 0);
  await h.switch(account('beginner'));
  assert.equal(headerRight(h) === undefined, true);
  assert.equal(sheets(h).length, 0);
  // Back on the general account: the sheet does not reappear open.
  await h.switch(account('general'));
  assert.equal(typeof headerRight(h), 'function');
  assert.equal(sheets(h)[0].props.visible, false);
});
