import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RedisLockService } from './redis-lock.service';

// Intentionally not @Global. RedisService is a shared singleton, but requiring
// each consuming module to import RedisModule keeps dependencies explicit and
// test isolation intact (no hidden ambient provider). AssetsModule imports it
// for candle cache/locks and ProvidersModule imports it for KIS coordination.
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
    RedisLockService,
  ],
  exports: [RedisService, RedisLockService],
})
export class RedisModule {}
