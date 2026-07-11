jest.mock('../../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return { Prisma: { Decimal: runtime.Decimal } };
});

import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { BinancePublicClient } from './binance-public.client';
import { BinanceCandleIngestionService } from './binance-candle.ingestion.service';

// Opt-in real-provider smoke: one public klines page per interval with a
// small range and a small limit. No credentials are involved (public API)
// and nothing is written to the database.
const liveDescribe =
  process.env.BINANCE_CANDLE_LIVE_SMOKE === '1' ? describe : describe.skip;
liveDescribe('Binance candle live smoke', () => {
  const service = new BinanceCandleIngestionService(
    new BinancePublicClient(
      new ProviderConfigService(),
      new ProviderHttpClient(),
    ),
  );
  const symbol = process.env.BINANCE_CANDLE_SMOKE_SYMBOL ?? 'BTCUSDT';

  it('fetches one bounded 5m page with strict parsing', async () => {
    const now = new Date();
    const page = await service.fetchKlinesPage({
      symbol,
      interval: '5m',
      from: new Date(now.getTime() - 2 * 60 * 60_000),
      to: now,
      now,
      limit: 30,
    });
    expect(page.acceptedRows).toBeGreaterThan(0);
    expect(page.rejectedRows).toBe(0);
    // The most recent kline may be the in-progress one.
    const last = page.candles[page.candles.length - 1];
    expect(last.openTime.getTime()).toBeLessThanOrEqual(now.getTime());
  }, 30_000);

  it('fetches one bounded 1d page and one 1w page', async () => {
    const now = new Date();
    const daily = await service.fetchKlinesPage({
      symbol,
      interval: '1d',
      from: new Date(now.getTime() - 10 * 24 * 60 * 60_000),
      to: now,
      now,
      limit: 15,
    });
    expect(daily.acceptedRows).toBeGreaterThan(0);
    const weekly = await service.fetchKlinesPage({
      symbol,
      interval: '1w',
      from: new Date(now.getTime() - 8 * 7 * 24 * 60 * 60_000),
      to: now,
      now,
      limit: 10,
    });
    expect(weekly.acceptedRows).toBeGreaterThan(0);
    expect(
      weekly.candles.every(
        (candle) =>
          (candle.openTime.getTime() - 4 * 24 * 60 * 60_000) %
            (7 * 24 * 60 * 60_000) ===
          0,
      ),
    ).toBe(true);
  }, 30_000);
});
