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
import { KisDomesticPeriodAdapter } from './kis-domestic-period.adapter';
import { KisOverseasPeriodAdapter } from './kis-overseas-period.adapter';
import { KisPeriodCandleNormalizerService } from './kis-period-candle-normalizer.service';

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
    domestic: new KisDomesticPeriodAdapter(auth, quote, providerConfig),
    overseas: new KisOverseasPeriodAdapter(auth, quote, providerConfig),
    normalizer: new KisPeriodCandleNormalizerService(),
  };
}

async function closeHarness(harness: Harness | undefined) {
  if (!harness) return;
  await harness.coordinator.onModuleDestroy();
  await harness.redis.onModuleDestroy();
}

function formatYmd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

// Opt-in real-provider smoke: one rate-limited page per interval with a
// small range. Requires real KIS credentials in the environment; never runs
// by default and never logs credentials.
const periodDescribe =
  process.env.KIS_PERIOD_CANDLE_LIVE_SMOKE === '1' ? describe : describe.skip;
periodDescribe('KIS period candle live smoke', () => {
  let harness: Harness | undefined;
  afterAll(() => closeHarness(harness));

  it('fetches one domestic daily page and strictly parses at least one row', async () => {
    harness = harness ?? createHarness();
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const page = await harness.domestic.fetchPeriodPage({
      asset: {
        id: 'live-smoke',
        symbol: process.env.KIS_DOMESTIC_CANDLE_SMOKE_SYMBOL ?? '005930',
        marketCode: process.env.KIS_DOMESTIC_CANDLE_SMOKE_MARKET ?? 'J',
      },
      interval: '1d',
      fromDate: formatYmd(from),
      endDate: formatYmd(now),
      timeoutMs: 15_000,
    });
    expect(page.state).toBe('ok');
    const normalized = harness.normalizer.normalizeDomesticPeriodRows({
      rows: page.rows,
      interval: '1d',
      from,
      to: new Date(now.getTime() + 1),
      now,
    });
    expect(normalized.acceptedRows).toBeGreaterThan(0);
  }, 30_000);

  it('fetches one overseas daily page (GUBN=0) and strictly parses at least one row', async () => {
    harness = harness ?? createHarness();
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const page = await harness.overseas.fetchPeriodPage({
      asset: {
        id: 'live-smoke',
        symbol: process.env.KIS_US_CANDLE_SMOKE_SYMBOL ?? 'AAPL',
        marketCode: process.env.KIS_US_CANDLE_SMOKE_MARKET ?? 'NAS',
      },
      interval: '1d',
      fromDate: formatYmd(from),
      endDate: formatYmd(now),
      timeoutMs: 15_000,
    });
    expect(page.state).toBe('ok');
    const normalized = harness.normalizer.normalizeOverseasPeriodRows({
      rows: page.rows,
      interval: '1d',
      from,
      to: new Date(now.getTime() + 1),
      now,
    });
    expect(normalized.acceptedRows).toBeGreaterThan(0);
  }, 30_000);

  it('fetches one overseas weekly page (GUBN=1) and anchors rows to Mondays', async () => {
    harness = harness ?? createHarness();
    const now = new Date();
    const from = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
    const page = await harness.overseas.fetchPeriodPage({
      asset: {
        id: 'live-smoke',
        symbol: process.env.KIS_US_CANDLE_SMOKE_SYMBOL ?? 'AAPL',
        marketCode: process.env.KIS_US_CANDLE_SMOKE_MARKET ?? 'NAS',
      },
      interval: '1w',
      fromDate: formatYmd(from),
      endDate: formatYmd(now),
      timeoutMs: 15_000,
    });
    expect(page.state).toBe('ok');
    const normalized = harness.normalizer.normalizeOverseasPeriodRows({
      rows: page.rows,
      interval: '1w',
      from,
      to: new Date(now.getTime() + 1),
      now,
    });
    expect(normalized.acceptedRows).toBeGreaterThan(0);
  }, 30_000);
});
