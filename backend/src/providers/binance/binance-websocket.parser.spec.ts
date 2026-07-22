jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      USD: 'USD',
    },
    Prisma: {
      Decimal,
    },
  };
});

import { CurrencyCode } from '../../generated/prisma/client';
import { parseBinanceWebSocketMessage } from './binance-websocket.parser';

describe('Binance WebSocket parser', () => {
  it('parses an exact trade tick with a stable provider trade id', () => {
    const parsed = parseBinanceWebSocketMessage({
      frame: JSON.stringify({
        e: 'trade',
        E: 1784682000000,
        T: 1784682000001,
        s: 'BTCUSDT',
        t: 4242,
        p: '90000.12345678',
      }),
      receivedAt: new Date('2026-07-22T01:00:00.010Z'),
    });

    expect(parsed).toMatchObject({
      state: 'trade',
      trade: {
        providerSymbol: 'BTCUSDT',
        tradeId: '4242',
        price: '90000.12345678',
        currencyCode: CurrencyCode.USD,
      },
    });
  });

  const receivedAt = new Date('2026-06-19T03:00:30.000Z');

  it('parses combined spot ticker stream payloads', () => {
    const parsed = parseBinanceWebSocketMessage({
      frame: JSON.stringify({
        stream: 'btcusdt@ticker',
        data: {
          e: '24hrTicker',
          E: Date.parse('2026-06-19T03:00:28.000Z'),
          s: 'BTCUSDT',
          P: '1.750',
          c: '100123.123456789',
          b: '100122.5',
          a: '100124.5',
          C: Date.parse('2026-06-19T03:00:27.000Z'),
        },
      }),
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'ticker',
      ticker: {
        providerSymbol: 'BTCUSDT',
        streamName: 'btcusdt@ticker',
        price: '100123.12345679',
        changeRate: '1.75000000',
        bidPrice: '100122.50000000',
        askPrice: '100124.50000000',
        currencyCode: CurrencyCode.USD,
        sourceTimestamp: new Date('2026-06-19T03:00:28.000Z'),
        effectiveAt: new Date('2026-06-19T03:00:28.000Z'),
        receivedAt,
      },
    });
  });

  it('parses subscription acknowledgements', () => {
    const parsed = parseBinanceWebSocketMessage({
      frame: JSON.stringify({
        result: null,
        id: 1,
      }),
      receivedAt,
    });

    expect(parsed).toEqual({
      state: 'ack',
      id: 1,
      result: null,
      receivedAt,
    });
  });

  it('parses control-plane errors without treating them as ticker payloads', () => {
    const parsed = parseBinanceWebSocketMessage({
      frame: JSON.stringify({
        code: 2,
        msg: 'Invalid request',
        id: 1,
      }),
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'failed',
      reason: 'BINANCE_WS_CONTROL_ERROR',
      message: 'Invalid request',
      receivedAt,
    });
  });

  it('parses serverShutdown events', () => {
    const parsed = parseBinanceWebSocketMessage({
      frame: JSON.stringify({
        e: 'serverShutdown',
        E: Date.parse('2026-06-19T03:00:28.000Z'),
      }),
      receivedAt,
    });

    expect(parsed).toMatchObject({
      state: 'server_shutdown',
      eventTime: new Date('2026-06-19T03:00:28.000Z'),
      receivedAt,
    });
  });
});
