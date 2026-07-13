import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { readRedisConfig } from '../redis/redis.config';
import { readLiveCandleConfig } from './live-candle.config';
import { LiveCandleHealthService } from './live-candle-health.service';
import {
  buildLiveCandleDedupeKey,
  buildLiveCandleOwnerLeaseKey,
  buildLiveCandlePointerKey,
  buildLiveCandleStateKey,
  LIVE_CANDLE_ACTIVE_INDEX_KEY,
  LiveCandleStoreService,
} from './live-candle-store.service';
import type { NormalizedLiveCandleEvent } from './live-candle.types';

const itRedis = process.env.CANDLE_LIVE_REDIS_SMOKE === '1' ? it : it.skip;

describe('LiveCandleStoreService real Redis smoke', () => {
  itRedis(
    'atomically deduplicates delta volume, preserves out-of-order close, and blocks old owners',
    async () => {
      const redis = new RedisService(readRedisConfig());
      const generation = randomUUID();
      const assetId = `live-candle-smoke-${randomUUID()}`;
      const leaseKey = buildLiveCandleOwnerLeaseKey(
        'kis',
        Math.floor(Math.random() * 1_000_000_000) + 1,
      );
      const config = { ...readLiveCandleConfig({}), stateTtlSeconds: 300 };
      const service = new LiveCandleStoreService(
        redis,
        new LiveCandleHealthService(),
        config,
      );
      const openTime = new Date('2026-07-13T00:00:00.000Z');
      const stateKey = buildLiveCandleStateKey(assetId, openTime, generation);
      const pointerKey = buildLiveCandlePointerKey(assetId);
      const eventIds = [
        'first',
        'second',
        'late',
        'race',
        'same-time-new',
        'same-time-old',
      ];
      try {
        expect(await redis.ping()).toBe('PONG');
        expect(await redis.setNxPx(leaseKey, generation, 120_000)).toBe(true);
        const first = await service.applyEvent({
          event: event(assetId, 'first', 60_000, '100', '2'),
          ownerGeneration: generation,
          ownerLeaseKey: leaseKey,
          continuousAtBucketOpen: true,
        });
        expect(first.state).toMatchObject({
          open: '100.00000000',
          close: '100.00000000',
          volume: '2.00000000',
          eventCount: 1,
        });

        await service.applyEvent({
          event: event(assetId, 'second', 120_000, '110', '3'),
          ownerGeneration: generation,
          ownerLeaseKey: leaseKey,
        });
        const duplicate = await service.applyEvent({
          event: event(assetId, 'second', 120_000, '110', '3'),
          ownerGeneration: generation,
          ownerLeaseKey: leaseKey,
        });
        expect(duplicate.status).toBe('duplicate');

        const late = await service.applyEvent({
          event: event(assetId, 'late', 90_000, '90', '1'),
          ownerGeneration: generation,
          ownerLeaseKey: leaseKey,
        });
        expect(late).toMatchObject({
          status: 'out_of_order',
          state: {
            high: '110.00000000',
            low: '90.00000000',
            close: '110.00000000',
            volume: '6.00000000',
          },
        });

        const race = await Promise.all(
          Array.from({ length: 20 }, () =>
            service.applyEvent({
              event: event(assetId, 'race', 180_000, '108', '4'),
              ownerGeneration: generation,
              ownerLeaseKey: leaseKey,
            }),
          ),
        );
        expect(
          race.filter((result) => result.status === 'updated'),
        ).toHaveLength(1);
        expect((await service.getCurrent(assetId))?.volume).toBe('10.00000000');

        await service.applyEvent({
          event: event(assetId, 'same-time-new', 200_000, '112', '1', '200'),
          ownerGeneration: generation,
          ownerLeaseKey: leaseKey,
        });
        const sameTimeOlderSequence = await service.applyEvent({
          event: event(assetId, 'same-time-old', 200_000, '80', '1', '199'),
          ownerGeneration: generation,
          ownerLeaseKey: leaseKey,
        });
        expect(sameTimeOlderSequence).toMatchObject({
          status: 'out_of_order',
          state: {
            low: '80.00000000',
            close: '112.00000000',
            volume: '12.00000000',
          },
        });

        const oldOwner = await service.applyEvent({
          event: event(assetId, 'old-owner', 240_000, '109', '99'),
          ownerGeneration: 'stale-generation',
          ownerLeaseKey: leaseKey,
        });
        expect(oldOwner.status).toBe('owner_lost');
      } finally {
        try {
          await redis
            .removeFromSortedSet(LIVE_CANDLE_ACTIVE_INDEX_KEY, [stateKey])
            .catch(() => 0);
          await Promise.allSettled([
            redis.delete(stateKey),
            redis.delete(pointerKey),
            redis.delete(leaseKey),
            ...eventIds.map((eventId) =>
              redis.delete(
                buildLiveCandleDedupeKey(
                  assetId,
                  openTime,
                  generation,
                  eventId,
                ),
              ),
            ),
          ]);
        } finally {
          await redis.onModuleDestroy();
        }
      }
    },
    30_000,
  );
});

function event(
  assetId: string,
  eventId: string,
  offsetMs: number,
  price: string,
  quantity: string,
  sequence = String(offsetMs),
): NormalizedLiveCandleEvent {
  return {
    provider: 'kis',
    source: 'kis_krx_realtime_trade',
    assetId,
    assetType: 'domestic_stock' as never,
    market: 'KRX',
    symbol: '005930',
    eventTime: new Date(Date.parse('2026-07-13T00:00:00.000Z') + offsetMs),
    receivedAt: new Date(Date.parse('2026-07-13T00:05:00.000Z')),
    price: `${price}.00000000`,
    tradeQuantity: `${quantity}.00000000`,
    amount: null,
    eventId,
    sequence,
    marketSession: 'regular',
    delayed: false,
    openTime: new Date('2026-07-13T00:00:00.000Z'),
    closeTime: new Date('2026-07-13T00:05:00.000Z'),
    mode: 'delta',
    absolute: null,
  };
}
