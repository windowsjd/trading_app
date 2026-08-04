jest.mock('../generated/prisma/client', () => {
  // Typed so the mocked module's Decimal is not an `any` leaking into every
  // fixture in the file.
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

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
  /**
   * 작업 6 보완 §5.1 — STRICT shape for a KEYED claim.
   *
   * The regression: `{}`, `{ data: {} }`, and `{ success: false, data: {...} }`
   * all passed the old "responsePayloadJson !== null" check, and then passed
   * every field comparison vacuously because each was "if present, must match".
   * A payload with no claimId, no grantedAt, and no walletBalanceAfter replayed
   * as a clean success — a payout confirmed with no evidence it happened.
   */
  const KEYED_BALANCE = '10050000.00000000';

  const expectKeyedGrantedRejection = (
    responsePayloadJson: unknown,
    balance = KEYED_BALANCE,
  ) =>
    expect(
      expectThrownCode(() =>
        assertStoredGrantedResponse(
          grantedClaim({
            responsePayloadJson: responsePayloadJson as Prisma.JsonValue,
          }),
          balance,
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');

  it('refuses an EMPTY keyed granted payload', () => {
    expectKeyedGrantedRejection({});
  });

  it('refuses a keyed granted payload with an empty data object', () => {
    expectKeyedGrantedRejection({ success: true, data: {} });
  });

  it('refuses a keyed granted payload missing claimId', () => {
    expectKeyedGrantedRejection(
      payload({
        granted: true,
        duplicate: false,
        grantedAt: '2026-08-04T02:00:00.000Z',
        walletBalanceAfter: KEYED_BALANCE,
      }),
    );
  });

  it('refuses a keyed granted payload missing walletBalanceAfter', () => {
    expectKeyedGrantedRejection(
      payload({
        granted: true,
        duplicate: false,
        claimId: CLAIM_ID,
        grantedAt: '2026-08-04T02:00:00.000Z',
      }),
    );
  });

  it('refuses a keyed granted payload missing grantedAt', () => {
    expectKeyedGrantedRejection(
      payload({
        granted: true,
        duplicate: false,
        claimId: CLAIM_ID,
        walletBalanceAfter: KEYED_BALANCE,
      }),
    );
  });

  it('refuses a keyed granted payload whose success is not true', () => {
    expectKeyedGrantedRejection({
      success: false,
      data: {
        granted: true,
        duplicate: false,
        claimId: CLAIM_ID,
        grantedAt: '2026-08-04T02:00:00.000Z',
        walletBalanceAfter: KEYED_BALANCE,
      },
    });
  });

  it('refuses non-boolean granted/duplicate flags', () => {
    expectKeyedGrantedRejection(
      payload({
        granted: 'yes',
        duplicate: false,
        claimId: CLAIM_ID,
        grantedAt: '2026-08-04T02:00:00.000Z',
        walletBalanceAfter: KEYED_BALANCE,
      }),
    );
  });

  it('refuses a stored payload that records itself as a DUPLICATE', () => {
    // The stored record is the canonical FIRST response, which by definition
    // granted rather than replayed.
    expectKeyedGrantedRejection(
      payload({
        granted: false,
        duplicate: true,
        claimId: CLAIM_ID,
        grantedAt: '2026-08-04T02:00:00.000Z',
        walletBalanceAfter: KEYED_BALANCE,
      }),
    );
  });

  it('refuses a keyed payload whose balance disagrees with the ledger', () => {
    expectKeyedGrantedRejection(
      payload({
        granted: true,
        duplicate: false,
        claimId: CLAIM_ID,
        grantedAt: '2026-08-04T02:00:00.000Z',
        walletBalanceAfter: '999.00000000',
      }),
    );
  });

  it('accepts a complete keyed granted payload', () => {
    expect(() =>
      assertStoredGrantedResponse(
        grantedClaim({
          responsePayloadJson: payload({
            granted: true,
            duplicate: false,
            claimId: CLAIM_ID,
            grantedAt: '2026-08-04T02:00:00.000Z',
            walletBalanceAfter: KEYED_BALANCE,
          }),
        }),
        KEYED_BALANCE,
      ),
    ).not.toThrow();
  });

  /**
   * 작업 6 보완 §5.3 — LEGACY unkeyed claims predate the stored payload
   * entirely. The strict shape is NOT retro-applied to them; only what is
   * actually present has to agree.
   */
  it('accepts a legacy unkeyed claim with NO stored payload', () => {
    expect(() =>
      assertStoredGrantedResponse(
        grantedClaim({ idempotencyKey: null, responsePayloadJson: null }),
        KEYED_BALANCE,
      ),
    ).not.toThrow();
  });

  it('accepts a legacy unkeyed claim with a PARTIAL stored payload', () => {
    expect(() =>
      assertStoredGrantedResponse(
        grantedClaim({
          idempotencyKey: null,
          responsePayloadJson: payload({ claimId: CLAIM_ID }),
        }),
        KEYED_BALANCE,
      ),
    ).not.toThrow();
  });

  it('still catches a legacy payload that contradicts the ledger', () => {
    expect(
      expectThrownCode(() =>
        assertStoredGrantedResponse(
          grantedClaim({
            idempotencyKey: null,
            responsePayloadJson: payload({ walletBalanceAfter: '1.00000000' }),
          }),
          KEYED_BALANCE,
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  // ------------------------------------------------ keyed refusal payload

  const rejectedKeyedClaim = (responsePayloadJson: unknown) =>
    grantedClaim({
      status: 'rejected',
      grantedAt: null,
      rejectedAt: new Date('2026-08-04T02:00:00.000Z'),
      failureCode: 'AD_REWARD_COOLDOWN_ACTIVE',
      failureReason: 'Cooldown is active.',
      walletTransactionId: null,
      walletTransaction: null,
      responsePayloadJson: responsePayloadJson as Prisma.JsonValue,
    });

  it('refuses a keyed refusal payload with no stored object', () => {
    expect(
      expectThrownCode(() =>
        assertStoredRejectedResponse(rejectedKeyedClaim(null)),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a keyed refusal payload missing its failure code', () => {
    expect(
      expectThrownCode(() =>
        assertStoredRejectedResponse(
          rejectedKeyedClaim({ refused: true, message: 'Cooldown is active.' }),
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a keyed refusal payload missing its message', () => {
    expect(
      expectThrownCode(() =>
        assertStoredRejectedResponse(
          rejectedKeyedClaim({
            refused: true,
            code: 'AD_REWARD_COOLDOWN_ACTIVE',
          }),
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('refuses a keyed refusal payload whose message contradicts the claim', () => {
    expect(
      expectThrownCode(() =>
        assertStoredRejectedResponse(
          rejectedKeyedClaim({
            refused: true,
            code: 'AD_REWARD_COOLDOWN_ACTIVE',
            message: 'Something else entirely.',
          }),
        ),
      ),
    ).toBe('AD_REWARD_CLAIM_INTEGRITY');
  });

  it('accepts a complete keyed refusal payload', () => {
    expect(() =>
      assertStoredRejectedResponse(
        rejectedKeyedClaim({
          refused: true,
          code: 'AD_REWARD_COOLDOWN_ACTIVE',
          message: 'Cooldown is active.',
        }),
      ),
    ).not.toThrow();
  });

  it('does not force the keyed refusal shape on a legacy unkeyed claim', () => {
    expect(() =>
      assertStoredRejectedResponse({
        ...rejectedKeyedClaim(null),
        idempotencyKey: null,
      }),
    ).not.toThrow();
  });
});
