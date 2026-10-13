jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{
      Decimal: typeof import('@prisma/client/runtime/client').Decimal;
    }>('@prisma/client/runtime/client').Decimal,
  },
  PrismaClient: class {},
}));

import { BinanceUsdmKlineClient } from './binance-kline-usdm.client';
import { BinanceCandleIngestionService } from './binance-candle.ingestion.service';

describe('BinanceUsdmKlineClient', () => {
  it('reads USDⓈ-M contract klines (not Spot, Mark or Index) through the shared Binance coordinator', async () => {
    const http = {
      getJson: jest.fn().mockResolvedValue({
        json: [],
        receivedAt: new Date('2026-10-13T10:30:00.000Z'),
        status: 200,
      }),
    };
    const client = new BinanceUsdmKlineClient(http as never);
    await client.fetchKlines({
      symbol: 'hypeusdt',
      interval: '4h',
      limit: 499,
      startTime: 1,
      endTime: 2,
    });
    const [url, options] = http.getJson.mock.calls[0] as unknown as [
      string,
      { provider: string; timeoutMs: number },
    ];
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://fapi.binance.com');
    expect(parsed.pathname).toBe('/fapi/v1/klines');
    expect(parsed.searchParams.get('symbol')).toBe('HYPEUSDT');
    expect(parsed.searchParams.get('interval')).toBe('4h');
    expect(parsed.searchParams.get('limit')).toBe('499');
    expect(options).toEqual({ provider: 'binance', timeoutMs: 5000 });
  });

  it('feeds the strict page parser, keeping the open contract bucket provisional', async () => {
    const now = new Date('2026-10-13T10:30:00.000Z');
    const open = Date.parse('2026-10-13T04:00:00.000Z');
    const current = Date.parse('2026-10-13T08:00:00.000Z');
    const kline = (t: number) => [
      t,
      '100.1',
      '101.2',
      '99.3',
      '100.4',
      '12',
      t + 4 * 3600_000 - 1,
      '1200',
    ];
    const http = {
      getJson: jest.fn().mockResolvedValue({
        json: [
          kline(open),
          kline(current),
          [open + 60_000, '1', '1', '1', '1', '1', 0, '1'],
        ],
        receivedAt: now,
        status: 200,
      }),
    };
    const ingestion = new BinanceCandleIngestionService(
      new BinanceUsdmKlineClient(http as never),
    );
    const page = await ingestion.fetchKlinesPage({
      symbol: 'BTCUSDT',
      interval: '4h',
      from: new Date(open),
      to: new Date(current + 4 * 3600_000),
      now,
      limit: 3,
    });
    expect(page.candles.map((c) => c.isClosed)).toEqual([true, false]);
    // The off-grid row is rejected, never repaired.
    expect(page.rejectedRows).toBe(1);
    expect(page.candles[0].closeTime.toISOString()).toBe(
      '2026-10-13T08:00:00.000Z',
    );
  });
});
