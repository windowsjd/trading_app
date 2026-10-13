jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual<typeof import('@prisma/client/runtime/client')>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
  PrismaClient: class PrismaClient {},
  UserStatus: { active: 'active' },
}));
jest.mock('../assets/assets.service', () => ({
  AssetsService: class AssetsService {},
}));
jest.mock('../assets/live-candle-overlay.service', () => ({
  LiveCandleOverlayService: class LiveCandleOverlayService {},
}));
jest.mock('./live-candle-pubsub.service', () => ({
  LiveCandlePubSubService: class LiveCandlePubSubService {},
}));
jest.mock('../providers/market-display-price.service', () => ({
  MarketDisplayPriceService: class MarketDisplayPriceService {},
}));
jest.mock('../providers/market-estimated-quote.service', () => ({
  MarketEstimatedQuoteService: class MarketEstimatedQuoteService {},
}));

import { BinanceRealtimePriceEventBus } from '../providers/binance/binance-realtime-price-event-bus.service';
import { KisRealtimePriceEventBus } from '../providers/kis/kis-realtime-price-event-bus.service';
import { MarketPriceEventService } from '../providers/market-price-event.service';
import type { AssetEstimatedQuoteEvent } from '../providers/market-estimated-quote.service';
import { AssetTickerGateway } from './asset-ticker.gateway';

const TIINGO = 'tiingo_equity_reference_price';
const AAPL_METADATA = {
  assetId: 'asset-aapl',
  symbol: 'AAPL',
  name: 'Apple',
  assetType: 'us_stock',
  market: 'NAS',
  priceCurrency: 'USD',
  displayPriceDecimals: null,
};

type FakeClient = {
  readyState: number;
  bufferedAmount: number;
  send: jest.Mock;
};

