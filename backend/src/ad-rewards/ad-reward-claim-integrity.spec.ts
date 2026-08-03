jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AdRewardClaimStatus: {
      pending: 'pending',
      verified: 'verified',
      granted: 'granted',
      rejected: 'rejected',
      failed: 'failed',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    SnapshotReason: {
      scheduled: 'scheduled',
      general_account_open: 'general_account_open',
      performance_baseline: 'performance_baseline',
      external_funding_before: 'external_funding_before',
      external_funding_after: 'external_funding_after',
    },
    WalletTransactionDirection: { credit: 'credit', debit: 'debit' },
    WalletTransactionReferenceType: {
      general_account_open: 'general_account_open',
      ad_reward_claim: 'ad_reward_claim',
      order: 'order',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      ad_reward: 'ad_reward',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  assertKeyedGrantedClaimBoundaryIntegrity,
  assertStoredGrantedResponse,
  assertStoredRejectedResponse,
  type StoredClaimForIntegrity,
} from './ad-reward-claim-integrity';

const d = (value: string) => new Prisma.Decimal(value);

const CLAIM_ID = 'claim-1';
const ACCOUNT_ID = 'account-1';
const REWARD = '50000';

function grantedClaim(
  overrides: Partial<StoredClaimForIntegrity> = {},
): StoredClaimForIntegrity {
  return {
    id: CLAIM_ID,
    userId: 'user-1',
    tradingAccountId: ACCOUNT_ID,
    status: 'granted',
    rewardAmountKrw: d(REWARD),
    grantedAt: new Date('2026-08-04T02:00:00.000Z'),
    rejectedAt: null,
    failureCode: null,
    failureReason: null,
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    responsePayloadJson: null,
    walletTransactionId: 'ledger-1',
    walletTransaction: null,
    ...overrides,
  };
}

function boundary(overrides: {
  reason: 'external_funding_before' | 'external_funding_after';
  totalAssetKrw: string;
  cumulativeExternalFundingKrw: string;
  tradingAccountId?: string | null;
  seasonParticipantId?: string | null;
  externalFundingAmountKrw?: string | null;
  externalFundingReferenceType?: string;
  timeWeightedReturnFactor?: string;
  returnRate?: string;
  investmentPnlKrw?: string;
}) {
  const total = d(overrides.totalAssetKrw);
  const funding = d(overrides.cumulativeExternalFundingKrw);

  return {
    id: `snapshot-${overrides.reason}`,
    seasonParticipantId: overrides.seasonParticipantId ?? null,
    tradingAccountId:
      overrides.tradingAccountId === undefined
        ? ACCOUNT_ID
        : overrides.tradingAccountId,
    snapshotReason: overrides.reason,
    totalAssetKrw: total,
    returnRate: d(overrides.returnRate ?? '0'),
    cumulativeExternalFundingKrw: funding,
    investmentPnlKrw:
      overrides.investmentPnlKrw === undefined
        ? total.sub(funding)
        : d(overrides.investmentPnlKrw),
    timeWeightedReturnFactor: d(overrides.timeWeightedReturnFactor ?? '1'),
    externalFundingAmountKrw:
      overrides.externalFundingAmountKrw === null
        ? null
        : d(overrides.externalFundingAmountKrw ?? REWARD),
    externalFundingReferenceType:
      overrides.externalFundingReferenceType ?? 'ad_reward_claim',
  };
}

function healthyPair() {
  return [
    boundary({
      reason: 'external_funding_before',
      totalAssetKrw: '10000000',
      cumulativeExternalFundingKrw: '10000000',
    }),
    boundary({
      reason: 'external_funding_after',
      totalAssetKrw: '10050000',
      cumulativeExternalFundingKrw: '10050000',
    }),
  ];
}

function client(rows: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  return {
    findMany,
    client: { equitySnapshot: { findMany } } as never,
  };
}

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(HttpException);
  const response = (error as HttpException).getResponse() as {
    error: { code: string };
  };
  return response.error.code;
}

async function expectRejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return errorCode(error);
  }
  throw new Error('expected the call to reject');
}

function expectThrownCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    return errorCode(error);
  }
  throw new Error('expected the call to throw');
}

/**
 * 작업 6 보완 4. These checks are what stop a replay from confirming a payout
 * whose performance boundary is missing or wrong — the failure that would
 * otherwise turn an ad reward into investment profit on the next TWR advance.
 */
