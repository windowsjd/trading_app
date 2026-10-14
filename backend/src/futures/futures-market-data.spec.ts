jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import {
  FUTURES_MARKET_STATS_MAX_AGE_MS,
  currentFuturesMarketStats,
  futuresMarketLabel,
  parseBinanceFuturesDepth,
  parseBinanceFuturesTicker,
  parseFuturesMarketStats,
  parseFuturesOrderBookEvent,
  presentFuturesMarketStats,
  serializeFuturesMarketStats,
  type FuturesMarketStats,
} from './futures-market-data';

const at = new Date('2026-10-14T03:00:00.000Z');
const depth = (data: Record<string, unknown> = {}, stream?: string) => ({
  stream: stream ?? 'btcusdt@depth10@500ms',
  data: {
    e: 'depthUpdate',
    E: +at,
    T: +at - 2,
    s: 'BTCUSDT',
    U: 100,
    u: 105,
    pu: 99,
    b: [
      ['62000.10', '1.500'],
      ['62000.30', '0.250'],
    ],
    a: [
      ['62000.50', '0.100'],
      ['62000.40', '2.000'],
    ],
    ...data,
  },
});
const ticker = (data: Record<string, unknown> = {}, stream?: string) => ({
  stream: stream ?? 'btcusdt@ticker',
  data: {
    e: '24hrTicker',
    E: +at,
    s: 'BTCUSDT',
    p: '-310.20',
    P: '-0.498',
    w: '62110.0',
    c: '62000.10',
    Q: '0.002',
    o: '62310.30',
    h: '63000.00',
    l: '61500.00',
    v: '182000.5',
    q: '11303000000.12',
    O: +at - 86_400_000,
    C: +at,
    F: 1,
    L: 2,
    n: 2,
    ...data,
  },
});

describe('USDⓈ-M partial book frames', () => {
  it('reads ten-level contract books, best first, with the final update id', () => {
    const parsed = parseBinanceFuturesDepth(depth());
    expect(parsed.state).toBe('depth');
    if (parsed.state !== 'depth') return;
    expect(parsed.symbol).toBe('BTCUSDT');
    expect(parsed.sequence).toBe('105');
    expect(parsed.effectiveAt).toBe(new Date(+at - 2).toISOString());
    expect(parsed.asks.map((l) => l.price)).toEqual(['62000.40', '62000.50']);
    expect(parsed.bids.map((l) => l.price)).toEqual(['62000.30', '62000.10']);
  });

  it.each([
    ['a SUBSCRIBE reply', { result: null, id: 11 }],
    ['a Spot partial book', { stream: 'btcusdt@depth10', data: {} }],
    ['another stream', { stream: 'btcusdt@aggTrade', data: {} }],
  ])('ignores %s', (_name, frame) => {
    expect(parseBinanceFuturesDepth(frame).state).toBe('other');
  });

  it.each([
    ['another event', depth({ e: 'aggTrade' })],
    ['a symbol not matching the stream', depth({ s: 'ETHUSDT' })],
    ['a non-USDT symbol', depth({ s: 'BTCBUSD' }, 'btcbusd@depth10@500ms')],
    ['an unsafe update id', depth({ u: 2 ** 53 })],
    ['a negative update id', depth({ u: -1 })],
    ['no time', depth({ T: undefined, E: undefined })],
    [
      'eleven levels',
      depth({ b: Array.from({ length: 11 }, (_, i) => [`${i + 1}`, '1']) }),
    ],
    ['a zero price', depth({ a: [['0', '1']] })],
    [
      'a duplicate price',
      depth({
        b: [
          ['1.0', '1'],
          ['1', '2'],
        ],
      }),
    ],
    ['a number instead of a string', depth({ a: [[62000.5, '1']] })],
    ['a malformed level', depth({ a: [['62000.5']] })],
  ])('refuses the whole snapshot on %s', (_name, frame) => {
    expect(parseBinanceFuturesDepth(frame).state).toBe('invalid');
  });
});

