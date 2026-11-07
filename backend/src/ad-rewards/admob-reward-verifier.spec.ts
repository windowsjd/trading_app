import { AdMobRewardVerifier } from './admob-reward-verifier';
import { ADMOB_SESSION_EXPIRY_GRACE_MS } from './admob.config';

/**
 * The AdMob adapter reads the ad session; only a recorded Google reward event
 * (the SSV callback) is evidence. Every refusal is final except "not
 * confirmed yet", which is retryable and writes nothing.
 */
const SESSION = '0d5b8a43-6a1e-4c55-9d0b-4bbf8f6a1c2e';
const now = new Date('2026-11-07T10:00:00.000Z');
const session = (patch: Record<string, unknown> = {}) => ({
  id: SESSION,
  userId: 'user-1',
  tradingAccountId: 'account-1',
  provider: 'admob',
  purpose: 'funding',
  platform: 'android',
  idempotencyKey: 'ad_reward_claim_1',
  createdAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 60_000),
  ssvTransactionId: null,
  ssvVerifiedAt: null,
  ssvRewardedAt: null,
  ssvAdUnit: null,
  ssvKeyId: null,
  ssvRewardItem: null,
  ssvRewardAmount: null,
  ...patch,
});
const verifier = (row: ReturnType<typeof session> | null) =>
  new AdMobRewardVerifier(
    {
      adRewardSession: { findUnique: jest.fn(() => Promise.resolve(row)) },
    } as never,
    () => now,
  );
const request = (patch: Record<string, unknown> = {}) => ({
  provider: 'admob',
  proof: SESSION,
  expectedUserId: 'user-1',
  expectedTradingAccountId: 'account-1',
  expectedPurpose: 'funding' as const,
  commandKey: 'ad_reward_claim_1',
  ...patch,
});
const confirmed = {
  ssvTransactionId: '18fa792de1bca816048293fc71035638',
  ssvVerifiedAt: new Date(now.getTime() - 5_000),
  ssvRewardedAt: new Date(now.getTime() - 6_000),
  ssvAdUnit: '3165650506',
  ssvKeyId: '3335741209',
  ssvRewardItem: 'virtual_krw',
  ssvRewardAmount: '1',
};

describe('AdMobRewardVerifier', () => {
  it('a confirmed session is evidence: Google event id, the SESSION purpose, identifiers-only metadata', async () => {
    const result = await verifier(session(confirmed)).verify(request());
    expect(result).toEqual({
      ok: true,
      provider: 'admob',
      purpose: 'funding',
      providerEventId: '18fa792de1bca816048293fc71035638',
      occurredAt: confirmed.ssvRewardedAt,
      metadata: {
        sessionId: SESSION,
        platform: 'android',
        adUnit: '3165650506',
        keyId: '3335741209',
        rewardItem: 'virtual_krw',
        rewardAmount: '1',
      },
    });
    // A reset session reports its own purpose (the caller refuses it on a top-up).
    const reset = await verifier(
      session({ ...confirmed, purpose: 'account_reset' }),
    ).verify(request());
    expect(reset.ok && reset.purpose).toBe('account_reset');
  });

  it('not confirmed yet is retryable (nothing to write); final only after the expiry grace', async () => {
    expect(await verifier(session()).verify(request())).toMatchObject({
      ok: false,
      retryable: true,
      reasonCode: 'SSV_PENDING',
    });
    // Just past the callback deadline a callback may still be committing: still pending.
    const justExpired = session({ expiresAt: new Date(now.getTime() - 1) });
    expect(await verifier(justExpired).verify(request())).toMatchObject({
      ok: false,
      retryable: true,
      reasonCode: 'SSV_PENDING',
    });
    const expired = session({
      expiresAt: new Date(now.getTime() - ADMOB_SESSION_EXPIRY_GRACE_MS - 1),
    });
    const result = await verifier(expired).verify(request());
    expect(result).toMatchObject({ ok: false, reasonCode: 'SESSION_EXPIRED' });
    expect('retryable' in result && result.retryable).toBeFalsy();
  });

  it.each([
    ['another member', { expectedUserId: 'user-2' }],
    ['another account', { expectedTradingAccountId: 'account-2' }],
    ['another command key', { commandKey: 'ad_reward_claim_2' }],
  ])('refuses %s, finally', async (_label, patch) => {
    const result = await verifier(session(confirmed)).verify(request(patch));
    expect(result).toMatchObject({ ok: false, reasonCode: 'SESSION_MISMATCH' });
    expect('retryable' in result && result.retryable).toBeFalsy();
  });

  it('refuses a proof that is not an AdMob session', async () => {
    expect(await verifier(null).verify(request())).toMatchObject({
      ok: false,
      reasonCode: 'SESSION_NOT_FOUND',
    });
    expect(
      await verifier(session(confirmed)).verify(request({ proof: 'proof-1' })),
    ).toMatchObject({ ok: false, reasonCode: 'INVALID_PROOF' });
    expect(
      await verifier(session({ ...confirmed, provider: 'other' })).verify(
        request(),
      ),
    ).toMatchObject({ ok: false, reasonCode: 'SESSION_NOT_FOUND' });
  });
});
