import { Module } from '@nestjs/common';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BatchService } from './batch.service';
import { DailyPortfolioSnapshotJobService } from './daily-portfolio-snapshot-job.service';
import { DailySeasonCycleJobService } from './daily-season-cycle-job.service';
import { SeasonRankingJobService } from './season-ranking-job.service';
import { SeasonSettlementJobService } from './season-settlement-job.service';

@Module({
  imports: [PrismaModule],
  providers: [
    BatchService,
    DailyPortfolioSnapshotJobService,
    DailySeasonCycleJobService,
    SeasonRankingJobService,
    SeasonSettlementJobService,
    PortfolioValuationService,
  ],
  exports: [
    BatchService,
    DailyPortfolioSnapshotJobService,
    DailySeasonCycleJobService,
    SeasonRankingJobService,
    SeasonSettlementJobService,
  ],
})
export class BatchModule {}
