jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return { Prisma: { Decimal } };
});

import { parseBinanceFiveMinuteKline } from './binance-kline.parser';

describe('parseBinanceFiveMinuteKline', () => {
  const frame = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      e: 'kline',
      E: 299_000,
      s: 'BTCUSDT',
      k: {
        t: 0,
        T: 299_999,
        s: 'BTCUSDT',
        i: '5m',
        f: 10,
        L: 20,
        o: '100',
        h: '110',
        l: '90',
        c: '105',
        v: '12.5',
        n: 11,
        x: false,
        q: '1300.25',
        ...overrides,
      },
    });

  it('parses native absolute 5m OHLCV and final metadata', () => {
    const parsed = parseBinanceFiveMinuteKline(frame({ x: true }));

    expect(parsed.state).toBe('kline');
    if (parsed.state !== 'kline') return;
    expect(parsed.kline).toMatchObject({
      symbol: 'BTCUSDT',
      openTime: new Date(0),
      closeTime: new Date(300_000),
      open: '100.00000000',
      high: '110.00000000',
      low: '90.00000000',
      close: '105.00000000',
      volume: '12.50000000',
      quoteVolume: '1300.25000000',
      final: true,
      tradeCount: 11,
    });
    expect(parsed.kline.eventId).toContain('binance:BTCUSDT:0:');
  });

  it('accepts combined-stream envelopes and subscription acknowledgements', () => {
    const combined = parseBinanceFiveMinuteKline(
      JSON.stringify({ stream: 'btcusdt@kline_5m', data: JSON.parse(frame()) }),
    );
    expect(combined.state).toBe('kline');
    expect(
      parseBinanceFiveMinuteKline(JSON.stringify({ result: null, id: 1 })),
    ).toEqual({ state: 'ack' });
  });

  it('rejects subscription errors without exposing provider response text', () => {
    expect(
      parseBinanceFiveMinuteKline(
        JSON.stringify({ id: 1, code: 2, msg: 'provider detail' }),
      ),
    ).toEqual({
      state: 'failed',
      reason: 'BINANCE_SUBSCRIPTION_FAILED',
      message: 'Binance rejected the kline subscription request.',
    });
  });

  it('rejects malformed intervals, bucket boundaries, and inconsistent OHLC', () => {
    expect(parseBinanceFiveMinuteKline(frame({ i: '1m' }))).toMatchObject({
      state: 'failed',
      reason: 'INVALID_KLINE',
    });
    expect(parseBinanceFiveMinuteKline(frame({ T: 300_000 }))).toMatchObject({
      state: 'failed',
    });
    expect(parseBinanceFiveMinuteKline(frame({ h: '99' }))).toMatchObject({
      state: 'failed',
    });
  });
});
