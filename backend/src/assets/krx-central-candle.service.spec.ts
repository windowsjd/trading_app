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
