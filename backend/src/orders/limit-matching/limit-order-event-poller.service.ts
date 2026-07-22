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
  type LimitOrderStreamEntry,
} from './limit-order-event-stream.service';
import {
  LimitOrderExecutionError,
  LimitOrderExecutionService,
} from './limit-order-execution.service';
import { parseLimitOrderPriceEvent } from './limit-order-event-validator';
import type { LimitOrderPriceEvent } from './limit-order-price-event.types';
import { LimitOrderMatcherHealthService } from './limit-order-matcher-health.service';
import { LimitOrderMatcherLeaderService } from './limit-order-matcher-leader.service';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: LimitOrderEventStreamService,
    private readonly leader: LimitOrderMatcherLeaderService,
    private readonly health: LimitOrderMatcherHealthService,
    private readonly candidates: LimitOrderCandidateRepository,
    private readonly execution: LimitOrderExecutionService,
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
    this.runId = await this.health.startLeader({
      consumerName: this.config.consumerName,
      startedAt: new Date(),
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
      await this.stream.acknowledge(this.config, entry.streamId);
      this.lastAcknowledgedEvent = entry.streamId;
      this.logger.error(
        `LIMIT_ORDER_EVENT_INVALID moved to DLQ (${entry.streamId}): ${safeMessage(error)}`,
      );
      return;
    }

    const processed = await this.prisma.limitOrderProcessedEvent.findUnique({
      where: { eventId: event.eventId },
      select: { eventId: true },
    });
    if (processed) {
      await this.stream.acknowledge(this.config, entry.streamId);
      this.lastAcknowledgedEvent = entry.streamId;
      return;
    }

    let previousCandidateIds = '';
    for (;;) {
      const candidates = await this.candidates.findCandidates({
        assetId: event.assetId,
        eventPrice: event.price,
        eventReceivedAt: new Date(event.receivedAt),
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
    await this.stream.acknowledge(this.config, entry.streamId);
    this.lastAcknowledgedEvent = entry.streamId;
  }

  private async assertEventAsset(
    event: ReturnType<typeof parseLimitOrderPriceEvent>,
  ) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: event.assetId },
      select: {
        symbol: true,
        market: true,
        assetType: true,
        currencyCode: true,
        settlementCurrency: true,
        isActive: true,
      },
    });
    if (
      !asset?.isActive ||
      asset.symbol !== event.symbol ||
      asset.market !== event.market ||
      asset.assetType !== event.assetType ||
      (asset.settlementCurrency ?? asset.currencyCode) !== event.currencyCode
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
    await this.health.heartbeat(this.runId, {
      activeLeaderInstance: this.config.consumerName,
      lastRedisRead: this.lastRedisRead,
      lastSuccessfulEvent: this.lastSuccessfulEvent,
      lastAcknowledgedEvent: this.lastAcknowledgedEvent,
      pendingCount: info.pendingCount,
      consumerLag: info.lag,
      streamFirstId: info.firstId,
      streamLastId: info.lastId,
    });
    this.lastHeartbeatAt = now;
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
