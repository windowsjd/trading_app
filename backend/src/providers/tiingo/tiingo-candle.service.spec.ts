jest.mock('../../generated/prisma/client', () => {
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
  };
});

import { resolveMarketSession } from '../../orders/market-calendar.policy';
import { TiingoError } from './tiingo.errors';
import {
  listUsSessions,
  missingRuns,
  TiingoCandleService,
} from './tiingo-candle.service';
import type { TiingoRestClient } from './tiingo-rest.client';

/** Synthetic regular-session 5m bars (never real Tiingo data). */
function syntheticBars(
  localDate: string,
  extra: Record<string, unknown>[] = [],
) {
  const session = resolveMarketSession('US', localDate.replaceAll('-', ''))!;
  const bars: Record<string, unknown>[] = [];
  for (
    let time = session.openTime.getTime(), index = 0;
    time < session.closeTime.getTime();
    time += 300_000, index += 1
  ) {
    const base = 100 + index / 100;
    bars.push({
      date: new Date(time).toISOString(),
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base + 0.1,
      volume: 1000 + index,
    });
  }
  return [...bars, ...extra];
}

function datesBetween(start: string, end: string) {
  return listUsSessions(
    new Date(`${start}T00:00:00-04:00`),
    new Date(`${end}T23:59:59-04:00`),
  ).map((session) => session.localDate);
}

function createService(
  respond: (startDate: string, endDate: string) => unknown,
) {
  const rest = {
    getIntradayPrices: jest.fn(
      async (
        _symbol: string,
        input: { startDate: string; endDate: string },
      ) => ({
        json: await respond(input.startDate, input.endDate),
        receivedAt: new Date(),
        bytes: 1,
      }),
    ),
    getDailyPrices: jest.fn(),
  };
  return {
    service: new TiingoCandleService(rest as unknown as TiingoRestClient),
    rest,
  };
}

const bySessions = (startDate: string, endDate: string) =>
  datesBetween(startDate, endDate).flatMap((date) => syntheticBars(date));

describe('US session planning', () => {
  it('skips weekends, holidays and keeps early closes', () => {
    const sessions = listUsSessions(
      new Date('2026-11-25T00:00:00-05:00'),
      new Date('2026-11-30T23:00:00-05:00'),
    );
    expect(sessions.map((session) => session.localDate)).toEqual([
      '2026-11-25',
      '2026-11-27',
      '2026-11-30',
    ]);
    // Day after Thanksgiving closes at 13:00 ET.
    expect(sessions[1].closeTime.toISOString()).toBe(
      '2026-11-27T18:00:00.000Z',
    );
    expect(sessions[1].earlyClose).toBe(true);
  });

  it('splits only contiguous missing runs, newest first', () => {
    const sessions = listUsSessions(
      new Date('2026-10-01T00:00:00-04:00'),
      new Date('2026-10-09T23:00:00-04:00'),
    );
    const held = new Set(['2026-10-06']);
    const runs = missingRuns(
      sessions,
      (session) => !held.has(session.localDate),
      2,
    ).map((run) => run.map((session) => session.localDate));
    expect(runs).toEqual([
      ['2026-10-09', '2026-10-08'],
      ['2026-10-07'],
      ['2026-10-05', '2026-10-02'],
      ['2026-10-01'],
    ]);
  });
});

