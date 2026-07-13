import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import {
  REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT,
  REDIS_DISCARD_RECONCILED_LIVE_CANDLE_SCRIPT,
  REDIS_MARK_LIVE_CANDLE_FINALIZED_SCRIPT,
  REDIS_MARK_LIVE_CANDLE_INCOMPLETE_SCRIPT,
} from '../redis/redis-lua-scripts';
import { RedisUnavailableError } from '../redis/redis.types';
import {
  LIVE_CANDLE_CONFIG,
  type LiveCandleConfig,
} from './live-candle.config';
import { LiveCandleHealthService } from './live-candle-health.service';
import type {
  LiveCandleBaseline,
  LiveCandleStoreUpdateResult,
  LiveCandleStoreUpdateStatus,
  LiveFiveMinuteCandleState,
  NormalizedLiveCandleEvent,
} from './live-candle.types';

const LIVE_KEY_PREFIX = 'candles:live:v1';
export const LIVE_CANDLE_ACTIVE_INDEX_KEY = `${LIVE_KEY_PREFIX}:active`;
const MAX_FINALIZE_BATCH = 500;

@Injectable()
export class LiveCandleStoreService {
  constructor(
    private readonly redis: RedisService,
    private readonly health: LiveCandleHealthService,
    @Inject(LIVE_CANDLE_CONFIG) private readonly config: LiveCandleConfig,
  ) {}

  async applyEvent(input: {
    event: NormalizedLiveCandleEvent;
    ownerGeneration: string;
    ownerLeaseKey: string;
    baseline?: LiveCandleBaseline | null;
    continuousAtBucketOpen?: boolean;
  }): Promise<LiveCandleStoreUpdateResult> {
    const stateKey = buildLiveCandleStateKey(
      input.event.assetId,
      input.event.openTime,
      input.ownerGeneration,
    );
    const pointerKey = buildLiveCandlePointerKey(input.event.assetId);
    const dedupeKey = buildLiveCandleDedupeKey(
      input.event.assetId,
      input.event.openTime,
      input.ownerGeneration,
      input.event.eventId,
    );
    const initial = this.initialState(
      input.event,
      input.ownerGeneration,
      input.baseline ?? null,
      input.continuousAtBucketOpen === true,
    );
    const event = {
      mode: input.event.mode,
      openTime: input.event.openTime.toISOString(),
      closeTime: input.event.closeTime.toISOString(),
      eventTime: input.event.eventTime.toISOString(),
      price: input.event.price,
      tradeQuantity: input.event.tradeQuantity,
      amount: input.event.amount,
      sequence: input.event.sequence,
      absolute: input.event.absolute,
    };

    try {
      const raw = await this.redis.eval(
        REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT,
        [
          input.ownerLeaseKey,
          stateKey,
          pointerKey,
          dedupeKey,
          LIVE_CANDLE_ACTIVE_INDEX_KEY,
        ],
        [
          input.ownerGeneration,
          input.ownerGeneration,
          input.event.mode,
          JSON.stringify(event),
          JSON.stringify(initial),
          String(this.config.stateTtlSeconds),
          String(this.config.stateTtlSeconds),
          String(this.config.stateTtlSeconds),
          String(input.event.closeTime.getTime()),
        ],
      );
      const parsed = parseUpdateResult(raw);
      if (parsed.status === 'updated') this.health.increment('eventsAccepted');
      if (parsed.status === 'duplicate')
        this.health.increment('eventsDuplicate');
      if (parsed.status === 'out_of_order') {
        this.health.increment('eventsOutOfOrder');
      }
      return { ...parsed, stateKey };
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        this.health.increment('redisLuaFailure');
      }
      throw error;
    }
  }

  async getCurrent(assetId: string): Promise<LiveFiveMinuteCandleState | null> {
    const stateKey = await this.redis.get(buildLiveCandlePointerKey(assetId));
    if (!stateKey || !stateKey.startsWith(`${LIVE_KEY_PREFIX}:state:`)) {
      return null;
    }
    return this.getByKey(stateKey);
  }

  async getByKey(stateKey: string): Promise<LiveFiveMinuteCandleState | null> {
    const raw = await this.redis.get(stateKey);
    if (!raw) return null;
    try {
      return validateState(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  async getDueStateKeys(now: Date, graceMs: number): Promise<string[]> {
    const keys = await this.redis.zrangeByScore(
      LIVE_CANDLE_ACTIVE_INDEX_KEY,
      '-inf',
      now.getTime() - graceMs,
    );
    this.health.setActiveBuckets(keys.length);
    return keys.slice(0, MAX_FINALIZE_BATCH);
  }

  async markIncomplete(input: {
    stateKey: string;
    ownerLeaseKey: string;
    ownerGeneration: string;
  }): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          REDIS_MARK_LIVE_CANDLE_INCOMPLETE_SCRIPT,
          [input.ownerLeaseKey, input.stateKey],
          [input.ownerGeneration, String(this.config.stateTtlSeconds)],
        ),
      ) === 1
    );
  }

  async markFinalized(input: {
    stateKey: string;
    ownerLeaseKey: string;
    ownerGeneration: string;
    revision: number;
  }): Promise<LiveFiveMinuteCandleState | null> {
    const raw = await this.redis.eval(
      REDIS_MARK_LIVE_CANDLE_FINALIZED_SCRIPT,
      [input.ownerLeaseKey, input.stateKey, LIVE_CANDLE_ACTIVE_INDEX_KEY],
      [
        input.ownerGeneration,
        String(input.revision),
        String(this.config.stateTtlSeconds),
      ],
    );
    if (raw === 0 || raw === '0') return null;
    try {
      return validateState(JSON.parse(String(raw)) as unknown);
    } catch {
      return null;
    }
  }

  async removeFromFinalizeIndex(stateKey: string): Promise<void> {
    await this.redis.removeFromSortedSet(LIVE_CANDLE_ACTIVE_INDEX_KEY, [
      stateKey,
    ]);
  }

  async discardReconciledCurrent(
    assetId: string,
    openTime: Date,
  ): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          REDIS_DISCARD_RECONCILED_LIVE_CANDLE_SCRIPT,
          [buildLiveCandlePointerKey(assetId), LIVE_CANDLE_ACTIVE_INDEX_KEY],
          [openTime.toISOString()],
        ),
      ) === 1
    );
  }

  private initialState(
    event: NormalizedLiveCandleEvent,
    ownerGeneration: string,
    baseline: LiveCandleBaseline | null,
    continuousAtBucketOpen: boolean,
  ): LiveFiveMinuteCandleState {
    const absolute = event.absolute;
    const open = absolute?.open ?? baseline?.open ?? event.price;
    const high = absolute?.high ?? baseline?.high ?? event.price;
    const low = absolute?.low ?? baseline?.low ?? event.price;
    const close = absolute?.close ?? baseline?.close ?? event.price;
    // Delta values are applied by the Lua reducer below. Seeding them here
    // would count the first trade twice.
    const volume = absolute?.volume ?? baseline?.volume ?? null;
    const amount = absolute?.amount ?? baseline?.amount ?? null;
    return {
      schemaVersion: 1,
      assetId: event.assetId,
      assetType: event.assetType,
      market: event.market,
      symbol: event.symbol,
      interval: '5m',
      openTime: event.openTime.toISOString(),
      closeTime: event.closeTime.toISOString(),
      open,
      high,
      low,
      close,
      volume,
      amount,
      firstEventAt: (baseline?.firstEventAt ?? event.eventTime).toISOString(),
      lastEventAt: (baseline?.lastEventAt ?? event.eventTime).toISOString(),
      sourceUpdatedAt: (
        baseline?.sourceUpdatedAt ?? event.eventTime
      ).toISOString(),
      baselineEventTime: baseline?.baselineEventTime.toISOString() ?? null,
      eventCount: 0,
      revision: 0,
      provisional: true,
      complete: absolute !== null || continuousAtBucketOpen,
      finalized: false,
      providerFinal: absolute?.providerFinal ?? false,
      sourceContinuity: absolute !== null || continuousAtBucketOpen,
      sourceProvider: event.source,
      delayed: event.delayed,
      ownerGeneration,
      lastSequence: baseline ? null : event.sequence,
    };
  }
}

