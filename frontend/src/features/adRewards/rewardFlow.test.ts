import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyRewardCommandFailure,
  forgetRewardAttempt,
  formatManwon,
  rememberedRewardAttempt,
  rememberRewardAttempt,
  rewardSheetState,
} from './rewardFlow.ts';
import { getRewardedAdProvider } from './rewardedAd.ts';

const funding = (overrides: Record<string, unknown> = {}) => ({
  tradingAccountId: 'G', enabled: true, provider: 'ads', eligible: true, reason: null,
  rewardAmountKrw: '5000000.00000000', grantedCountToday: 1, grantedAmountTodayKrw: '5000000.00000000',
  remainingCountToday: 2, remainingAmountTodayKrw: '10000000.00000000', nextEligibleAt: null, ...overrides,
}) as never;
const reset = (overrides: Record<string, unknown> = {}) => ({
  tradingAccountId: 'G', enabled: true, provider: 'ads', eligible: true, reason: null, blockers: [],
  targetKrwBalance: '10000000.00000000', resetCount: 0, lastResetAt: null, ...overrides,
}) as never;

describe('the device never authorizes a financial command (AdMob SSV, 2026-11-07)', () => {
  it('web/Node/Expo Go hosts have no provider at all', () => {
    assert.equal(getRewardedAdProvider(), null);
  });

  it('the AdMob provider yields no proof: its only "success" is earned, and the server decides', () => {
    for (const file of ['rewardedAd.ts', 'rewardedAd.native.ts', 'rewardedAdTypes.ts']) {
      const source = readFileSync(path.join(process.cwd(), 'src/features/adRewards', file), 'utf8').replace(/\/\/.*$/gmu, '');
      assert.equal(/status:\s*'completed'|proof:/u.test(source), false, file);
    }
    // The SSV options come from the server session; the app never invents them.
    const native = readFileSync(path.join(process.cwd(), 'src/features/adRewards/rewardedAd.native.ts'), 'utf8');
    assert.match(native, /serverSideVerificationOptions: \{ userId: ssv\.userId, customData: ssv\.customData \}/);
    assert.match(native, /requestNonPersonalizedAdsOnly: true/);
  });
});

