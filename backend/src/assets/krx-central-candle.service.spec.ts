jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: { DbNull: Symbol('Prisma.DbNull') },
  AssetType: { domestic_stock: 'domestic_stock' },
  CurrencyCode: { KRW: 'KRW' },
  MarketCandleSyncMode: { repair: 'repair' },
}));
jest.mock('./market-candle-sync.service', () => ({
  MarketCandleSyncService: class MarketCandleSyncService {},
}));
jest.mock('./market-candle-sync-state.repository', () => ({
  MarketCandleSyncStateRepository: class MarketCandleSyncStateRepository {},
}));

import { Logger } from '@nestjs/common';
import { readKoscomConfig } from '../providers/koscom/koscom.config';
import { KrxCentralCandleService } from './krx-central-candle.service';
import { readKrxCentralCandlesConfig } from './krx-central-candles.config';

/**
 * 3c (design v2.1 §7.6 step 2): under budget pressure the central intraday
 * 1m tick drops to every other bucket — the next tick's window covers the
 * skipped one — and stops while P3 is not admitted at all.
 */
const kst = (local: string) => new Date(`${local}+09:00`);
const COHORTS = [
  {
    id: 'cohort-1',
    obligationStart: '2026-10-14T15:00:00.000Z',
    symbols: ['005930', '000660'],
  },
];

function create(enforced: boolean) {
  const prisma = {
    asset: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'a1', symbol: '000660' },
        { id: 'a2', symbol: '005930' },
      ]),
    },
  };
  const sync = {
    syncAsset: jest.fn().mockResolvedValue({
      feeds: [{ status: 'completed', pagesFetched: 1 }],
    }),
  };
  const states = {
    findCheckpointsOverlapping: jest.fn().mockResolvedValue([]),
  };
  const budget = { p3Cadence: jest.fn().mockResolvedValue('normal') };
  const koscom = readKoscomConfig({
    KOSCOM_API_KEY: 'k',
    PROVIDER_INGESTION_ENABLED: 'true',
    KOSCOM_BUDGET_ENFORCEMENT_ENABLED: enforced ? 'true' : 'false',
  });
  const service = new KrxCentralCandleService(
    prisma as never,
    sync as never,
    states as never,
    {} as never,
    readKrxCentralCandlesConfig(
      { KOSCOM_CENTRAL_CANDLES_ENABLED: 'true' },
      COHORTS,
    ),
    budget as never,
    { getConfig: () => koscom } as never,
  );
  return { service, sync, budget, koscom };
}

describe('central KRX 1m cadence under the budget governor (3c)', () => {
  it('skips odd buckets when reduced and passes the projected remaining P3', async () => {
    const h = create(true);
    h.budget.p3Cadence.mockResolvedValue('reduced');
    // 10:01:10 collects bucket 12 (even): runs.
    const even = await h.service.runIntradayTick({
      now: kst('2026-10-15T10:01:10'),
    });
    expect(even.skippedReason === undefined).toBe(true);
    expect(h.sync.syncAsset).toHaveBeenCalledTimes(2);
    const input = (h.budget.p3Cadence.mock.calls as unknown[][])[0][0] as {
      namespace: string;
      projectedP3: number;
      caps: unknown;
    };
    // Ticks 10:01:10 … 15:31:10 (67) for 2 obligated stocks.
    expect(input.projectedP3).toBe(2 * 67);
    expect(input.namespace).toBe(h.koscom.namespace);
    expect(input.caps).toEqual({ dailyCap: 50_000, monthlyCap: 1_000_000 });
    // 10:06:10 collects bucket 13 (odd): skipped, nothing requested.
    const odd = await h.service.runIntradayTick({
      now: kst('2026-10-15T10:06:10'),
    });
    expect(odd.skippedReason).toBe('BUDGET_P3_REDUCED');
    expect(h.sync.syncAsset).toHaveBeenCalledTimes(2);
  });

  it('runs no intraday request while P3 is not admitted', async () => {
    const h = create(true);
    h.budget.p3Cadence.mockResolvedValue('blocked');
    const summary = await h.service.runIntradayTick({
      now: kst('2026-10-15T10:01:10'),
    });
    expect(summary.skippedReason).toBe('BUDGET_P3_BLOCKED');
    expect(summary.assets).toBe(2);
    expect(h.sync.syncAsset).not.toHaveBeenCalled();
  });

  it('never consults the governor while enforcement is off', async () => {
    const h = create(false);
    await h.service.runIntradayTick({ now: kst('2026-10-15T10:06:10') });
    expect(h.budget.p3Cadence).not.toHaveBeenCalled();
    expect(h.sync.syncAsset).toHaveBeenCalledTimes(2);
  });
});

