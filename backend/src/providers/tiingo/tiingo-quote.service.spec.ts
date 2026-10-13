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
    PrismaClient: class PrismaClient {},
  };
});

import { AssetType, CurrencyCode } from '../../generated/prisma/client';
import type { MarketPriceEventService } from '../market-price-event.service';
import type { TiingoAssetMapService } from './tiingo-asset-map.service';
import { readTiingoConfig, TiingoConfigService } from './tiingo.config';
import { TiingoError } from './tiingo.errors';
import { TiingoMarketDataStore } from './tiingo-market-data.store';
import { parseTiingoTimestamp } from './tiingo.parser';
import { TiingoQuoteService } from './tiingo-quote.service';
import type { TiingoRestClient } from './tiingo-rest.client';
import type { TiingoStreamService } from './tiingo-stream.service';

const AAPL = {
  id: 'asset-aapl',
  symbol: 'AAPL',
  market: 'NAS',
  assetType: AssetType.us_stock,
  priceCurrency: CurrencyCode.USD,
};
const TARGET = {
  assetId: 'asset-aapl',
  symbol: 'AAPL',
  market: 'NAS',
  ticker: 'aapl',
};

// Tue 2026-10-13 (EDT): 10:30 ET open session; 18:00 ET after close.
const OPEN_NOW = new Date('2026-10-13T14:30:00.000Z');
const AFTER_CLOSE = new Date('2026-10-13T22:00:00.000Z');

function setup(
  options: { managed?: boolean; streamDelivering?: boolean } = {},
) {
  const store = new TiingoMarketDataStore();
  const rest = {
    getSnapshot: jest.fn(),
    getDailyPrices: jest.fn(),
    getIntradayPrices: jest.fn(),
  };
  const events = { publish: jest.fn<void, [unknown]>() };
  const managed = options.managed ?? true;
  const assetMap = {
    targetForAsset: jest.fn().mockResolvedValue(managed ? TARGET : null),
    getMapping: jest.fn().mockResolvedValue({
      targets: managed ? [TARGET] : [],
      unmapped: [],
      loadedAt: null,
      lastLoadFailed: false,
    }),
    cachedTargetForSymbol: jest.fn((symbol: string) =>
      managed && symbol === 'AAPL' ? TARGET : null,
    ),
  };
  const stream = {
    getStatus: jest.fn(() => ({
      reference: {
        state: options.streamDelivering ? 'subscribed' : 'reconnecting',
        lastDataAt: options.streamDelivering ? new Date().toISOString() : null,
      },
      liquidity: {
        state: options.streamDelivering ? 'subscribed' : 'reconnecting',
        lastDataAt: options.streamDelivering ? new Date().toISOString() : null,
      },
    })),
  };
  const service = new TiingoQuoteService(
    new TiingoConfigService(
      readTiingoConfig({
        TIINGO_ENABLED: 'true',
        TIINGO_API_TOKEN: 'synthetic-token',
        TIINGO_ALLOWED_SYMBOLS: 'AAPL',
      }),
    ),
    assetMap as unknown as TiingoAssetMapService,
    rest as unknown as TiingoRestClient,
    store,
    events as unknown as MarketPriceEventService,
    stream as unknown as TiingoStreamService,
  );
  service.onModuleInit();
  return { service, store, rest, events, assetMap };
}

const snapshot = (
  timestamp: string,
  overrides: Record<string, unknown> = {},
) => ({
  json: [
    {
      ticker: 'AAPL',
      timestamp,
      tngoLast: 247.5,
      lqSpread: 0.0004,
      lqBidPrice: 247.45,
      lqBidSize: 300,
      lqAskPrice: 247.55,
      lqAskSize: 200,
      ...overrides,
    },
  ],
  receivedAt: new Date(),
  bytes: 1,
});

