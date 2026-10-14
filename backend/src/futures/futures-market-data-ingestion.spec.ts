jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { EventEmitter } from 'node:events';
import {
  FUTURES_MARKET_WS_URL,
  FUTURES_PUBLIC_WS_URL,
  FuturesMarketDataIngestion,
} from './futures-market-data-ingestion.service';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  pings = 0;
  terminated = false;
  constructor(readonly url: string) {
    super();
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  ping() {
    this.pings += 1;
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.terminated = true;
    this.close();
  }
}

const contract = (symbol: string) => ({
  symbol,
  pair: symbol,
  baseAsset: symbol.replace('USDT', ''),
  contractType: 'PERPETUAL',
  status: 'TRADING',
  quoteAsset: 'USDT',
  marginAsset: 'USDT',
  underlyingType: 'COIN',
});
const instrument = (id: string, symbol: string) => ({
  id,
  isActive: true,
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  markContractJson: contract(symbol),
  markVerifiedAt: new Date(Date.now() - 60_000),
  underlyingAsset: {
    symbol,
    isActive: true,
    assetType: 'crypto',
    market: 'BINANCE',
    currencyCode: 'USD',
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
  },
});
const depthFrame = (symbol: string, u: number, price = '62000.5') => ({
  stream: `${symbol.toLowerCase()}@depth10@500ms`,
  data: {
    e: 'depthUpdate',
    E: Date.now(),
    T: Date.now(),
    s: symbol,
    U: u,
    u,
    pu: u - 1,
    b: [[price, '1']],
    a: [['62001', '2']],
  },
});
const tickerFrame = (symbol: string, eventTime: number, change = '1.25') => ({
  stream: `${symbol.toLowerCase()}@ticker`,
  data: {
    e: '24hrTicker',
    E: eventTime,
    s: symbol,
    P: change,
    q: '1000',
    c: '62000',
    O: eventTime - 86_400_000,
    C: eventTime,
  },
});

describe('USDⓈ-M display market data ingestion', () => {
  const original = process.env.FUTURES_MARKET_DATA_STREAMING_ENABLED;
  let sockets: FakeSocket[];
  let publishFutures: jest.Mock;
  let write: jest.Mock;
  let service: FuturesMarketDataIngestion;
  beforeEach(() => {
    process.env.FUTURES_MARKET_DATA_STREAMING_ENABLED = 'true';
    sockets = [];
    publishFutures = jest.fn().mockResolvedValue(true);
    write = jest.fn().mockResolvedValue(true);
    service = new FuturesMarketDataIngestion(
      {
        futuresInstrument: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              instrument('i-btc', 'BTCUSDT'),
              instrument('i-eth', 'ETHUSDT'),
            ]),
        },
      } as never,
      { write } as never,
      { publishFutures } as never,
      ((url: string) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      }) as never,
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await service.onModuleDestroy();
    if (original === undefined)
      delete process.env.FUTURES_MARKET_DATA_STREAMING_ENABLED;
    else process.env.FUTURES_MARKET_DATA_STREAMING_ENABLED = original;
  });

  it('opens one shared socket per route and subscribes every verified contract', async () => {
    await service.cycle();
    expect(sockets.map((s) => s.url)).toEqual([
      FUTURES_PUBLIC_WS_URL,
      FUTURES_MARKET_WS_URL,
    ]);
    sockets.forEach((socket) => socket.emit('open'));
    expect(sockets[0].sent).toEqual([
      {
        method: 'SUBSCRIBE',
        params: ['btcusdt@depth10@500ms', 'ethusdt@depth10@500ms'],
        id: 11,
      },
    ]);
    expect(sockets[1].sent).toEqual([
      {
        method: 'SUBSCRIBE',
        params: ['btcusdt@ticker', 'ethusdt@ticker'],
        id: 12,
      },
    ]);
    // A second cycle reuses the same two connections.
    await service.cycle();
    expect(sockets.length).toBe(2);
  });

  it('publishes the newest valid book per contract with its instrument identity', async () => {
    await service.refreshTargets();
    const at = new Date('2026-10-14T03:00:00Z');
    expect(service.acceptDepth({ result: null, id: 11 }, at)).toBe(false);
    expect(service.acceptDepth(depthFrame('BTCUSDT', 10), at)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishFutures).toHaveBeenCalledTimes(1);
    const [event] = publishFutures.mock.calls[0] as [Record<string, any>];
    expect(event.type).toBe('futures_order_book');
    expect(event.sequence).toBe('10');
    expect(event.book.instrumentId).toBe('i-btc');
    expect(event.book.symbol).toBe('BTCUSDT');
    expect(event.book.quantityUnit).toBe('BTC');
    expect(event.book.priceUnit).toBe('USDT');
    expect(event.book.capturedAt).toBe(at.toISOString());
    // Older or repeated update ids and unoffered contracts are never relayed.
    expect(service.acceptDepth(depthFrame('BTCUSDT', 10), at)).toBe(true);
    expect(service.acceptDepth(depthFrame('BTCUSDT', 9), at)).toBe(true);
    expect(service.acceptDepth(depthFrame('SOLUSDT', 50), at)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishFutures).toHaveBeenCalledTimes(1);
  });

  it('coalesces books while a publish is in flight', async () => {
    await service.refreshTargets();
    let release!: () => void;
    publishFutures.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(true))),
    );
    const at = new Date();
    service.acceptDepth(depthFrame('BTCUSDT', 1, '1'), at);
    service.acceptDepth(depthFrame('BTCUSDT', 2, '2'), at);
    service.acceptDepth(depthFrame('BTCUSDT', 3, '3'), at);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      publishFutures.mock.calls.map(
        ([event]: [Record<string, any>]) => event.sequence,
      ),
    ).toEqual(['1', '3']);
  });

  it('keeps the newest ticker per contract and writes the shared statistics', async () => {
    await service.cycle();
    const base = Date.now();
    expect(service.acceptTicker(tickerFrame('BTCUSDT', base), new Date())).toBe(
      true,
    );
    expect(
      service.acceptTicker(tickerFrame('BTCUSDT', base - 1, '-9'), new Date()),
    ).toBe(true);
    expect(service.marketStats().map((s) => s.priceChangePercent)).toEqual([
      '1.25',
    ]);
    write.mockResolvedValueOnce(false);
    await service.cycle();
    await service.cycle();
    expect(write).toHaveBeenCalledTimes(2);
    expect(
      (write.mock.calls[1][0] as Array<{ symbol: string }>).map(
        (s) => s.symbol,
      ),
    ).toEqual(['BTCUSDT']);
    // Nothing changed since the successful write: no rewrite.
    await service.cycle();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('replaces a socket that stays silent for 15 seconds', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await service.cycle();
    sockets.forEach((socket) => socket.emit('open'));
    now += 15_001;
    await service.cycle();
    expect(sockets.slice(0, 2).every((s) => s.terminated)).toBe(true);
    await service.cycle();
    expect(sockets.length).toBe(4);
  });

  it('does nothing while streaming is disabled', async () => {
    process.env.FUTURES_MARKET_DATA_STREAMING_ENABLED = 'false';
    service.onModuleInit();
    await service.cycle();
    expect(sockets.length).toBe(0);
  });
});