/**
 * 2026-10-18: the latest session's KOSCOM daily is provisional when the
 * post-close phases store it (NXT after-market until 20:00), so the daily
 * phase also re-reads the previous session — before the open on its own,
 * and inside today's first post-close request.
 */
describe('central KRX daily re-read of the previous session', () => {
  it('before the open re-reads only the previous session, one 1d request per asset', async () => {
    const { service, sync } = create(false);
    sync.syncAsset.mockResolvedValue({
      feeds: [{ status: 'completed', pagesFetched: 1, coverageComplete: true }],
    });

    // Monday 2026-10-19 08:30 KST → Friday 10-16.
    const summary = await service.runDaily({ now: kst('2026-10-19T08:30:00') });

    expect(summary.sessionDate).toBe('2026-10-16');
    expect(summary.attempted).toBe(2);
    expect(summary.proven).toBe(2);
    expect(sync.syncAsset).toHaveBeenCalledTimes(2);
    for (const [call] of sync.syncAsset.mock.calls)
      expect(call).toMatchObject({
        targets: ['1d'],
        mode: 'repair',
        from: kst('2026-10-16T00:00:00'),
        to: kst('2026-10-17T00:00:00'),
      });
  });

  it('reports a previous-session bar that is still unconfirmed', async () => {
    const { service, sync } = create(false);
    sync.syncAsset.mockResolvedValue({
      feeds: [
        {
          status: 'completed',
          pagesFetched: 1,
          coverageComplete: false,
          completionReason: 'unconfirmed',
        },
      ],
    });

    const summary = await service.runDaily({ now: kst('2026-10-19T08:30:00') });

    expect(summary.proven).toBe(0);
    expect(summary.partial).toBe(2);
    expect(summary.unprovenAssets.map((entry) => entry.symbol)).toEqual([
      '000660',
      '005930',
    ]);
  });

  it("still refuses an open session and starts today's post-close request at the previous session", async () => {
    const { service, sync } = create(false);
    expect(
      (await service.runDaily({ now: kst('2026-10-19T10:00:00') }))
        .skippedReason,
    ).toBe('SESSION_NOT_CLOSED');
    expect(sync.syncAsset).not.toHaveBeenCalled();

    (service as unknown as { states: object }).states = {
      findCandleCoverage: jest.fn().mockResolvedValue({
        contiguousCoveredTo: kst('2026-10-19T00:00:00'),
        hasInteriorGap: false,
      }),
    };
    await service.runDaily({ now: kst('2026-10-19T15:50:00') });
    for (const [call] of sync.syncAsset.mock.calls)
      expect(call).toMatchObject({
        targets: ['1d'],
        from: kst('2026-10-16T00:00:00'),
        to: kst('2026-10-19T15:50:00'),
      });
    expect(sync.syncAsset).toHaveBeenCalledTimes(2);
  });
});

/**
 * Closing-price evidence (2026-10-18): the closing-auction buckets are never
 * required slots, yet they hold the KRX close the closed-market display
 * shows. KOSCOM publishes the 15:30 print minutes late (10-16: 15:25 bucket
 * stored at 15:42), so post-close repair requests the window when missing.
 */