describe('TiingoQuoteService display price', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('serves a fresh in-session stream price without REST and without a stored id', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, store, rest, events } = setup({ streamDelivering: true });
    store.acceptReference({
      symbol: 'AAPL',
      price: '247.61',
      timestamp: parseTiingoTimestamp('2026-10-13T10:29:58.000000001-04:00')!,
      capturedAt: new Date('2026-10-13T14:29:58.100Z'),
      origin: 'ws',
    });
    const result = await service.resolveDisplayPrice(AAPL, OPEN_NOW);
    expect(result).toMatchObject({
      state: 'available',
      price: '247.61',
      sourceName: 'tiingo_equity_reference_price',
      origin: 'ws',
      decision: {
        selectedSourceType: 'provider_api',
        selectedSourceName: 'tiingo_equity_reference_price',
        selectedSnapshotId: null,
        fallbackUsed: false,
      },
    });
    expect(rest.getSnapshot).not.toHaveBeenCalled();
    // Stream ticks are published in-process (never to Redis).
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish.mock.calls[0][0]).toMatchObject({
      type: 'market_price',
      assetId: 'asset-aapl',
      delayed: false,
      snapshotState: null,
      price: {
        price: '247.61',
        currencyCode: 'USD',
        sourceName: 'tiingo_equity_reference_price',
      },
    });
  });

  it('falls back to one REST snapshot when the stream has nothing', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, rest, store } = setup();
    rest.getSnapshot.mockResolvedValueOnce(
      snapshot('2026-10-13T10:29:59.5-04:00'),
    );
    const result = await service.resolveDisplayPrice(AAPL, OPEN_NOW);
    expect(result).toMatchObject({
      state: 'available',
      price: '247.5',
      origin: 'rest_snapshot',
    });
    expect(store.latestLiquidity('AAPL')).toMatchObject({
      bidPrice: '247.45',
      askSize: '200',
    });
    // Within the minimum interval no second snapshot request is made.
    await service.resolveDisplayPrice(AAPL, OPEN_NOW);
    expect(rest.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable (never a KIS/admin fallback) when Tiingo fails', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, rest } = setup();
    rest.getSnapshot.mockRejectedValueOnce(
      new TiingoError('TIINGO_UNAUTHORIZED', false, 401),
    );
    const result = await service.resolveDisplayPrice(AAPL, OPEN_NOW);
    expect(result).toMatchObject({
      state: 'unavailable',
      code: 'TIINGO_REFERENCE_PRICE_MISSING',
      failureStage: 'tiingo_reference_price',
      evidence: {
        provider: 'tiingo',
        lastSnapshotErrorCode: 'TIINGO_UNAUTHORIZED',
        fallback: 'none',
      },
    });
    expect(service.getStatus()).toMatchObject({
      displayUnavailable: 1,
      lastUnavailableCode: 'TIINGO_REFERENCE_PRICE_MISSING',
    });
  });

  it('rejects a price from before the current session open', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, rest } = setup();
    // Pre-market value only (09:00 ET) — not a regular-session price.
    rest.getSnapshot.mockResolvedValueOnce(
      snapshot('2026-10-13T09:00:00-04:00'),
    );
    const result = await service.resolveDisplayPrice(AAPL, OPEN_NOW);
    expect(result).toMatchObject({
      state: 'unavailable',
      code: 'TIINGO_REFERENCE_PRICE_OUTSIDE_SESSION',
    });
  });

  it('marks a quiet stream price stale instead of treating it as current', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, store, rest } = setup();
    const captured = new Date(OPEN_NOW.getTime() - 400_000);
    const timestamp = parseTiingoTimestamp('2026-10-13T10:23:20-04:00')!;
    store.acceptReference({
      symbol: 'AAPL',
      price: '247',
      timestamp,
      capturedAt: captured,
      origin: 'ws',
    });
    // REST confirms nothing newer (same provider timestamp → duplicate).
    rest.getSnapshot.mockResolvedValueOnce(
      snapshot('2026-10-13T10:23:20-04:00'),
    );
    const result = await service.resolveDisplayPrice(AAPL, OPEN_NOW);
    expect(result).toMatchObject({
      state: 'unavailable',
      code: 'TIINGO_REFERENCE_PRICE_STALE',
    });
  });

  it('uses the official EOD close after the session and caches it', async () => {
    jest.setSystemTime(AFTER_CLOSE);
    const { service, rest } = setup();
    rest.getDailyPrices.mockResolvedValue({
      json: [
        {
          date: '2026-10-13T00:00:00.000Z',
          open: 245,
          high: 249,
          low: 244,
          close: 248.04,
          volume: 1,
          adjClose: 248.04,
        },
      ],
      receivedAt: new Date(),
      bytes: 1,
    });
    const first = await service.resolveDisplayPrice(AAPL, AFTER_CLOSE);
    expect(first).toMatchObject({
      state: 'available',
      price: '248.04',
      origin: 'rest_close',
      effectiveAt: new Date('2026-10-13T20:00:00.000Z'),
    });
    await service.resolveDisplayPrice(AAPL, AFTER_CLOSE);
    expect(rest.getDailyPrices).toHaveBeenCalledTimes(1);
    expect(rest.getIntradayPrices).not.toHaveBeenCalled();
    expect(service.getStatus().lastSessionClose).toMatchObject({
      localDate: '2026-10-13',
      basis: 'eod_official_close',
    });
  });

  it('uses the last regular-session stream value before EOD is published', async () => {
    jest.setSystemTime(AFTER_CLOSE);
    const { service, rest, store } = setup();
    rest.getDailyPrices.mockResolvedValue({
      json: [],
      receivedAt: new Date(),
      bytes: 2,
    });
    store.acceptReference({
      symbol: 'AAPL',
      price: '247.9',
      timestamp: parseTiingoTimestamp('2026-10-13T15:59:59.9-04:00')!,
      capturedAt: new Date('2026-10-13T20:00:00.000Z'),
      origin: 'ws',
    });
    // An after-hours tick must not become the session close.
    store.acceptReference({
      symbol: 'AAPL',
      price: '250',
      timestamp: parseTiingoTimestamp('2026-10-13T17:00:00-04:00')!,
      capturedAt: new Date('2026-10-13T21:00:00.000Z'),
      origin: 'ws',
    });
    const result = await service.resolveDisplayPrice(AAPL, AFTER_CLOSE);
    expect(result).toMatchObject({ state: 'available', price: '247.9' });
    expect(rest.getIntradayPrices).not.toHaveBeenCalled();
  });

  it('falls back to the last regular 5m bar, capped at the session close', async () => {
    jest.setSystemTime(AFTER_CLOSE);
    const { service, rest } = setup();
    rest.getDailyPrices.mockResolvedValue({
      json: [],
      receivedAt: new Date(),
      bytes: 2,
    });
    rest.getIntradayPrices.mockResolvedValue({
      json: [
        {
          date: '2026-10-13T19:50:00.000Z',
          open: 1,
          high: 2,
          low: 1,
          close: 2,
          volume: 5,
        },
        {
          date: '2026-10-13T19:55:00.000Z',
          open: 2,
          high: 3,
          low: 2,
          close: 2.5,
          volume: 5,
        },
      ],
      receivedAt: new Date(),
      bytes: 2,
    });
    const result = await service.resolveDisplayPrice(AAPL, AFTER_CLOSE);
    expect(result).toMatchObject({
      state: 'available',
      price: '2.5',
      effectiveAt: new Date('2026-10-13T20:00:00.000Z'),
    });
    expect(service.getStatus().lastSessionClose?.basis).toBe(
      'intraday_last_bar',
    );
  });

  it('throttles retries after every close source failed', async () => {
    jest.setSystemTime(AFTER_CLOSE);
    const { service, rest } = setup();
    rest.getDailyPrices.mockRejectedValue(
      new TiingoError('TIINGO_SERVER_ERROR', true, 503),
    );
    const result = await service.resolveDisplayPrice(AAPL, AFTER_CLOSE);
    expect(result).toMatchObject({
      state: 'unavailable',
      code: 'TIINGO_SESSION_CLOSE_MISSING',
      evidence: {
        lastSessionCloseErrorCode: 'TIINGO_SERVER_ERROR',
      },
    });
    await service.resolveDisplayPrice(AAPL, AFTER_CLOSE);
    expect(rest.getDailyPrices).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(31_000);
    await service.resolveDisplayPrice(AAPL, new Date(Date.now()));
    expect(rest.getDailyPrices).toHaveBeenCalledTimes(2);
  });

  it('leaves non-managed assets to the stored policy', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, rest } = setup({ managed: false });
    expect(await service.resolveDisplayPrice(AAPL, OPEN_NOW)).toBeNull();
    expect(rest.getSnapshot).not.toHaveBeenCalled();
  });
});