describe('TiingoCandleService', () => {
  const NOW = new Date('2026-10-13T18:02:00.000Z'); // 14:02 ET, session open

  it('loads regular-session bars, flags the forming bar and reuses memory', async () => {
    const { service, rest } = createService((start, end) =>
      bySessions(start, end),
    );
    const first = await service.loadFiveMinuteBars({
      symbol: 'AAPL',
      from: new Date('2026-10-12T13:30:00.000Z'),
      to: NOW,
      now: NOW,
      maxSessions: 10,
    });
    expect(first.coverage).toMatchObject({
      requestedSessions: 2,
      coveredSessions: 2,
      stopCode: null,
      requests: 1,
    });
    const last = first.rows.at(-1)!;
    expect(last.openTime.toISOString()).toBe('2026-10-13T18:00:00.000Z');
    expect(last.isClosed).toBe(false);
    expect(first.rows[0].isClosed).toBe(true);
    // A future bar of the live session is outside [from, to) and not returned.
    expect(first.rows.every((row) => row.openTime < NOW)).toBe(true);
    await service.loadFiveMinuteBars({
      symbol: 'AAPL',
      from: new Date('2026-10-12T13:30:00.000Z'),
      to: NOW,
      now: NOW,
      maxSessions: 10,
    });
    expect(rest.getIntradayPrices).toHaveBeenCalledTimes(1);
  });

  it('keeps the recent part when an older request fails (partial, never filled)', async () => {
    let calls = 0;
    const { service } = createService((start, end) => {
      calls += 1;
      if (calls > 1)
        throw new TiingoError('TIINGO_RATE_LIMITED', true, 429, 60_000);
      return bySessions(start, end);
    });
    const result = await service.loadFiveMinuteBars({
      symbol: 'AAPL',
      from: new Date('2026-09-01T13:30:00.000Z'),
      to: NOW,
      now: NOW,
      maxSessions: 140,
    });
    expect(result.coverage.stopCode).toBe('TIINGO_RATE_LIMITED');
    expect(result.coverage.coveredSessions).toBe(16);
    expect(result.coverage.unfetchedSessions).toBe(
      result.coverage.requestedSessions - 16,
    );
    expect(result.rows[0].openTime.toISOString() >= '2026-09-21').toBe(true);
  });

  it('reports sessions Tiingo returns no bars for as empty, not as data', async () => {
    const { service } = createService((start, end) =>
      bySessions(start, end).filter((bar) => String(bar.date) >= '2026-10-07'),
    );
    const result = await service.loadFiveMinuteBars({
      symbol: 'AAPL',
      from: new Date('2026-10-01T13:30:00.000Z'),
      to: NOW,
      now: NOW,
      maxSessions: 140,
    });
    expect(result.coverage.emptySessions).toBe(4);
    expect(result.coverage.coveredSessions).toBe(5);
  });

  it('excludes extended-hours and off-grid bars and bars without volume', async () => {
    const { service } = createService(() =>
      [
        ...syntheticBars('2026-10-12'),
        {
          date: '2026-10-12T12:00:00.000Z',
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        },
        {
          date: '2026-10-12T21:00:00.000Z',
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        },
        {
          date: '2026-10-12T14:02:00.000Z',
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        },
      ].map((bar) =>
        bar.date === '2026-10-12T14:00:00.000Z'
          ? { ...bar, volume: undefined }
          : bar,
      ),
    );
    const result = await service.loadFiveMinuteBars({
      symbol: 'AAPL',
      from: new Date('2026-10-12T00:00:00.000Z'),
      to: new Date('2026-10-13T00:00:00.000Z'),
      now: NOW,
      maxSessions: 1,
    });
    expect(result.coverage.outOfSessionBars).toBe(3);
    expect(result.coverage.invalidBars).toBe(1);
    expect(result.rows).toHaveLength(77);
  });

  it('bounds the sessions a read can request', async () => {
    const { service, rest } = createService((start, end) =>
      bySessions(start, end),
    );
    const result = await service.loadFiveMinuteBars({
      symbol: 'AAPL',
      from: new Date('2025-10-13T00:00:00.000Z'),
      to: NOW,
      now: NOW,
      maxSessions: 3,
    });
    expect(result.coverage.requestedSessions).toBe(3);
    expect(rest.getIntradayPrices).toHaveBeenCalledTimes(1);
  });

  it('caches daily bars and reports a failed daily read', async () => {
    const { service, rest } = createService(() => []);
    rest.getDailyPrices.mockResolvedValueOnce({
      json: [
        { date: '2026-10-12', open: 1, high: 2, low: 1, close: 2, volume: 3 },
      ],
      receivedAt: new Date(),
      bytes: 1,
    });
    const input = {
      symbol: 'AAPL',
      from: new Date('2026-10-01T04:00:00.000Z'),
      to: NOW,
      now: NOW,
    };
    expect((await service.loadDailyBars(input)).bars).toHaveLength(1);
    expect((await service.loadDailyBars(input)).bars).toHaveLength(1);
    expect(rest.getDailyPrices).toHaveBeenCalledTimes(1);
    rest.getDailyPrices.mockRejectedValueOnce(
      new TiingoError('TIINGO_FORBIDDEN', false, 403),
    );
    const failed = await service.loadDailyBars({
      ...input,
      from: new Date('2026-09-01T04:00:00.000Z'),
    });
    expect(failed.bars).toEqual([]);
    expect(failed.coverage.stopCode).toBe('TIINGO_FORBIDDEN');
  });

  it('forgets everything on shutdown', async () => {
    const { service, rest } = createService((start, end) =>
      bySessions(start, end),
    );
    const input = {
      symbol: 'AAPL',
      from: new Date('2026-10-12T13:30:00.000Z'),
      to: NOW,
      now: NOW,
      maxSessions: 2,
    };
    await service.loadFiveMinuteBars(input);
    service.onModuleDestroy();
    expect(service.getStatus().cachedSessions).toBe(0);
    await service.loadFiveMinuteBars(input);
    expect(rest.getIntradayPrices).toHaveBeenCalledTimes(2);
  });
});
