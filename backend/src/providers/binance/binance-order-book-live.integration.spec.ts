jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
import { WebSocket } from 'ws';
import { Prisma } from '../../generated/prisma/client';
import {
  binanceCombinedStreamUrl,
  parseBinanceDepth,
} from './binance-order-book.parser';

const live = process.env.BINANCE_LIVE_ORDER_BOOK_SMOKE === '1' ? it : it.skip;

describe('public Binance depth10 smoke (explicit opt-in, no DB)', () => {
  live(
    'receives exact 10+10 snapshots at default cadence and recovers after reconnect',
    async () => {
      const base =
        process.env.BINANCE_ORDER_BOOK_SMOKE_URL ??
        'wss://stream.binance.com:443';
      async function connectAndRead(count: number) {
        const socket = new WebSocket(binanceCombinedStreamUrl(base));
        const observations: Array<{ receivedAt: number; sequence: string }> =
          [];
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('BINANCE_DEPTH_SMOKE_TIMEOUT')),
              15_000,
            );
            const fail = (error: Error) => {
              clearTimeout(timeout);
              reject(error);
            };
            socket.once('error', fail);
            socket.once('open', () =>
              socket.send(
                JSON.stringify({
                  method: 'SUBSCRIBE',
                  params: ['btcusdt@depth10'],
                  id: 1,
                }),
              ),
            );
            socket.on('message', (buffer: Buffer) => {
              try {
                const parsed = parseBinanceDepth(buffer.toString('utf8'));
                if (parsed.state === 'other') return;
                expect(parsed.state).toBe('depth');
                if (parsed.state !== 'depth')
                  throw new Error('invalid live depth');
                expect(parsed.symbol).toBe('BTCUSDT');
                expect(parsed.asks).toHaveLength(10);
                expect(parsed.bids).toHaveLength(10);
                const raw = JSON.parse(buffer.toString('utf8')) as {
                  data: { asks: string[][]; bids: string[][]; E?: unknown };
                };
                expect(raw.data.E).toBeUndefined();
                // Verify actual provider ordering and exact string preservation.
                expect(parsed.asks).toEqual(
                  raw.data.asks.map(([price, quantity]) => ({
                    price,
                    quantity,
                  })),
                );
                expect(parsed.bids).toEqual(
                  raw.data.bids.map(([price, quantity]) => ({
                    price,
                    quantity,
                  })),
                );
                expect(
                  new Prisma.Decimal(parsed.asks[0].price).gt(
                    parsed.bids[0].price,
                  ),
                ).toBe(true);
                observations.push({
                  receivedAt: Date.now(),
                  sequence: parsed.sequence,
                });
                if (observations.length === count) {
                  clearTimeout(timeout);
                  resolve();
                }
              } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
              }
            });
          });
          return observations;
        } finally {
          socket.terminate();
        }
      }
      const first = await connectAndRead(3);
      const cadence = (first[2].receivedAt - first[0].receivedAt) / 2;
      expect(cadence).toBeGreaterThan(500);
      expect(cadence).toBeLessThan(3000);
      const next = await connectAndRead(1);
      expect(BigInt(next[0].sequence)).toBeGreaterThan(
        BigInt(first[2].sequence),
      );
    },
    35_000,
  );
});