describe('TiingoQuoteService estimated quote', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the in-session estimate and notifies listeners', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, store } = setup({ streamDelivering: true });
    const received: unknown[] = [];
    service.onEstimatedQuote((quote) => received.push(quote));
    store.acceptLiquidity({
      symbol: 'AAPL',
      fields: {
        spread: '0.0004',
        bidPrice: '247.45',
        bidSize: '300',
        askPrice: null,
        askSize: null,
        referencePrice: '247.5',
      },
      timestamp: parseTiingoTimestamp('2026-10-13T10:29:59-04:00')!,
      capturedAt: new Date('2026-10-13T14:29:59.200Z'),
      origin: 'ws',
    });
    expect(received).toHaveLength(1);
    expect(await service.getEstimatedQuote(AAPL, OPEN_NOW)).toMatchObject({
      assetId: 'asset-aapl',
      bidPrice: '247.45',
      bidSize: '300',
      askPrice: null,
      askSize: null,
    });
  });

  it('seeds a missing estimate from one REST snapshot and hides it after the close', async () => {
    jest.setSystemTime(OPEN_NOW);
    const { service, rest } = setup();
    rest.getSnapshot.mockResolvedValueOnce(
      snapshot('2026-10-13T10:29:59-04:00'),
    );
    expect(await service.getEstimatedQuote(AAPL, OPEN_NOW)).toMatchObject({
      bidPrice: '247.45',
      askPrice: '247.55',
    });
    jest.setSystemTime(AFTER_CLOSE);
    expect(await service.getEstimatedQuote(AAPL, AFTER_CLOSE)).toBeNull();
  });
});
