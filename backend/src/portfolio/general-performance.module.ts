import { Module } from '@nestjs/common';
import { GeneralAccountPerformanceService } from './general-account-performance.service';
import { GeneralExternalFundingService } from './general-external-funding.service';
import { PortfolioValuationService } from './portfolio-valuation.service';

/**
 * General-mode performance building blocks (작업 7).
 *
 * Deliberately a SEPARATE module from PortfolioModule and with NO dependency
 * on TradingAccountsModule. Two consumers need these services:
 *
 *   TradingAccountsModule  → writes the origin snapshot inside the
 *                            general-account open transaction
 *   PortfolioModule        → account-scoped portfolio/equity reads
 *   AdRewardsModule        → external-funding boundary snapshots
 *
 * and PortfolioModule itself needs TradingAccountAccessService. Keeping these
 * providers here is what stops that from becoming an import cycle.
 */
@Module({
  providers: [
    PortfolioValuationService,
    GeneralExternalFundingService,
    GeneralAccountPerformanceService,
  ],
  exports: [
    PortfolioValuationService,
    GeneralExternalFundingService,
    GeneralAccountPerformanceService,
  ],
})
export class GeneralPerformanceModule {}
