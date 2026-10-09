import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type TradingAccount } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../portfolio/general-external-funding.service';
import { futuresSnapshotValues } from '../portfolio/futures-snapshot-values';
import { calculateMaxDrawdown } from '../ranking/ranking-refresh.service';

/** DB-only event snapshots. A market-data outage cannot block a risk-reducing
 * close. Missing observations are not fabricated; scheduled/live reads recover.
 * Financial/DB errors still abort the originating transaction. */
@Injectable()
export class FuturesPerformanceService {
  private readonly logger = new Logger(FuturesPerformanceService.name);
  private readonly valuation: PortfolioValuationService;
  private readonly performance: GeneralAccountPerformanceService;
  constructor(prisma: PrismaService) {
    this.valuation = new PortfolioValuationService(prisma);
    this.performance = new GeneralAccountPerformanceService(
      prisma,
      this.valuation,
      new GeneralExternalFundingService(prisma),
    );
  }
  async capture(
    tx: Prisma.TransactionClient,
    account: TradingAccount & { seasonParticipant: { id: string } | null },
    capturedAt: Date,
  ) {
    try {
      if (isStandaloneAccountMode(account.mode)) {
        await this.performance.createOrdinarySnapshotInTransaction({
          account,
          reason: 'order_executed',
          capturedAt,
          client: tx,
        });
        return;
      }
      const valuation = await this.valuation.calculateTradingAccountValuation(
        account.id,
        capturedAt,
        'home_live_valuation',
        tx,
      );
      await tx.equitySnapshot.create({
        data: {
          tradingAccountId: account.id,
          totalAssetKrw: valuation.totalAssetKrw,
          returnRate: valuation.returnRate,
          krwCash: valuation.krwCash,
          usdCashKrw: valuation.usdCashKrw,
          domesticStockValueKrw: valuation.domesticStockValueKrw,
          usStockValueKrw: valuation.usStockValueKrw,
          cryptoValueKrw: valuation.cryptoValueKrw,
          ...futuresSnapshotValues(valuation),
          snapshotReason: 'order_executed',
          capturedAt,
        },
      });
      const points = await tx.equitySnapshot.findMany({
        where: { tradingAccountId: account.id },
        select: { totalAssetKrw: true, capturedAt: true },
      });
      await tx.seasonParticipant.update({
        where: { tradingAccountId: account.id },
        data: {
          totalAssetKrw: valuation.totalAssetKrw,
          totalReturnRate: valuation.returnRate,
          maxDrawdown: calculateMaxDrawdown(points).toFixed(8),
        },
      });
    } catch (error) {
      if (
        !(error instanceof PortfolioValuationError) ||
        ![
          'FUTURES_MARK_UNAVAILABLE',
          'FUTURES_MARK_STALE',
          'ASSET_PRICE_UNAVAILABLE',
          'ASSET_PRICE_STALE',
          'FX_RATE_UNAVAILABLE',
          'FX_RATE_STALE',
        ].includes(error.code)
      )
        throw error;
      this.logger.warn(
        JSON.stringify({
          event: 'futures_performance_observation_unavailable',
          tradingAccountId: account.id,
          capturedAt: capturedAt.toISOString(),
          code: error.code,
        }),
      );
    }
  }
}
