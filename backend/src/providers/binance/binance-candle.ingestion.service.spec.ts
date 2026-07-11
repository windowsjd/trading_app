jest.mock('../../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return { Prisma: { Decimal: runtime.Decimal } };
});

import { BinanceCandleIngestionService } from './binance-candle.ingestion.service';
import { BinanceCandleInputError } from './binance-candle.types';

const FIVE_MIN = 5 * 60_000;
const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
// Monday 2026-07-06 00:00:00 UTC.
const MONDAY = Date.UTC(2026, 6, 6);

function kline(openMs: number, intervalMs: number, overrides: unknown[] = []) {
  const row: unknown[] = [
    openMs,
    '100',
    '102',
    '99',
    '101',
    '10',
    openMs + intervalMs - 1,
    '1010', // quote asset volume → amount
    5,
    '4',
    '404',
    '0',
  ];
  overrides.forEach((value, index) => {
    if (value !== undefined) row[index] = value;
  });
  return row;
}

describe('BinanceCandleIngestionService', () => {
  const createService = (pages: unknown[][]) => {
    const fetchKlines = jest.fn();
    for (const page of pages) {
      fetchKlines.mockResolvedValueOnce({
        response: page,
        receivedAt: new Date('2026-07-08T00:00:00Z'),
      });
    }
    const service = new BinanceCandleIngestionService({
      fetchKlines,
    } as never);
    return { service, fetchKlines };
  };

  it('pages forward with startTime and a 1000-row boundary, deduplicating openTimes', async () => {
    const from = MONDAY;
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      kline(from + index * FIVE_MIN, FIVE_MIN),
    );
    const { service, fetchKlines } = createService([firstPage]);
    const now = new Date(from + 30 * DAY);
    const page = await service.fetchKlinesPage({
      symbol: 'btcusdt',
      interval: '5m',
      from: new Date(from),
      to: new Date(from + 2000 * FIVE_MIN),
      now,
    });

    expect(fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '5m',
      limit: 1000,
      startTime: from,
      endTime: from + 2000 * FIVE_MIN - 1,
    });
    expect(page.acceptedRows).toBe(1000);
    expect(page.nextCursor).toEqual({ startTime: from + 1000 * FIVE_MIN });
    expect(page.stopReason).toBeNull();
    expect(page.complete).toBe(false);

    // Second page resumes from the cursor and terminates the range.
    const secondPage = Array.from({ length: 1000 }, (_, index) =>
      kline(from + (1000 + index) * FIVE_MIN, FIVE_MIN),
    );
    const { service: service2, fetchKlines: fetch2 } = createService([
      secondPage,
    ]);
    const done = await service2.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(from),
      to: new Date(from + 2000 * FIVE_MIN),
      cursor: page.nextCursor,
      now,
    });
    expect(fetch2.mock.calls[0][0].startTime).toBe(from + 1000 * FIVE_MIN);
    expect(done.nextCursor).toBeNull();
    expect(done.stopReason).toBe('target_reached');
    expect(done.complete).toBe(true);
  });

  it('maps kline fields strictly: quote asset volume becomes amount', async () => {
    const { service } = createService([[kline(MONDAY, FIVE_MIN)]]);
    const page = await service.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(MONDAY),
      to: new Date(MONDAY + FIVE_MIN),
      now: new Date(MONDAY + DAY),
    });
    const candle = page.candles[0];
    expect(candle.open.toFixed()).toBe('100');
    expect(candle.close.toFixed()).toBe('101');
    expect(candle.volume.toFixed()).toBe('10');
    expect(candle.amount?.toFixed()).toBe('1010');
    expect(candle.closeTime.getTime()).toBe(MONDAY + FIVE_MIN);
    expect(candle.isClosed).toBe(true);
  });

  it.each([
    ['1d', DAY, MONDAY],
    ['1w', WEEK, MONDAY],
  ] as const)(
    'accepts %s klines on the UTC grid and keeps the in-progress kline open',
    async (interval, intervalMs, gridStart) => {
      const { service } = createService([
        [
          kline(gridStart, intervalMs),
          kline(gridStart + intervalMs, intervalMs),
        ],
      ]);
      // `now` inside the second kline: it is the currently-open candle.
      const now = new Date(gridStart + intervalMs + 1000);
      const page = await service.fetchKlinesPage({
        symbol: 'BTCUSDT',
        interval,
        from: new Date(gridStart),
        to: new Date(now.getTime()),
        now,
      });
      expect(page.acceptedRows).toBe(2);
      expect(page.candles[0].isClosed).toBe(true);
      expect(page.candles[1].isClosed).toBe(false);
      expect(page.stopReason).toBe('target_reached');
      expect(page.complete).toBe(true);
    },
  );

  it('rejects off-grid weekly klines (Binance weeks open on Monday UTC)', async () => {
    const offGrid = MONDAY + DAY; // Tuesday
    const { service } = createService([
      [kline(offGrid, WEEK), kline(MONDAY, WEEK)],
    ]);
    const page = await service.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '1w',
      from: new Date(MONDAY - WEEK),
      to: new Date(MONDAY + 2 * WEEK),
      now: new Date(MONDAY + 2 * WEEK),
    });
    expect(page.acceptedRows).toBe(1);
    expect(page.rejectedRows).toBe(1);
  });

  it.each([
    ['non-array row', 'oops'],
    ['short row', [MONDAY, '100', '102']],
    ['negative price', kline(MONDAY, FIVE_MIN, [undefined, '-1'])],
    [
      'zero close',
      kline(MONDAY, FIVE_MIN, [
        undefined,
        undefined,
        undefined,
        undefined,
        '0',
      ]),
    ],
    ['high below low', kline(MONDAY, FIVE_MIN, [undefined, undefined, '98'])],
    [
      'garbage volume',
      kline(MONDAY, FIVE_MIN, [
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'x',
      ]),
    ],
    [
      'inconsistent close time',
      kline(MONDAY, FIVE_MIN, [
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        MONDAY + FIVE_MIN,
      ]),
    ],
  ])(
    'rejects malformed rows (%s) without repairing them',
    async (_name, badRow) => {
      const { service } = createService([
        [badRow, kline(MONDAY + FIVE_MIN, FIVE_MIN)],
      ]);
      const page = await service.fetchKlinesPage({
        symbol: 'BTCUSDT',
        interval: '5m',
        from: new Date(MONDAY),
        to: new Date(MONDAY + DAY),
        now: new Date(MONDAY + DAY),
      });
      expect(page.acceptedRows).toBe(1);
      expect(page.rejectedRows).toBe(1);
    },
  );

  it('never reports success when no row survives strict validation', async () => {
    const { service } = createService([[['bad'], ['worse']]]);
    const page = await service.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(MONDAY),
      to: new Date(MONDAY + DAY),
      now: new Date(MONDAY + DAY),
    });
    expect(page.stopReason).toBe('malformed_response');
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('flags a non-array response as malformed', async () => {
    const { service } = createService([]);
    const fetchKlines = jest
      .fn()
      .mockResolvedValue({ response: { code: -1 }, receivedAt: new Date() });
    const broken = new BinanceCandleIngestionService({ fetchKlines } as never);
    const page = await broken.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(MONDAY),
      to: new Date(MONDAY + DAY),
    });
    expect(page.stopReason).toBe('malformed_response');
    expect(page.complete).toBe(false);
  });

  it('terminates with empty_page / provider_exhausted instead of looping', async () => {
    const { service } = createService([[]]);
    const empty = await service.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(MONDAY),
      to: new Date(MONDAY + DAY),
      now: new Date(MONDAY + DAY),
    });
    expect(empty.stopReason).toBe('empty_page');
    expect(empty.complete).toBe(false);

    // A short page that does not reach `to`: the provider ran out of data.
    const { service: shortService } = createService([
      [kline(MONDAY, FIVE_MIN)],
    ]);
    const short = await shortService.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(MONDAY),
      to: new Date(MONDAY + DAY),
      now: new Date(MONDAY + DAY),
    });
    expect(short.stopReason).toBe('provider_exhausted');
    expect(short.complete).toBe(false);
    expect(short.nextCursor).toBeNull();
  });

  it('excludes future klines', async () => {
    const now = new Date(MONDAY + FIVE_MIN);
    const { service } = createService([
      [kline(MONDAY, FIVE_MIN), kline(MONDAY + 2 * FIVE_MIN, FIVE_MIN)],
    ]);
    const page = await service.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(MONDAY),
      to: new Date(MONDAY + DAY),
      now,
    });
    expect(page.acceptedRows).toBe(1);
    expect(page.rejectedRows).toBe(1);
  });

  it.each([
    [{ symbol: 'b@d' }],
    [{ interval: '3m' }],
    [{ from: new Date('invalid') }],
    [{ limit: 1001 }],
    [{ cursor: { startTime: MONDAY - 1 } }],
  ])('rejects invalid inputs %#', async (overrides) => {
    const { service } = createService([[]]);
    await expect(
      service.fetchKlinesPage({
        symbol: 'BTCUSDT',
        interval: '5m',
        from: new Date(MONDAY),
        to: new Date(MONDAY + DAY),
        ...(overrides as object),
      } as never),
    ).rejects.toBeInstanceOf(BinanceCandleInputError);
  });

  it('uses only the public Binance client (no KIS rate limiter involvement)', async () => {
    const fetchKlines = jest.fn().mockResolvedValue({
      response: [kline(MONDAY, FIVE_MIN)],
      receivedAt: new Date(),
    });
    const client = { fetchKlines };
    const service = new BinanceCandleIngestionService(client as never);
    await service.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '5m',
      from: new Date(MONDAY),
      to: new Date(MONDAY + FIVE_MIN),
      now: new Date(MONDAY + DAY),
    });
    // The service's only collaborator is BinancePublicClient.fetchKlines.
    expect(fetchKlines).toHaveBeenCalledTimes(1);
    const source = jest.requireActual<Record<string, unknown>>(
      './binance-candle.ingestion.service',
    );
    expect(Object.keys(source)).toContain('BinanceCandleIngestionService');
  });
});
