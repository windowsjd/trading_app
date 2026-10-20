import { Module } from '@nestjs/common';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';
import { SeasonFinalResultService } from './season-final-result.service';
import { PositionsModule } from '../positions/positions.module';

@Module({
  imports: [PositionsModule],
  controllers: [RecordsController],
  providers: [
    RecordsService,
    SeasonFinalResultService,
    PortfolioValuationService,
  ],
})
export class RecordsModule {}
