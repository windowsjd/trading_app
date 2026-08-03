jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
      general_account_open: 'general_account_open',
      performance_baseline: 'performance_baseline',
      external_funding_before: 'external_funding_before',
      external_funding_after: 'external_funding_after',
    },
    TradingAccountMode: { season: 'season', general: 'general' },
    WalletTransactionDirection: { credit: 'credit', debit: 'debit' },
    WalletTransactionReferenceType: {
      general_account_open: 'general_account_open',
      ad_reward_claim: 'ad_reward_claim',
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
import type { PrismaService } from '../prisma/prisma.service';
import type { GeneralExternalFundingService } from './general-external-funding.service';
import {
  GeneralAccountPerformanceService,
  LATEST_SNAPSHOT_CANDIDATE_LIMIT,
} from './general-account-performance.service';
import type { PortfolioValuationService } from './portfolio-valuation.service';

const d = (value: string) => new Prisma.Decimal(value);

/** Both rows of a payout boundary: same capturedAt, same createdAt, by design. */
const CAPTURED_AT = new Date('2026-08-04T02:00:00.000Z');
const CREATED_AT = new Date('2026-08-04T02:00:00.123Z');
const LOW_UUID = '00000000-0000-4000-8000-000000000001';
const HIGH_UUID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const ACCOUNT_ID = 'account-1';

type SnapshotFixture = ReturnType<typeof boundaryRow>;

function boundaryRow(input: {
  id: string;
  reason: 'external_funding_before' | 'external_funding_after';
  totalAssetKrw: string;
  cumulativeExternalFundingKrw: string;
}) {
  return {
    id: input.id,
    seasonParticipantId: null,
    tradingAccountId: ACCOUNT_ID,
    totalAssetKrw: d(input.totalAssetKrw),
    returnRate: d('0'),
    snapshotReason: input.reason,
    cumulativeExternalFundingKrw: d(input.cumulativeExternalFundingKrw),
    investmentPnlKrw: d(input.totalAssetKrw).sub(
      d(input.cumulativeExternalFundingKrw),
    ),
    timeWeightedReturnFactor: d('1'),
    externalFundingAmountKrw: d('50000'),
    externalFundingReferenceType: 'ad_reward_claim',
    externalFundingReferenceId: 'claim-1',
    capturedAt: CAPTURED_AT,
    createdAt: CREATED_AT,
  };
}

function committedPair(beforeId: string, afterId: string) {
  return {
    before: boundaryRow({
      id: beforeId,
      reason: 'external_funding_before',
      totalAssetKrw: '10000000',
      cumulativeExternalFundingKrw: '10000000',
    }),
    after: boundaryRow({
      id: afterId,
      reason: 'external_funding_after',
      totalAssetKrw: '10050000',
      cumulativeExternalFundingKrw: '10050000',
    }),
  };
}

function createService(rows: SnapshotFixture[], originCount = 1) {
  const prisma = {
    equitySnapshot: {
      findFirst: jest.fn().mockResolvedValue(
        rows.length === 0
          ? null
          : {
              capturedAt: rows.reduce(
                (max, row) => (row.capturedAt > max ? row.capturedAt : max),
                rows[0].capturedAt,
              ),
            },
      ),
      findMany: jest.fn().mockImplementation(({ where }: never) => {
        const capturedAt = (where as { capturedAt: Date }).capturedAt;
        return Promise.resolve(
          rows.filter(
            (row) => row.capturedAt.getTime() === capturedAt.getTime(),
          ),
        );
      }),
      count: jest.fn().mockResolvedValue(originCount),
    },
  } as unknown as PrismaService;

  const service = new GeneralAccountPerformanceService(
    prisma,
    {} as unknown as PortfolioValuationService,
    {} as unknown as GeneralExternalFundingService,
  );

  return { service, prisma };
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
 * 작업 7 보완 1 + 2. Both fixes exist because the same payout transaction
 * writes the before/after pair with identical timestamps: the ordering must not
 * come from a UUID, and the ledger must not be allowed to drift ahead of the
 * snapshot that TWR advances from.
 */
describe('GeneralAccountPerformanceService', () => {
  describe('findLatestPerformanceSnapshot (boundary order)', () => {
    it.each([
      ['before UUID greater than after UUID', HIGH_UUID, LOW_UUID],
      ['after UUID greater than before UUID', LOW_UUID, HIGH_UUID],
    ])(
      'returns the after row when the %s',
      async (_label, beforeId, afterId) => {
        const { before, after } = committedPair(beforeId, afterId);
        const { service } = createService([before, after]);

        const latest = await service.findLatestPerformanceSnapshot(ACCOUNT_ID);

        expect(latest?.id).toBe(after.id);
        expect(latest?.snapshotReason).toBe('external_funding_after');
      },
    );

    it.each([
      ['before UUID greater than after UUID', HIGH_UUID, LOW_UUID],
      ['after UUID greater than before UUID', LOW_UUID, HIGH_UUID],
    ])(
      'accepts the committed state and does not raise integrity when the %s',
      async (_label, beforeId, afterId) => {
        const { before, after } = committedPair(beforeId, afterId);
        const { service } = createService([before, after]);

        const { snapshot, state } =
          await service.requirePerformanceState(ACCOUNT_ID);

        expect(snapshot.id).toBe(after.id);
        // The state the NEXT ordinary advance continues from is the after row,
        // so the reward is not re-counted as growth.
        expect(state.totalAssetKrw.toFixed(8)).toBe('10050000.00000000');
        expect(state.cumulativeExternalFundingKrw.toFixed(8)).toBe(
          '10050000.00000000',
        );
      },
    );

    it('returns null when the account has no snapshot at all', async () => {
      const { service } = createService([]);

      await expect(
        service.findLatestPerformanceSnapshot(ACCOUNT_ID),
      ).resolves.toBeNull();
    });

    it('fails closed instead of ranking a truncated candidate page', async () => {
      const rows = Array.from(
        { length: LATEST_SNAPSHOT_CANDIDATE_LIMIT + 1 },
        (_, index) =>
          boundaryRow({
            id: `row-${index}`,
            reason: 'external_funding_after',
            totalAssetKrw: '10050000',
            cumulativeExternalFundingKrw: '10050000',
          }),
      );
      const { service } = createService(rows);

      expect(
        await expectRejectionCode(
          service.findLatestPerformanceSnapshot(ACCOUNT_ID),
        ),
      ).toBe('GENERAL_PERFORMANCE_INTEGRITY');
    });

    it('still refuses an account whose newest state is an unpaired before row', async () => {
      const { before } = committedPair(LOW_UUID, HIGH_UUID);
      const { service } = createService([before]);

      expect(
        await expectRejectionCode(service.requirePerformanceState(ACCOUNT_ID)),
      ).toBe('GENERAL_PERFORMANCE_INTEGRITY');
    });
  });

  describe('assertExternalFundingContinuity (작업 7 보완 2)', () => {
    const { service } = createService([]);

    it('accepts a snapshot that still matches the ledger total', () => {
      expect(() =>
        service.assertExternalFundingContinuity(
          d('10050000'),
          d('10050000.00000000'),
          'snapshot',
        ),
      ).not.toThrow();
    });

    it('refuses to advance when the ledger has grown past the snapshot', () => {
      // Exactly the state a lost `after` boundary leaves behind: the ad reward
      // is in the ledger and the wallet, but not in the performance state.
      expect(
        expectThrownCode(() =>
          service.assertExternalFundingContinuity(
            d('10000000'),
            d('10050000'),
            'snapshot',
          ),
        ),
      ).toBe('GENERAL_PERFORMANCE_INTEGRITY');
    });

    it('refuses a snapshot with no cumulative external funding at all', () => {
      expect(
        expectThrownCode(() =>
          service.assertExternalFundingContinuity(
            null,
            d('10000000'),
            'snapshot',
          ),
        ),
      ).toBe('GENERAL_PERFORMANCE_INTEGRITY');
    });
  });
});
