// Two processes' coordinators on ONE Redis (local loopback only): an operator
// backfill at budget 480 and the server at 1200. Spot klines reserve weight 2.
import { RedisService } from '../../../../backend/src/redis/redis.service';
import { readRedisConfig } from '../../../../backend/src/redis/redis.config';
import { BinanceRestCoordinator } from '../../../../backend/src/providers/binance/binance-rest-coordinator';

async function main() {
  const redis = new RedisService(readRedisConfig({ REDIS_URL: 'redis://127.0.0.1:57101' }));
  await redis.eval("return redis.call('DEL', KEYS[1], KEYS[2])", ['provider:{binance-rest}:state', 'provider:{binance-rest}:leases'], []);
  process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE = '480';
  const backfill = new BinanceRestCoordinator(redis);
  process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE = '1200';
  const server = new BinanceRestCoordinator(redis);
  const klines = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1000';
  const last = 'https://fapi.binance.com/fapi/v2/ticker/price';
  let backfillAdmitted = 0;
  let backfillRefusal = '';
  for (;;) {
    try {
      const token = await backfill.acquire(klines, 10_000);
      await backfill.complete(token, 'success');
      backfillAdmitted += 1;
    } catch (error) {
      backfillRefusal = (error as { code?: string }).code ?? String(error);
      break;
    }
  }
  let serverAdmitted = 0;
  let serverRefusal = '';
  for (;;) {
    try {
      const token = await server.acquire(last, 10_000);
      await server.complete(token, 'success');
      serverAdmitted += 1;
    } catch (error) {
      serverRefusal = (error as { code?: string }).code ?? String(error);
      break;
    }
  }
  console.log(JSON.stringify({ backfillAdmitted, backfillWeight: backfillAdmitted * 2, backfillRefusal, serverAdmittedAfterBackfill: serverAdmitted, serverWeight: serverAdmitted * 2, serverRefusal }));
  await redis.onModuleDestroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
