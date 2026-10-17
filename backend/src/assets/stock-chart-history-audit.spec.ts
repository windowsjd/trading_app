jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
  PrismaClient: class PrismaClient {},
}));

import { resolvePeriodWindowForDate } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import type { MarketSessionWindow } from '../orders/market-calendar.policy';
import type { PrismaService } from '../prisma/prisma.service';
import { resolveRequiredFiveMinuteSlotEndMs } from './candle-expected-slots.policy';
import {
  StockChartHistoryAudit,
  plannedFourHourBuckets,
  previousSessions,
  type StockChartAssetReport,
  type StockChartKey,
} from './stock-chart-history-audit';

// Saturday 12:00 KST = Friday 23:00 New York: the KRX window starts with the
// 2026-10-16 session, the US window with 2026-10-15 (today is not counted).
const NOW = new Date('2026-10-17T03:00:00.000Z');
const FIVE_MINUTES_MS = 5 * 60_000;
const TIINGO_ENV = { US_STOCK_PRICE_PROVIDER: 'tiingo' };
/** No listing, no KRX cohort, no measured provider depth. */
const NO_LIMITS = { listings: new Map<string, string>(), krxCohorts: [] };

type Row = {
  assetId: string;
  interval: '5m' | '4h' | '1d';
  openTime: Date;
  closeTime: Date;
  isClosed: boolean;
  sourceProvider: string;
};

type Asset = {
  id: string;
  symbol: string;
  assetType: 'domestic_stock' | 'us_stock';
  market: string;
  currencyCode: 'KRW' | 'USD';
  isActive: boolean;
};

const usAsset = (id: string, symbol: string): Asset => ({
  id,
  symbol,
  assetType: 'us_stock',
  market: 'NAS',
  currencyCode: 'USD',
  isActive: true,
});
const krxAsset = (id: string, symbol: string): Asset => ({
  id,
  symbol,
  assetType: 'domestic_stock',
  market: 'KRX',
  currencyCode: 'KRW',
  isActive: true,
});

function fakePrisma(
  assets: Asset[],
  rows: Row[],
): Pick<PrismaService, 'asset' | 'marketCandle'> {
  const fake = {
    asset: {
      findMany: jest.fn(({ where }: { where: { id?: { in: string[] } } }) =>
        Promise.resolve(
          assets.filter((asset) =>
            where.id ? where.id.in.includes(asset.id) : asset.isActive,
          ),
        ),
      ),
    },
    marketCandle: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: {
            assetId: string;
            interval: string;
            openTime: { gte: Date; lt: Date };
          };
        }) =>
          Promise.resolve(
            rows.filter(
              (row) =>
                row.assetId === where.assetId &&
                row.interval === where.interval &&
                row.openTime >= where.openTime.gte &&
                row.openTime < where.openTime.lt,
            ),
          ),
      ),
    },
  };
  return fake as unknown as Pick<PrismaService, 'asset' | 'marketCandle'>;
}

function sessions(market: 'KRX' | 'US', count: number): MarketSessionWindow[] {
  const result = previousSessions(market, NOW.getTime(), count);
  expect(result.calendarGap).toBe(false);
  return result.sessions;
}

function fiveMinuteRows(
  assetId: string,
  list: readonly MarketSessionWindow[],
  provider: string,
  skip: (session: MarketSessionWindow, slotMs: number) => boolean = () => false,
): Row[] {
  return list.flatMap((session) => {
    const rows: Row[] = [];
    const end = resolveRequiredFiveMinuteSlotEndMs(session);
    for (
      let slot = session.openTime.getTime();
      slot < end;
      slot += FIVE_MINUTES_MS
    )
      if (!skip(session, slot))
        rows.push({
          assetId,
          interval: '5m',
          openTime: new Date(slot),
          closeTime: new Date(slot + FIVE_MINUTES_MS),
          isClosed: true,
          sourceProvider: provider,
        });
    return rows;
  });
}

function fourHourRows(
  assetId: string,
  list: readonly MarketSessionWindow[],
  provider: string,
): Row[] {
  return list.flatMap((session) =>
    plannedFourHourBuckets(session).map((bucket) => ({
      assetId,
      interval: '4h' as const,
      openTime: new Date(bucket.openMs),
      closeTime: new Date(bucket.closeMs),
      isClosed: true,
      sourceProvider: provider,
    })),
  );
}

