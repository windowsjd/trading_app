import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AssetType } from '../../generated/prisma/client';
import { getAssetTradingStatus } from '../market-hours.policy';
import { LimitOrderCandidateRepository } from './limit-order-candidate.repository';
import {
  compareRedisStreamIds,
  LimitOrderEventStreamService,
  redisStreamIdTimestampMs,
  type LimitOrderStreamEntry,
} from './limit-order-event-stream.service';
import {
  LimitOrderExecutionError,
  LimitOrderExecutionService,
} from './limit-order-execution.service';
import { parseLimitOrderPriceEvent } from './limit-order-event-validator';
import type { LimitOrderPriceEvent } from './limit-order-price-event.types';
import { LimitOrderMatchBoundaryService } from './limit-order-match-boundary.service';
import {
  LimitOrderMatcherHealthService,
  type LimitOrderProcessedEventStats,
} from './limit-order-matcher-health.service';
import { LimitOrderMatcherLeaderService } from './limit-order-matcher-leader.service';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';

type CachedEventAsset = {
  symbol: string;
  market: string;
  assetType: AssetType;
  currencyCode: string;
  expiresAt: number;
};

class MatcherFatalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MatcherFatalError';
  }
}

@Injectable()
export class LimitOrderEventPollerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LimitOrderEventPollerService.name);
  private readonly config = readLimitOrderMatchingConfig();
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private permanentFailure = false;
  private runId: string | null = null;
  private lastRedisRead: string | null = null;
  private lastSuccessfulEvent: string | null = null;
  private lastAcknowledgedEvent: string | null = null;
  private lastHeartbeatAt = 0;
  private lastReclaimAt = 0;
  private lastAcknowledgedAt: string | null = null;
  private leaderStartedAt: string | null = null;
  private lastProcessedEventStats: LimitOrderProcessedEventStats | null = null;
  private lastProcessedEventStatsAt = 0;
  private readonly assetCache = new Map<string, CachedEventAsset>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: LimitOrderEventStreamService,
    private readonly leader: LimitOrderMatcherLeaderService,
    private readonly health: LimitOrderMatcherHealthService,
    private readonly candidates: LimitOrderCandidateRepository,
    private readonly execution: LimitOrderExecutionService,
    private readonly boundary: LimitOrderMatchBoundaryService,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    this.loopPromise = this.run().catch((error: unknown) => {
      this.logger.error(
        `Limit matcher stopped unexpectedly: ${safeMessage(error)}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loopPromise;
    if (this.runId) await this.health.finish(this.runId).catch(() => undefined);
    this.runId = null;
    await this.leader.release();
  }

  private async run(): Promise<void> {
    while (!this.stopping && !this.permanentFailure) {
      try {
        if (!(await this.leader.tryAcquire())) {
          await delay(this.config.leaderRetryMs);
          continue;
        }
        await this.runAsLeader();
      } catch (error) {
        const code = errorCode(error);
        const message = safeMessage(error);
        if (this.runId) {
          await this.health
            .fail(this.runId, code, message)
            .catch(() => undefined);
          this.runId = null;
        }
        await this.leader.release().catch(() => undefined);
        this.logger.error(`${code}: ${message}`);
        if (
          error instanceof MatcherFatalError ||
          error instanceof LimitOrderExecutionError
        ) {
          this.permanentFailure = true;
          break;
        }
        if (!this.stopping) await delay(this.config.leaderRetryMs);
      }
    }
  }

  private async runAsLeader(): Promise<void> {
    await this.stream.ensureConsumerGroup(this.config);
    const leaderStartedAt = new Date();
    this.leaderStartedAt = leaderStartedAt.toISOString();
    this.runId = await this.health.startLeader({
      consumerName: this.config.consumerName,
      startedAt: leaderStartedAt,
    });
    // Establish the durable Ops row before the retention check so a startup
    // gap is recorded as failed/degraded instead of disappearing into logs.
    await this.assertNoGap();
    await this.writeHeartbeat(true);

    while (!this.stopping) {
      await this.leader.assertHeld();
      const now = Date.now();
      let entries: LimitOrderStreamEntry[] = [];
      if (now - this.lastReclaimAt >= this.config.reclaimIntervalMs) {
        const reclaimed = await this.stream.reclaimStale(this.config);
        this.lastReclaimAt = now;
        if (reclaimed.deletedIds.length > 0) {
          throw new MatcherFatalError(
            'LIMIT_ORDER_EVENT_GAP_DETECTED',
            `Redis trimmed ${reclaimed.deletedIds.length} pending price event(s).`,
          );
        }
        entries = reclaimed.entries;
        await this.assertNoGap();
      }
      if (entries.length === 0) {
        entries = await this.stream.readOwnPending(this.config);
      }
      if (entries.length === 0) {
        // A standby may acquire the DB lock before the previous consumer's
        // pending entry reaches XAUTOCLAIM's idle threshold. Do not consume a
        // newer event during that window: global stream order is stricter
        // than availability for this first matcher version.
        const pending = await this.stream.inspect(this.config);
        if (pending.pendingCount > 0) {
          await this.writeHeartbeat(false);
          await delay(
            Math.min(this.config.leaderRetryMs, this.config.pendingIdleMs),
          );
          continue;
        }
        entries = await this.stream.readNew(this.config);
        this.lastRedisRead = new Date().toISOString();
      }
      // The PostgreSQL session may have disappeared while XREADGROUP was
      // blocked. Re-prove leadership before any financial mutation.
      await this.leader.assertHeld();
      for (const entry of entries) await this.processEntry(entry);
      await this.writeHeartbeat(false);
    }
  }

  private async processEntry(entry: LimitOrderStreamEntry): Promise<void> {
    let event: LimitOrderPriceEvent;
    try {
      if (!entry.payload) throw new Error('Stream entry payload is missing.');
      event = parseLimitOrderPriceEvent(entry.payload);
      if (entry.eventId !== event.eventId) {
        throw new Error('Stream eventId does not match payload eventId.');
      }
      await this.assertEventAsset(event);
    } catch (error) {
      await this.stream.moveToDlq(
        this.config,
        entry,
        'LIMIT_ORDER_EVENT_INVALID',
      );
      await this.health.recordEventFailure({
        consumerName: this.config.consumerName,
        streamId: entry.streamId,
        eventId: entry.eventId,
        code: 'LIMIT_ORDER_EVENT_INVALID',
        message: safeMessage(error),
      });
      await this.acknowledge(entry.streamId);
      this.logger.error(
        `LIMIT_ORDER_EVENT_INVALID moved to DLQ (${entry.streamId}): ${safeMessage(error)}`,
      );
      return;
    }

    // EVERY durable decision for this event happens inside the boundary
    // mutex: the dedupe read, the candidate sweep, the executions, and the
    // processed-event insert. A limit-order Create cannot observe a partial
    // state, and its activation cursor is therefore either strictly before
    // this event (so the event fills it) or strictly after it (so the event
    // is already durably processed and can never fill it). The Redis ACK is
    // deliberately OUTSIDE the mutex and strictly AFTER the DB work — an ACK
    // before the processed row would lose the event on a crash.
    const lease = await this.boundary.acquireSession();
    try {
      const processed = await this.prisma.limitOrderProcessedEvent.findUnique({
        where: { eventId: event.eventId },
        select: { eventId: true },
      });
      // A duplicate XADD of an already-processed event must not re-run the
      // candidate sweep: orders created AFTER the original processing would
      // otherwise be filled by a stale price. It still gets ACKed below, so
      // the duplicate leaves the pending list.
      if (!processed) await this.processEventUnderBoundary(entry, event);
    } finally {
      await lease.release();
    }
    await this.acknowledge(entry.streamId);
  }

  /** Candidate sweep + durable dedupe insert. Callers hold the boundary. */
  private async processEventUnderBoundary(
    entry: LimitOrderStreamEntry,
    event: LimitOrderPriceEvent,
  ): Promise<void> {
    let previousCandidateIds = '';
    for (;;) {
      const candidates = await this.candidates.findCandidates({
        assetId: event.assetId,
        eventPrice: event.price,
        currencyCode: event.currencyCode,
        streamId: entry.streamId,
        batchSize: this.config.candidateBatchSize,
      });
      if (candidates.length === 0) break;
      const candidateIds = candidates
        .map((candidate) => candidate.id)
        .join(',');
      if (candidateIds === previousCandidateIds) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_CONFLICT',
          'Candidate batch made no progress.',
        );
      }
      previousCandidateIds = candidateIds;
      for (const candidate of candidates) {
        await this.execution.executeCandidate({
          orderId: candidate.id,
          seasonParticipantId: candidate.seasonParticipantId,
          streamId: entry.streamId,
          event,
        });
      }
    }

    this.lastSuccessfulEvent = entry.streamId;
    try {
      await this.prisma.limitOrderProcessedEvent.create({
        data: {
          eventId: event.eventId,
          firstStreamId: entry.streamId,
          receivedAt: new Date(event.receivedAt),
          processedAt: new Date(),
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
  }

  private async acknowledge(streamId: string): Promise<void> {
    await this.stream.acknowledge(this.config, streamId);
    this.lastAcknowledgedEvent = streamId;
    this.lastAcknowledgedAt = new Date().toISOString();
  }

  /**
   * Route/session validation for one event. The asset row is served from a
   * short-TTL bounded cache, so a burst of trades on one asset costs a single
   * database read instead of one per event. The cache is a routing filter
   * only: order eligibility re-reads and re-locks the asset inside the
   * execution transaction, so a stale entry can never authorize a fill.
   */
  private async assertEventAsset(
    event: ReturnType<typeof parseLimitOrderPriceEvent>,
  ) {
    const asset = await this.resolveEventAsset(event.assetId);
    if (
      !asset ||
      asset.symbol !== event.symbol ||
      asset.market !== event.market ||
      asset.assetType !== event.assetType ||
      asset.currencyCode !== event.currencyCode
    ) {
      throw new Error('Event asset metadata is invalid.');
    }
    const providerRouteValid =
      event.provider === 'binance'
        ? asset.assetType === AssetType.crypto &&
          asset.market.trim().toUpperCase() === 'BINANCE' &&
          event.sourceName === 'binance_spot_ws_trade'
        : (asset.assetType === AssetType.domestic_stock &&
            event.sourceName === 'kis_krx_realtime_trade') ||
          (asset.assetType === AssetType.us_stock &&
            event.sourceName === 'kis_us_delayed_trade');
    if (!providerRouteValid) {
      throw new Error('Event provider/source route is invalid for the asset.');
    }
    if (asset.assetType !== AssetType.crypto) {
      const trading = getAssetTradingStatus(
        { assetType: asset.assetType, market: asset.market },
        new Date(event.providerEventAt),
      );
      if (!trading.tradable) {
        throw new Error(
          `Stock trade event is outside an eligible session: ${trading.reason}.`,
        );
      }
    }
  }

  private async resolveEventAsset(
    assetId: string,
  ): Promise<CachedEventAsset | null> {
    const now = Date.now();
    const cached = this.assetCache.get(assetId);
    if (cached && cached.expiresAt > now) return cached;

    const asset = await this.prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        symbol: true,
        market: true,
        assetType: true,
        currencyCode: true,
        settlementCurrency: true,
        isActive: true,
      },
    });
    this.assetCache.delete(assetId);
    if (!asset?.isActive) return null;
    // Bounded LRU-ish eviction: Map preserves insertion order, so the oldest
    // entry is always the first key.
    if (this.assetCache.size >= this.config.assetCacheMaxEntries) {
      const oldest = this.assetCache.keys().next();
      if (!oldest.done) this.assetCache.delete(oldest.value);
    }
    const entry: CachedEventAsset = {
      symbol: asset.symbol,
      market: asset.market,
      assetType: asset.assetType,
      currencyCode: asset.settlementCurrency ?? asset.currencyCode,
      expiresAt: now + this.config.assetCacheTtlMs,
    };
    this.assetCache.set(assetId, entry);
    return entry;
  }

  private async assertNoGap(): Promise<void> {
    const info = await this.stream.inspect(this.config);
    if (
      info.firstId &&
      info.groupLastDeliveredId &&
      info.groupLastDeliveredId !== '0-0' &&
      info.pendingCount === 0 &&
      compareRedisStreamIds(info.groupLastDeliveredId, info.firstId) < 0
    ) {
      throw new MatcherFatalError(
        'LIMIT_ORDER_EVENT_GAP_DETECTED',
        `Stream first ID ${info.firstId} is ahead of consumer cursor ${info.groupLastDeliveredId}.`,
      );
    }
  }

  private async writeHeartbeat(force: boolean): Promise<void> {
    if (!this.runId) return;
    const now = Date.now();
    if (!force && now - this.lastHeartbeatAt < this.config.heartbeatIntervalMs)
      return;
    const info = await this.stream.inspect(this.config);
    const oldestPendingMs = redisStreamIdTimestampMs(info.oldestPendingId);
    await this.health.heartbeat(this.runId, {
      activeLeaderInstance: this.config.consumerName,
      leaderStartedAt: this.leaderStartedAt,
      lastRedisRead: this.lastRedisRead,
      lastSuccessfulEvent: this.lastSuccessfulEvent,
      lastAcknowledgedEvent: this.lastAcknowledgedEvent,
      lastAcknowledgedAt: this.lastAcknowledgedAt,
      pendingCount: info.pendingCount,
      oldestPendingAgeMs:
        oldestPendingMs === null ? null : Math.max(0, now - oldestPendingMs),
      consumerLag: info.lag,
      streamFirstId: info.firstId,
      streamLastId: info.lastId,
      streamLength: info.length,
      // Fraction of the configured MAXLEN still free. A stream sitting at its
      // cap silently trims the oldest entries, which is exactly where an
      // un-read event would be lost.
      retentionHeadroomRatio:
        info.length === null
          ? null
          : Math.max(
              0,
              (this.config.eventMaxLen - info.length) / this.config.eventMaxLen,
            ),
      processedEvents: await this.readProcessedEventStats(now),
    });
    this.lastHeartbeatAt = now;
  }

  /**
   * Growth/ageing of the durable dedupe table.
   *
   * Sampled on a MUCH slower cadence than the heartbeat
   * (LIMIT_ORDER_PROCESSED_EVENT_STATS_INTERVAL_MS, minutes by default) and
   * with approximate aggregates, because capacity moves on a scale of hours
   * while the heartbeat runs every few seconds. A sampling failure is logged
   * and the previous sample is reused: capacity observability must never stop
   * the matcher itself.
   */
  private async readProcessedEventStats(
    now: number,
  ): Promise<LimitOrderProcessedEventStats | null> {
    if (
      this.lastProcessedEventStats &&
      now - this.lastProcessedEventStatsAt <
        this.config.processedEventStatsIntervalMs
    ) {
      return this.lastProcessedEventStats;
    }
    try {
      const stats = await this.health.collectProcessedEventStats();
      this.lastProcessedEventStats = stats;
      this.lastProcessedEventStatsAt = now;
      this.warnOnProcessedEventCapacity(stats);
    } catch (error) {
      this.logger.warn(
        `Processed-event growth sampling failed: ${safeMessage(error)}`,
      );
      // Do not retry on the very next heartbeat: a failing sample must not
      // become a per-tick query storm on top of an already unhealthy database.
      this.lastProcessedEventStatsAt = now;
    }
    return this.lastProcessedEventStats;
  }

  /**
   * Capacity warning. Retention deletion is deliberately NOT implemented (a
   * deleted event id could be re-delivered and fill a later order), so the
   * table grows and an operator has to act before it becomes a problem —
   * partitioning, an archive, or a proven retention window.
   */
  private warnOnProcessedEventCapacity(
    stats: LimitOrderProcessedEventStats,
  ): void {
    const bytes = (stats.tableBytes ?? 0) + (stats.indexBytes ?? 0);
    if (
      bytes < this.config.processedEventWarnBytes &&
      stats.rowCount < this.config.processedEventWarnRowCount
    ) {
      return;
    }
    this.logger.warn(
      JSON.stringify({
        event: 'limit_order_processed_events_capacity_warning',
        approximateRowCount: stats.rowCount,
        totalBytes: bytes,
        warnBytes: this.config.processedEventWarnBytes,
        warnRowCount: this.config.processedEventWarnRowCount,
        lastDayCount: stats.lastDayCount,
      }),
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (
    error instanceof MatcherFatalError ||
    error instanceof LimitOrderExecutionError
  ) {
    return error.code;
  }
  return 'LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE';
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'P2002'
  );
}
