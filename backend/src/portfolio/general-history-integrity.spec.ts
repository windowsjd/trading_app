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
    Prisma: { Decimal },
    SnapshotReason: {
      season_join: 'season_join',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
      general_account_open: 'general_account_open',
      performance_baseline: 'performance_baseline',
      external_funding_before: 'external_funding_before',
      external_funding_after: 'external_funding_after',
    },
    WalletTransactionReferenceType: {
      order: 'order',
      exchange_transaction: 'exchange_transaction',
      general_account_open: 'general_account_open',
      ad_reward_claim: 'ad_reward_claim',
    },
  };
});

import { Prisma } from '../generated/prisma/client';
import {
  assertGeneralDailyHistoryRows,
  assertGeneralEquityHistoryRows,
  assertGeneralHistoryBoundaryPairs,
  type GeneralHistoryEquityRow,
} from './general-history-integrity';
import { GeneralPerformanceError } from './general-performance.policy';

/**
 * 작업 6·7 보완 3.
 *
 * The regression these tests exist for: the equity endpoint used to validate
 * only the account's LATEST performance state, then serialise whatever the
 * range returned. A null performance column came out as `"investmentPnlKrw":
 * null` in a 200, and an orphaned `after` boundary drew a vertical jump that a
 * user reads as a trading gain. Every case below must be a structured 500.
 */

const ACCOUNT_ID = 'account-1';
const CAPTURED_AT = new Date('2026-08-01T00:00:00.000Z');

const d = (value: string) => new Prisma.Decimal(value);

function equityRow(
  overrides: Partial<GeneralHistoryEquityRow> = {},
): GeneralHistoryEquityRow {
  return {
    id: 'equity-1',
    seasonParticipantId: null,
    tradingAccountId: ACCOUNT_ID,
    totalAssetKrw: d('10000000'),
    returnRate: d('0'),
    snapshotReason: 'scheduled',
    cumulativeExternalFundingKrw: d('10000000'),
    investmentPnlKrw: d('0'),
    timeWeightedReturnFactor: d('1'),
    externalFundingAmountKrw: null,
    externalFundingReferenceType: null,
    externalFundingReferenceId: null,
    capturedAt: CAPTURED_AT,
    createdAt: CAPTURED_AT,
    ...overrides,
  };
}

function expectIntegrityFailure(run: () => unknown) {
  expect(run).toThrow(GeneralPerformanceError);
  try {
    run();
  } catch (error) {
    expect((error as GeneralPerformanceError).code).toBe(
      'GENERAL_PERFORMANCE_INTEGRITY',
    );
  }
}

describe('general equity history rows', () => {
  it('accepts a healthy ordinary capture', () => {
    expect(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [equityRow()]),
    ).not.toThrow();
  });

  it.each([
    ['cumulativeExternalFundingKrw'],
    ['investmentPnlKrw'],
    ['timeWeightedReturnFactor'],
  ])('rejects a row whose %s is null instead of serialising null', (field) => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({ [field]: null } as Partial<GeneralHistoryEquityRow>),
      ]),
    );
  });

  it('rejects investment PnL that is not total - cumulative funding', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({ investmentPnlKrw: d('123') }),
      ]),
    );
  });

  it('rejects a return rate that disagrees with its factor', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({ returnRate: d('5') }),
      ]),
    );
  });

  it('rejects a negative total asset value', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({
          totalAssetKrw: d('-1'),
          investmentPnlKrw: d('-10000001'),
        }),
      ]),
    );
  });

  it('rejects a season participant link on a general row', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({ seasonParticipantId: 'sp-1' }),
      ]),
    );
  });

  it('rejects a row belonging to another trading account', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({ tradingAccountId: 'account-other' }),
      ]),
    );
  });

  it('requires an origin to be the exact zero point of performance', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({
          snapshotReason: 'performance_baseline',
          timeWeightedReturnFactor: d('1.5'),
          returnRate: d('50'),
        }),
      ]),
    );
  });

  it('rejects more than one origin in the returned history', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({ id: 'e1', snapshotReason: 'performance_baseline' }),
        equityRow({ id: 'e2', snapshotReason: 'performance_baseline' }),
      ]),
    );
  });

  it('rejects an ordinary capture that carries funding reference columns', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({
          snapshotReason: 'scheduled',
          externalFundingAmountKrw: d('50000'),
          externalFundingReferenceType: 'ad_reward_claim',
          externalFundingReferenceId: 'claim-1',
        }),
      ]),
    );
  });

  it('rejects a boundary row with no funding reference', () => {
    expectIntegrityFailure(() =>
      assertGeneralEquityHistoryRows(ACCOUNT_ID, [
        equityRow({ snapshotReason: 'external_funding_before' }),
      ]),
    );
  });
});

describe('general daily history rows', () => {
  const dailyRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'daily-1',
    seasonParticipantId: null,
    tradingAccountId: ACCOUNT_ID,
    totalAssetKrw: d('10000000'),
    returnRate: d('0'),
    cumulativeExternalFundingKrw: d('10000000'),
    investmentPnlKrw: d('0'),
    timeWeightedReturnFactor: d('1'),
    capturedAt: CAPTURED_AT,
    ...overrides,
  });

  it('accepts a healthy daily row', () => {
    expect(() =>
      assertGeneralDailyHistoryRows(ACCOUNT_ID, [dailyRow()]),
    ).not.toThrow();
  });

  it('rejects a daily row with null performance columns', () => {
    expectIntegrityFailure(() =>
      assertGeneralDailyHistoryRows(ACCOUNT_ID, [
        dailyRow({ timeWeightedReturnFactor: null }),
      ]),
    );
  });

  it('rejects a daily row whose PnL does not reconcile', () => {
    expectIntegrityFailure(() =>
      assertGeneralDailyHistoryRows(ACCOUNT_ID, [
        dailyRow({ investmentPnlKrw: d('999') }),
      ]),
    );
  });
});

