import { Module } from '@nestjs/common';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { RankingController } from './ranking.controller';
import { RankingRefreshService } from './ranking-refresh.service';
import { RankingService } from './ranking.service';

@Module({
  controllers: [RankingController],
  providers: [RankingService, RankingRefreshService, PortfolioValuationService],
  exports: [RankingRefreshService],
})
export class RankingModule {}
