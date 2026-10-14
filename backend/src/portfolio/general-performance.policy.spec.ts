jest.mock('../generated/prisma/client', () => {
  // Typed so the mocked module's Decimal is not an `any` leaking into every
  // fixture in the file.
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

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
  toCumulativePrincipalReturnRatePercent,
  toReturnRatePercent,
  type OrderableSnapshot,
} from './general-performance.policy';

const d = (value: string | number) => new Prisma.Decimal(value);

/**
 * The central promise of 작업 7: an ad reward is virtual funding, not
 * performance. These tests pin that down numerically for the STORED
 * time-weighted record. The representative cumulative-principal rate has its
 * own block at the end of this file.
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

  describe('external funding is neutral to the stored TWR record', () => {
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

/**
 * 일반·초보 수익률 정책 변경: the representative rate is investment PnL over the
 * cumulative principal of the SAME state. An inflow is not profit (PnL stays),
 * but it grows the principal, so the rate may move — the opposite of the
 * stored TWR record's neutrality above, and both are asserted side by side.
 */
describe('cumulative-principal representative return rate', () => {
  const rate = (principal: string, total: string) =>
    toCumulativePrincipalReturnRatePercent({
      totalAssetKrw: d(total),
      cumulativeExternalFundingKrw: d(principal),
    }).toFixed(8);

  it.each([
    ['10000000', '10000000', '0.00000000'],
    ['10000000', '12000000', '20.00000000'],
    ['10000000', '9000000', '-10.00000000'],
    ['10000000', '0', '-100.00000000'],
    ['12000000', '14000000', '16.66666667'],
    ['12000000', '11000000', '-8.33333333'],
  ])('principal %s with total %s is %s%%', (principal, total, expected) => {
    expect(rate(principal, total)).toBe(expected);
  });

  it('rounds half-up at the 8 dp return-rate scale, never through a JS number', () => {
    // 1 KRW over a 3 KRW principal = 33.333333333…%
    expect(rate('3', '4')).toBe('33.33333333');
    // ±0.01 KRW on 200,000,000 is exactly ±0.000000005%: half rounds away
    // from zero at the 8th decimal place.
    expect(rate('200000000', '200000000.01')).toBe('0.00000001');
    expect(rate('200000000', '199999999.99')).toBe('-0.00000001');
  });

  it('fails closed on a non-positive principal instead of showing 0%', () => {
    for (const principal of ['0', '-1']) {
      expect(() => rate(principal, '10000000')).toThrow(
        expect.objectContaining({
          code: 'GENERAL_PERFORMANCE_INTEGRITY',
        }) as never,
      );
    }
  });

  it('fails closed on a negative total or a non-finite input', () => {
    expect(() => rate('10000000', '-1')).toThrow(GeneralPerformanceError);
    expect(() =>
      toCumulativePrincipalReturnRatePercent({
        totalAssetKrw: d('NaN'),
        cumulativeExternalFundingKrw: d('10000000'),
      }),
    ).toThrow(GeneralPerformanceError);
  });

  const reward = (input: {
    total: string;
    principal: string;
    amount: string;
  }) =>
    buildExternalFundingBoundary({
      previous: {
        totalAssetKrw: d(input.total),
        timeWeightedReturnFactor: d(input.total).div(input.principal),
      },
      totalAssetBeforeKrw: input.total,
      cumulativeExternalFundingBeforeKrw: input.principal,
      externalFundingAmountKrw: input.amount,
    });

  it('keeps 0% when a reward arrives with zero investment PnL', () => {
    const { before, after } = reward({
      total: '10000000',
      principal: '10000000',
      amount: '2000000',
    });
    expect(toCumulativePrincipalReturnRatePercent(before).toFixed(8)).toBe(
      '0.00000000',
    );
    expect(toCumulativePrincipalReturnRatePercent(after).toFixed(8)).toBe(
      '0.00000000',
    );
  });

  it('changes the rate but not PnL when a reward follows a gain (예시 2)', () => {
    const { before, after } = reward({
      total: '12000000',
      principal: '10000000',
      amount: '2000000',
    });

    expect(before.investmentPnlKrw.toFixed(8)).toBe('2000000.00000000');
    expect(after.investmentPnlKrw.toFixed(8)).toBe('2000000.00000000');
    expect(after.totalAssetKrw.toFixed(8)).toBe('14000000.00000000');
    expect(after.cumulativeExternalFundingKrw.toFixed(8)).toBe(
      '12000000.00000000',
    );
    expect(toCumulativePrincipalReturnRatePercent(before).toFixed(8)).toBe(
      '20.00000000',
    );
    expect(toCumulativePrincipalReturnRatePercent(after).toFixed(8)).toBe(
      '16.66666667',
    );
    // The stored TWR record of the same pair is still neutral.
    expect(after.returnRate.toFixed(8)).toBe(before.returnRate.toFixed(8));
  });

  it('changes the rate but not PnL when a reward follows a loss (예시 3)', () => {
    const { before, after } = reward({
      total: '9000000',
      principal: '10000000',
      amount: '2000000',
    });

    expect(before.investmentPnlKrw.toFixed(8)).toBe('-1000000.00000000');
    expect(after.investmentPnlKrw.toFixed(8)).toBe('-1000000.00000000');
    expect(toCumulativePrincipalReturnRatePercent(before).toFixed(8)).toBe(
      '-10.00000000',
    );
    expect(toCumulativePrincipalReturnRatePercent(after).toFixed(8)).toBe(
      '-8.33333333',
    );
  });

  it('uses each state’s own principal across consecutive rewards and later trading', () => {
    // +2,000,000 PnL, then two 1,000,000 rewards, then +600,000 more PnL.
    let state = reward({
      total: '12000000',
      principal: '10000000',
      amount: '1000000',
    }).after;
    expect(toCumulativePrincipalReturnRatePercent(state).toFixed(8)).toBe(
      '18.18181818',
    );

    state = buildExternalFundingBoundary({
      previous: state,
      totalAssetBeforeKrw: state.totalAssetKrw.toFixed(8),
      cumulativeExternalFundingBeforeKrw:
        state.cumulativeExternalFundingKrw.toFixed(8),
      externalFundingAmountKrw: '1000000',
    }).after;
    expect(state.investmentPnlKrw.toFixed(8)).toBe('2000000.00000000');
    expect(toCumulativePrincipalReturnRatePercent(state).toFixed(8)).toBe(
      '16.66666667',
    );

    const traded = advanceGeneralPerformance({
      previous: state,
      currentTotalAssetKrw: '14600000',
      cumulativeExternalFundingKrw: state.cumulativeExternalFundingKrw,
    });
    expect(traded.investmentPnlKrw.toFixed(8)).toBe('2600000.00000000');
    expect(toCumulativePrincipalReturnRatePercent(traded).toFixed(8)).toBe(
      '21.66666667',
    );
  });

  it('recovers from -100% only through the principal after funding at a zero total', () => {
    const wiped = advanceGeneralPerformance({
      previous: {
        totalAssetKrw: d('10000000'),
        timeWeightedReturnFactor: d('1'),
      },
      currentTotalAssetKrw: '0',
      cumulativeExternalFundingKrw: '10000000',
    });
    expect(toCumulativePrincipalReturnRatePercent(wiped).toFixed(8)).toBe(
      '-100.00000000',
    );

    const { after } = buildExternalFundingBoundary({
      previous: wiped,
      totalAssetBeforeKrw: '0',
      cumulativeExternalFundingBeforeKrw: '10000000',
      externalFundingAmountKrw: '1000000',
    });
    // The 10,000,000 loss is still a loss; only the principal grew.
    expect(after.investmentPnlKrw.toFixed(8)).toBe('-10000000.00000000');
    expect(toCumulativePrincipalReturnRatePercent(after).toFixed(8)).toBe(
      '-90.90909091',
    );
  });

  it('is exactly 0% at a performance origin', () => {
    expect(
      toCumulativePrincipalReturnRatePercent(
        buildGeneralPerformanceOrigin('10000000'),
      ).toFixed(8),
    ).toBe('0.00000000');
  });
});
