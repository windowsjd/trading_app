import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { rewardSheetHarness, coded } = require('../../../test/rewardSheetHarness.cjs');

/** Small values only: request bodies and texts, never the rendered tree. */
const claimPath = '/trading-accounts/G/ad-rewards/claim';
const resetPath = '/trading-accounts/G/account-reset';

describe('general home 보상 sheet (자금 관리)', () => {
  it('without a rewarded-ad provider both rewards stay disabled under 광고 기능 준비 중 and nothing is sent', async (t) => {
    const h = rewardSheetHarness({ provider: null });
    await h.start(); t.after(h.close);
    assert.equal(h.has('reward-ad-notice'), true);
    assert.match(h.text(), /광고 기능 준비 중/);
    assert.match(h.text(), /가상자금 500만 원 추가/);
    assert.match(h.text(), /보상형 광고를 시청하면 일반계정에 가상자금 500만 원이 추가됩니다\./);
    assert.match(h.text(), /일반계정의 투자 상태를 초기화하고 가상자금 1,000만 원으로 다시 시작합니다\./);
    assert.equal(h.state('reward-funding-start'), 'disabled');
    assert.equal(h.state('reward-reset-start'), 'disabled');
    await h.press('reward-funding-start');
    assert.deepEqual([h.requests.length, h.sessions.length, h.shows.length, h.reads.length], [0, 0, 0, 0], 'no session, ad, command or read');
    // The test-only panel is gone (2026-11-07): no test-ad buttons in the sheet.
    assert.equal(/테스트 광고/.test(h.text()), false);
    assert.equal(h.has('reward-test-panel'), false);
  });

  it('a server without ads (the production default) keeps them disabled, even with a provider', async (t) => {
    const h = rewardSheetHarness({ funding: { enabled: false, provider: null, eligible: false, reason: 'AD_REWARD_DISABLED', rewardAmountKrw: null } });
    await h.start(); t.after(h.close);
    assert.match(h.text(), /광고 기능 준비 중/);
    assert.equal(h.state('reward-funding-start'), 'disabled');
    assert.equal(h.state('reward-reset-start'), 'disabled');
  });

  it('a top-up: a server session first, the ad with ITS verification options, then one claim with the session as proof', async (t) => {
    const h = rewardSheetHarness();
    await h.start(); t.after(h.close);
    assert.equal(h.has('reward-ad-notice'), false);
    assert.match(h.text(), /오늘 3회 더 받을 수 있습니다\./);
    await h.press('reward-funding-start');
    assert.equal(h.sessions.length, 1);
    const [session] = h.sessions;
    assert.deepEqual([session.accountId, session.purpose, session.platform], ['G', 'funding', 'android']);
    assert.match(session.idempotencyKey, /^ad_reward_claim_/);
    assert.equal(h.shows.length, 1);
    assert.deepEqual(h.shows[0].ssv, { userId: 'ssv-user-1', customData: 'session-1' });
    assert.deepEqual(h.requests, [{ path: claimPath, body: { provider: 'admob', proof: 'session-1', idempotencyKey: session.idempotencyKey } }]);
    assert.equal(h.has('reward-done'), true);
    assert.match(h.text(), /가상자금 500만 원이 추가되었습니다\./);
    const keys = h.invalidations.map((key: unknown[]) => key.slice(0, 3).join('/'));
    for (const key of ['tradingAccount/adRewards/G', 'tradingAccount/wallets/G', 'tradingAccount/portfolio/G'])
      assert.equal(keys.includes(key), true, key);
  });

  it('Google not confirmed yet: the SAME command is asked again until the server confirms — no second ad or session', async (t) => {
    const h = rewardSheetHarness({ pendingAnswers: 2, confirmWaitMs: 2_000 });
    await h.start(); t.after(h.close);
    await h.press('reward-funding-start');
    for (let i = 0; i < 20 && !h.has('reward-done'); i += 1) await h.flush();
    assert.equal(h.has('reward-done'), true);
    assert.equal(h.requests.length, 3, 'two pending answers, then the payout');
    assert.equal(new Set(h.requests.map((request: any) => JSON.stringify(request.body))).size, 1, 'one key and proof throughout');
    assert.deepEqual([h.sessions.length, h.shows.length], [1, 1]);
  });

  it('still not confirmed after the wait: 확인 대기, kept through closing and a remount, re-checked with the same key', async (t) => {
    const h = rewardSheetHarness({ pendingAnswers: 1_000, confirmWaitMs: 30 });
    await h.start(); t.after(h.close);
    await h.press('reward-funding-start');
    for (let i = 0; i < 10 && !h.has('reward-verifying'); i += 1) await h.flush();
    assert.equal(h.has('reward-verifying'), true);
    assert.match(h.text(), /광고 시청 확인을 기다리고 있어요\./);
    assert.match(h.text(), /자동으로 추가돼요\. 같은 광고로 두 번 지급되지 않아요\./);
    const firstBody = JSON.stringify(h.requests[0].body);
    // Closing keeps it and refreshes the money views (the server may have paid on Google's callback).
    const before = h.invalidations.length;
    await h.dismiss();
    assert.equal(h.closed, 1);
    assert.equal(h.invalidations.slice(before).some((key: unknown[]) => key.slice(0, 3).join('/') === 'tradingAccount/wallets/G'), true);
    await h.setVisible(false);
    // Home re-mounts the sheet (another account and back): the attempt is still there.
    await h.remount();
    await h.setVisible(true);
    for (let i = 0; i < 10 && !h.has('reward-verifying'); i += 1) await h.flush();
    assert.equal(h.has('reward-verifying'), true);
    // Google's confirmation arrives: 결과 확인 gets the payout with the same command.
    h.pendingAnswers = 0;
    await h.press('reward-verify-check');
    assert.equal(h.has('reward-done'), true);
    assert.equal(h.requests.every((request: any) => JSON.stringify(request.body) === firstBody), true, 'never a new key or proof');
    assert.deepEqual([h.sessions.length, h.shows.length], [1, 1], 'never a second ad');
  });

  it('watched to the end while Home re-mounted the sheet: its next opening asks with the same command, no second ad', async (t) => {
    const h = rewardSheetHarness();
    await h.start(); t.after(h.close);
    let release: () => void = () => undefined;
    h.showGate = new Promise<void>((resolve) => { release = resolve; });
    await h.press('reward-funding-start');
    assert.equal(h.shows.length, 1);
    // Home keys the sheet again while the ad is on screen; then the ad ends with its reward.
    await h.remount();
    release();
    await h.flush();
    assert.equal(h.requests.length, 0, 'the unmounted sheet sends nothing');
    await h.setVisible(false);
    await h.setVisible(true);
    for (let i = 0; i < 10 && !h.has('reward-done'); i += 1) await h.flush();
    assert.equal(h.has('reward-done'), true);
    assert.deepEqual(h.requests.map((request: any) => [request.body.proof, request.body.idempotencyKey]),
      [['session-1', h.sessions[0].idempotencyKey]]);
    assert.deepEqual([h.sessions.length, h.shows.length], [1, 1], 'never a second session or ad');
  });

  it('an answer that never arrived is re-checked with the SAME key and proof, never a new ad', async (t) => {
    const h = rewardSheetHarness();
    h.failures.push(Object.assign(new Error('timeout'), { code: 'ECONNABORTED', request: {} }));
    await h.start(); t.after(h.close);
    await h.press('reward-funding-start');
    assert.equal(h.has('reward-uncertain'), true);
    assert.match(h.text(), /결과를 확인하지 못했습니다\./);
    await h.press('reward-retry');
    assert.equal(h.shows.length, 1, 'no second ad');
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[1].body, h.requests[0].body);
    assert.equal(h.has('reward-done'), true);
  });

  it('a reset needs its own confirmation step before the session and the ad, then sends one reset command', async (t) => {
    const h = rewardSheetHarness();
    await h.start(); t.after(h.close);
    await h.press('reward-reset-start');
    assert.deepEqual([h.sessions.length, h.shows.length], [0, 0], 'nothing happens before the confirmation');
    assert.equal(h.has('reward-reset-confirm'), true);
    for (const line of [
      '일반계정의 투자 상태가 초기화됩니다.',
      '현재 가상자금이 1,000만 원으로 조정됩니다.',
      '보유 종목, 선물 포지션이나 미체결·조건 주문이 있으면 진행할 수 없습니다.',
      '과거 거래 기록은 그대로 보존됩니다.',
      '확인 후에는 되돌리기 어렵습니다.',
    ]) assert.equal(h.text().includes(line), true, line);
    await h.press('reward-reset-cancel');
    assert.equal(h.has('reward-reset-confirm'), false);
    await h.press('reward-reset-start');
    await h.press('reward-reset-run');
    assert.deepEqual([h.sessions[0].purpose, h.shows.length], ['account_reset', 1]);
    assert.match(h.sessions[0].idempotencyKey, /^account_reset_/);
    assert.deepEqual(h.requests, [{ path: resetPath, body: { provider: 'admob', proof: 'session-1', idempotencyKey: h.sessions[0].idempotencyKey } }]);
    assert.match(h.text(), /일반계정을 초기화했습니다\./);
    const keys = h.invalidations.map((key: unknown[]) => key.slice(0, 3).join('/'));
    for (const key of ['tradingAccount/adRewards/G', 'tradingAccount/wallets/G', 'tradingAccount/portfolio/G',
      'tradingAccount/positions/G', 'tradingAccount/orders/G', 'tradingAccount/futures/G'])
      assert.equal(keys.includes(key), true, key);
  });

  it('lists what blocks a reset, and keeps it closed while anything is held', async (t) => {
    const h = rewardSheetHarness({ reset: { eligible: false, reason: 'GENERAL_ACCOUNT_RESET_BLOCKED', blockers: ['SPOT_HOLDINGS', 'OPEN_ORDERS'] } });
    await h.start(); t.after(h.close);
    assert.equal(h.has('reward-reset-blockers'), true);
    assert.match(h.text(), /보유 중인 종목이 있습니다\./);
    assert.match(h.text(), /체결되지 않은 주문이 있습니다\./);
    assert.equal(h.state('reward-reset-start'), 'disabled');
    assert.equal(h.state('reward-funding-start'), 'enabled', 'the top-up is unaffected');
  });

  it('the server refusing the session (e.g. a reset blocked since) shows its reason; no ad is shown', async (t) => {
    const h = rewardSheetHarness();
    const refusal = coded(409, 'GENERAL_ACCOUNT_RESET_BLOCKED');
    h.sessionFailures.push(refusal);
    await h.start(); t.after(h.close);
    const readsBefore = h.reads.length;
    await h.press('reward-reset-start');
    await h.press('reward-reset-run');
    assert.equal(h.shows.length, 0, 'no ad for a reset that would be refused');
    assert.equal(h.requests.length, 0);
    assert.equal(h.has('reward-refused'), true);
    assert.match(h.text(), /일반계정을 초기화하지 못했습니다\./);
    assert.equal(h.notices()[0].props.error === refusal, true);
    assert.equal(h.reads.length > readsBefore, true, 'eligibility re-read');
  });

  it('a refused command is final for that attempt and re-reads eligibility', async (t) => {
    const h = rewardSheetHarness();
    const refusal = coded(422, 'AD_REWARD_VERIFICATION_FAILED');
    h.failures.push(refusal);
    await h.start(); t.after(h.close);
    const readsBefore = h.reads.length;
    await h.press('reward-funding-start');
    assert.equal(h.has('reward-uncertain'), false);
    assert.equal(h.has('reward-verifying'), false);
    assert.equal(h.has('reward-funding'), true, 'back on the menu with the refusal');
    assert.equal(h.reads.length > readsBefore, true);
    assert.match(h.text(), /가상자금을 추가하지 못했습니다\./);
    const notices = h.notices();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].props.error === refusal, true);
    assert.equal(notices[0].props.message === undefined, true, 'the server\'s own reason');
  });

  it('an early close, a failed load, a show failure and consent each say what happened and send no command', async (t) => {
    const cases = [
      [{ status: 'dismissed' }, 'reward-dismissed', /광고 시청이 완료되지 않아 아무것도 처리하지 않았습니다\./],
      [{ status: 'unavailable', reason: 'load' }, 'reward-ad-failed', /광고를 불러오지 못했어요\. 잠시 후 다시 시도해 주세요\. 가상자금과 계정은 그대로예요\./],
      [{ status: 'unavailable', reason: 'show' }, 'reward-ad-failed', /광고를 표시하지 못했어요\./],
      [{ status: 'unavailable', reason: 'consent' }, 'reward-ad-failed', /광고 개인정보 선택에 따라 지금은 광고를 표시할 수 없어요\./],
    ] as const;
    for (const [outcome, node, copy] of cases) {
      const h = rewardSheetHarness();
      h.adOutcome = outcome;
      await h.start(); t.after(h.close);
      await h.press('reward-funding-start');
      assert.equal(h.requests.length, 0, JSON.stringify(outcome));
      assert.equal(h.has(node), true, node);
      assert.match(h.text(), copy);
      assert.equal(h.state('reward-funding-start'), 'enabled', 'it may be tried again');
    }
  });

  it('while an ad is loading or showing, a second tap starts nothing; the button says it is busy', async (t) => {
    const h = rewardSheetHarness();
    let release: () => void = () => undefined;
    h.showGate = new Promise<void>((done) => { release = done; });
    await h.start(); t.after(h.close);
    const button = h.node('reward-funding-start');
    await h.press('reward-funding-start');
    // The stale button (pressed again before a re-render) and the fresh one.
    await (async () => { button.props.onPress(); await h.flush(); })();
    assert.equal(h.state('reward-funding-start'), 'loading');
    assert.equal(h.state('reward-reset-start'), 'disabled');
    assert.match(h.text(), /광고를 불러오고 있어요\./);
    assert.deepEqual([h.sessions.length, h.shows.length], [1, 1]);
    release();
    for (let i = 0; i < 10 && !h.has('reward-done'); i += 1) await h.flush();
    assert.deepEqual([h.sessions.length, h.shows.length, h.requests.length], [1, 1, 1]);
  });

  it('every other step starts over when the sheet hides (another tab, another account)', async (t) => {
    const h = rewardSheetHarness();
    await h.start(); t.after(h.close);
    await h.press('reward-funding-start');
    assert.equal(h.has('reward-done'), true);
    await h.setVisible(false);
    await h.setVisible(true);
    assert.equal(h.has('reward-done'), false);
    assert.equal(h.has('reward-funding'), true);
    await h.press('reward-reset-start');
    assert.equal(h.has('reward-reset-confirm'), true);
    await h.setVisible(false);
    await h.setVisible(true);
    assert.equal(h.has('reward-reset-confirm'), false);
  });

  it('Google\'s privacy options entry appears only when its consent asks for one', async (t) => {
    const none = rewardSheetHarness();
    await none.start(); t.after(none.close);
    assert.equal(none.has('reward-ads-privacy'), false);
    const required = rewardSheetHarness({ adsReady: { canRequestAds: true, privacyOptionsRequired: true } });
    await required.start(); t.after(required.close);
    assert.equal(required.has('reward-ads-privacy'), true);
    await required.press('reward-ads-privacy');
    assert.equal(required.privacyOpened, 1);
  });
});
