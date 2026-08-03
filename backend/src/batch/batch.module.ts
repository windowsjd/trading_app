import { Module } from '@nestjs/common';
import { LimitOrderCancelService } from '../orders/limit-order-cancel.service';
import { OrderReservationService } from '../orders/order-reservation.service';
import { GeneralPerformanceModule } from '../portfolio/general-performance.module';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BatchService } from './batch.service';
import { DailyPortfolioSnapshotJobService } from './daily-portfolio-snapshot-job.service';
import { GeneralDailySnapshotJobService } from './general-daily-snapshot-job.service';
import { DailySeasonCycleJobService } from './daily-season-cycle-job.service';
import { FinalTierAssignmentJobService } from './final-tier-assignment-job.service';
import { RewardGrantJobService } from './reward-grant-job.service';
import { SeasonRankingJobService } from './season-ranking-job.service';
import { SeasonSettlementJobService } from './season-settlement-job.service';
import { SeasonLifecycleTransitionJobService } from './season-lifecycle-transition-job.service';

@Module({
  imports: [PrismaModule, GeneralPerformanceModule],
  providers: [
    BatchService,
    LimitOrderCancelService,
    OrderReservationService,
    DailyPortfolioSnapshotJobService,
    GeneralDailySnapshotJobService,
    DailySeasonCycleJobService,
    FinalTierAssignmentJobService,
    RewardGrantJobService,
    SeasonRankingJobService,
    SeasonSettlementJobService,
    SeasonLifecycleTransitionJobService,
    PortfolioValuationService,
  ],
  exports: [
    BatchService,
    DailyPortfolioSnapshotJobService,
    GeneralDailySnapshotJobService,
    DailySeasonCycleJobService,
    FinalTierAssignmentJobService,
    RewardGrantJobService,
    SeasonRankingJobService,
    SeasonSettlementJobService,
    SeasonLifecycleTransitionJobService,
  ],
})
export class BatchModule {}