export function buildLiveCandleOwnerLeaseKey(
  provider: 'binance' | 'kis',
  shard = 0,
): string {
  return `${LIVE_KEY_PREFIX}:owner:${provider}:${shard}`;
}

export function buildLiveCandleStateKey(
  assetId: string,
  openTime: Date,
  generation: string,
): string {
  return `${LIVE_KEY_PREFIX}:state:${encodeURIComponent(assetId)}:5m:${openTime.getTime()}:${hash(generation)}`;
}

export function buildLiveCandlePointerKey(assetId: string): string {
  return `${LIVE_KEY_PREFIX}:current:${encodeURIComponent(assetId)}:5m`;
}

export function buildLiveCandleDedupeKey(
  assetId: string,
  openTime: Date,
  generation: string,
  eventId: string,
): string {
  return `${LIVE_KEY_PREFIX}:dedupe:${encodeURIComponent(assetId)}:5m:${openTime.getTime()}:${hash(generation)}:${hash(eventId)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function parseUpdateResult(raw: unknown): {
  status: LiveCandleStoreUpdateStatus;
  state: LiveFiveMinuteCandleState | null;
} {
  if (typeof raw !== 'string') {
    throw new Error('Redis live candle reducer returned an invalid result.');
  }
  const parsed = JSON.parse(raw) as {
    status?: unknown;
    state?: unknown;
  };
  const statuses: readonly LiveCandleStoreUpdateStatus[] = [
    'updated',
    'duplicate',
    'out_of_order',
    'baseline_covered',
    'owner_lost',
    'generation_mismatch',
    'bucket_mismatch',
  ];
  if (!statuses.includes(parsed.status as LiveCandleStoreUpdateStatus)) {
    throw new Error('Redis live candle reducer returned an unknown status.');
  }
  return {
    status: parsed.status as LiveCandleStoreUpdateStatus,
    state: parsed.state ? validateState(parsed.state) : null,
  };
}

function validateState(value: unknown): LiveFiveMinuteCandleState {
  if (!value || typeof value !== 'object') throw new Error('Invalid state.');
  const state = value as Partial<LiveFiveMinuteCandleState>;
  if (
    state.schemaVersion !== 1 ||
    state.interval !== '5m' ||
    typeof state.assetId !== 'string' ||
    typeof state.openTime !== 'string' ||
    typeof state.closeTime !== 'string' ||
    typeof state.ownerGeneration !== 'string' ||
    typeof state.revision !== 'number'
  ) {
    throw new Error('Invalid state.');
  }
  return state as LiveFiveMinuteCandleState;
}
