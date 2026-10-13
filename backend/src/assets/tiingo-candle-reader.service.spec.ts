jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { AssetType, CurrencyCode } from '../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveMarketSession,
} from '../orders/market-calendar.policy';
import { TiingoError } from '../providers/tiingo/tiingo.errors';
import { TiingoCandleService } from '../providers/tiingo/tiingo-candle.service';
import type { TiingoQuoteService } from '../providers/tiingo/tiingo-quote.service';
import type { TiingoRestClient } from '../providers/tiingo/tiingo-rest.client';
import type {
  AssetCandlesAsset,
  ParsedAssetCandlesQuery,
  TiingoCandleSource,
} from './asset-candles.service';
import { CandleReadPlanBuilder } from './candle-read-plan.builder';
import { CandleResponseBuilder } from './candle-response.builder';
import { readCandleServingConfig } from './candle-serving.config';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import type { MarketCandlesRepository } from './market-candles.repository';
import {
  TiingoCandleReaderService,
  TiingoCandleUnavailableError,
} from './tiingo-candle-reader.service';

const ASSET: AssetCandlesAsset = {
  id: 'asset-aapl',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  market: 'NAS',
  assetType: AssetType.us_stock,
  currencyCode: CurrencyCode.USD,
  priceCurrency: CurrencyCode.USD,
  settlementCurrency: CurrencyCode.USD,
  isActive: true,
};
const TARGET = {
  assetId: 'asset-aapl',
  symbol: 'AAPL',
  market: 'NAS',
  ticker: 'aapl',
};

/** Synthetic regular-session 5m bars for one US date (never real data). */
function sessionBars(
  localDate: string,
  skip: (index: number) => boolean = () => false,
) {
  const session = resolveMarketSession('US', localDate.replaceAll('-', ''))!;
  const bars: Record<string, unknown>[] = [];
  let index = 0;
  for (
    let time = session.openTime.getTime();
    time < session.closeTime.getTime();
    time += 300_000, index += 1
  ) {
    if (skip(index)) continue;
    bars.push({
      date: new Date(time).toISOString(),
      open: 100 + index,
      high: 100 + index + 0.5,
      low: 100 + index - 0.5,
      close: 100 + index + 0.25,
      volume: 10,
    });
  }
  return bars;
}

function sessionDates(start: string, end: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = Date.parse(`${start}T00:00:00.000Z`);
    cursor <= Date.parse(`${end}T00:00:00.000Z`);
    cursor += 86_400_000
  ) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    if (resolveMarketSession('US', date.replaceAll('-', ''))) dates.push(date);
  }
  return dates;
}

function createReader(options: {
  intraday?: (start: string, end: string) => unknown;
  daily?: unknown;
}) {
  const rest = {
    getIntradayPrices: jest.fn(
      async (_s: string, input: { startDate: string; endDate: string }) => ({
        json: await Promise.resolve(
          options.intraday
            ? options.intraday(input.startDate, input.endDate)
            : sessionDates(input.startDate, input.endDate).flatMap((date) =>
                sessionBars(date),
              ),
        ),
        receivedAt: new Date(),
        bytes: 1,
      }),
    ),
    getDailyPrices: jest.fn(() =>
      Promise.resolve({
        json: options.daily ?? [],
        receivedAt: new Date(),
        bytes: 1,
      }),
    ),
  };
  const quotes = {
    isEnabled: () => true,
    targetForAsset: jest.fn().mockResolvedValue(TARGET),
  } as unknown as TiingoQuoteService;
  const reader = new TiingoCandleReaderService(
    quotes,
    new TiingoCandleService(rest as unknown as TiingoRestClient),
    new CandleReadPlanBuilder(readCandleServingConfig({})),
    new MarketCandleAggregationService({} as MarketCandlesRepository),
    new CandleResponseBuilder(),
  );
  return { reader, rest };
}

function query(
  interval: ParsedAssetCandlesQuery['interval'],
  from: Date,
  now: Date,
  limit = 600,
): ParsedAssetCandlesQuery {
  const minutes = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
    '1w': 10080,
  };
  return {
    range: interval === '4h' ? '96d' : '1y',
    rangeProvided: true,
    rangeStartAt: from,
    rangeEndAt: now,
    interval,
    intervalMinutes: minutes[interval],
    limit,
    requestedDate: now.toISOString().slice(0, 10),
    toHHmmss: '000000',
    toInstant: now,
    dateProvided: true,
    toProvided: true,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock: now,
  };
}

const source = (response: { data: { source: unknown } }) =>
  response.data.source as TiingoCandleSource;

