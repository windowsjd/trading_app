import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { AssetType } from '../../generated/prisma/client';
import { resolveStockMarketSessionState } from '../../orders/market-calendar.policy';
import {
  MarketSnapshotHealthService,
  type MarketSnapshotHealthReason,
} from '../market-snapshot-health.service';
import { ProviderConfigService } from '../provider-config.service';
import { KisRestCurrentPriceIngestionService } from './kis-rest-current-price.ingestion.service';

const MISSING_COMPLETED_SESSION_REASONS: ReadonlySet<MarketSnapshotHealthReason> =
  new Set(['PROVIDER_MISSING', 'LAST_COMPLETED_SESSION_PRICE_MISSING']);

const KRX_MARKETS = new Set(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX']);

export type KisKrxStartupCatchUpResult =
  | {
      state: 'skipped';
      reason:
        | 'PROVIDER_DISABLED'
        | 'KIS_REST_UNAVAILABLE'
        | 'MARKET_CALENDAR_COVERAGE_MISSING'
        | 'NO_COMPLETED_KRX_SESSION_TODAY';
    }
  | { state: 'not_needed'; reason: 'LATEST_COMPLETED_SESSION_COVERED' }
  | {
      state: 'completed';
      requestedSymbols: string[];
      created: number;
      skipped: number;
    }
  | { state: 'failed'; reason: string };

/**
 * One best-effort KRX recovery pass per backend process start.
 *
 * WebSocket remains the live price owner. This only runs after today's real
 * KRX session has closed and only for active domestic symbols whose latest
 * completed-session price is missing. Holidays, weekends, pre-open, live
 * sessions, and missing calendar coverage never call KIS.
 */
@Injectable()
export class KisKrxStartupCatchUpService implements OnApplicationBootstrap {
  private readonly logger = new Logger(KisKrxStartupCatchUpService.name);
  private startupPromise: Promise<KisKrxStartupCatchUpResult> | null = null;

  constructor(
    private readonly configService: ProviderConfigService,
    private readonly healthService: MarketSnapshotHealthService,
    private readonly restIngestionService: KisRestCurrentPriceIngestionService,
  ) {}

  onApplicationBootstrap(): void {
    void this.startOnce();
  }

  /** Shared by the lifecycle hook and WebSocket startup; never polls/repeats. */
  startOnce(now = new Date()): Promise<KisKrxStartupCatchUpResult> {
    this.startupPromise ??= this.runStartupCatchUp(now);
    return this.startupPromise;
  }

  async runStartupCatchUp(
    now = new Date(),
  ): Promise<KisKrxStartupCatchUpResult> {
    try {
      const config = this.configService.getConfig();
      if (!config.common.providerIngestionEnabled || !config.kis.enabled) {
        return { state: 'skipped', reason: 'PROVIDER_DISABLED' };
      }
      if (!config.kis.canCallRestLive) {
        return { state: 'skipped', reason: 'KIS_REST_UNAVAILABLE' };
      }

      const marketState = resolveStockMarketSessionState(
        {
          assetType: 'domestic_stock' as AssetType,
          market: 'KRX',
        },
        now,
      );
      if (!marketState || marketState.state === 'calendar_unavailable') {
        this.logger.warn('KIS KRX startup catch-up skipped.', {
          reason: 'MARKET_CALENDAR_COVERAGE_MISSING',
          now: now.toISOString(),
        });
        return {
          state: 'skipped',
          reason: 'MARKET_CALENDAR_COVERAGE_MISSING',
        };
      }

      const currentSession = marketState.currentSession;
      const completedSession = marketState.latestCompletedSession;
      if (
        marketState.state !== 'closed' ||
        !currentSession ||
        currentSession.closeTime.getTime() > now.getTime() ||
        !completedSession ||
        completedSession.localDate !== currentSession.localDate
      ) {
        return {
          state: 'skipped',
          reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
        };
      }

      const health = await this.healthService.checkActiveAssetCoverage({ now });
      const requestedSymbols = [
        ...new Set(
          health.assets
            .filter(
              (asset) =>
                asset.state === 'unavailable' &&
                asset.assetType === ('domestic_stock' as AssetType) &&
                KRX_MARKETS.has(asset.market.trim().toUpperCase()) &&
                asset.reason !== null &&
                MISSING_COMPLETED_SESSION_REASONS.has(asset.reason),
            )
            .map((asset) => asset.symbol),
        ),
      ];

      if (requestedSymbols.length === 0) {
        return {
          state: 'not_needed',
          reason: 'LATEST_COMPLETED_SESSION_COVERED',
        };
      }

      const result = await this.restIngestionService.ingestCurrentPrices({
        dryRun: false,
        requestedBy: 'kis-krx-startup-catch-up',
        domesticSymbols: requestedSymbols,
        usSymbols: [],
        maxSnapshots: requestedSymbols.length,
      });

      if (!result.success || result.failed > 0) {
        const reason = result.errorCode ?? 'KIS_REST_CURRENT_PRICE_FAILED';
        this.logger.warn('KIS KRX startup catch-up failed.', {
          reason,
          requestedSymbolCount: requestedSymbols.length,
          failed: result.failed,
        });
        return { state: 'failed', reason };
      }

      this.logger.log('KIS KRX startup catch-up completed.', {
        requestedSymbolCount: requestedSymbols.length,
        created: result.created,
        skipped: result.skipped,
        completedSessionDate: completedSession.localDate,
      });
      return {
        state: 'completed',
        requestedSymbols,
        created: result.created,
        skipped: result.skipped,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('KIS KRX startup catch-up failed safely.', { reason });
      return { state: 'failed', reason };
    }
  }
}