function createGateway(options: { managed: boolean }) {
  const displayPrices = {
    displaySourceNames: jest
      .fn()
      .mockResolvedValue(options.managed ? [TIINGO] : null),
  };
  let quoteListener: ((event: AssetEstimatedQuoteEvent) => void) | null = null;
  const estimatedQuotes = {
    loadTarget: jest.fn((assetId: string) =>
      Promise.resolve(assetId === 'asset-aapl' ? { assetId } : null),
    ),
    getCurrent: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn(
      (listener: (event: AssetEstimatedQuoteEvent) => void) => {
        quoteListener = listener;
        return () => {
          quoteListener = null;
        };
      },
    ),
  };
  const gateway = new AssetTickerGateway(
    {
      user: { findUnique: jest.fn() },
      asset: { findUnique: jest.fn() },
    } as never,
    { verifyAsync: jest.fn() } as never,
    { get: jest.fn() } as never,
    {
      getAssetPriceForTicker: jest.fn().mockResolvedValue(null),
      calculateChangeRate: jest.fn().mockResolvedValue(null),
      convertRealtimePriceToKrw: jest.fn().mockResolvedValue({
        state: 'available',
        priceKrw: '346654.00000000',
        fxRateSource: null,
      }),
    } as never,
    { getMetadata: jest.fn().mockResolvedValue(AAPL_METADATA) } as never,
    new MarketPriceEventService(
      new KisRealtimePriceEventBus(),
      new BinanceRealtimePriceEventBus(),
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    displayPrices as never,
    estimatedQuotes as never,
  );
  gateway.onModuleInit();
  const attach = (bufferedAmount = 0) => {
    const client: FakeClient = {
      readyState: 1,
      bufferedAmount,
      send: jest.fn(),
    };
    const state = {
      userId: 'user-1',
      subscriptions: new Map<string, string | null>(),
      candleSubscriptions: new Map(),
      pendingCandles: new Map(),
      pendingTickers: new Map(),
      orderBookSubscriptions: new Map(),
      pendingOrderBooks: new Map(),
      estimatedQuoteSubscriptions: new Map(),
      pendingEstimatedQuotes: new Map(),
    };
    (gateway as unknown as { clients: Map<unknown, unknown> }).clients.set(
      client,
      state,
    );
    return { client, state };
  };
  const send = (client: FakeClient, message: unknown) =>
    (
      gateway as unknown as {
        handleMessage(client: unknown, raw: string): Promise<void>;
      }
    ).handleMessage(client, JSON.stringify(message));
  const sent = (client: FakeClient) =>
    client.send.mock.calls.map(
      ([payload]) => JSON.parse(payload as string) as Record<string, unknown>,
    );
  return {
    gateway,
    displayPrices,
    estimatedQuotes,
    attach,
    send,
    sent,
    pushQuote: (event: AssetEstimatedQuoteEvent) => quoteListener?.(event),
  };
}

const buildRealtime = (gateway: AssetTickerGateway, event: unknown) =>
  (
    gateway as unknown as {
      buildRealtimeTickerMessageFromEvent(
        event: unknown,
      ): Promise<Record<string, unknown> | null>;
    }
  ).buildRealtimeTickerMessageFromEvent(event);

const marketPrice = (sourceName: string, delayed = false) => ({
  type: 'market_price',
  assetId: 'asset-aapl',
  price: {
    price: '247.61',
    currencyCode: 'USD',
    sourceName,
    effectiveAt: '2026-06-18T15:00:29.000Z',
    capturedAt: '2026-06-18T15:00:29.500Z',
  },
  delayed,
  snapshotState: null,
});

const quote = (bidPrice: string): AssetEstimatedQuoteEvent => ({
  type: 'asset_estimated_quote',
  assetId: 'asset-aapl',
  kind: 'estimated_liquidity',
  provider: 'tiingo',
  priceCurrency: 'USD',
  quantityUnit: 'share',
  bid: { price: bidPrice, size: '300' },
  ask: { price: null, size: null },
  spread: '0.0004',
  referencePrice: '247.5',
  effectiveAt: '2026-06-18T15:00:29.000Z',
  capturedAt: '2026-06-18T15:00:29.200Z',
});

describe('AssetTickerGateway — Tiingo trial routing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Thu 2026-06-18 11:00:30 ET — US regular session.
    jest.setSystemTime(new Date('2026-06-18T15:00:30.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fans out the Tiingo reference price for a managed asset as realtime', async () => {
    const { gateway } = createGateway({ managed: true });
    const ticker = await buildRealtime(gateway, marketPrice(TIINGO));
    expect(ticker).toMatchObject({
      assetId: 'asset-aapl',
      realtime: true,
      priceLocal: '247.61',
      assetPriceSnapshotId: null,
      priceSource: { sourceType: 'provider_api', sourceName: TIINGO },
    });
    gateway.onModuleDestroy();
  });

  it('never shows a KIS tick in place of the managed Tiingo source', async () => {
    const { gateway } = createGateway({ managed: true });
    expect(
      await buildRealtime(gateway, marketPrice('kis_us_delayed_trade', true)),
    ).toBeNull();
    gateway.onModuleDestroy();
  });

  it('keeps the stored eligibility for unmanaged assets (Tiingo ticks rejected)', async () => {
    const { gateway } = createGateway({ managed: false });
    expect(await buildRealtime(gateway, marketPrice(TIINGO))).toBeNull();
    expect(
      await buildRealtime(gateway, marketPrice('kis_us_delayed_trade', true)),
    ).toMatchObject({ realtime: false, delayed: true });
    gateway.onModuleDestroy();
  });
});

describe('AssetTickerGateway — asset_estimated_quote channel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-18T15:00:30.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('acknowledges a supported asset and sends the current estimate', async () => {
    const { gateway, attach, send, sent, estimatedQuotes } = createGateway({
      managed: true,
    });
    estimatedQuotes.getCurrent.mockResolvedValueOnce(quote('247.45'));
    const { client } = attach();
    await send(client, {
      type: 'subscribe',
      channel: 'asset_estimated_quote',
      assetId: 'asset-aapl',
    });
    expect(sent(client)).toEqual([
      {
        type: 'subscribed',
        channel: 'asset_estimated_quote',
        assetId: 'asset-aapl',
      },
      quote('247.45'),
    ]);
    gateway.onModuleDestroy();
  });

  it('rejects unsupported and malformed subscriptions without an order book', async () => {
    const { gateway, attach, send, sent } = createGateway({ managed: true });
    const { client } = attach();
    await send(client, {
      type: 'subscribe',
      channel: 'asset_estimated_quote',
      assetId: 'asset-tsla',
    });
    await send(client, { type: 'subscribe', channel: 'asset_estimated_quote' });
    expect(sent(client)).toEqual([
      {
        type: 'subscription_error',
        channel: 'asset_estimated_quote',
        assetId: 'asset-tsla',
        code: 'UNSUPPORTED_ASSET',
      },
      {
        type: 'subscription_error',
        channel: 'asset_estimated_quote',
        assetId: null,
        code: 'INVALID_SUBSCRIPTION',
      },
    ]);
    gateway.onModuleDestroy();
  });

  it('delivers live estimates only while subscribed and cleans up', async () => {
    const { gateway, attach, send, sent, pushQuote } = createGateway({
      managed: true,
    });
    const { client, state } = attach();
    const other = attach();
    await send(client, {
      type: 'subscribe',
      channel: 'asset_estimated_quote',
      assetId: 'asset-aapl',
    });
    pushQuote(quote('247.46'));
    expect(sent(client).at(-1)).toEqual(quote('247.46'));
    // A client that never subscribed receives nothing.
    expect(other.client.send).not.toHaveBeenCalled();
    await send(client, {
      type: 'unsubscribe',
      channel: 'asset_estimated_quote',
      assetId: 'asset-aapl',
    });
    pushQuote(quote('247.47'));
    expect(sent(client).at(-1)).toEqual({
      type: 'unsubscribed',
      channel: 'asset_estimated_quote',
      assetId: 'asset-aapl',
    });
    expect(state.estimatedQuoteSubscriptions.size).toBe(0);
    gateway.onModuleDestroy();
  });

  it('coalesces estimates for a slow socket and clears them on disconnect', async () => {
    const { gateway, attach, send, pushQuote } = createGateway({
      managed: true,
    });
    const { client, state } = attach();
    await send(client, {
      type: 'subscribe',
      channel: 'asset_estimated_quote',
      assetId: 'asset-aapl',
    });
    client.send.mockClear();
    client.bufferedAmount = 10_000_000;
    pushQuote(quote('247.46'));
    pushQuote(quote('247.48'));
    expect(client.send).not.toHaveBeenCalled();
    expect(state.pendingEstimatedQuotes.get('asset-aapl')).toEqual(
      quote('247.48'),
    );
    client.bufferedAmount = 0;
    jest.advanceTimersByTime(150);
    expect(client.send).toHaveBeenCalledTimes(1);
    gateway.handleDisconnect(client as never);
    expect(state.estimatedQuoteSubscriptions.size).toBe(0);
    expect(state.pendingEstimatedQuotes.size).toBe(0);
    gateway.onModuleDestroy();
  });
});
