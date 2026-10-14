jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class {},
  UserStatus: { active: 'active' },
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
jest.mock('../assets/assets.service', () => ({ AssetsService: class {} }));
jest.mock('../assets/live-candle-overlay.service', () => ({
  LiveCandleOverlayService: class {},
}));
jest.mock('./live-candle-pubsub.service', () => ({
  LiveCandlePubSubService: class {},
}));
import { AssetTickerGateway } from './asset-ticker.gateway';
import { BinanceRealtimePriceEventBus } from '../providers/binance/binance-realtime-price-event-bus.service';
import { MarketPriceEventService } from '../providers/market-price-event.service';
import { KisRealtimePriceEventBus } from '../providers/kis/kis-realtime-price-event-bus.service';
import type { OrderBookEvent } from '../providers/order-book.types';
import type { FuturesOrderBookEvent } from '../futures/futures-market-data';
import { MarketOrderBookSubscriptionService } from '../providers/market-order-book-subscription.service';

const target = { assetId: 'btc', symbol: 'BTCUSDT', baseAsset: 'BTC' };
function snapshot(
  sequence = '1',
  assetId = 'btc',
  base = 'BTC',
): OrderBookEvent {
  return {
    type: 'asset_order_book',
    sequence,
    book: {
      assetId,
      priceUnit: 'USDT',
      quantityUnit: base,
      marketLabel: `${base} / USDT`,
      asks: [{ price: '68420.10000000', quantity: '0.00125000' }],
      bids: [],
      capturedAt: '2026-09-19T00:00:00.000Z',
      effectiveAt: null,
    },
  };
}
function client() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
  };
}
type Client = ReturnType<typeof client>;
const messages = (socket: Client): Array<Record<string, unknown>> =>
  socket.send.mock.calls.map(
    ([text]) => JSON.parse(text as string) as Record<string, unknown>,
  );
const request = (assetId = 'btc', type = 'subscribe') => ({
  type,
  channel: 'asset_order_book',
  assetId,
});

const verifiedInstrument = () => ({
  id: 'instrument-btc',
  underlyingAssetId: 'btc',
  isActive: true,
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  markVerifiedAt: new Date(Date.now() - 60_000),
  markContractJson: {
    symbol: 'BTCUSDT',
    pair: 'BTCUSDT',
    baseAsset: 'BTC',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    underlyingType: 'COIN',
  },
  underlyingAsset: {
    symbol: 'BTCUSDT',
    isActive: true,
    assetType: 'crypto',
    market: 'BINANCE',
    currencyCode: 'USD',
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
  },
});

function setup() {
  let receive: (event: OrderBookEvent) => void = () => {};
  let receiveFutures: (event: FuturesOrderBookEvent) => void = () => {};
  const off = jest.fn();
  const offFutures = jest.fn();
  const instruments = {
    findUnique: jest
      .fn()
      .mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'instrument-btc' ? verifiedInstrument() : null,
        ),
      ),
  };
  const books = {
    loadTargets: jest.fn().mockResolvedValue(
      new Map([
        ['BTCUSDT', target],
        ['ETHUSDT', { assetId: 'eth', symbol: 'ETHUSDT', baseAsset: 'ETH' }],
      ]),
    ),
  };
  const gateway = new AssetTickerGateway(
    {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user', status: 'active' }),
      },
    } as never,
    { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user' }) } as never,
    { get: jest.fn().mockReturnValue('secret') } as never,
    { getAssetPriceForTicker: jest.fn().mockResolvedValue(null) } as never,
    { getMetadata: jest.fn() } as never,
    new MarketPriceEventService(
      new KisRealtimePriceEventBus(),
      new BinanceRealtimePriceEventBus(),
    ),
    undefined,
    undefined,
    { websocketBackpressureBytes: 10 } as never,
    undefined,
    {
      subscribe: (listener: typeof receive) => {
        receive = listener;
        return off;
      },
      subscribeFutures: (listener: typeof receiveFutures) => {
        receiveFutures = listener;
        return offFutures;
      },
    } as never,
    new MarketOrderBookSubscriptionService(
      books as never,
      { futuresInstrument: instruments } as never,
    ),
  );
  gateway.onModuleInit();
  const internals = gateway as unknown as {
    handleMessage(socket: Client, raw: string): Promise<void>;
    flushPendingOrderBooks(): void;
    clients: Map<
      Client,
      {
        orderBookSubscriptions: Map<string, unknown>;
        pendingOrderBooks: Map<string, OrderBookEvent>;
      }
    >;
  };
  return {
    gateway,
    books,
    instruments,
    off,
    offFutures,
    internals,
    futures: (socket: Client) =>
      (
        gateway as unknown as {
          futuresOrderBooks: WeakMap<
            object,
            {
              subscriptions: Map<string, unknown>;
              pending: Map<string, FuturesOrderBookEvent>;
            }
          >;
        }
      ).futuresOrderBooks.get(internals.clients.get(socket)!),
    push: (event: OrderBookEvent) => receive(event),
    pushFutures: (event: FuturesOrderBookEvent) => receiveFutures(event),
    connect: (socket: Client) =>
      gateway.handleConnection(
        socket as never,
        {
          headers: { host: 'localhost' },
          url: '/api/v1/ws?token=token',
        } as never,
      ),
    send: (socket: Client, message: unknown) =>
      internals.handleMessage(socket, JSON.stringify(message)),
  };
}

