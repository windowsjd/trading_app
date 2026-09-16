import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { AssetType } from '../../generated/prisma/client';
import { resolveStockMarketSessionState } from '../../orders/market-calendar.policy';
import {
  MarketSnapshotHealthService,
  type MarketSnapshotHealthReason,
} from '../market-snapshot-health.service';
import { ProviderConfigService } from '../provider-config.service';
import {
  KisKrxSessionCloseIngestionService,
  type KisKrxSessionCloseResult,
} from './kis-krx-session-close.ingestion.service';

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
  | {
      state: 'failed';
      reason: string;
      failures?: Array<{ assetId: string; symbol: string; reason: string }>;
    };

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
    private readonly closeIngestionService: KisKrxSessionCloseIngestionService,
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
      const configuredDomesticSymbols = new Set(
        config.kis.domesticSymbols.map((symbol) => symbol.trim().toUpperCase()),
      );
      const requestedAssets = health.assets.filter(
        (asset) =>
          asset.state === 'unavailable' &&
          asset.assetType === ('domestic_stock' as AssetType) &&
          KRX_MARKETS.has(asset.market.trim().toUpperCase()) &&
          configuredDomesticSymbols.has(asset.symbol.trim().toUpperCase()) &&
          asset.reason !== null &&
          MISSING_COMPLETED_SESSION_REASONS.has(asset.reason),
      );
      const requestedSymbols = [
        ...new Set(requestedAssets.map((asset) => asset.symbol)),
      ];

      if (requestedSymbols.length === 0) {
        return {
          state: 'not_needed',
          reason: 'LATEST_COMPLETED_SESSION_COVERED',
        };
      }

      const results = new Map<string, KisKrxSessionCloseResult>();
      // Bounded sequential requests use the existing shared KIS rate limiter.
      for (const asset of requestedAssets) {
        results.set(
          asset.assetId,
          await this.closeIngestionService.recoverSessionPrice({
            assetId: asset.assetId,
            symbol: asset.symbol,
            now,
          }),
        );
      }
      // A created row is not proof of recovery: read it with consumer policy.
      const after = await this.healthService.checkActiveAssetCoverage({ now });
      const failures = requestedAssets.flatMap((asset) => {
        const checked = after.assets.find(
          (row) => row.assetId === asset.assetId,
        );
        if (checked?.state === 'available') return [];
        const result = results.get(asset.assetId);
        return [
          {
            assetId: asset.assetId,
            symbol: asset.symbol,
            reason:
              result?.state === 'failed'
                ? result.reason
                : (checked?.reason ?? 'COMPLETED_SESSION_PRICE_UNAVAILABLE'),
          },
        ];
      });
      if (failures.length > 0) {
        const reason = 'COMPLETED_SESSION_PRICE_UNAVAILABLE';
        this.logger.warn('KIS KRX startup catch-up failed.', {
          reason,
          completedSessionDate: completedSession.localDate,
          failures,
        });
        return { state: 'failed', reason, failures };
      }
      const created = [...results.values()].filter(
        (result) => result.state === 'created',
      ).length;
      const skipped = requestedAssets.length - created;
      this.logger.log('KIS KRX startup catch-up completed.', {
        requestedSymbolCount: requestedSymbols.length,
        created,
        skipped,
        completedSessionDate: completedSession.localDate,
      });
      return { state: 'completed', requestedSymbols, created, skipped };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('KIS KRX startup catch-up failed safely.', { reason });
      return { state: 'failed', reason };
    }
  }
}
