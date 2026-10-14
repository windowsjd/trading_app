import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import {
  FUTURES_MARKET_STATS_KEY,
  parseFuturesMarketStats,
  serializeFuturesMarketStats,
  type FuturesMarketStats,
} from './futures-market-data';

/** The whole blob disappears soon after its writer stops. */
const FUTURES_MARKET_STATS_TTL_SECONDS = 120;

/** Shared 24h statistics so every API instance reads the same latest ticker.
 * Display data: a missing or unreadable cache means "unavailable", never 0. */
@Injectable()
export class FuturesMarketStatsStore {
  private readonly logger = new Logger(FuturesMarketStatsStore.name);
  private writeUnavailable = false;

  constructor(@Optional() private readonly redis?: RedisService) {}

  async write(stats: FuturesMarketStats[]): Promise<boolean> {
    if (!this.redis) return false;
    try {
      await this.redis.setWithTtl(
        FUTURES_MARKET_STATS_KEY,
        serializeFuturesMarketStats(stats),
        FUTURES_MARKET_STATS_TTL_SECONDS,
      );
      this.writeUnavailable = false;
      return true;
    } catch {
      if (!this.writeUnavailable)
        this.logger.warn('FUTURES_MARKET_STATS_WRITE_FAILED');
      this.writeUnavailable = true;
      return false;
    }
  }

  async read(): Promise<Map<string, FuturesMarketStats>> {
    if (!this.redis) return new Map();
    try {
      return parseFuturesMarketStats(
        await this.redis.get(FUTURES_MARKET_STATS_KEY),
      );
    } catch {
      return new Map();
    }
  }
}