describe('asset_order_book app WebSocket', () => {
  afterEach(() => jest.useRealTimers());

  it.each([null, '', 123])(
    'returns a channel-specific error for invalid assetId %s',
    async (assetId) => {
      const h = setup();
      const socket = client();
      try {
        await h.connect(socket);
        await h.send(socket, { ...request(), assetId });
        expect(messages(socket).at(-1)).toMatchObject({
          type: 'subscription_error',
          channel: 'asset_order_book',
          code: 'INVALID_SUBSCRIPTION',
        });
        expect(h.books.loadTargets).not.toHaveBeenCalled();
      } finally {
        h.gateway.onModuleDestroy();
      }
    },
  );

  it('isolates subscriptions, acknowledges without fake initial data and strips internal sequence', async () => {
    const h = setup();
    const btc = client();
    const eth = client();
    try {
      await h.connect(btc);
      await h.connect(eth);
      await h.send(btc, request());
      await h.send(eth, request('eth'));
      expect(messages(btc)).toEqual([
        { type: 'subscribed', channel: 'asset_order_book', assetId: 'btc' },
      ]);
      h.push(snapshot());
      h.push(snapshot('1', 'eth', 'ETH'));
      expect(messages(btc).at(-1)).toEqual({
        type: 'asset_order_book',
        ...snapshot().book,
      });
      expect(messages(eth).at(-1)?.assetId).toBe('eth');
      expect(messages(btc).at(-1)).not.toHaveProperty('sequence');
      h.push(snapshot('2', 'btc', 'ETH'));
      expect(messages(btc)).toHaveLength(2);
    } finally {
      h.gateway.onModuleDestroy();
    }
  });

  it.each([
    'unknown',
    'domestic-stock',
    'us-stock',
    'inactive-crypto',
    'other-provider',
  ])('rejects unsupported subscription %s', async (id) => {
    const h = setup();
    const socket = client();
    try {
      await h.connect(socket);
      await h.send(socket, request(id));
      expect(messages(socket).at(-1)).toMatchObject({
        type: 'subscription_error',
        channel: 'asset_order_book',
        assetId: id,
        code: 'UNSUPPORTED_ASSET',
      });
      expect(h.internals.clients.get(socket)?.orderBookSubscriptions.size).toBe(
        0,
      );
    } finally {
      h.gateway.onModuleDestroy();
    }
  });

  it('coalesces latest-only, ignores duplicates/regressions, flushes via existing timer and cleans pending state', async () => {
    jest.useFakeTimers();
    const h = setup();
    const socket = client();
    try {
      await h.connect(socket);
      await h.send(socket, request());
      const state = h.internals.clients.get(socket)!;
      socket.bufferedAmount = 100;
      for (let i = 1; i <= 104; i++) h.push(snapshot(String(i)));
      h.push(snapshot('103'));
      expect(state.pendingOrderBooks.size).toBe(1);
      expect(state.pendingOrderBooks.get('btc')?.sequence).toBe('104');
      expect(messages(socket)).toHaveLength(1);
      socket.bufferedAmount = 0;
      jest.advanceTimersByTime(100);
      expect(messages(socket)).toHaveLength(2);
      expect(state.pendingOrderBooks.size).toBe(0);
      h.push(snapshot('104'));
      expect(messages(socket)).toHaveLength(2);
      socket.bufferedAmount = 100;
      h.push(snapshot('105'));
      await h.send(socket, request('btc', 'unsubscribe'));
      expect(state.pendingOrderBooks.size).toBe(0);
      expect(state.orderBookSubscriptions.size).toBe(0);
      await h.send(socket, request());
      h.push(snapshot('106'));
      h.gateway.handleDisconnect(socket as never);
      expect(state.pendingOrderBooks.size).toBe(0);
      expect(state.orderBookSubscriptions.size).toBe(0);
      expect(h.internals.clients.size).toBe(0);
    } finally {
      h.gateway.onModuleDestroy();
      expect(h.off).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds concurrent validation and cancels unsubscribe/disconnect races', async () => {
    const h = setup();
    const socket = client();
    let release!: (targets: Map<string, typeof target>) => void;
    h.books.loadTargets.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    try {
      await h.connect(socket);
      const pending = Array.from({ length: 21 }, (_, i) =>
        h.send(socket, request(`id-${i}`)),
      );
      expect(h.books.loadTargets).toHaveBeenCalledTimes(20);
      expect(messages(socket).at(-1)?.code).toBe('SUBSCRIPTION_LIMIT');
      await h.send(socket, request('id-0', 'unsubscribe'));
      h.gateway.handleDisconnect(socket as never);
      const count = messages(socket).length;
      release(new Map([['BTCUSDT', { ...target, assetId: 'id-0' }]]));
      await Promise.all(pending);
      expect(messages(socket)).toHaveLength(count);
      expect(h.internals.clients.size).toBe(0);
    } finally {
      h.gateway.onModuleDestroy();
    }
  });

  it('does not resurrect an unsubscribed validation and allows reconnect to restore the subscription', async () => {
    const h = setup();
    const first = client();
    const next = client();
    let release!: (targets: Map<string, typeof target>) => void;
    h.books.loadTargets.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    try {
      await h.connect(first);
      const pending = h.send(first, request());
      await h.send(first, request('btc', 'unsubscribe'));
      release(new Map([['BTCUSDT', target]]));
      await pending;
      expect(
        messages(first).some((message) => message.type === 'subscribed'),
      ).toBe(false);
      h.gateway.handleDisconnect(first as never);
      await h.connect(next);
      await h.send(next, request());
      h.push(snapshot('123'));
      expect(messages(next).at(-1)?.type).toBe('asset_order_book');
    } finally {
      h.gateway.onModuleDestroy();
    }
  });

  it('fails closed when active asset lookup is unavailable', async () => {
    const h = setup();
    const socket = client();
    h.books.loadTargets.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    try {
      await h.connect(socket);
      await h.send(socket, request());
      expect(messages(socket).at(-1)?.code).toBe('ORDER_BOOK_UNAVAILABLE');
    } finally {
      h.gateway.onModuleDestroy();
    }
  });
});

function futuresEvent(
  sequence = '1',
  instrumentId = 'instrument-btc',
  quantityUnit = 'BTC',
): FuturesOrderBookEvent {
  return {
    type: 'futures_order_book',
    sequence,
    book: {
      instrumentId,
      symbol: 'BTCUSDT',
      priceUnit: 'USDT',
      quantityUnit,
      marketLabel: 'BTC / USDT 무기한',
      asks: [{ price: '62000.50000000', quantity: '1.250' }],
      bids: [{ price: '62000.10000000', quantity: '0.500' }],
      capturedAt: '2026-10-14T00:00:00.000Z',
      effectiveAt: '2026-10-14T00:00:00.000Z',
    },
  };
}
const futuresRequest = (
  instrumentId: unknown = 'instrument-btc',
  type = 'subscribe',
) => ({
  type,
  channel: 'futures_order_book',
  instrumentId,
});

describe('futures_order_book app WebSocket', () => {
  afterEach(() => jest.useRealTimers());

  it.each([null, '', 123, 'x'.repeat(81)])(
    'returns a channel-specific error for invalid instrumentId %j',
    async (instrumentId) => {
      const h = setup();
      const socket = client();
      try {
        await h.connect(socket);
        await h.send(socket, futuresRequest(instrumentId));
        expect(messages(socket).at(-1)).toMatchObject({
          type: 'subscription_error',
          channel: 'futures_order_book',
          code: 'INVALID_SUBSCRIPTION',
        });
        expect(h.instruments.findUnique).not.toHaveBeenCalled();
      } finally {
        h.gateway.onModuleDestroy();
      }
    },
  );

  it('delivers contract books only to that instrument, never across Spot/Futures', async () => {
    const h = setup();
    const futures = client();
    const spot = client();
    try {
      await h.connect(futures);
      await h.connect(spot);
      await h.send(futures, futuresRequest());
      await h.send(spot, request('btc'));
      expect(messages(futures)).toEqual([
        {
          type: 'subscribed',
          channel: 'futures_order_book',
          instrumentId: 'instrument-btc',
        },
      ]);
      h.pushFutures(futuresEvent('7'));
      expect(messages(futures).at(-1)).toEqual({
        type: 'futures_order_book',
        ...futuresEvent('7').book,
      });
      expect(messages(futures).at(-1)).not.toHaveProperty('sequence');
      // The underlying Spot book never reaches the contract subscriber, and
      // the contract book never reaches the Spot subscriber of 'btc'.
      h.push(snapshot('8'));
      expect(messages(futures)).toHaveLength(2);
      expect(messages(spot).map((m) => m.type)).toEqual([
        'subscribed',
        'asset_order_book',
      ]);
      // Repeated/older sequences and mismatched units are dropped.
      h.pushFutures(futuresEvent('7'));
      h.pushFutures(futuresEvent('6'));
      h.pushFutures(futuresEvent('9', 'instrument-btc', 'ETH'));
      expect(messages(futures)).toHaveLength(2);
    } finally {
      h.gateway.onModuleDestroy();
      expect(h.offFutures).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses unknown contracts and fails closed when lookup is unavailable', async () => {
    const h = setup();
    const socket = client();
    try {
      await h.connect(socket);
      await h.send(socket, futuresRequest('instrument-unknown'));
      expect(messages(socket).at(-1)).toMatchObject({
        type: 'subscription_error',
        channel: 'futures_order_book',
        instrumentId: 'instrument-unknown',
        code: 'UNSUPPORTED_INSTRUMENT',
      });
      expect(h.futures(socket)?.subscriptions.size).toBe(0);
      h.instruments.findUnique.mockRejectedValueOnce(new Error('db down'));
      await h.send(socket, futuresRequest());
      expect(messages(socket).at(-1)?.code).toBe('ORDER_BOOK_UNAVAILABLE');
      expect(h.futures(socket)?.subscriptions.size).toBe(0);
    } finally {
      h.gateway.onModuleDestroy();
    }
  });

  it('coalesces latest-only under backpressure and cleans up on unsubscribe/disconnect', async () => {
    jest.useFakeTimers();
    const h = setup();
    const socket = client();
    try {
      await h.connect(socket);
      await h.send(socket, futuresRequest());
      const books = h.futures(socket)!;
      socket.bufferedAmount = 100;
      for (let i = 1; i <= 30; i++) h.pushFutures(futuresEvent(String(i)));
      expect(books.pending.size).toBe(1);
      expect(books.pending.get('instrument-btc')?.sequence).toBe('30');
      expect(messages(socket)).toHaveLength(1);
      socket.bufferedAmount = 0;
      jest.advanceTimersByTime(100);
      expect(messages(socket)).toHaveLength(2);
      expect(books.pending.size).toBe(0);
      socket.bufferedAmount = 100;
      h.pushFutures(futuresEvent('31'));
      await h.send(socket, futuresRequest('instrument-btc', 'unsubscribe'));
      expect(messages(socket).at(-1)).toEqual({
        type: 'unsubscribed',
        channel: 'futures_order_book',
        instrumentId: 'instrument-btc',
      });
      expect(books.pending.size).toBe(0);
      expect(books.subscriptions.size).toBe(0);
      h.gateway.handleDisconnect(socket as never);
      expect(h.internals.clients.size).toBe(0);
    } finally {
      h.gateway.onModuleDestroy();
    }
  });

  it('bounds concurrent contract subscriptions per client', async () => {
    const h = setup();
    const socket = client();
    h.instruments.findUnique.mockReturnValue(new Promise(() => {}));
    try {
      await h.connect(socket);
      void Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          h.send(socket, futuresRequest(`instrument-${i}`)),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.instruments.findUnique).toHaveBeenCalledTimes(20);
      expect(messages(socket).at(-1)?.code).toBe('SUBSCRIPTION_LIMIT');
    } finally {
      h.gateway.onModuleDestroy();
    }
  });
});