describe('keyed granted claim boundary integrity', () => {
  it('accepts a complete, performance-neutral pair', async () => {
    const { client: db } = client(healthyPair());

    await expect(
      assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
    ).resolves.toBeUndefined();
  });

  it('never looks for a boundary on an UNKEYED pre-작업 7 claim', async () => {
    const { client: db, findMany } = client([]);

    await expect(
      assertKeyedGrantedClaimBoundaryIntegrity(
        db,
        grantedClaim({ idempotencyKey: null }),
      ),
    ).resolves.toBeUndefined();
    // Not merely "does not throw": it must not even ask, because a missing
    // pair is the EXPECTED state for those claims and must not be fabricated.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses a claim whose before row is missing', async () => {
    const { client: db } = client([healthyPair()[1]]);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a claim whose after row is missing', async () => {
    const { client: db } = client([healthyPair()[0]]);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a stray row that references the claim under another reason', async () => {
    const rows = [
      ...healthyPair(),
      boundary({
        reason: 'external_funding_after',
        totalAssetKrw: '10050000',
        cumulativeExternalFundingKrw: '10050000',
        externalFundingReferenceType: 'ad_reward_claim',
      }),
    ];
    rows[2] = { ...rows[2], id: 'snapshot-duplicate' };
    const { client: db } = client(rows);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a boundary whose amount is not the claim reward', async () => {
    const rows = healthyPair();
    rows[0] = boundary({
      reason: 'external_funding_before',
      totalAssetKrw: '10000000',
      cumulativeExternalFundingKrw: '10000000',
      externalFundingAmountKrw: '1',
    });
    const { client: db } = client(rows);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a boundary row scoped to another trading account', async () => {
    const rows = healthyPair();
    rows[1] = boundary({
      reason: 'external_funding_after',
      totalAssetKrw: '10050000',
      cumulativeExternalFundingKrw: '10050000',
      tradingAccountId: 'other-account',
    });
    const { client: db } = client(rows);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a boundary row that carries a season participant', async () => {
    const rows = healthyPair();
    rows[0] = boundary({
      reason: 'external_funding_before',
      totalAssetKrw: '10000000',
      cumulativeExternalFundingKrw: '10000000',
      seasonParticipantId: 'participant-1',
    });
    const { client: db } = client(rows);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses an inflow that moved the TWR factor', async () => {
    const rows = healthyPair();
    rows[1] = boundary({
      reason: 'external_funding_after',
      totalAssetKrw: '10050000',
      cumulativeExternalFundingKrw: '10050000',
      timeWeightedReturnFactor: '1.005',
    });
    const { client: db } = client(rows);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses an inflow that moved investment PnL', async () => {
    const rows = healthyPair();
    rows[1] = boundary({
      reason: 'external_funding_after',
      totalAssetKrw: '10050000',
      cumulativeExternalFundingKrw: '10050000',
      investmentPnlKrw: '50000',
    });
    const { client: db } = client(rows);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses an after total that is not before plus the reward', async () => {
    const rows = healthyPair();
    rows[1] = boundary({
      reason: 'external_funding_after',
      totalAssetKrw: '10099999',
      cumulativeExternalFundingKrw: '10050000',
    });
    const { client: db } = client(rows);

    expect(
      await expectRejectionCode(
        assertKeyedGrantedClaimBoundaryIntegrity(db, grantedClaim()),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });
});

/**
 * responsePayloadJson is canonical data, not a write-only audit field: a
 * replay compares it against the live ledger every time.
 */
describe('stored response payload', () => {
  const payload = (data: Record<string, unknown>) =>
    ({ success: true, data }) as unknown as Prisma.JsonValue;

  it('accepts a payload that still matches the ledger', () => {
    expect(() =>
      assertStoredGrantedResponse(
        grantedClaim({
          responsePayloadJson: payload({
            granted: true,
            duplicate: false,
            claimId: CLAIM_ID,
            grantedAt: '2026-08-04T02:00:00.000Z',
            walletBalanceAfter: '10050000.00000000',
          }),
        }),
        '10050000.00000000',
      ),
    ).not.toThrow();
  });

  it('refuses a payload whose balance no longer matches the ledger', () => {
    expect(
      expectThrownCode(() =>
        assertStoredGrantedResponse(
          grantedClaim({
            responsePayloadJson: payload({
              claimId: CLAIM_ID,
              walletBalanceAfter: '999.00000000',
            }),
          }),
          '10050000.00000000',
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a payload that names a different claim', () => {
    expect(
      expectThrownCode(() =>
        assertStoredGrantedResponse(
          grantedClaim({
            responsePayloadJson: payload({ claimId: 'someone-else' }),
          }),
          '10050000.00000000',
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a payload whose grantedAt disagrees with the claim', () => {
    expect(
      expectThrownCode(() =>
        assertStoredGrantedResponse(
          grantedClaim({
            responsePayloadJson: payload({
              grantedAt: '2020-01-01T00:00:00.000Z',
            }),
          }),
          '10050000.00000000',
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a refusal payload that names a different failure code', () => {
    expect(
      expectThrownCode(() =>
        assertStoredRejectedResponse(
          grantedClaim({
            status: 'rejected',
            failureCode: 'AD_REWARD_COOLDOWN_ACTIVE',
            responsePayloadJson: {
              refused: true,
              code: 'AD_REWARD_DAILY_COUNT_LIMIT',
              message: 'x',
            } as unknown as Prisma.JsonValue,
          }),
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });
});
