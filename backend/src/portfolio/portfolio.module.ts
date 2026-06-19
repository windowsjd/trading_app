import { Module } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { PortfolioValuationService } from './portfolio-valuation.service';

@Module({
  controllers: [PortfolioController],
  providers: [PortfolioService, PortfolioValuationService],
})
export class PortfolioModule {}
