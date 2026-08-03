jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return { Prisma: { Decimal }, PrismaClient: class PrismaClient {} };
});

import { Prisma } from '../generated/prisma/client';
import {
  advanceGeneralPerformance,
  assertGeneralPerformanceStateConsistent,
  buildExternalFundingBoundary,
  buildGeneralPerformanceOrigin,
  compareGeneralSnapshotOrder,
  GeneralPerformanceError,
  pickLatestSnapshot,
  snapshotPhaseRank,
  toReturnRatePercent,
  type OrderableSnapshot,
} from './general-performance.policy';

const d = (value: string | number) => new Prisma.Decimal(value);

/**
 * The central promise of 작업 7: an ad reward is virtual funding, not
 * performance. These tests pin that down numerically.
 */
describe('general performance (TWR) policy', () => {
  describe('origin', () => {
    it('starts flat: factor 1, return 0, no investment PnL', () => {
      const origin = buildGeneralPerformanceOrigin('10000000');

      expect(origin.totalAssetKrw.toFixed(8)).toBe('10000000.00000000');
      expect(origin.cumulativeExternalFundingKrw.toFixed(8)).toBe(
        '10000000.00000000',
      );
      expect(origin.investmentPnlKrw.toFixed(8)).toBe('0.00000000');
      expect(origin.timeWeightedReturnFactor.toFixed(8)).toBe('1.00000000');
      expect(origin.returnRate.toFixed(8)).toBe('0.00000000');
    });

    it('rejects negative initial funding', () => {
      expect(() => buildGeneralPerformanceOrigin('-1')).toThrow(
        GeneralPerformanceError,
      );
    });
  });

  describe('ordinary segments', () => {
    const previous = {
      totalAssetKrw: d('10000000'),
      timeWeightedReturnFactor: d('1'),
    };

    it('turns a 10% gain into factor 1.1 / +10%', () => {
      const next = advanceGeneralPerformance({
        previous,
        currentTotalAssetKrw: '11000000',
        cumulativeExternalFundingKrw: '10000000',
      });

      expect(next.timeWeightedReturnFactor.toFixed(8)).toBe('1.10000000');
      expect(next.returnRate.toFixed(8)).toBe('10.00000000');
      expect(next.investmentPnlKrw.toFixed(8)).toBe('1000000.00000000');
    });

    it('turns a 10% loss into factor 0.9 / -10%', () => {
      const next = advanceGeneralPerformance({
        previous,
        currentTotalAssetKrw: '9000000',
        cumulativeExternalFundingKrw: '10000000',
      });

      expect(next.timeWeightedReturnFactor.toFixed(8)).toBe('0.90000000');
      expect(next.returnRate.toFixed(8)).toBe('-10.00000000');
      expect(next.investmentPnlKrw.toFixed(8)).toBe('-1000000.00000000');
    });

    it('chains segments: many small advances equal one big one', () => {
      // 10,000,000 → 11,000,000 → 12,100,000 in two steps is +21%.
      const step1 = advanceGeneralPerformance({
        previous,
        currentTotalAssetKrw: '11000000',
        cumulativeExternalFundingKrw: '10000000',
      });
      const step2 = advanceGeneralPerformance({
        previous: step1,
        currentTotalAssetKrw: '12100000',
        cumulativeExternalFundingKrw: '10000000',
      });
      const oneShot = advanceGeneralPerformance({
        previous,
        currentTotalAssetKrw: '12100000',
        cumulativeExternalFundingKrw: '10000000',
      });

      expect(step2.timeWeightedReturnFactor.toFixed(18)).toBe(
        oneShot.timeWeightedReturnFactor.toFixed(18),
      );
      expect(step2.returnRate.toFixed(8)).toBe('21.00000000');
    });

    it('does not feed the ROUNDED return rate back into the next factor', () => {
      // A total that yields a repeating factor: rounding the percent to 8 dp
      // and re-deriving would drift, multiplying the raw factor does not.
      let state = {
        totalAssetKrw: d('10000000'),
        timeWeightedReturnFactor: d('1'),
      };
      for (let i = 0; i < 3; i += 1) {
        const next = advanceGeneralPerformance({
          previous: state,
          currentTotalAssetKrw: state.totalAssetKrw
            .mul(d('10000000'))
            .div(d('9999999'))
            .toFixed(8),
          cumulativeExternalFundingKrw: '10000000',
        });
        state = {
          totalAssetKrw: next.totalAssetKrw,
          timeWeightedReturnFactor: next.timeWeightedReturnFactor,
        };
      }

      // factor must still be derivable from the ratio of totals, not from the
      // rounded percentages.
      const expectedFactor = state.totalAssetKrw.div(d('10000000'));
      expect(
        state.timeWeightedReturnFactor.sub(expectedFactor).abs().lt(d('1e-12')),
      ).toBe(true);
    });
  });

  describe('external funding is performance-neutral', () => {
    const boundary = () =>
      buildExternalFundingBoundary({
        previous: {
          totalAssetKrw: d('10000000'),
          timeWeightedReturnFactor: d('1'),
        },
        // Market already produced +10% before the ad reward arrives.
        totalAssetBeforeKrw: '11000000',
        cumulativeExternalFundingBeforeKrw: '10000000',
        externalFundingAmountKrw: '1000000',
      });

    it('adds exactly the reward to total assets', () => {
      const { before, after } = boundary();
      expect(after.totalAssetKrw.sub(before.totalAssetKrw).toFixed(8)).toBe(
        '1000000.00000000',
      );
      expect(after.totalAssetKrw.toFixed(8)).toBe('12000000.00000000');
    });

    it('adds exactly the reward to cumulative external funding', () => {
      const { before, after } = boundary();
      expect(
        after.cumulativeExternalFundingKrw
          .sub(before.cumulativeExternalFundingKrw)
          .toFixed(8),
      ).toBe('1000000.00000000');
    });

    it('leaves investment PnL unchanged', () => {
      const { before, after } = boundary();
      expect(before.investmentPnlKrw.toFixed(8)).toBe('1000000.00000000');
      expect(after.investmentPnlKrw.toFixed(8)).toBe(
        before.investmentPnlKrw.toFixed(8),
      );
    });

    it('leaves the TWR factor and return rate unchanged', () => {
      const { before, after } = boundary();
      expect(before.returnRate.toFixed(8)).toBe('10.00000000');
      expect(after.timeWeightedReturnFactor.toFixed(18)).toBe(
        before.timeWeightedReturnFactor.toFixed(18),
      );
      expect(after.returnRate.toFixed(8)).toBe(before.returnRate.toFixed(8));
    });

    it('stays neutral across MULTIPLE rewards', () => {
      let state = buildGeneralPerformanceOrigin('10000000');

      for (let i = 0; i < 3; i += 1) {
        const { after } = buildExternalFundingBoundary({
          previous: state,
          totalAssetBeforeKrw: state.totalAssetKrw.toFixed(8),
          cumulativeExternalFundingBeforeKrw:
            state.cumulativeExternalFundingKrw.toFixed(8),
          externalFundingAmountKrw: '500000',
        });
        state = after;
      }

      // Three rewards, zero market movement → still exactly 0%.
      expect(state.returnRate.toFixed(8)).toBe('0.00000000');
      expect(state.investmentPnlKrw.toFixed(8)).toBe('0.00000000');
      expect(state.cumulativeExternalFundingKrw.toFixed(8)).toBe(
        '11500000.00000000',
      );
      expect(state.totalAssetKrw.toFixed(8)).toBe('11500000.00000000');
    });

    it('attributes post-reward market movement to the NEXT segment', () => {
      const { after } = boundary(); // 12,000,000 at +10%
      const up = advanceGeneralPerformance({
        previous: after,
        currentTotalAssetKrw: '13200000', // +10% on 12,000,000
        cumulativeExternalFundingKrw: '11000000',
      });
      const down = advanceGeneralPerformance({
        previous: after,
        currentTotalAssetKrw: '10800000', // -10% on 12,000,000
        cumulativeExternalFundingKrw: '11000000',
      });

      // 1.1 × 1.1 = 1.21 and 1.1 × 0.9 = 0.99
      expect(up.returnRate.toFixed(8)).toBe('21.00000000');
      expect(down.returnRate.toFixed(8)).toBe('-1.00000000');
    });

    it('rejects a non-positive funding amount', () => {
      expect(() =>
        buildExternalFundingBoundary({
          previous: {
            totalAssetKrw: d('10000000'),
            timeWeightedReturnFactor: d('1'),
          },
          totalAssetBeforeKrw: '10000000',
          cumulativeExternalFundingBeforeKrw: '10000000',
          externalFundingAmountKrw: '0',
        }),
      ).toThrow(GeneralPerformanceError);
    });
  });

  describe('total loss', () => {
    it('reports factor 0 / -100% when everything is lost', () => {
      const wiped = advanceGeneralPerformance({
        previous: {
          totalAssetKrw: d('10000000'),
          timeWeightedReturnFactor: d('1'),
        },
        currentTotalAssetKrw: '0',
        cumulativeExternalFundingKrw: '10000000',
      });

      expect(wiped.timeWeightedReturnFactor.toFixed(8)).toBe('0.00000000');
      expect(wiped.returnRate.toFixed(8)).toBe('-100.00000000');
    });

    it('keeps -100% after a later ad reward (no silent recovery)', () => {
      const wiped = advanceGeneralPerformance({
        previous: {
          totalAssetKrw: d('10000000'),
          timeWeightedReturnFactor: d('1'),
        },
        currentTotalAssetKrw: '0',
        cumulativeExternalFundingKrw: '10000000',
      });

      const { before, after } = buildExternalFundingBoundary({
        previous: wiped,
        totalAssetBeforeKrw: '0',
        cumulativeExternalFundingBeforeKrw: '10000000',
        externalFundingAmountKrw: '1000000',
      });

      expect(before.timeWeightedReturnFactor.toFixed(8)).toBe('0.00000000');
      expect(after.timeWeightedReturnFactor.toFixed(8)).toBe('0.00000000');
      expect(after.returnRate.toFixed(8)).toBe('-100.00000000');
      // The money is real even though the cumulative return is not recovered.
      expect(after.totalAssetKrw.toFixed(8)).toBe('1000000.00000000');
    });

    it('flags value reappearing from zero with no funding boundary', () => {
      expect(() =>
        advanceGeneralPerformance({
          previous: {
            totalAssetKrw: d('0'),
            timeWeightedReturnFactor: d('0'),
          },
          currentTotalAssetKrw: '5000',
          cumulativeExternalFundingKrw: '10000000',
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'GENERAL_PERFORMANCE_DISCONTINUITY',
        }) as never,
      );
    });

    it('holds the factor steady while the account stays at zero', () => {
      const next = advanceGeneralPerformance({
        previous: { totalAssetKrw: d('0'), timeWeightedReturnFactor: d('0') },
        currentTotalAssetKrw: '0',
        cumulativeExternalFundingKrw: '10000000',
      });
      expect(next.timeWeightedReturnFactor.toFixed(8)).toBe('0.00000000');
    });

    it('rejects a negative total asset value', () => {
      expect(() =>
        advanceGeneralPerformance({
          previous: {
            totalAssetKrw: d('10000000'),
            timeWeightedReturnFactor: d('1'),
          },
          currentTotalAssetKrw: '-1',
          cumulativeExternalFundingKrw: '10000000',
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'GENERAL_PERFORMANCE_INTEGRITY',
        }) as never,
      );
    });
  });

  describe('stored state validation', () => {
    const consistent = {
      totalAssetKrw: d('11000000'),
      cumulativeExternalFundingKrw: d('10000000'),
      investmentPnlKrw: d('1000000'),
      timeWeightedReturnFactor: d('1.1'),
      returnRate: d('10'),
    };

    it('accepts a self-consistent state', () => {
      expect(() =>
        assertGeneralPerformanceStateConsistent(consistent, 'snapshot'),
      ).not.toThrow();
    });

    it('rejects missing performance columns', () => {
      expect(() =>
        assertGeneralPerformanceStateConsistent(
          { ...consistent, timeWeightedReturnFactor: null },
          'snapshot',
        ),
      ).toThrow(GeneralPerformanceError);
    });

    it('rejects an investment PnL that is not total - external funding', () => {
      expect(() =>
        assertGeneralPerformanceStateConsistent(
          { ...consistent, investmentPnlKrw: d('999999') },
          'snapshot',
        ),
      ).toThrow(GeneralPerformanceError);
    });

    it('rejects a return rate that disagrees with its factor', () => {
      expect(() =>
        assertGeneralPerformanceStateConsistent(
          { ...consistent, returnRate: d('42') },
          'snapshot',
        ),
      ).toThrow(GeneralPerformanceError);
    });

    it('rejects a negative factor', () => {
      expect(() =>
        assertGeneralPerformanceStateConsistent(
          {
            ...consistent,
            timeWeightedReturnFactor: d('-0.1'),
            returnRate: d('-110'),
          },
          'snapshot',
        ),
      ).toThrow(GeneralPerformanceError);
    });
  });

  /**
   * 작업 7 보완 1. The pair is written inside ONE transaction, so it shares
   * capturedAt AND createdAt and the only thing left to separate the rows used
   * to be a random UUID. Every case below therefore fixes the UUIDs explicitly
   * and runs BOTH directions: whichever id happens to be larger, the answers
   * must be identical.
   */
  describe('boundary ordering (작업 7 보완 1)', () => {
    const SAME_CAPTURED_AT = new Date('2026-08-04T02:00:00.000Z');
    const SAME_CREATED_AT = new Date('2026-08-04T02:00:00.123Z');
    const LOW_UUID = '00000000-0000-4000-8000-000000000001';
    const HIGH_UUID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

    const pair = (
      beforeId: string,
      afterId: string,
    ): { before: OrderableSnapshot; after: OrderableSnapshot } => ({
      before: {
        id: beforeId,
        snapshotReason: 'external_funding_before',
        capturedAt: SAME_CAPTURED_AT,
        // Identical createdAt on purpose: both rows are inserted by the same
        // transaction and can land on the same microsecond.
        createdAt: SAME_CREATED_AT,
      },
      after: {
        id: afterId,
        snapshotReason: 'external_funding_after',
        capturedAt: SAME_CAPTURED_AT,
        createdAt: SAME_CREATED_AT,
      },
    });

    const cases: Array<[string, string, string]> = [
      ['before UUID greater than after UUID', HIGH_UUID, LOW_UUID],
      ['after UUID greater than before UUID', LOW_UUID, HIGH_UUID],
    ];

    it.each(cases)(
      'picks the after row as the latest state when the %s',
      (_label, beforeId, afterId) => {
        const { before, after } = pair(beforeId, afterId);

        expect(pickLatestSnapshot([before, after])).toBe(after);
        // Input order must not matter either.
        expect(pickLatestSnapshot([after, before])).toBe(after);
      },
    );

    it.each(cases)(
      'orders history before → after when the %s',
      (_label, beforeId, afterId) => {
        const { before, after } = pair(beforeId, afterId);

        expect([after, before].sort(compareGeneralSnapshotOrder)).toEqual([
          before,
          after,
        ]);
        expect([before, after].sort(compareGeneralSnapshotOrder)).toEqual([
          before,
          after,
        ]);
      },
    );

    it('never lets a before row win a tie against an ordinary snapshot', () => {
      const { before } = pair(HIGH_UUID, LOW_UUID);
      const scheduled: OrderableSnapshot = {
        id: LOW_UUID,
        snapshotReason: 'scheduled',
        capturedAt: SAME_CAPTURED_AT,
        createdAt: SAME_CREATED_AT,
      };

      expect(pickLatestSnapshot([before, scheduled])).toBe(scheduled);
    });

    it('still prefers a newer capturedAt over the phase rank', () => {
      const { before, after } = pair(LOW_UUID, HIGH_UUID);
      const later: OrderableSnapshot = {
        id: LOW_UUID,
        snapshotReason: 'scheduled',
        capturedAt: new Date(SAME_CAPTURED_AT.getTime() + 1000),
        createdAt: SAME_CREATED_AT,
      };

      expect(pickLatestSnapshot([before, after, later])).toBe(later);
    });

    it('keeps ordinary snapshots on their existing createdAt → id order', () => {
      const base = {
        snapshotReason: 'scheduled' as const,
        capturedAt: SAME_CAPTURED_AT,
      };
      const older = { ...base, id: HIGH_UUID, createdAt: SAME_CREATED_AT };
      const newer = {
        ...base,
        id: LOW_UUID,
        createdAt: new Date(SAME_CREATED_AT.getTime() + 5),
      };

      expect([newer, older].sort(compareGeneralSnapshotOrder)).toEqual([
        older,
        newer,
      ]);
      expect(pickLatestSnapshot([older, newer])).toBe(newer);
    });

    it('ranks the three phases before < ordinary < after', () => {
      expect(snapshotPhaseRank('external_funding_before')).toBeLessThan(
        snapshotPhaseRank('scheduled'),
      );
      expect(snapshotPhaseRank('scheduled')).toBeLessThan(
        snapshotPhaseRank('external_funding_after'),
      );
      // Every non-boundary reason shares one rank, so their relative order is
      // decided exactly as it was before this change.
      expect(snapshotPhaseRank('general_account_open')).toBe(
        snapshotPhaseRank('performance_baseline'),
      );
      expect(snapshotPhaseRank('order_executed')).toBe(
        snapshotPhaseRank('scheduled'),
      );
    });

    it('returns null for an empty candidate set', () => {
      expect(pickLatestSnapshot([])).toBeNull();
    });
  });

  describe('toReturnRatePercent', () => {
    it.each([
      ['1', '0.00000000'],
      ['1.5', '50.00000000'],
      ['0.5', '-50.00000000'],
      ['0', '-100.00000000'],
      ['2.345', '134.50000000'],
    ])('maps factor %s to %s%%', (factor, expected) => {
      expect(toReturnRatePercent(d(factor)).toFixed(8)).toBe(expected);
    });
  });
});
