import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { RedisService } from '../redis/redis.service';
import { RedisLockService } from '../redis/redis-lock.service';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import {
  LIVE_CANDLE_CONFIG,
  type LiveCandleConfig,
} from './live-candle.config';
import { LiveCandleHealthService } from './live-candle-health.service';
import { LiveCandlePublisherService } from './live-candle-publisher.service';
import {
  buildLiveCandleOwnerLeaseKey,
  LiveCandleStoreService,
} from './live-candle-store.service';
import { MarketCandlesRepository } from './market-candles.repository';
import type { LiveFiveMinuteCandleState } from './live-candle.types';

export const LIVE_CANDLE_FINALIZER_LEASE_KEY =
  'candles:live:v1:finalizer-owner';

@Injectable()
export class LiveCandleFinalizerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LiveCandleFinalizerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: LiveCandleStoreService,
    private readonly repository: MarketCandlesRepository,
    private readonly cache: AssetCandlesCacheService,
    private readonly redis: RedisService,
    private readonly locks: RedisLockService,
    private readonly publisher: LiveCandlePublisherService,
    private readonly health: LiveCandleHealthService,
    @Inject(LIVE_CANDLE_CONFIG) private readonly config: LiveCandleConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.config.finalizerIntervalMs);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  runOnce(now = new Date()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.finalizeAsOwner(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async finalizeAsOwner(now: Date): Promise<void> {
    const acquired = await this.locks.acquire(
      LIVE_CANDLE_FINALIZER_LEASE_KEY,
      this.config.ownerLeaseTtlMs,
    );
    if (acquired.status !== 'acquired') return;
    let owned = true;
    let renewalInFlight = false;
    const renewTimer = setInterval(() => {
      if (renewalInFlight || !owned) return;
      renewalInFlight = true;
      void this.locks
        .extend(acquired.lock, this.config.ownerLeaseTtlMs)
        .then((renewed) => {
          if (!renewed) owned = false;
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, this.config.ownerLeaseRenewMs);
    renewTimer.unref?.();
    try {
      await this.finalizeDue(now, () => owned);
    } finally {
      clearInterval(renewTimer);
      await this.locks.release(acquired.lock);
    }
  }

  private async finalizeDue(now: Date, isOwner: () => boolean): Promise<void> {
    let stateKeys: string[];
    try {
      stateKeys = await this.store.getDueStateKeys(
        now,
        this.config.finalizeGraceMs,
      );
    } catch {
      return;
    }
    for (const stateKey of stateKeys) {
      if (!isOwner()) return;
      const state = await this.store.getByKey(stateKey);
      if (!state) {
        await this.store.removeFromFinalizeIndex(stateKey);
        continue;
      }
      await this.finalizeOne(stateKey, state, now);
    }
  }

  private async finalizeOne(
    stateKey: string,
    state: LiveFiveMinuteCandleState,
    now: Date,
  ): Promise<void> {
    if (state.finalized) {
      await this.store.removeFromFinalizeIndex(stateKey);
      return;
    }
    if (
      Date.parse(state.closeTime) + this.config.finalizeGraceMs >
      now.getTime()
    ) {
      return;
    }
    if (
      !this.isStrictlyValid(state) ||
      !state.complete ||
      state.volume === null ||
      (!state.providerFinal && !state.sourceContinuity)
    ) {
      this.health.increment('incompleteBuckets');
      await this.store.removeFromFinalizeIndex(stateKey);
      this.logger.warn(
        JSON.stringify({
          event: 'live_candle_finalize_deferred_to_reconciliation',
          assetId: state.assetId,
          openTime: state.openTime,
          complete: state.complete,
          providerFinal: state.providerFinal,
          sourceContinuity: state.sourceContinuity,
        }),
      );
      return;
    }
    const provider = state.sourceProvider.startsWith('binance')
      ? 'binance'
      : 'kis';
    const ownerLeaseKey = buildLiveCandleOwnerLeaseKey(provider);
    if ((await this.redis.get(ownerLeaseKey)) !== state.ownerGeneration) return;

    const startedAt = Date.now();
    try {
      const write = await this.repository.upsertMany([
        {
          assetId: state.assetId,
          interval: '5m',
          openTime: new Date(state.openTime),
          closeTime: new Date(state.closeTime),
          open: state.open,
          high: state.high,
          low: state.low,
          close: state.close,
          volume: state.volume,
          amount: state.amount,
          isClosed: true,
          sourceProvider: state.sourceProvider,
          sourceUpdatedAt: new Date(state.sourceUpdatedAt),
        },
      ]);
      if (write.writtenCount > 0) {
        await this.cache.invalidateAsset(state.assetId);
      } else if (!(await this.hasCanonicalClosedRow(state))) {
        throw new Error('Canonical closed candle was not persisted.');
      }
      const finalized = await this.store.markFinalized({
        stateKey,
        ownerLeaseKey,
        ownerGeneration: state.ownerGeneration,
        revision: state.revision,
      });
      if (!finalized) return;
      await this.publisher.publishState(finalized);
      this.health.increment('finalizeSuccess');
      this.health.setFinalizeLatencyMs(Date.now() - startedAt);
    } catch (error) {
      this.health.increment('finalizeFailure');
      this.logger.warn(
        JSON.stringify({
          event: 'live_candle_finalize_failed',
          assetId: state.assetId,
          openTime: state.openTime,
          error: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      // The Redis state and finalize index deliberately remain for retry.
    }
  }

  private async hasCanonicalClosedRow(
    state: LiveFiveMinuteCandleState,
  ): Promise<boolean> {
    const rows = await this.repository.findRange({
      assetId: state.assetId,
      interval: '5m',
      from: new Date(state.openTime),
      to: new Date(state.closeTime),
    });
    return rows.some(
      (row) =>
        row.openTime.getTime() === Date.parse(state.openTime) && row.isClosed,
    );
  }

  private isStrictlyValid(state: LiveFiveMinuteCandleState): boolean {
    const openTime = Date.parse(state.openTime);
    const closeTime = Date.parse(state.closeTime);
    const firstEventAt = Date.parse(state.firstEventAt);
    const lastEventAt = Date.parse(state.lastEventAt);
    const sourceUpdatedAt = Date.parse(state.sourceUpdatedAt);
    if (
      !state.assetId.trim() ||
      (!state.sourceProvider.startsWith('binance') &&
        !state.sourceProvider.startsWith('kis')) ||
      !Number.isFinite(openTime) ||
      !Number.isFinite(closeTime) ||
      closeTime <= openTime ||
      closeTime - openTime > 300_000 ||
      !Number.isFinite(firstEventAt) ||
      !Number.isFinite(lastEventAt) ||
      !Number.isFinite(sourceUpdatedAt) ||
      firstEventAt > lastEventAt ||
      !Number.isSafeInteger(state.eventCount) ||
      state.eventCount < 0 ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0
    ) {
      return false;
    }
    try {
      const open = new Prisma.Decimal(state.open);
      const high = new Prisma.Decimal(state.high);
      const low = new Prisma.Decimal(state.low);
      const close = new Prisma.Decimal(state.close);
      const volume = new Prisma.Decimal(state.volume ?? '-1');
      const amount =
        state.amount === null ? null : new Prisma.Decimal(state.amount);
      return (
        [open, high, low, close, volume].every((value) => value.isFinite()) &&
        open.gt(0) &&
        high.gt(0) &&
        low.gt(0) &&
        close.gt(0) &&
        volume.gte(0) &&
        (amount === null || (amount.isFinite() && amount.gte(0))) &&
        high.gte(open) &&
        high.gte(low) &&
        high.gte(close) &&
        low.lte(open) &&
        low.lte(close)
      );
    } catch {
      return false;
    }
  }
}
