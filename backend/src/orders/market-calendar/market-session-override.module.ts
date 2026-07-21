import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MarketSessionOverrideLoaderService } from './market-session-override.loader.service';

/**
 * Owns the runtime lifecycle of the operator market-session override layer:
 * the loader marks the process as override-aware (fail-closed until the first
 * DB load) and keeps the in-memory snapshot fresh. Import this module from
 * any module that mutates overrides (operator API) or reacts to override
 * changes (candle cache invalidation).
 */
@Module({
  imports: [PrismaModule],
  providers: [MarketSessionOverrideLoaderService],
  exports: [MarketSessionOverrideLoaderService],
})
export class MarketSessionOverrideModule {}