describe('TiingoCandleReaderService', () => {
  it('builds US 4h buckets 09:30–13:30 and 13:30–16:00 from 5m bars', async () => {
    const { reader } = createReader({});
    const now = new Date('2026-10-13T12:00:00.000Z'); // 08:00 ET, before open
    const { response } = await reader.read(
      ASSET,
      TARGET,
      query('4h', new Date('2026-10-12T13:30:00.000Z'), now),
    );
    expect(response.data.candles.map((c) => c.time)).toEqual([
      '2026-10-12T13:30:00.000Z',
      '2026-10-12T17:30:00.000Z',
    ]);
    // 48 bars (09:30–13:25) then 30 bars (13:30–15:55).
    expect(response.data.candles[0]).toMatchObject({
      open: '100.00000000',
      high: '147.50000000',
      low: '99.50000000',
      close: '147.25000000',
      volume: '480.00000000',
    });
    expect(response.data.candles[1]).toMatchObject({
      open: '148.00000000',
      close: '177.25000000',
      volume: '300.00000000',
    });
    expect(source(response)).toMatchObject({
      provider: 'tiingo',
      dataset: 'equity_intraday',
      persisted: false,
      priceAdjustment: 'raw',
      coverage: 'complete',
      currentCandleTime: null,
    });
  });

  it('caps the early-close session into one 09:30–13:00 bucket', async () => {
    const { reader } = createReader({});
    const now = new Date('2026-11-28T15:00:00.000Z');
    const { response } = await reader.read(
      ASSET,
      TARGET,
      query('4h', new Date('2026-11-27T14:30:00.000Z'), now),
    );
    expect(response.data.candles).toHaveLength(1);
    expect(response.data.candles[0]).toMatchObject({
      time: '2026-11-27T14:30:00.000Z',
      close: '141.25000000',
      volume: '420.00000000',
    });
  });

  it('follows the America/New_York clock across the DST change', async () => {
    const { reader } = createReader({});
    const now = new Date('2026-11-03T12:00:00.000Z');
    const { response } = await reader.read(
      ASSET,
      TARGET,
      query('4h', new Date('2026-10-30T13:30:00.000Z'), now),
    );
    expect(response.data.candles.map((c) => c.time)).toEqual([
      '2026-10-30T13:30:00.000Z', // EDT 09:30
      '2026-10-30T17:30:00.000Z', // EDT 13:30
      '2026-11-02T14:30:00.000Z', // EST 09:30
      '2026-11-02T18:30:00.000Z', // EST 13:30
    ]);
  });

  it('serves a 96-session window from the 30 sessions that exist (partial)', async () => {
    const now = new Date('2026-10-13T12:00:00.000Z');
    const available = sessionDates('2026-08-01', '2026-10-12').slice(-30);
    const { reader, rest } = createReader({
      intraday: (start, end) =>
        sessionDates(start, end)
          .filter((date) => available.includes(date))
          .flatMap((date) => sessionBars(date)),
    });
    const anchor = findPreviousMarketSession(ASSET, now, 96)!;
    const { response, droppedIncompleteBuckets } = await reader.read(
      ASSET,
      TARGET,
      query('4h', anchor.openTime, now),
    );
    expect(response.data.state).toBe('available');
    expect(response.data.candles).toHaveLength(60);
    expect(droppedIncompleteBuckets).toBe(0);
    expect(source(response)).toMatchObject({
      coverage: 'partial',
      requestedSessions: 96,
      coveredSessions: 30,
    });
    // 96 sessions in requests of at most 16 sessions.
    expect(rest.getIntradayPrices).toHaveBeenCalledTimes(6);
  });

  it('answers an empty window with no data as empty, not as an error', async () => {
    const { reader } = createReader({ intraday: () => [] });
    const now = new Date('2026-10-13T12:00:00.000Z');
    const { response } = await reader.read(
      ASSET,
      TARGET,
      query('4h', new Date('2026-10-05T13:30:00.000Z'), now),
    );
    expect(response.data.state).toBe('empty');
    expect(source(response).coverage).toBe('empty');
  });

  it('fails explicitly when the provider fails and nothing is held', async () => {
    const { reader } = createReader({
      intraday: () => {
        throw new TiingoError('TIINGO_UNAUTHORIZED', false, 401);
      },
    });
    const now = new Date('2026-10-13T12:00:00.000Z');
    await expect(
      reader.read(
        ASSET,
        TARGET,
        query('4h', new Date('2026-10-05T13:30:00.000Z'), now),
      ),
    ).rejects.toBeInstanceOf(TiingoCandleUnavailableError);
  });

  it('marks the in-progress bucket and drops an incomplete historical one', async () => {
    const now = new Date('2026-10-13T18:02:00.000Z'); // 14:02 ET
    const { reader } = createReader({
      intraday: (start, end) =>
        sessionDates(start, end).flatMap((date) =>
          date === '2026-10-12'
            ? sessionBars(date, (index) => index === 10) // hole in the morning
            : sessionBars(date),
        ),
    });
    const { response, droppedIncompleteBuckets } = await reader.read(
      ASSET,
      TARGET,
      query('4h', new Date('2026-10-12T13:30:00.000Z'), now),
    );
    expect(droppedIncompleteBuckets).toBe(1);
    expect(response.data.candles.map((c) => c.time)).toEqual([
      '2026-10-12T17:30:00.000Z',
      '2026-10-13T13:30:00.000Z',
      '2026-10-13T17:30:00.000Z',
    ]);
    expect(source(response)).toMatchObject({
      coverage: 'partial',
      currentCandleTime: '2026-10-13T17:30:00.000Z',
    });
  });

  it('flags the forming 5m bar', async () => {
    const now = new Date('2026-10-13T18:02:00.000Z');
    const { reader } = createReader({});
    const { response } = await reader.read(
      ASSET,
      TARGET,
      query('5m', new Date('2026-10-13T13:30:00.000Z'), now),
    );
    expect(response.data.candles.at(-1)?.time).toBe('2026-10-13T18:00:00.000Z');
    expect(source(response).currentCandleTime).toBe('2026-10-13T18:00:00.000Z');
  });

  it('uses adjusted EOD bars and a provisional bar for today', async () => {
    const now = new Date('2026-10-13T18:02:00.000Z');
    const { reader } = createReader({
      daily: [
        {
          date: '2026-10-09T00:00:00.000Z',
          open: 200,
          high: 210,
          low: 190,
          close: 205,
          volume: 1000,
          adjOpen: 100,
          adjHigh: 105,
          adjLow: 95,
          adjClose: 102.5,
          adjVolume: 2000,
        },
        {
          date: '2026-10-12T00:00:00.000Z',
          open: 206,
          high: 212,
          low: 204,
          close: 210,
          volume: 1000,
          adjOpen: 103,
          adjHigh: 106,
          adjLow: 102,
          adjClose: 105,
          adjVolume: 2000,
        },
        {
          date: '2026-10-08T00:00:00.000Z',
          open: 1,
          high: 2,
          low: 1,
          close: 2,
          volume: 1,
        },
      ],
    });
    const { response, droppedIncompleteBuckets } = await reader.read(
      ASSET,
      TARGET,
      query('1d', new Date('2026-10-01T04:00:00.000Z'), now),
    );
    expect(droppedIncompleteBuckets).toBe(1); // the bar without adjusted values
    expect(response.data.candles.map((c) => [c.time, c.close])).toEqual([
      ['2026-10-09T04:00:00.000Z', '102.50000000'],
      ['2026-10-12T04:00:00.000Z', '105.00000000'],
      ['2026-10-13T04:00:00.000Z', '154.25000000'],
    ]);
    expect(source(response)).toMatchObject({
      dataset: 'eod',
      priceAdjustment: 'split_dividend_adjusted',
      currentCandleTime: '2026-10-13T04:00:00.000Z',
    });

    const weekly = await reader.read(
      ASSET,
      TARGET,
      query('1w', new Date('2026-10-01T04:00:00.000Z'), now),
    );
    expect(weekly.response.data.candles.map((c) => c.time)).toEqual([
      '2026-10-05T04:00:00.000Z',
      '2026-10-12T04:00:00.000Z',
    ]);
    expect(weekly.response.data.candles[1]).toMatchObject({
      open: '103.00000000',
      close: '154.25000000',
    });
  });

  it('starts a daily window at a whole day, like stored reads', async () => {
    const now = new Date('2026-10-13T22:30:00.000Z'); // 18:30 ET, EOD posted
    const eod = (date: string, close: number) => ({
      date: `${date}T00:00:00.000Z`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 10,
      adjOpen: close,
      adjHigh: close,
      adjLow: close,
      adjClose: close,
      adjVolume: 10,
    });
    const { reader } = createReader({
      daily: [
        eod('2026-10-08', 101),
        eod('2026-10-09', 102),
        eod('2026-10-12', 103),
        eod('2026-10-13', 104),
      ],
    });
    // The window opens mid-session on 10-08: that day's bucket started
    // before it, so neither the bar nor the session is counted.
    const { response } = await reader.read(
      ASSET,
      TARGET,
      query('1d', new Date('2026-10-08T15:00:00.000Z'), now),
    );
    expect(response.data.candles.map((c) => c.time)).toEqual([
      '2026-10-09T04:00:00.000Z',
      '2026-10-12T04:00:00.000Z',
      '2026-10-13T04:00:00.000Z',
    ]);
    expect(source(response)).toMatchObject({
      coverage: 'complete',
      requestedSessions: 3,
      coveredSessions: 3,
    });
  });

  it('returns a confirmed-empty weekend window without calling Tiingo', async () => {
    const { reader, rest } = createReader({});
    const { response } = await reader.read(
      ASSET,
      TARGET,
      query(
        '5m',
        new Date('2026-10-17T04:00:00.000Z'),
        new Date('2026-10-18T20:00:00.000Z'),
      ),
    );
    expect(response.data.state).toBe('empty');
    expect(rest.getIntradayPrices).not.toHaveBeenCalled();
  });
});
