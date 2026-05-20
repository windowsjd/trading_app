import { Module } from '@nestjs/common';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BatchService } from './batch.service';
import { DailyPortfolioSnapshotJobService } from './daily-portfolio-snapshot-job.service';
import { SeasonRankingJobService } from './season-ranking-job.service';

@Module({
  imports: [PrismaModule],
  providers: [
    BatchService,
    DailyPortfolioSnapshotJobService,
    SeasonRankingJobService,
    PortfolioValuationService,
  ],
  exports: [
    BatchService,
    DailyPortfolioSnapshotJobService,
    SeasonRankingJobService,
  ],
})
export class BatchModule {}