describe('central KRX post-close repair of the closing-auction window', () => {
  // Thu 2026-10-15, 09:00–15:30 KST; repair phase at 15:40.
  const at = kst('2026-10-15T15:40:00');
  const provenThrough1520 = {
    mode: 'repair',
    status: 'completed',
    coverageComplete: true,
    targetFrom: kst('2026-10-15T09:00:00'),
    targetTo: kst('2026-10-15T15:20:00'),
    coveredFrom: kst('2026-10-15T09:00:00'),
    coveredTo: kst('2026-10-15T15:20:00'),
    createdAt: kst('2026-10-15T15:21:10'),
    auditPhase: 'intraday',
    auditFirstMissingMs: null,
  };
  const auctionAttempt = {
    ...provenThrough1520,
    targetFrom: kst('2026-10-15T15:20:00'),
    targetTo: kst('2026-10-15T15:30:00'),
    coveredFrom: kst('2026-10-15T15:20:00'),
    coveredTo: kst('2026-10-15T15:30:00'),
    createdAt: kst('2026-10-15T15:40:05'),
    auditPhase: 'repair',
  };
  function repairHarness(storedCounts: number[], rows: object[] = []) {
    const { service, sync } = create(false);
    const count = jest.fn();
    for (const stored of storedCounts) count.mockResolvedValueOnce(stored);
    const internals = service as unknown as {
      prisma: { asset: unknown; marketCandle: unknown };
      states: unknown;
    };
    internals.prisma.marketCandle = { count };
    internals.states = {
      countAuditedRuns: jest.fn().mockResolvedValue(0),
      findCheckpointsOverlapping: jest
        .fn()
        .mockResolvedValue([provenThrough1520, ...rows]),
    };
    return { service, sync, count };
  }

  it('requests the auction window once when its buckets are missing, then reports it stored', async () => {
    // Per asset: missing before, stored after the request.
    const { service, sync, count } = repairHarness([0, 2, 0, 2]);

    const summary = await service.runRepair({ now: at });

    expect(sync.syncAsset).toHaveBeenCalledTimes(2);
    for (const [call] of sync.syncAsset.mock.calls)
      expect(call).toMatchObject({
        targets: ['5m'],
        mode: 'repair',
        from: kst('2026-10-15T15:20:00'),
        to: kst('2026-10-15T15:30:00'),
        krxAudit: { phase: 'repair' },
      });
    expect(count).toHaveBeenCalledWith({
      where: {
        assetId: 'a1',
        interval: '5m',
        isClosed: true,
        sourceProvider: 'koscom_intraday',
        openTime: {
          gte: kst('2026-10-15T15:20:00'),
          lt: kst('2026-10-15T15:30:00'),
        },
      },
    });
    expect(summary.closingAuctionMissing).toEqual([]);
    // Required-slot completeness is judged separately and was already proven.
    expect(summary.proven).toBe(2);
    expect(summary.unprovenAssets).toEqual([]);
  });

  it('makes no request when the auction buckets are already stored', async () => {
    const { service, sync } = repairHarness([2, 2]);
    const summary = await service.runRepair({ now: at });
    expect(sync.syncAsset).not.toHaveBeenCalled();
    expect(summary.closingAuctionMissing).toEqual([]);
  });

  it('reports a still-missing auction (never a silent success) and stops after two requests', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const first = repairHarness([0, 1, 0, 0]);
      const summary = await first.service.runRepair({ now: at });
      expect(first.sync.syncAsset).toHaveBeenCalledTimes(2);
      expect(summary.closingAuctionMissing).toEqual(['000660', '005930']);
      expect(summary.proven).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('krx_central_closing_auction_missing'),
      );

      const exhausted = repairHarness([0, 0], [auctionAttempt, auctionAttempt]);
      const again = await exhausted.service.runRepair({ now: at });
      expect(exhausted.sync.syncAsset).not.toHaveBeenCalled();
      expect(again.closingAuctionMissing).toEqual(['000660', '005930']);
    } finally {
      warn.mockRestore();
    }
  });
});