describe('보상 sheet rules', () => {
  it('formats the server amount in 만 원', () => {
    assert.equal(formatManwon('5000000.00000000'), '500만 원');
    assert.equal(formatManwon('10000000'), '1,000만 원');
    assert.equal(formatManwon('12345'), '12,345원');
    assert.equal(formatManwon(null), '-');
  });

  it('opens nothing without a device provider or a server that can verify ads', () => {
    for (const state of [
      rewardSheetState({ providerReady: false, funding: funding(), reset: reset() }),
      rewardSheetState({ providerReady: true, funding: funding({ enabled: false, eligible: false, reason: 'AD_REWARD_DISABLED' }), reset: reset() }),
      rewardSheetState({ providerReady: true, funding: funding({ eligible: false, reason: 'AD_REWARD_PROVIDER_UNAVAILABLE' }), reset: reset() }),
      rewardSheetState({ providerReady: true, funding: undefined, reset: undefined }),
    ]) {
      assert.equal(state.adReady, false);
      assert.equal(state.notice, '광고 기능 준비 중');
      assert.equal(state.funding.canStart, false);
      assert.equal(state.reset.canStart, false);
    }
  });

  it('with ads ready: the top-up follows its limits, a reset its blockers', () => {
    const ready = rewardSheetState({ providerReady: true, funding: funding(), reset: reset() });
    assert.equal(ready.notice, null);
    assert.equal(ready.funding.canStart, true);
    assert.equal(ready.funding.status, '오늘 2회 더 받을 수 있습니다.');
    assert.equal(ready.reset.canStart, true);

    const limited = rewardSheetState({ providerReady: true,
      funding: funding({ eligible: false, reason: 'AD_REWARD_DAILY_COUNT_LIMIT', remainingCountToday: 0 }), reset: reset() });
    assert.equal(limited.funding.canStart, false);
    assert.equal(limited.funding.status, '오늘 받을 수 있는 가상자금을 모두 받았습니다.');
    assert.equal(limited.reset.canStart, true, 'a reset is not a top-up');

    const cooling = rewardSheetState({ providerReady: true,
      funding: funding({ eligible: false, reason: 'AD_REWARD_COOLDOWN_ACTIVE', nextEligibleAt: '2026-10-20T03:05:00.000Z' }), reset: reset() });
    assert.equal(cooling.funding.status, '12:05 이후 다시 받을 수 있습니다.');
    // Just after KST midnight reads 00:05 on every engine (never 24:05).
    const midnight = rewardSheetState({ providerReady: true,
      funding: funding({ eligible: false, reason: 'AD_REWARD_COOLDOWN_ACTIVE', nextEligibleAt: '2026-10-19T15:05:00.000Z' }), reset: reset() });
    assert.equal(midnight.funding.status, '00:05 이후 다시 받을 수 있습니다.');

    const unvalued = rewardSheetState({ providerReady: true, funding: funding(),
      reset: reset({ eligible: false, reason: 'GENERAL_ACCOUNT_RESET_UNAVAILABLE' }) });
    assert.equal(unvalued.reset.canStart, false);
    assert.equal(unvalued.reset.status, '환율 정보를 확인할 수 없어 지금은 초기화할 수 없습니다. 잠시 후 다시 시도해주세요.');

    const blocked = rewardSheetState({ providerReady: true, funding: funding(),
      reset: reset({ eligible: false, reason: 'GENERAL_ACCOUNT_RESET_BLOCKED', blockers: ['FUTURES_POSITIONS', 'RESERVED_FUNDS'] }) });
    assert.equal(blocked.reset.canStart, false);
    assert.deepEqual(blocked.reset.blockers, ['열려 있는 선물 포지션이 있습니다.', '주문에 묶인 자금이 있습니다.']);
  });

  it('no daily cap configured (remaining null): no countdown line, still startable', () => {
    const unlimited = rewardSheetState({ providerReady: true,
      funding: funding({ remainingCountToday: null, remainingAmountTodayKrw: null, grantedCountToday: 12 }), reset: reset() });
    assert.equal(unlimited.funding.canStart, true);
    assert.equal(unlimited.funding.status, null);
  });

  it('"not confirmed yet" is pending (ask the same command again), never a refusal or a new ad', () => {
    assert.equal(classifyRewardCommandFailure({ response: { status: 409, data: { error: { code: 'AD_REWARD_VERIFICATION_PENDING' } } } }), 'pending');
    assert.equal(classifyRewardCommandFailure({ response: { status: 422, data: { error: { code: 'AD_REWARD_VERIFICATION_FAILED' } } } }), 'refused');
  });

  it('open attempts are kept per sign-in and account, and only their own key forgets them', () => {
    const attempt = { purpose: 'funding' as const, idempotencyKey: 'k1', proof: 's1', providerKey: 'admob' };
    rememberRewardAttempt('1:G', attempt);
    assert.equal(rememberedRewardAttempt('1:G')?.idempotencyKey, 'k1');
    assert.equal(rememberedRewardAttempt('1:H') === null, true, 'another account');
    assert.equal(rememberedRewardAttempt('2:G') === null, true, 'another sign-in');
    forgetRewardAttempt('1:G', { ...attempt, idempotencyKey: 'k2' });
    assert.equal(rememberedRewardAttempt('1:G')?.idempotencyKey, 'k1');
    forgetRewardAttempt('1:G', attempt);
    assert.equal(rememberedRewardAttempt('1:G') === null, true);
  });

  it('only an answer that never arrived is uncertain (re-check with the same key)', () => {
    assert.equal(classifyRewardCommandFailure(Object.assign(new Error('x'), { code: 'ERR_NETWORK', request: {} })), 'uncertain');
    assert.equal(classifyRewardCommandFailure({ response: { status: 502, data: {} } }), 'uncertain');
    assert.equal(classifyRewardCommandFailure({ response: { status: 500, data: { error: { code: 'INTERNAL_SERVER_ERROR' } } } }), 'uncertain');
    assert.equal(classifyRewardCommandFailure({ response: { status: 409, data: { error: { code: 'GENERAL_ACCOUNT_RESET_BLOCKED' } } } }), 'refused');
    assert.equal(classifyRewardCommandFailure({ response: { status: 503, data: { error: { code: 'AD_REWARD_DISABLED' } } } }), 'refused');
    assert.equal(classifyRewardCommandFailure({ response: { status: 500, data: { error: { code: 'GENERAL_ACCOUNT_INTEGRITY' } } } }), 'refused');
    assert.equal(classifyRewardCommandFailure({ response: { status: 422, data: {} } }), 'refused');
  });
});
