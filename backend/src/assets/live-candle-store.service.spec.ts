jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
}));

import { AssetType } from '../generated/prisma/client';
import { REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT } from '../redis/redis-lua-scripts';
import { readLiveCandleConfig } from './live-candle.config';
import { LiveCandleHealthService } from './live-candle-health.service';
import { LiveCandleStoreService } from './live-candle-store.service';
import type {
  LiveFiveMinuteCandleState,
  NormalizedLiveCandleEvent,
} from './live-candle.types';

describe('LiveCandleStoreService', () => {
  it('does not seed a delta quantity before the atomic reducer applies it', async () => {
    let initial: LiveFiveMinuteCandleState | null = null;
    const redis = {
      eval: jest.fn(
        (
          _script: string,
          _keys: readonly string[],
          args: readonly string[],
        ) => {
          initial = JSON.parse(args[4]) as LiveFiveMinuteCandleState;
          return Promise.resolve(
            JSON.stringify({ status: 'updated', state: initial }),
          );
        },
      ),
    };
    const service = new LiveCandleStoreService(
      redis as never,
      new LiveCandleHealthService(),
      readLiveCandleConfig({}),
    );

    await service.applyEvent({
      event: deltaEvent(),
      ownerGeneration: 'generation-1',
      ownerLeaseKey: 'lease',
      continuousAtBucketOpen: true,
    });

    expect(initial).toMatchObject({
      open: '100.00000000',
      high: '100.00000000',
      low: '100.00000000',
      close: '100.00000000',
      volume: null,
      amount: null,
      complete: true,
      sourceContinuity: true,
      eventCount: 0,
    });
    const evalCalls = redis.eval.mock.calls as unknown[][];
    const event = JSON.parse((evalCalls[0][2] as readonly string[])[3]) as {
      tradeQuantity: string;
    };
    expect(event.tradeQuantity).toBe('2.00000000');
  });

  it('keeps a mid-bucket delta candle explicitly incomplete without hydration', async () => {
    let initial: LiveFiveMinuteCandleState | null = null;
    const redis = {
      eval: jest.fn((_script, _keys, args: readonly string[]) => {
        initial = JSON.parse(args[4]) as LiveFiveMinuteCandleState;
        return Promise.resolve(
          JSON.stringify({ status: 'updated', state: initial }),
        );
      }),
    };
    const service = new LiveCandleStoreService(
      redis as never,
      new LiveCandleHealthService(),
      readLiveCandleConfig({}),
    );
    await service.applyEvent({
      event: deltaEvent(),
      ownerGeneration: 'generation-1',
      ownerLeaseKey: 'lease',
    });
    expect(initial).toMatchObject({ complete: false, sourceContinuity: false });
  });

  it('uses one ownership-checked Lua operation and contains no global keyspace command', () => {
    expect(REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT).toContain(
      "redis.call('GET', KEYS[1]) ~= ARGV[1]",
    );
    expect(REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT).toContain('decimal_add');
    expect(REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT).toContain(
      "status=wasOutOfOrder and 'out_of_order' or 'updated'",
    );
    expect(REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT).not.toMatch(
      /redis\.call\('(KEYS|SCAN|FLUSHDB|FLUSHALL)'/u,
    );
  });
});

function deltaEvent(): NormalizedLiveCandleEvent {
  return {
    provider: 'kis',
    source: 'kis_krx_realtime_trade',
    assetId: 'asset-1',
    assetType: AssetType.domestic_stock,
    market: 'KRX',
    symbol: '005930',
    eventTime: new Date('2026-07-13T00:01:00.000Z'),
    receivedAt: new Date('2026-07-13T00:01:01.000Z'),
    price: '100.00000000',
    tradeQuantity: '2.00000000',
    amount: null,
    eventId: 'event-1',
    sequence: '1',
    marketSession: 'regular',
    delayed: false,
    openTime: new Date('2026-07-13T00:00:00.000Z'),
    closeTime: new Date('2026-07-13T00:05:00.000Z'),
    mode: 'delta',
    absolute: null,
  };
}
