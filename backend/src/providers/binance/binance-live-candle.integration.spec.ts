jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return { Prisma: { Decimal } };
});

import { WebSocket } from 'ws';
import { parseBinanceFiveMinuteKline } from './binance-kline.parser';

const itLive = process.env.BINANCE_LIVE_CANDLE_SMOKE === '1' ? it : it.skip;

describe('Binance native live 5m candle smoke', () => {
  itLive(
    'receives one bounded native kline frame without DB writes',
    async () => {
      const symbol = (
        process.env.BINANCE_CANDLE_SMOKE_SYMBOL ?? 'BTCUSDT'
      ).toLowerCase();
      const base = (
        process.env.BINANCE_WS_MARKET_DATA_BASE_URL ??
        'wss://stream.binance.com:9443'
      ).replace(/\/+$/u, '');
      const socket = new WebSocket(`${base}/ws/${symbol}@kline_5m`);
      try {
        const parsed = await new Promise<
          ReturnType<typeof parseBinanceFiveMinuteKline>
        >((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('BINANCE_LIVE_CANDLE_TIMEOUT')),
            20_000,
          );
          socket.once('error', () => {
            clearTimeout(timeout);
            reject(new Error('BINANCE_LIVE_CANDLE_SOCKET_ERROR'));
          });
          socket.on('message', (data: Buffer | string) => {
            const text =
              typeof data === 'string' ? data : data.toString('utf8');
            const result = parseBinanceFiveMinuteKline(text);
            if (result.state !== 'kline') return;
            clearTimeout(timeout);
            resolve(result);
          });
        });
        expect(parsed.state).toBe('kline');
        if (parsed.state === 'kline') {
          expect(parsed.kline.symbol).toBe(symbol.toUpperCase());
          expect(parsed.kline.closeTime.getTime()).toBeGreaterThan(
            parsed.kline.openTime.getTime(),
          );
        }
      } finally {
        socket.close(1000, 'bounded smoke complete');
      }
    },
    25_000,
  );
});