function dailyRows(
  assetId: string,
  market: 'KRX' | 'US',
  list: readonly MarketSessionWindow[],
  provider: string,
): Row[] {
  return list.map((session) => {
    const window = resolvePeriodWindowForDate(
      market,
      session.localDate.replace(/-/gu, ''),
      '1d',
    );
    if (!window) throw new Error(`no daily window for ${session.localDate}`);
    return {
      assetId,
      interval: '1d',
      openTime: window.openTime,
      closeTime: window.closeTime,
      isClosed: true,
      sourceProvider: provider,
    };
  });
}

function windowOf(report: StockChartAssetReport, chart: StockChartKey) {
  const window = report.windows.find((entry) => entry.chart === chart);
  if (!window) throw new Error(`no ${chart} window`);
  return window;
}

describe('StockChartHistoryAudit', () => {
  it('passes a US stock whose 5m, 4h and 1d history fills every chart window', async () => {
    const us = sessions('US', 576);
    const rows = [
      ...fiveMinuteRows('nvda', us.slice(0, 24), 'tiingo_equity_intraday'),
      ...fourHourRows('nvda', us.slice(0, 96), 'tiingo_equity_intraday_4h'),
      ...dailyRows('nvda', 'US', us, 'tiingo_eod'),
    ];
    const audit = new StockChartHistoryAudit(
      fakePrisma([usAsset('nvda', 'NVDA')], rows),
      NO_LIMITS,
      TIINGO_ENV,
    );
    const report = await audit.run({ now: NOW });
    expect(report.pass).toBe(true);
    expect(report.assets[0].windows.map((w) => [w.chart, w.state])).toEqual([
      ['5m', 'complete'],
      ['15m', 'complete'],
      ['30m', 'complete'],
      ['1h', 'complete'],
      ['4h', 'complete'],
      ['1d', 'complete'],
    ]);
    expect(windowOf(report.assets[0], '1d').sessionsExpected).toBe(576);
    expect(windowOf(report.assets[0], '4h').sessionsExpected).toBe(96);
    expect(report.summary.US['4h'].complete).toBe(1);
  });

  it('never calls 45 days of 5m a complete 96-session 4h history', async () => {
    const us = sessions('US', 576);
    // The 45-day 5m backfill (≈ 31 sessions) synthesized into 4h, and nothing older.
    const recent = us.filter(
      (session) =>
        session.openTime.getTime() >= NOW.getTime() - 45 * 24 * 60 * 60_000,
    );
    expect(recent.length).toBeGreaterThan(24);
    expect(recent.length).toBeLessThan(96);
    const rows = [
      ...fiveMinuteRows('avgo', recent, 'tiingo_equity_intraday'),
      ...fourHourRows('avgo', recent, 'tiingo_equity_intraday_4h'),
      ...dailyRows('avgo', 'US', us, 'tiingo_eod'),
    ];
    const report = await new StockChartHistoryAudit(
      fakePrisma([usAsset('avgo', 'AVGO')], rows),
      NO_LIMITS,
      TIINGO_ENV,
    ).run({ now: NOW });
    const fourHour = windowOf(report.assets[0], '4h');
    expect(fourHour.state).toBe('incomplete');
    expect(fourHour.sessionsCovered).toBe(recent.length);
    expect(fourHour.leadingMissing.count).toBe(96 - recent.length);
    expect(fourHour.interiorMissing.count).toBe(0);
    expect(windowOf(report.assets[0], '1h').state).toBe('complete');
    expect(windowOf(report.assets[0], '1d').state).toBe('complete');
    expect(report.pass).toBe(false);
    expect(report.summary.US['4h'].incompleteSymbols).toEqual(['AVGO']);
  });

  it('counts only the current US provider rows', async () => {
    const us = sessions('US', 576);
    const rows = [
      ...fiveMinuteRows('t', us.slice(0, 24), 'tiingo_equity_intraday'),
      ...fourHourRows('t', us.slice(0, 96), 'tiingo_equity_intraday_4h'),
      // A KIS daily row (left from before the switch) is never Tiingo history.
      ...dailyRows('t', 'US', us, 'kis_overseas_period'),
    ];
    const report = await new StockChartHistoryAudit(
      fakePrisma([usAsset('t', 'T')], rows),
      NO_LIMITS,
      TIINGO_ENV,
    ).run({ now: NOW });
    expect(windowOf(report.assets[0], '1d')).toMatchObject({
      state: 'incomplete',
      sessionsCovered: 0,
      firstCoveredSession: null,
    });
    expect(windowOf(report.assets[0], '4h').state).toBe('complete');
  });

  it('serves the recent 4h range from complete 5m without stored 4h rows', async () => {
    const us = sessions('US', 96);
    const recentFrom = NOW.getTime() - 30 * 24 * 60 * 60_000;
    const older = us.filter((s) => s.openTime.getTime() < recentFrom);
    const rows = [
      ...fiveMinuteRows('x', us.slice(0, 24), 'tiingo_equity_intraday'),
      ...fourHourRows('x', older, 'tiingo_equity_intraday_4h'),
    ];
    const report = await new StockChartHistoryAudit(
      fakePrisma([usAsset('x', 'X')], rows),
      NO_LIMITS,
      TIINGO_ENV,
    ).run({ now: NOW, markets: ['US'] });
    expect(windowOf(report.assets[0], '4h').state).toBe('complete');
  });

  it('never requires the KRX closing-auction slots and reports a missing slot as a hole', async () => {
    const krx = sessions('KRX', 576);
    expect(
      (resolveRequiredFiveMinuteSlotEndMs(krx[0]) - krx[0].openTime.getTime()) /
        FIVE_MINUTES_MS,
    ).toBe(76);
    const holeSession = krx[7];
    const rows = [
      ...fiveMinuteRows(
        'k',
        krx.slice(0, 24),
        'koscom_intraday',
        (session, slot) =>
          session.localDate === holeSession.localDate &&
          slot === session.openTime.getTime() + 12 * FIVE_MINUTES_MS,
      ),
      ...fourHourRows('k', krx.slice(0, 96), 'koscom_history_10m'),
      ...dailyRows('k', 'KRX', krx, 'koscom_history'),
    ];
    const report = await new StockChartHistoryAudit(
      fakePrisma([krxAsset('k', '009150')], rows),
      NO_LIMITS,
      TIINGO_ENV,
    ).run({ now: NOW });
    const asset = report.assets[0];
    expect(windowOf(asset, '5m').state).toBe('complete');
    expect(windowOf(asset, '15m').state).toBe('complete');
    expect(windowOf(asset, '30m')).toMatchObject({
      state: 'incomplete',
      interiorMissing: { count: 1, dates: [holeSession.localDate] },
    });
    expect(windowOf(asset, '1h').state).toBe('incomplete');
    expect(windowOf(asset, '4h').state).toBe('complete');
    expect(windowOf(asset, '1d').state).toBe('complete');
  });

  it('separates sessions before a recorded listing from missing data', async () => {
    const us = sessions('US', 576);
    const listing = us[40];
    const listed = us.slice(0, 41);
    const rows = [
      ...fiveMinuteRows('ipo', us.slice(0, 24), 'tiingo_equity_intraday'),
      ...fourHourRows('ipo', listed, 'tiingo_equity_intraday_4h'),
      ...dailyRows('ipo', 'US', listed, 'tiingo_eod'),
    ];
    const listings = new Map([['US:IPO', listing.localDate]]);
    const report = await new StockChartHistoryAudit(
      fakePrisma([usAsset('ipo', 'IPO')], rows),
      { listings, krxCohorts: [] },
      TIINGO_ENV,
    ).run({ now: NOW });
    const asset = report.assets[0];
    expect(asset.listedOn).toBe(listing.localDate);
    expect(windowOf(asset, '1d')).toMatchObject({
      state: 'limited_by_listing',
      sessionsCovered: 41,
      firstCoveredSession: listing.localDate,
      interiorMissing: { count: 0 },
    });
    expect(windowOf(asset, '4h').state).toBe('limited_by_listing');
    expect(report.pass).toBe(true);

    // A hole after the listing is still missing data.
    const holed = rows.filter(
      (row) =>
        !(
          row.interval === '1d' &&
          row.openTime.getTime() ===
            resolvePeriodWindowForDate(
              'US',
              us[10].localDate.replace(/-/gu, ''),
              '1d',
            )?.openTime.getTime()
        ),
    );
    const again = await new StockChartHistoryAudit(
      fakePrisma([usAsset('ipo', 'IPO')], holed),
      { listings, krxCohorts: [] },
      TIINGO_ENV,
    ).run({ now: NOW });
    expect(windowOf(again.assets[0], '1d')).toMatchObject({
      state: 'incomplete',
      interiorMissing: { count: 1, dates: [us[10].localDate] },
    });
  });

  it('reports KRX 5m windows before the collection start A as initial history, never 4h/1d', async () => {
    const krx = sessions('KRX', 576);
    // A = the first session date after the window: no 5m was collected yet.
    const obligationStart = '2026-10-18T15:00:00.000Z';
    const rows = [
      ...fourHourRows('n', krx.slice(0, 96), 'koscom_history_10m'),
      ...dailyRows('n', 'KRX', krx, 'koscom_history'),
    ];
    const report = await new StockChartHistoryAudit(
      fakePrisma([krxAsset('n', '009150')], rows),
      {
        listings: new Map(),
        krxCohorts: [{ id: 'c', obligationStart, symbols: ['009150'] }],
      },
      TIINGO_ENV,
    ).run({ now: NOW });
    const asset = report.assets[0];
    expect(asset.collectionStart).toBe(obligationStart);
    for (const chart of ['5m', '15m', '30m', '1h'] as const)
      expect(windowOf(asset, chart)).toMatchObject({
        state: 'limited_by_collection_start',
        unexplained: { count: 0 },
      });
    expect(windowOf(asset, '1h').explained.beforeCollectionStart).toBe(24);
    expect(windowOf(asset, '4h').state).toBe('complete');
    expect(windowOf(asset, '1d').state).toBe('complete');
    expect(report.pass).toBe(true);
    expect(report.summary.KRX['1h'].limitedByCollectionStart).toBe(1);

    // After A, a missing session is a collection defect.
    const afterStart = await new StockChartHistoryAudit(
      fakePrisma([krxAsset('n', '009150')], rows),
      {
        listings: new Map(),
        krxCohorts: [
          {
            id: 'c',
            obligationStart: '2026-10-11T15:00:00.000Z',
            symbols: ['009150'],
          },
        ],
      },
      TIINGO_ENV,
    ).run({ now: NOW });
    expect(windowOf(afterStart.assets[0], '5m')).toMatchObject({
      state: 'incomplete',
      unexplained: { count: 3 },
    });
  });

  it('labels US gaps older than a measured Tiingo intraday depth, and only when one is passed', async () => {
    const us = sessions('US', 576);
    const reachFrom = us[64].localDate; // 65 sessions of 5m history
    const reached = us.slice(0, 65);
    const rows = [
      ...fiveMinuteRows('p', us.slice(0, 24), 'tiingo_equity_intraday'),
      ...fourHourRows('p', reached, 'tiingo_equity_intraday_4h'),
      ...dailyRows('p', 'US', us, 'tiingo_eod'),
    ];
    const measured = await new StockChartHistoryAudit(
      fakePrisma([usAsset('p', 'P')], rows),
      { ...NO_LIMITS, usIntradayHistoryFrom: reachFrom },
      TIINGO_ENV,
    ).run({ now: NOW });
    expect(windowOf(measured.assets[0], '4h')).toMatchObject({
      state: 'limited_by_provider',
      sessionsCovered: 65,
      explained: { beforeProviderHistory: 31 },
      unexplained: { count: 0 },
    });
    expect(windowOf(measured.assets[0], '1d').state).toBe('complete');
    const assumed = await new StockChartHistoryAudit(
      fakePrisma([usAsset('p', 'P')], rows),
      NO_LIMITS,
      TIINGO_ENV,
    ).run({ now: NOW });
    expect(windowOf(assumed.assets[0], '4h').state).toBe('incomplete');
  });

  it('skips non-stock assets and limits the run to the requested market', async () => {
    const prisma = fakePrisma(
      [
        usAsset('u', 'U'),
        krxAsset('k', '000660'),
        { ...usAsset('c', 'BTC'), assetType: 'us_stock', market: 'BINANCE' },
      ],
      [],
    );
    const report = await new StockChartHistoryAudit(
      prisma,
      NO_LIMITS,
      TIINGO_ENV,
    ).run({ now: NOW, markets: ['KRX'] });
    expect(report.assets.map((a) => a.symbol)).toEqual(['000660']);
    expect(report.pass).toBe(false);
    expect(report.summary.KRX['1d'].incompleteSymbols).toEqual(['000660']);
  });
});