describe('USDⓈ-M rolling 24h ticker frames', () => {
  it('keeps only the provider change percent, quote volume and window', () => {
    const parsed = parseBinanceFuturesTicker(ticker(), at);
    expect(parsed).toEqual({
      state: 'ticker',
      stats: {
        symbol: 'BTCUSDT',
        priceChangePercent: '-0.498',
        quoteVolume: '11303000000.12',
        windowOpenTime: new Date(+at - 86_400_000).toISOString(),
        windowCloseTime: at.toISOString(),
        eventTime: at.toISOString(),
        receivedAt: at.toISOString(),
      },
    });
  });

  it.each([
    ['another event', ticker({ e: 'markPriceUpdate' })],
    ['a symbol not matching the stream', ticker({ s: 'ETHUSDT' })],
    ['a non-decimal change', ticker({ P: '1e3' })],
    ['a numeric change', ticker({ P: 1 })],
    ['a negative volume', ticker({ q: '-1' })],
    ['an empty window', ticker({ O: +at, C: +at })],
    ['no event time', ticker({ E: undefined })],
  ])('refuses %s', (_name, frame) => {
    expect(parseBinanceFuturesTicker(frame, at).state).toBe('invalid');
  });

  it('ignores other streams', () => {
    expect(parseBinanceFuturesTicker(depth(), at).state).toBe('other');
  });
});

describe('shared 24h statistics', () => {
  const stats = (receivedAt: Date): FuturesMarketStats => ({
    symbol: 'BTCUSDT',
    priceChangePercent: '1.25',
    quoteVolume: '1000',
    windowOpenTime: new Date(+receivedAt - 86_400_000).toISOString(),
    windowCloseTime: receivedAt.toISOString(),
    eventTime: receivedAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
  });

  it('round-trips valid entries and drops malformed ones', () => {
    const good = stats(at);
    const raw = JSON.stringify({
      version: 1,
      stats: [good, { ...good, symbol: 'ETHUSDT', quoteVolume: 'NaN' }],
    });
    const parsed = parseFuturesMarketStats(raw);
    expect([...parsed.keys()]).toEqual(['BTCUSDT']);
    expect(
      parseFuturesMarketStats(serializeFuturesMarketStats([good])).get(
        'BTCUSDT',
      ),
    ).toEqual(good);
  });

  it.each([null, '', 'not json', '{"version":2,"stats":[]}', '[]'])(
    'reads %j as no statistics',
    (raw) => {
      expect(parseFuturesMarketStats(raw).size).toBe(0);
    },
  );

  it('treats statistics older than the window, or from the future, as unavailable', () => {
    const edge = new Date(+at - FUTURES_MARKET_STATS_MAX_AGE_MS);
    expect(currentFuturesMarketStats(stats(edge), at) !== null).toBe(true);
    expect(
      currentFuturesMarketStats(stats(new Date(+edge - 1)), at) === null,
    ).toBe(true);
    expect(
      currentFuturesMarketStats(stats(new Date(+at + 5_001)), at) === null,
    ).toBe(true);
    expect(currentFuturesMarketStats(undefined, at) === null).toBe(true);
  });

  it('never presents a number when unavailable', () => {
    expect(presentFuturesMarketStats(null)).toEqual({
      state: 'unavailable',
      priceChangePercent: null,
      quoteVolume: null,
      windowOpenTime: null,
      windowCloseTime: null,
      receivedAt: null,
    });
    expect(presentFuturesMarketStats(stats(at))).toMatchObject({
      state: 'available',
      priceChangePercent: '1.25',
      quoteVolume: '1000',
    });
  });
});

describe('relayed futures book events', () => {
  const event = {
    type: 'futures_order_book',
    sequence: '105',
    book: {
      instrumentId: 'instrument-btc',
      symbol: 'BTCUSDT',
      priceUnit: 'USDT',
      quantityUnit: 'BTC',
      marketLabel: futuresMarketLabel('BTCUSDT'),
      asks: [{ price: '62000.5', quantity: '1' }],
      bids: [{ price: '62000.1', quantity: '2' }],
      capturedAt: at.toISOString(),
      effectiveAt: at.toISOString(),
    },
  };

  it('accepts a valid event', () => {
    expect(parseFuturesOrderBookEvent(JSON.stringify(event))).toEqual(event);
  });

  it.each([
    ['a Spot event type', { ...event, type: 'asset_order_book' }],
    ['a bad sequence', { ...event, sequence: '01' }],
    ['a bad symbol', { ...event, book: { ...event.book, symbol: 'BTC' } }],
    ['no instrument', { ...event, book: { ...event.book, instrumentId: '' } }],
    [
      'a bad level',
      {
        ...event,
        book: { ...event.book, asks: [{ price: '-1', quantity: '1' }] },
      },
    ],
    ['a bad time', { ...event, book: { ...event.book, effectiveAt: 'later' } }],
  ])('rejects %s', (_name, value) => {
    expect(parseFuturesOrderBookEvent(JSON.stringify(value)) === null).toBe(
      true,
    );
  });
});
