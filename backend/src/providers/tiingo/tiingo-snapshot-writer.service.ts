import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  AssetPriceSourceType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { PROVIDER_PRICE_PUBSUB_CHANNEL } from '../fx-rate-update-event';
import {
  MarketPriceEventService,
  type MarketPriceEvent,
} from '../market-price-event.service';
import { buildProviderRawPayloadJson } from '../provider-raw-payload';
import { TiingoAssetMapService } from './tiingo-asset-map.service';
import { TiingoCollectorLeaseService } from './tiingo-collector-lease.service';
import {
  TiingoMarketDataStore,
  type TiingoReferenceObservation,
} from './tiingo-market-data.store';
import { TiingoQuoteService } from './tiingo-quote.service';
import { classifyUsEquitySegment } from './tiingo-session';
import { TiingoStreamService } from './tiingo-stream.service';
import {
  TIINGO_PROVIDER,
  TIINGO_STORED_PRICE_SOURCE,
  TiingoConfigService,
  toTiingoTicker,
} from './tiingo.config';

const FX_CACHE_MS = 60_000;
const TOP_UP_INTERVAL_MS = 30_000;
/** A symbol is topped up from REST only when its stored price and the stream are both this quiet. */
const TOP_UP_STALE_MS = 60_000;

export type TiingoSnapshotWriterStatus = {
  enabled: boolean;
  written: number;
  throttled: number;
  published: number;
  skippedNotOwner: number;
  skippedOutsideRegular: number;
  skippedUnmapped: number;
  skippedNotNewer: number;
  /** A tick arrived while the symbol's previous write was still running. */
  queuedBehindWrite: number;
  failed: number;
  restTopUps: number;
  lastWrittenAt: string | null;
  lastErrorCode: string | null;
};

type SymbolState = {
  /** Server time of the last write slot (throttle clock). */
  lastSlotMs: number;
  /** Provider time of the newest stored observation, ms + nanos. */
  lastEffective: { epochMs: number; nanos: number } | null;
  pending: TiingoReferenceObservation | null;
  timer: NodeJS.Timeout | null;
  checkedDb: boolean;
  /** One write per symbol at a time: a slow insert never races a newer tick. */
  writing: boolean;
};

/**
 * Official mode (2026-10-17): persists Tiingo reference prices as financial
 * snapshots. Only the lease-holding collector writes, only observations whose
 * provider time is inside a US regular session, at most one row per symbol
 * per `snapshotThrottleMs` — with a trailing write so the latest throttled
 * tick still lands within one interval — and never an observation older than
 * (or equal to) the newest stored one. effectiveAt is Tiingo's own timestamp
 * and capturedAt the receipt time: neither is ever moved forward, and a
 * heartbeat writes nothing. Each committed row is fanned out over the
 * existing Redis provider-price channel (the stored value, so lists, detail
 * and the WebSocket show the same price). While the socket is not delivering,
 * stale symbols are topped up from the REST snapshot endpoint.
 */
