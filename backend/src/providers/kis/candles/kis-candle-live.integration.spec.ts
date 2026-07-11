jest.mock('../../../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return { Prisma: { Decimal: runtime.Decimal } };
});

import { RedisService } from '../../../redis/redis.service';
import { ProviderConfigService } from '../../provider-config.service';
import { readKisRateLimitConfig } from '../coordination/kis-rate-limit.config';
import { KisRateLimiterService } from '../coordination/kis-rate-limiter.service';
import { KisRequestCoordinatorService } from '../coordination/kis-request-coordinator.service';
import { KisAuthClient } from '../kis-auth.client';
import { KisQuoteClient } from '../kis-quote.client';
import { KisCandleNormalizerService } from './kis-candle-normalizer.service';
import { KisDomesticMinuteAdapter } from './kis-domestic-minute.adapter';
import { KisUsMinuteAdapter } from './kis-us-minute.adapter';

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
  const providerConfig = new ProviderConfigService();
  const redis = new RedisService();
  const limiter = new KisRateLimiterService(
    redis,
    readKisRateLimitConfig(process.env, {
      kisEnabled: providerConfig.getKisConfig().enabled,
    }),
  );
  const coordinator = new KisRequestCoordinatorService(limiter);
  const auth = new KisAuthClient(providerConfig, coordinator);
  const quote = new KisQuoteClient(providerConfig, coordinator);
  return {
    redis,
    coordinator,
    domestic: new KisDomesticMinuteAdapter(auth, quote, providerConfig),
    us: new KisUsMinuteAdapter(auth, quote, providerConfig),
    normalizer: new KisCandleNormalizerService(),
  };
}

async function closeHarness(harness: Harness | undefined) {
  if (!harness) return;
  await harness.coordinator.onModuleDestroy();
  await harness.redis.onModuleDestroy();
}

const domesticDescribe =
  process.env.KIS_DOMESTIC_CANDLE_LIVE_SMOKE === '1' ? describe : describe.skip;
domesticDescribe('KIS domestic candle live smoke', () => {
  let harness: Harness | undefined;
  afterAll(() => closeHarness(harness));

  it('fetches one rate-limited page and strictly parses at least one row', async () => {
    harness = createHarness();
    const now = new Date();
    const result = await harness.domestic.fetchDomesticOneMinuteRows({
      asset: {
        id: 'live-smoke',
        symbol: process.env.KIS_DOMESTIC_CANDLE_SMOKE_SYMBOL ?? '005930',
        marketCode: process.env.KIS_DOMESTIC_CANDLE_SMOKE_MARKET ?? 'J',
      },
      from: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
      to: new Date(now.getTime() + 1),
      maxPages: 1,
      maxRows: 120,
      maxDurationMs: 15_000,
    });
    const normalized = harness.normalizer.normalizeDomesticOneMinuteRows({
      rows: result.rows,
      from: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
      to: new Date(now.getTime() + 1),
      now,
    });
    expect(result.pagesFetched).toBe(1);
    expect(normalized.acceptedRows).toBeGreaterThan(0);
  }, 30_000);
});

const usDescribe =
  process.env.KIS_US_CANDLE_LIVE_SMOKE === '1' ? describe : describe.skip;
usDescribe('KIS US candle live smoke', () => {
  let harness: Harness | undefined;
  afterAll(() => closeHarness(harness));

  it('fetches NMIN=5 through the rate-limited metadata path and strictly parses rows', async () => {
    harness = createHarness();
    const now = new Date();
    const result = await harness.us.fetchUsFiveMinuteRows({
      asset: {
        id: 'live-smoke',
        symbol: process.env.KIS_US_CANDLE_SMOKE_SYMBOL ?? 'AAPL',
        marketCode: process.env.KIS_US_CANDLE_SMOKE_MARKET ?? 'NAS',
      },
      from: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
      to: new Date(now.getTime() + 1),
      maxPages: 1,
      maxRows: 120,
      maxDurationMs: 15_000,
    });
    const normalized = harness.normalizer.normalizeUsFiveMinuteRows({
      rows: result.rows,
      from: new Date(now.getTime() - 7 * 24 * 60 * 60_000),
      to: new Date(now.getTime() + 1),
      now,
    });
    expect(result.pagesFetched).toBe(1);
    expect(normalized.acceptedRows).toBeGreaterThan(0);
  }, 30_000);
});
