import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { rewardSheetHarness } = require('../../../test/rewardSheetHarness.cjs');

test('the general reward sheet runs a test ad without any eligibility read, financial command, cache change or reward-success UI', async (t) => {
  const h = rewardSheetHarness({ provider: null, testAds: true });
  await h.start(); t.after(h.close);
  assert.equal(h.node('reward-test-panel') !== undefined, true);
  assert.equal(h.testImports, 0);
  assert.equal(h.state('reward-test-show'), 'disabled');
  assert.equal(h.state('reward-funding-start'), 'disabled');
  assert.equal(h.state('reward-reset-start'), 'disabled');
  await h.press('reward-test-show'); assert.equal(h.testAds.length, 0);
  await h.press('reward-test-load');
  assert.equal(h.testAds.length, 1); assert.equal(h.state('reward-test-show'), 'disabled');
  await h.emitTest('loaded'); assert.equal(h.state('reward-test-show'), 'enabled');
  await h.press('reward-test-show'); await h.press('reward-test-show');
  assert.equal(h.testAds[0].shows, 1);
  await h.emitTest('opened'); await h.emitTest('earned');
  assert.match(h.text(), /보상 이벤트를 수신/);
  assert.equal(h.node('reward-done') === undefined, true);
  await h.emitTest('closed'); assert.match(h.text(), /테스트 광고 시청 완료/);
  assert.equal(h.node('reward-done') === undefined, true);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.invalidations, []);
  assert.deepEqual(h.shows, [], 'no proof-producing provider ever runs');
  assert.equal(h.state('reward-funding-start'), 'disabled');
  assert.equal(h.state('reward-reset-start'), 'disabled');
});

test('early close, load error, display error and SDK failure do not become financial success', async (t) => {
  for (const kind of ['early', 'load', 'show', 'sdk']) {
    const h = rewardSheetHarness({ provider: null, testAds: true, showTestFailure: kind === 'show', testInitFailure: kind === 'sdk' });
    await h.start(); t.after(h.close);
    await h.press('reward-test-load');
    if (kind === 'load') await h.emitTest('error');
    else if (kind !== 'sdk') {
      await h.emitTest('loaded'); await h.press('reward-test-show');
      if (kind === 'early') { await h.emitTest('opened'); await h.emitTest('closed'); }
    }
    assert.match(h.text(), kind === 'early' ? /시청 완료 전에 종료/ : kind === 'load' ? /불러오지 못했습니다/ : kind === 'show' ? /표시하지 못했습니다/ : /SDK를 준비하지 못했습니다/);
    assert.equal(h.node('reward-done') === undefined, true);
    assert.equal(h.node('reward-funding') !== undefined, true, 'the normal sheet remains usable');
    assert.deepEqual(h.requests, []); assert.deepEqual(h.invalidations, []);
  }
});

test('hiding or changing the account discards the ad and ignores old-account events', async (t) => {
  const h = rewardSheetHarness({ provider: null, testAds: true });
  await h.start(); t.after(h.close);
  await h.press('reward-test-load'); await h.emitTest('loaded');
  await h.setVisible(false);
  assert.equal(h.testAds[0].disposed, true);
  await h.emitTest('earned', 0); await h.emitTest('closed', 0);
  await h.setVisible(true);
  assert.equal(h.state('reward-test-show'), 'disabled');
  await h.press('reward-test-load'); await h.emitTest('loaded');
  h.accountId = 'G2'; await h.update();
  assert.equal(h.testAds[1].disposed, true);
  assert.equal(h.state('reward-test-show'), 'disabled');
  await h.emitTest('earned', 1); await h.emitTest('closed', 1);
  assert.doesNotMatch(h.text(), /테스트 광고 시청 완료/);
  assert.deepEqual(h.requests, []); assert.deepEqual(h.invalidations, []);
});

test('production/unsupported builds and season/beginner accounts do not expose the test panel', async (t) => {
  for (const mode of ['general', 'season', 'beginner']) {
    const h = rewardSheetHarness({ provider: null, testAds: mode !== 'general' });
    h.mode = mode;
    await h.start(); t.after(h.close);
    assert.equal(h.node('reward-test-panel') === undefined, true);
    assert.equal(h.testImports, 0); assert.deepEqual(h.requests, []);
  }
});

test('logout unmounts the test session; native callbacks after logout cannot issue financial requests', async () => {
  const h = rewardSheetHarness({ provider: null, testAds: true });
  await h.start();
  await h.press('reward-test-load'); await h.emitTest('loaded'); await h.press('reward-test-show'); await h.emitTest('opened');
  await h.close();
  assert.equal(h.testAds[0].disposed, true);
  await h.emitTest('earned'); await h.emitTest('closed');
  assert.deepEqual(h.requests, []); assert.deepEqual(h.invalidations, []);
  assert.equal(h.testAds[0].shows, 1);
});
