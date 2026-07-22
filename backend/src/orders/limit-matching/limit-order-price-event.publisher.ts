import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NormalizedProviderTradeEventBus } from '../../providers/normalized-provider-trade-event-bus.service';
import { ProviderTradeRouteRegistry } from '../../providers/provider-trade-route.registry';
import { RedisService } from '../../redis/redis.service';
import { readLimitOrderMatchingConfig } from './limit-order-matching.config';
import { LimitOrderMatcherHealthService } from './limit-order-matcher-health.service';
import { buildLimitOrderPriceEvent } from './limit-order-price-event.types';

@Injectable()
export class LimitOrderPriceEventPublisher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LimitOrderPriceEventPublisher.name);
  private readonly config = readLimitOrderMatchingConfig();
  private unsubscribe: (() => void) | null = null;
  private publicationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tradeEvents: NormalizedProviderTradeEventBus,
    private readonly health: LimitOrderMatcherHealthService,
    private readonly routes: ProviderTradeRouteRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) return;
    this.unsubscribe = this.tradeEvents.subscribe((tick) => {
      // Asset resolution is asynchronous. Chain publications so consecutive
      // provider frames cannot reach XADD in database-response order instead
      // of their original arrival order. A failed entry degrades health but
      // does not permanently poison the queue for later frames.
      const publication = this.publicationTail.then(async () => {
        await this.publish(tick);
      });
      this.publicationTail = publication.catch(() => undefined);
      return publication;
    });
  }

  isActive(): boolean {
    return this.config.enabled && this.unsubscribe !== null;
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.publicationTail;
  }

  async publish(
    tick: Parameters<typeof buildLimitOrderPriceEvent>[0]['tick'],
  ): Promise<string> {
    const event = buildLimitOrderPriceEvent({
      tick,
      asset: await this.resolveAsset(tick),
    });
    try {
      return await this.redis.xadd(
        this.config.streamKey,
        { eventId: event.eventId, payload: JSON.stringify(event) },
        this.config.eventMaxLen,
      );
    } catch (error) {
      await this.health
        .degradeActiveLeader(
          'LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE',
          'Normalized trade could not be appended to the limit-order event stream.',
        )
        .catch(() => undefined);
      this.logger.error(
        `LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE: failed to publish ${event.provider} trade for ${event.assetId}.`,
      );
      throw error;
    }
  }

  /**
   * Prefers the metadata the canonical connection already read when it built
   * the subscription for this connection generation, so the hot path performs
   * ZERO database queries per trade. The registry lookup is generation-scoped:
   * metadata from a superseded connection is rejected and falls through to the
   * database, which is also the path legacy publishers (no carried metadata)
   * take. Asset activity is still re-verified inside the execution
   * transaction — this cache never authorises a fill on its own.
   */
  private async resolveAsset(
    tick: Parameters<typeof buildLimitOrderPriceEvent>[0]['tick'],
  ): Promise<Parameters<typeof buildLimitOrderPriceEvent>[0]['asset']> {
    const carried = tick.asset;
    if (carried && carried.assetId === tick.assetId) {
      const registered = this.routes.resolveAsset(
        tick.provider,
        tick.assetId,
        carried.generation,
      );
      if (registered) {
        return {
          id: registered.assetId,
          symbol: registered.symbol,
          market: registered.market,
          assetType: registered.assetType,
          settlementCurrency: registered.settlementCurrency,
        };
      }
    }

    const asset = await this.prisma.asset.findUnique({
      where: { id: tick.assetId },
      select: {
        id: true,
        symbol: true,
        market: true,
        assetType: true,
        currencyCode: true,
        settlementCurrency: true,
        isActive: true,
      },
    });
    if (!asset?.isActive) {
      throw new Error(
        'Normalized trade resolved to an inactive or missing asset.',
      );
    }
    return {
      ...asset,
      settlementCurrency: asset.settlementCurrency ?? asset.currencyCode,
    };
  }
}
