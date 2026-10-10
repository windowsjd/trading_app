import {
  evaluateFuturesReadiness,
  type FuturesReadinessRow,
} from './futures-readiness';

describe('Futures release readiness (independent of current mode)', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const config = {
    tradingMode: 'DISABLED' as const,
    riskEngine: true,
    markIngestion: true,
    lastPriceIngestion: true,
  };
  const row = (
    patch: Partial<FuturesReadinessRow> = {},
  ): FuturesReadinessRow => ({
    symbol: 'BTCUSDT',
    instrumentId: 'btc',
    active: true,
    coverage: 'verified',
    last: { valid: true },
    mark: { valid: true },
    openPositions: 0,
    pendingEntries: 0,
    liveProtections: 0,
    ...patch,
  });
  const evaluate = (rows = [row()], flags = config) =>
    evaluateFuturesReadiness(rows, [], flags, now);
  it('passes all launch targets while DISABLED without claiming new trading or idle worker liveness', () => {
    expect(evaluate().readiness).toEqual({
      launchReady: true,
      existingWorkReady: true,
      newTradingAvailable: false,
      userExitsAvailable: false,
    });
  });
  it('fails 22 expired instruments plus one healthy instrument', () => {
    const result = evaluate([
      row(),
      ...Array.from({ length: 22 }, (_, i) =>
        row({ instrumentId: `expired-${i}`, coverage: 'expired_or_invalid' }),
      ),
    ]);
    expect(result.summary.required).toBe(23);
    expect(result.blockers).toHaveLength(22);
    expect(result.readiness.launchReady).toBe(false);
  });
  it.each(['unverified', 'expired_or_invalid'])(
    'never hides an active %s instrument (including newly registered/unsupported contracts)',
    (coverage) => {
      expect(
        evaluate([row(), row({ instrumentId: 'other', coverage })]).readiness
          .launchReady,
      ).toBe(false);
    },
  );
  it.each([
    { last: null },
    { last: { valid: false } },
    { mark: { valid: false } },
  ])(
    'fails missing, invalid, future or stopped-price evidence: %j',
    (patch) => {
      expect(evaluate([row(patch)]).readiness.launchReady).toBe(false);
    },
  );
  it.each(['riskEngine', 'markIngestion', 'lastPriceIngestion'] as const)(
    'fails required %s config despite fresh stored prices',
    (key) => {
      expect(
        evaluate(undefined, { ...config, [key]: false }).readiness.launchReady,
      ).toBe(false);
    },
  );
  it('excludes intentionally inactive unsupported instruments without work; empty catalog cannot pass', () => {
    const inactive = row({
      active: false,
      coverage: 'unverified',
      last: null,
      mark: { valid: false },
    });
    expect(evaluate([row(), inactive]).readiness.launchReady).toBe(true);
    expect(evaluate([inactive]).readiness.launchReady).toBe(false);
    expect(evaluate([]).readiness.launchReady).toBe(false);
  });
  it('includes inactive instruments with open positions and requires risk observations', () => {
    const result = evaluate([
      row(),
      row({
        active: false,
        coverage: 'unverified',
        openPositions: 1,
        last: null,
      }),
    ]);
    expect(result.summary.required).toBe(2);
    expect(result.readiness.existingWorkReady).toBe(false);
    expect(result.blockers.map((b) => b.reason)).toContain('WORKER_UNOBSERVED');
  });
  it.each([
    'futures_limit_matching',
    'conditional_orders',
    'futures_liquidation',
  ])(
    'requires a recent actual successful %s cycle when work exists',
    (jobName) => {
      const work = row({
        [jobName === 'futures_limit_matching'
          ? 'pendingEntries'
          : jobName === 'conditional_orders'
            ? 'liveProtections'
            : 'openPositions']: 1,
      });
      const run = {
        jobName,
        status: 'succeeded',
        startedAt: new Date(+now - 1000).toISOString(),
        finishedAt: now.toISOString(),
      };
      const test = (patch = {}) =>
        evaluateFuturesReadiness([work], [{ ...run, ...patch }], config, now)
          .readiness.launchReady;
      expect(test()).toBe(true);
      expect(test({ status: 'failed' })).toBe(false);
      expect(test({ status: 'running', finishedAt: null })).toBe(false);
      expect(
        test({
          startedAt: new Date(+now - 121000).toISOString(),
          finishedAt: new Date(+now - 120001).toISOString(),
        }),
      ).toBe(false);
      expect(test({ finishedAt: new Date(+now + 1).toISOString() })).toBe(
        false,
      );
      expect(test({ resultJson: { states: { FUTURES_PRICE_STALE: 1 } } })).toBe(
        false,
      );
      expect(
        test({
          resultJson: {
            results: [{ failure: { code: 'FUTURES_MARK_STALE' } }],
          },
        }),
      ).toBe(false);
    },
  );
  it('does not mistake optional retention or idle worker failures for live execution failures', () => {
    const result = evaluateFuturesReadiness(
      [row()],
      [
        {
          jobName: 'futures_last_price_retention',
          status: 'failed',
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
        },
      ],
      config,
      now,
    );
    expect(result.readiness.launchReady).toBe(true);
    expect(result.workers[0].status).toBe('failed');
  });
  it.each([
    [
      'futures_limit_matching',
      'FUTURES_ENTRY_LIMIT_NOT_REACHED',
      'pendingEntries',
    ],
    ['conditional_orders', 'CONDITIONAL_LIMIT_NOT_REACHED', 'liveProtections'],
  ])(
    'keeps %s predicate waits healthy without hiding stale-price failures',
    (jobName, state, demand) => {
      const work = row({ [demand]: 1 });
      const run = {
        jobName,
        status: 'succeeded',
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        resultJson: { states: { [state]: 1 } },
      };
      expect(
        evaluateFuturesReadiness([work], [run], config, now).readiness
          .launchReady,
      ).toBe(true);
      expect(
        evaluateFuturesReadiness(
          [work],
          [
            {
              ...run,
              resultJson: { states: { [state]: 1, FUTURES_PRICE_STALE: 1 } },
            },
          ],
          config,
          now,
        ).readiness.launchReady,
      ).toBe(false);
    },
  );
  it('fresh current prices cannot conceal missing historical season-end evidence', () => {
    const result = evaluateFuturesReadiness([row()], [], config, now, [
      {
        seasonId: 'ended',
        instrumentId: 'btc',
        endAt: now.toISOString(),
        evidence: 'missing_or_invalid',
        ready: false,
      },
    ]);
    expect(result.readiness.launchReady).toBe(false);
    expect(result.readiness.existingWorkReady).toBe(false);
    expect(result.blockers[0].reason).toBe(
      'FINAL_SETTLEMENT_EVIDENCE_MISSING_OR_INVALID',
    );
  });
});
