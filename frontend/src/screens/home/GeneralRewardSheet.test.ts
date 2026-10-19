import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { rewardSheetHarness } = require('../../../test/rewardSheetHarness.cjs');

describe('general home 보상 sheet (자금 관리)', () => {
  it('without a rewarded-ad SDK both rewards stay disabled under 광고 기능 준비 중 and nothing is sent', async (t) => {
    const h = rewardSheetHarness({ provider: null });
    await h.start(); t.after(h.close);
    assert.equal(h.node('reward-ad-notice') === undefined, false);
    assert.match(h.text(), /광고 기능 준비 중/);
    assert.match(h.text(), /가상자금 500만 원 추가/);
    assert.match(h.text(), /보상형 광고를 시청하면 일반계정에 가상자금 500만 원이 추가됩니다\./);
    assert.match(h.text(), /일반계정 초기화/);
    assert.match(h.text(), /일반계정의 투자 상태를 초기화하고 가상자금 1,000만 원으로 다시 시작합니다\./);
    assert.equal(h.state('reward-funding-start'), 'disabled');
    assert.equal(h.state('reward-reset-start'), 'disabled');
    await h.press('reward-funding-start');
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.shows, []);
    // Not even the eligibility reads: nothing reaches the server.
    assert.deepEqual(h.reads, []);
    assert.equal(h.node('reward-reset-blockers') === undefined, true);
  });

  it('a server without ads (the production default) also keeps them disabled, even with a provider', async (t) => {
    const h = rewardSheetHarness({ funding: { enabled: false, provider: null, eligible: false, reason: 'AD_REWARD_DISABLED', rewardAmountKrw: null } });
    await h.start(); t.after(h.close);
    assert.match(h.text(), /광고 기능 준비 중/);
    assert.match(h.text(), /가상자금 500만 원 추가/, 'the product amount when the server sends none');
    assert.equal(h.state('reward-funding-start'), 'disabled');
    assert.equal(h.state('reward-reset-start'), 'disabled');
  });

  it('a verified top-up: one ad for funding, its proof and a fresh key are sent once, and money views refresh', async (t) => {
    const h = rewardSheetHarness();
    await h.start(); t.after(h.close);
    assert.equal(h.node('reward-ad-notice') === undefined, true);
    assert.match(h.text(), /오늘 3회 더 받을 수 있습니다\./);
    await h.press('reward-funding-start');
    assert.equal(h.shows.length, 1);
    assert.equal(h.shows[0].purpose, 'funding');
    assert.equal(h.shows[0].tradingAccountId, 'G');
    assert.deepEqual(h.requests, [{ path: '/trading-accounts/G/ad-rewards/claim',
      body: { provider: 'test-ads', proof: 'proof-1', idempotencyKey: h.shows[0].idempotencyKey } }]);
    assert.match(h.shows[0].idempotencyKey, /^ad_reward_claim_/);
    assert.equal(h.node('reward-done') === undefined, false);
    assert.match(h.text(), /가상자금 500만 원이 추가되었습니다\./);
    const keys = h.invalidations.map((key: unknown[]) => key.slice(0, 3).join('/'));
    for (const key of ['tradingAccount/adRewards/G', 'tradingAccount/wallets/G', 'tradingAccount/portfolio/G'])
      assert.equal(keys.includes(key), true, key);
  });

  it('an answer that never arrived is re-checked with the SAME key and proof, never a new ad', async (t) => {
    const h = rewardSheetHarness();
    h.failures.push(Object.assign(new Error('timeout'), { code: 'ECONNABORTED', request: {} }));
    await h.start(); t.after(h.close);
    await h.press('reward-funding-start');
    assert.equal(h.node('reward-uncertain') === undefined, false);
    assert.match(h.text(), /결과를 확인하지 못했습니다\./);
    await h.press('reward-retry');
    assert.equal(h.shows.length, 1, 'no second ad');
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[1].body, h.requests[0].body);
    assert.equal(h.node('reward-done') === undefined, false);
  });

  it('a reset needs its own confirmation step before the ad, then sends one reset command', async (t) => {
    const h = rewardSheetHarness();
    await h.start(); t.after(h.close);
    await h.press('reward-reset-start');
    assert.equal(h.shows.length, 0, 'nothing happens before the confirmation');
    assert.equal(h.node('reward-reset-confirm') === undefined, false);
    for (const line of [
      '일반계정의 투자 상태가 초기화됩니다.',
      '현재 가상자금이 1,000만 원으로 조정됩니다.',
      '보유 종목, 선물 포지션이나 미체결·조건 주문이 있으면 진행할 수 없습니다.',
      '과거 거래 기록은 그대로 보존됩니다.',
      '확인 후에는 되돌리기 어렵습니다.',
    ]) assert.equal(h.text().includes(line), true, line);
    await h.press('reward-reset-cancel');
    assert.equal(h.node('reward-reset-confirm') === undefined, true);
    await h.press('reward-reset-start');
    await h.press('reward-reset-run');
    assert.equal(h.shows.length, 1);
    assert.equal(h.shows[0].purpose, 'account_reset');
    assert.match(h.shows[0].idempotencyKey, /^account_reset_/);
    assert.deepEqual(h.requests, [{ path: '/trading-accounts/G/account-reset',
      body: { provider: 'test-ads', proof: 'proof-1', idempotencyKey: h.shows[0].idempotencyKey } }]);
    assert.match(h.text(), /일반계정을 초기화했습니다\./);
    const keys = h.invalidations.map((key: unknown[]) => key.slice(0, 3).join('/'));
    for (const key of ['tradingAccount/adRewards/G', 'tradingAccount/wallets/G', 'tradingAccount/portfolio/G',
      'tradingAccount/positions/G', 'tradingAccount/orders/G', 'tradingAccount/futures/G'])
      assert.equal(keys.includes(key), true, key);
  });

  it('lists what blocks a reset, and keeps it closed while anything is held', async (t) => {
    const h = rewardSheetHarness({ reset: { eligible: false, reason: 'GENERAL_ACCOUNT_RESET_BLOCKED', blockers: ['SPOT_HOLDINGS', 'OPEN_ORDERS'] } });
    await h.start(); t.after(h.close);
    assert.equal(h.node('reward-reset-blockers') === undefined, false);
    assert.match(h.text(), /보유 중인 종목이 있습니다\./);
    assert.match(h.text(), /체결되지 않은 주문이 있습니다\./);
    assert.equal(h.state('reward-reset-start'), 'disabled');
    assert.equal(h.state('reward-funding-start'), 'enabled', 'the top-up is unaffected');
  });

  it('a refused command is final for that attempt and re-reads eligibility; a skipped ad sends nothing', async (t) => {
    const h = rewardSheetHarness();
    const refusal = Object.assign(new Error('blocked'), { response: { status: 409, data: { error: { code: 'GENERAL_ACCOUNT_RESET_BLOCKED' } } } });
    h.failures.push(refusal);
    await h.start(); t.after(h.close);
    const readsBefore = h.reads.length;
    await h.press('reward-reset-start');
    await h.press('reward-reset-run');
    assert.equal(h.node('reward-uncertain') === undefined, true);
    assert.equal(h.node('reward-reset') === undefined, false, 'back on the menu with the refusal');
    assert.equal(h.reads.length > readsBefore, true, 'eligibility re-read');
    // The heading says what failed; the server's own reason follows (no override).
    assert.equal(h.node('reward-refused') === undefined, false);
    assert.match(h.text(), /일반계정을 초기화하지 못했습니다\./);
    const notices = h.notices();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].props.error === refusal, true);
    assert.equal(notices[0].props.message === undefined, true);

    h.adOutcome = { status: 'dismissed' };
    await h.press('reward-funding-start');
    assert.equal(h.requests.length, 1, 'no command for an ad that was not completed');
    assert.equal(h.node('reward-dismissed') === undefined, false);
  });

  it('an unresolved attempt survives closing: money views refresh and reopening re-checks with the same key', async (t) => {
    const h = rewardSheetHarness();
    h.failures.push(Object.assign(new Error('timeout'), { code: 'ECONNABORTED', request: {} }));
    await h.start(); t.after(h.close);
    await h.press('reward-funding-start');
    assert.equal(h.node('reward-uncertain') === undefined, false);
    const before = h.invalidations.length;
    await h.dismiss();
    assert.equal(h.closed, 1);
    const keys = h.invalidations.slice(before).map((key: unknown[]) => key.slice(0, 3).join('/'));
    for (const key of ['tradingAccount/wallets/G', 'tradingAccount/portfolio/G'])
      assert.equal(keys.includes(key), true, key);
    await h.setVisible(false);
    await h.setVisible(true);
    assert.equal(h.node('reward-uncertain') === undefined, false, 'still waiting for its re-check');
    await h.press('reward-retry');
    assert.equal(h.shows.length, 1, 'no second ad');
    assert.deepEqual(h.requests[1].body, h.requests[0].body);
    assert.equal(h.node('reward-done') === undefined, false);
  });

  it('every other step starts over when the sheet hides (another tab, another account)', async (t) => {
    const h = rewardSheetHarness();
    await h.start(); t.after(h.close);
    await h.press('reward-funding-start');
    assert.equal(h.node('reward-done') === undefined, false);
    await h.setVisible(false);
    await h.setVisible(true);
    assert.equal(h.node('reward-done') === undefined, true);
    assert.equal(h.node('reward-funding') === undefined, false);
    await h.press('reward-reset-start');
    assert.equal(h.node('reward-reset-confirm') === undefined, false);
    await h.setVisible(false);
    await h.setVisible(true);
    assert.equal(h.node('reward-reset-confirm') === undefined, true);
  });
});
