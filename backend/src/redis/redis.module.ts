import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// Intentionally not @Global. RedisService is a shared singleton, but requiring
// each consuming module to import RedisModule keeps dependencies explicit and
// test isolation intact (no hidden ambient provider). Only AssetsModule needs
// it today for the candle cache; the step 1-3 lock/rate limiter will import it
// where it is used.
//
// Provided via useFactory so Nest constructs RedisService with its default
// (env-derived config, real ioredis client factory) instead of trying to
// resolve its non-injectable constructor parameters.
@Module({
  providers: [
    {
      provide: RedisService,
      useFactory: () => new RedisService(),
    },
  ],
  exports: [RedisService],
})
export class RedisModule {}