describe('general history boundary pairs', () => {
  const REWARD = '50000';
  const CLAIM_ID = 'claim-1';

  const before = (overrides: Partial<GeneralHistoryEquityRow> = {}) =>
    equityRow({
      id: 'before-1',
      snapshotReason: 'external_funding_before',
      totalAssetKrw: d('10000000'),
      cumulativeExternalFundingKrw: d('10000000'),
      investmentPnlKrw: d('0'),
      externalFundingAmountKrw: d(REWARD),
      externalFundingReferenceType: 'ad_reward_claim',
      externalFundingReferenceId: CLAIM_ID,
      ...overrides,
    });

  const after = (overrides: Partial<GeneralHistoryEquityRow> = {}) =>
    equityRow({
      id: 'after-1',
      snapshotReason: 'external_funding_after',
      totalAssetKrw: d('10050000'),
      cumulativeExternalFundingKrw: d('10050000'),
      investmentPnlKrw: d('0'),
      externalFundingAmountKrw: d(REWARD),
      externalFundingReferenceType: 'ad_reward_claim',
      externalFundingReferenceId: CLAIM_ID,
      ...overrides,
    });

  const claimClient = (overrides: Record<string, unknown> = {}) => ({
    adRewardClaim: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: CLAIM_ID,
          status: 'granted',
          tradingAccountId: ACCOUNT_ID,
          rewardAmountKrw: d(REWARD),
          walletTransactionId: 'ledger-1',
          ...overrides,
        },
      ]),
    },
  });

  it('accepts a complete, performance-neutral pair', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(claimClient() as never, ACCOUNT_ID, [
        before(),
        after(),
      ]),
    ).resolves.toBeUndefined();
  });

  it('rejects a pair with only a BEFORE row', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(claimClient() as never, ACCOUNT_ID, [
        before(),
      ]),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects a pair with only an AFTER row', async () => {
    // This is the dangerous one: a lone `after` renders as a vertical jump in
    // total assets that reads exactly like a trading gain.
    await expect(
      assertGeneralHistoryBoundaryPairs(claimClient() as never, ACCOUNT_ID, [
        after(),
      ]),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects a pair whose before/after amounts differ', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(claimClient() as never, ACCOUNT_ID, [
        before(),
        after({ externalFundingAmountKrw: d('60000') }),
      ]),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects a boundary that moved the TWR factor — an inflow is not performance', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(claimClient() as never, ACCOUNT_ID, [
        before(),
        after({ timeWeightedReturnFactor: d('1.1'), returnRate: d('10') }),
      ]),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects an after total that is not before + the funded amount', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(claimClient() as never, ACCOUNT_ID, [
        before(),
        after({
          totalAssetKrw: d('10099999'),
          investmentPnlKrw: d('49999'),
        }),
      ]),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects a boundary whose claim is not granted', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(
        claimClient({ status: 'rejected' }) as never,
        ACCOUNT_ID,
        [before(), after()],
      ),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects a boundary whose claim belongs to another account', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(
        claimClient({ tradingAccountId: 'account-other' }) as never,
        ACCOUNT_ID,
        [before(), after()],
      ),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects a granted claim with no ledger row behind it', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(
        claimClient({ walletTransactionId: null }) as never,
        ACCOUNT_ID,
        [before(), after()],
      ),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('rejects a boundary amount that disagrees with the claim reward', async () => {
    await expect(
      assertGeneralHistoryBoundaryPairs(
        claimClient({ rewardAmountKrw: d('70000') }) as never,
        ACCOUNT_ID,
        [before(), after()],
      ),
    ).rejects.toBeInstanceOf(GeneralPerformanceError);
  });

  it('issues ONE batched claim query for a page with many boundaries', async () => {
    const client = {
      adRewardClaim: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'claim-1',
            status: 'granted',
            tradingAccountId: ACCOUNT_ID,
            rewardAmountKrw: d(REWARD),
            walletTransactionId: 'ledger-1',
          },
          {
            id: 'claim-2',
            status: 'granted',
            tradingAccountId: ACCOUNT_ID,
            rewardAmountKrw: d(REWARD),
            walletTransactionId: 'ledger-2',
          },
        ]),
      },
    };

    await assertGeneralHistoryBoundaryPairs(client as never, ACCOUNT_ID, [
      before({ id: 'b1' }),
      after({ id: 'a1' }),
      before({ id: 'b2', externalFundingReferenceId: 'claim-2' }),
      after({ id: 'a2', externalFundingReferenceId: 'claim-2' }),
    ]);

    // N+1 is the failure mode this guards against: two pairs, one query.
    expect(client.adRewardClaim.findMany).toHaveBeenCalledTimes(1);
  });

  it('queries nothing when the page holds no boundaries', async () => {
    const client = claimClient();

    await assertGeneralHistoryBoundaryPairs(client as never, ACCOUNT_ID, [
      equityRow(),
    ]);

    expect(client.adRewardClaim.findMany).not.toHaveBeenCalled();
  });
});