@Injectable()
export class TiingoSnapshotWriterService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TiingoSnapshotWriterService.name);
  private readonly symbols = new Map<string, SymbolState>();
  private unsubscribe: (() => void) | null = null;
  private topUpTimer: NodeJS.Timeout | null = null;
  private toppingUp = false;
  private fx: { rate: Prisma.Decimal | null; loadedAt: number } | null = null;
  private readonly status: TiingoSnapshotWriterStatus = {
    enabled: false,
    written: 0,
    throttled: 0,
    published: 0,
    skippedNotOwner: 0,
    skippedOutsideRegular: 0,
    skippedUnmapped: 0,
    skippedNotNewer: 0,
    queuedBehindWrite: 0,
    failed: 0,
    restTopUps: 0,
    lastWrittenAt: null,
    lastErrorCode: null,
  };

  constructor(
    private readonly config: TiingoConfigService,
    private readonly store: TiingoMarketDataStore,
    private readonly assetMap: TiingoAssetMapService,
    private readonly lease: TiingoCollectorLeaseService,
    private readonly prisma: PrismaService,
    private readonly events: MarketPriceEventService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly quotes?: TiingoQuoteService,
    @Optional() private readonly stream?: TiingoStreamService,
  ) {}

  onModuleInit(): void {
    const config = this.config.getConfig();
    if (!config.enabled || !config.persistenceEnabled) return;
    this.status.enabled = true;
    this.unsubscribe = this.store.onReference((observation) =>
      this.accept(observation),
    );
    this.topUpTimer = setInterval(() => {
      void this.topUp();
    }, TOP_UP_INTERVAL_MS);
    this.topUpTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.topUpTimer) clearInterval(this.topUpTimer);
    this.topUpTimer = null;
    for (const state of this.symbols.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.pending = null;
    }
  }

  getStatus(): TiingoSnapshotWriterStatus {
    return { ...this.status };
  }

  /** Store listener: decide write now, write later (throttled) or skip. */
  accept(observation: TiingoReferenceObservation, nowMs = Date.now()): void {
    // A remembered session close is not a live price.
    if (observation.origin === 'rest_close') return;
    if (observation.segment !== 'regular') {
      this.status.skippedOutsideRegular += 1;
      return;
    }
    if (!this.lease.owned()) {
      this.status.skippedNotOwner += 1;
      return;
    }
    const state = this.stateFor(observation.symbol);
    const throttleMs = this.config.getConfig().snapshotThrottleMs;
    const waitMs = state.lastSlotMs + throttleMs - nowMs;
    if (waitMs > 0) {
      this.status.throttled += 1;
      state.pending = observation;
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          const pending = state.pending;
          state.pending = null;
          if (pending) void this.write(pending);
        }, waitMs);
        state.timer.unref?.();
      }
      return;
    }
    state.pending = null;
    void this.write(observation, nowMs);
  }

  /** Persists one observation; exposed for tests. */
  async write(
    observation: TiingoReferenceObservation,
    nowMs = Date.now(),
  ): Promise<'created' | 'skipped' | 'failed'> {
    const state = this.stateFor(observation.symbol);
    // Reserve the throttle slot before any await.
    state.lastSlotMs = nowMs;
    if (state.writing) {
      // The previous write of this symbol is still running (slow DB): keep
      // the newest tick for when it finishes instead of racing it.
      state.pending = observation;
      this.status.queuedBehindWrite += 1;
      return 'skipped';
    }
    state.writing = true;
    try {
      return await this.writeOne(state, observation);
    } finally {
      state.writing = false;
      const next = state.timer ? null : state.pending;
      if (next) {
        state.pending = null;
        void this.write(next);
      }
    }
  }

  private async writeOne(
    state: SymbolState,
    observation: TiingoReferenceObservation,
  ): Promise<'created' | 'skipped' | 'failed'> {
    if (!this.lease.owned()) {
      this.status.skippedNotOwner += 1;
      return 'skipped';
    }
    const target = this.assetMap.cachedTargetForSymbol(observation.symbol);
    if (!target) {
      this.status.skippedUnmapped += 1;
      return 'skipped';
    }
    if (state.lastEffective && !isNewer(observation, state.lastEffective)) {
      this.status.skippedNotNewer += 1;
      return 'skipped';
    }
    try {
      if (!state.checkedDb) {
        // After a restart or a lease hand-over, never store an older price
        // than the previous collector did. Only rows at or after this tick
        // matter, so the read is bounded by construction (never a walk of
        // the asset's history on first activation).
        const latest = await this.prisma.assetPriceSnapshot.findFirst({
          where: {
            assetId: target.assetId,
            sourceType: AssetPriceSourceType.provider_api,
            sourceName: TIINGO_STORED_PRICE_SOURCE,
            effectiveAt: { gte: observation.effectiveAt },
          },
          orderBy: [{ effectiveAt: 'desc' }, { capturedAt: 'desc' }],
          select: { effectiveAt: true },
        });
        state.checkedDb = true;
        if (latest) {
          state.lastEffective = {
            epochMs: latest.effectiveAt.getTime(),
            nanos: 0,
          };
          this.status.skippedNotNewer += 1;
          return 'skipped';
        }
      }
      const priceKrw = await this.priceKrw(observation);
      if (!this.lease.owned()) {
        this.status.skippedNotOwner += 1;
        return 'skipped';
      }
      const config = this.config.getConfig();
      await this.prisma.assetPriceSnapshot.create({
        data: {
          assetId: target.assetId,
          price: observation.price,
          priceKrw,
          currencyCode: CurrencyCode.USD,
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: TIINGO_STORED_PRICE_SOURCE,
          sourceTimestamp: observation.effectiveAt,
          effectiveAt: observation.effectiveAt,
          capturedAt: observation.capturedAt,
          rawPayloadJson: buildProviderRawPayloadJson({
            payload: {
              provider: TIINGO_PROVIDER,
              messageType:
                observation.origin === 'ws'
                  ? 'ws_reference_price'
                  : 'rest_snapshot_reference_price',
              ticker: toTiingoTicker(observation.symbol),
              price: observation.price,
              effectiveAt: observation.effectiveAt.toISOString(),
              effectiveAtNanos: observation.effectiveAtNanos,
              priceBasis: 'tiingo_reference_price',
            },
            maxBytes: 2000,
            secrets: [config.token],
          }) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      state.lastEffective = {
        epochMs: observation.effectiveAt.getTime(),
        nanos: observation.effectiveAtNanos,
      };
      this.status.written += 1;
      this.status.lastWrittenAt = new Date().toISOString();
      if (this.lease.owned()) await this.publish(target.assetId, observation);
      return 'created';
    } catch (error) {
      this.status.failed += 1;
      this.status.lastErrorCode =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? `TIINGO_SNAPSHOT_WRITE_${error.code}`
          : 'TIINGO_SNAPSHOT_WRITE_FAILED';
      return 'failed';
    }
  }

  /**
   * While the reference socket is not delivering, refresh symbols whose
   * stored price is older than a minute from the rate-limited REST snapshot
   * (shared with the trial display path). Regular session only: outside it
   * the socket is quiet by design and a REST result is never stored, so a
   * call would only spend the REST budget the US LOC close reads need at
   * night (21:10–23:00 New York).
   */
  async topUp(now = new Date()): Promise<number> {
    if (!this.lease.owned() || !this.quotes || this.toppingUp) return 0;
    if (classifyUsEquitySegment(now) !== 'regular') return 0;
    this.toppingUp = true;
    try {
      return await this.topUpStale(now);
    } finally {
      this.toppingUp = false;
    }
  }

  private async topUpStale(now: Date): Promise<number> {
    if (!this.quotes) return 0;
    const reference = this.stream?.getStatus().reference;
    const delivering =
      reference?.state === 'subscribed' &&
      reference.lastDataAt !== null &&
      now.getTime() - Date.parse(reference.lastDataAt) <= TOP_UP_STALE_MS;
    if (delivering) return 0;
    const mapping = await this.assetMap.getMapping();
    let refreshed = 0;
    for (const target of mapping.targets) {
      const latest = this.store.latestReference(target.symbol);
      if (
        latest &&
        latest.segment === 'regular' &&
        now.getTime() - latest.capturedAt.getTime() <= TOP_UP_STALE_MS
      )
        continue;
      if (!(await this.quotes.refreshRegularReference(target.symbol, now)))
        continue;
      refreshed += 1;
      this.status.restTopUps += 1;
    }
    return refreshed;
  }

  private async publish(
    assetId: string,
    observation: TiingoReferenceObservation,
  ): Promise<void> {
    const event: MarketPriceEvent = {
      type: 'market_price',
      assetId,
      price: {
        price: observation.price,
        currencyCode: 'USD',
        sourceName: TIINGO_STORED_PRICE_SOURCE,
        effectiveAt: observation.effectiveAt.toISOString(),
        capturedAt: observation.capturedAt.toISOString(),
      },
      delayed: false,
      snapshotState: 'created',
    };
    // Redis is the multi-instance channel; local only when it cannot publish.
    let published = false;
    if (this.redis) {
      try {
        await this.redis.publish(
          PROVIDER_PRICE_PUBSUB_CHANNEL,
          JSON.stringify(event),
        );
        published = true;
      } catch {
        // Fall through to the in-process bus below.
      }
    }
    if (!published) this.events.publish(event);
    this.status.published += 1;
  }

  /** Display-only KRW value (never a financial input), as KIS stores it. */
  private async priceKrw(
    observation: TiingoReferenceObservation,
  ): Promise<string | null> {
    const nowMs = Date.now();
    if (!this.fx || nowMs - this.fx.loadedAt > FX_CACHE_MS) {
      const row = await this.prisma.fxRateSnapshot.findFirst({
        where: {
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
          rate: { gt: 0 },
          effectiveAt: { lte: observation.effectiveAt },
          OR: [
            { sourceType: FxRateSourceType.provider_api },
            {
              sourceType: FxRateSourceType.admin_manual,
              approvedByUserId: { not: null },
            },
          ],
        },
        orderBy: [
          { effectiveAt: 'desc' },
          { capturedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        select: { rate: true },
      });
      this.fx = { rate: row?.rate ?? null, loadedAt: nowMs };
    }
    return this.fx.rate
      ? new Prisma.Decimal(observation.price).mul(this.fx.rate).toFixed(8)
      : null;
  }

  private stateFor(symbol: string): SymbolState {
    const key = symbol.toUpperCase();
    let state = this.symbols.get(key);
    if (!state) {
      state = {
        lastSlotMs: 0,
        lastEffective: null,
        pending: null,
        timer: null,
        checkedDb: false,
        writing: false,
      };
      this.symbols.set(key, state);
    }
    return state;
  }
}

function isNewer(
  observation: TiingoReferenceObservation,
  stored: { epochMs: number; nanos: number },
): boolean {
  const epochMs = observation.effectiveAt.getTime();
  return (
    epochMs > stored.epochMs ||
    (epochMs === stored.epochMs && observation.effectiveAtNanos > stored.nanos)
  );
}
