import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { setup, account, flush, act } = require('../../../test/homeDiscoveryHarness.cjs');

// Home's header (2026-11-07): the mode title at the left, the mode's buttons
// at the right; the general home's 보상 opens its sheet. The sheet's own
// behaviour is GeneralRewardSheet.test.ts, the buttons' homeHeader.test.ts.
const sheets = (h: any) => h.renderer.root.findAll((node: any) => node.type === 'GeneralRewardSheet');
const header = (h: any) => h.headerOptions.at(-1) ?? {};
const actions = (h: any) => header(h).headerRight?.();

it('보상 sits in the header for a general account only; leaving Home or the account closes its sheet', async t => {
  const h = setup('general', 0); t.after(h.close); await flush();
  assert.equal(actions(h).type, 'HomeHeaderActions');
  assert.equal(actions(h).props.mode, 'general');
  assert.equal(sheets(h).length, 1);
  assert.equal(sheets(h)[0].props.visible, false);
  act(() => actions(h).props.onReward()); await flush();
  assert.equal(sheets(h)[0].props.visible, true);
  assert.equal(sheets(h)[0].props.account.id, 'general');

  // Another tab: closed, and still closed on return (nothing reopens by itself).
  await h.setFocused(false);
  assert.equal(sheets(h)[0].props.visible, false);
  await h.setFocused(true);
  assert.equal(sheets(h)[0].props.visible, false);

  // Season accounts have no header buttons; beginner accounts have 퀘스트 but no 보상.
  act(() => actions(h).props.onReward()); await flush();
  assert.equal(sheets(h)[0].props.visible, true);
  await h.switch(account('season'));
  assert.equal(header(h).headerRight === undefined, true);
  assert.equal(sheets(h).length, 0);
  await h.switch(account('beginner'));
  assert.equal(actions(h).props.mode, 'beginner');
  assert.equal(actions(h).props.onReward === undefined, true);
  assert.equal(sheets(h).length, 0);
  // Back on the general account: the sheet does not reappear open.
  await h.switch(account('general'));
  assert.equal(actions(h).props.mode, 'general');
  assert.equal(sheets(h)[0].props.visible, false);
});

it('the mode title replaces the 홈 title, keyed by the account; without an account only 홈 stays', async t => {
  const h = setup('season', 0); t.after(h.close); await flush();
  const left = header(h).headerLeft();
  assert.equal(left.type, 'HomeHeaderTitle');
  assert.equal(left.key, 'season');
  assert.equal(left.props.mode, 'season');
  assert.equal(header(h).headerTitle() === null, true);
  await h.switch(account('general', 'general-2'));
  assert.equal(header(h).headerLeft().key, 'general-2');
  assert.equal(header(h).headerLeft().props.mode, 'general');
  await h.switch(null);
  assert.equal(header(h).headerLeft === undefined, true);
  assert.equal(header(h).headerRight === undefined, true);
  assert.equal(header(h).headerTitle === undefined, true, 'the stack’s 홈 title');
});
