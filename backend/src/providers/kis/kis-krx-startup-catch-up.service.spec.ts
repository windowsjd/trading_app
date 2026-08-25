jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { Logger } from '@nestjs/common';
import type { MarketSnapshotHealthService } from '../market-snapshot-health.service';
import type { ProviderConfigService } from '../provider-config.service';
import type { KisRestCurrentPriceIngestionService } from './kis-rest-current-price.ingestion.service';
import { KisKrxStartupCatchUpService } from './kis-krx-startup-catch-up.service';

const POST_CLOSE = new Date('2026-08-24T07:30:00.000Z'); // 16:30 KST

describe('KIS KRX startup catch-up', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs existing REST current-price ingestion for missing latest completed-session coverage', async () => {
    const { service, restIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'completed',
      requestedSymbols: ['000270'],
      created: 1,
      skipped: 0,
    });
    expect(restIngestionService.ingestCurrentPrices).toHaveBeenCalledWith({
      dryRun: false,
      requestedBy: 'kis-krx-startup-catch-up',
      domesticSymbols: ['000270'],
      usSymbols: [],
      maxSnapshots: 1,
    });
  });

  it('does not call KIS when the latest completed session is already covered', async () => {
    const { service, restIngestionService } = createService({
      assets: [availableKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'not_needed',
      reason: 'LATEST_COMPLETED_SESSION_COVERED',
    });
    expect(restIngestionService.ingestCurrentPrices).not.toHaveBeenCalled();
  });

  it('does not call KIS on a KRX holiday', async () => {
    const { service, healthService, restIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(
      service.runStartupCatchUp(new Date('2026-08-17T07:30:00.000Z')),
    ).resolves.toEqual({
      state: 'skipped',
      reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
    });
    expect(healthService.checkActiveAssetCoverage).not.toHaveBeenCalled();
    expect(restIngestionService.ingestCurrentPrices).not.toHaveBeenCalled();
  });

  it.each([
    ['pre-open', new Date('2026-08-23T23:00:00.000Z')], // 08:00 KST
    ['live session', new Date('2026-08-24T01:00:00.000Z')], // 10:00 KST
  ])('does not call KIS during %s startup', async (_label, now) => {
    const { service, restIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(now)).resolves.toMatchObject({
      state: 'skipped',
      reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
    });
    expect(restIngestionService.ingestCurrentPrices).not.toHaveBeenCalled();
  });

  it('keeps missing calendar coverage distinct from a holiday', async () => {
    const { service, healthService, restIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(
      service.runStartupCatchUp(new Date('2028-08-24T07:30:00.000Z')),
    ).resolves.toEqual({
      state: 'skipped',
      reason: 'MARKET_CALENDAR_COVERAGE_MISSING',
    });
    expect(healthService.checkActiveAssetCoverage).not.toHaveBeenCalled();
    expect(restIngestionService.ingestCurrentPrices).not.toHaveBeenCalled();
  });

  it('skips safely when the KIS provider is disabled', async () => {
    const { service, healthService, restIngestionService } = createService({
      providerEnabled: false,
      assets: [missingKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'skipped',
      reason: 'PROVIDER_DISABLED',
    });
    expect(healthService.checkActiveAssetCoverage).not.toHaveBeenCalled();
    expect(restIngestionService.ingestCurrentPrices).not.toHaveBeenCalled();
  });

  it('absorbs a REST failure so application bootstrap can continue', async () => {
    const { service, restIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });
    restIngestionService.ingestCurrentPrices.mockRejectedValueOnce(
      new Error('temporary KIS timeout'),
    );

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'failed',
      reason: 'temporary KIS timeout',
    });
  });

  it('schedules only one startup pass while WebSocket streaming remains enabled', async () => {
    const { service } = createService({
      websocketStreamingEnabled: true,
      assets: [missingKrxAsset('000270')],
    });
    const run = jest.spyOn(service, 'runStartupCatchUp').mockResolvedValue({
      state: 'not_needed',
      reason: 'LATEST_COMPLETED_SESSION_COVERED',
    });

    await Promise.all([
      service.startOnce(POST_CLOSE),
      service.startOnce(POST_CLOSE),
    ]);
    service.onApplicationBootstrap();
    await flushAsync();

    expect(run).toHaveBeenCalledTimes(1);
  });
});

function createService(input: {
  providerEnabled?: boolean;
  websocketStreamingEnabled?: boolean;
  assets: object[];
}) {
  const providerEnabled = input.providerEnabled ?? true;
  const configService = {
    getConfig: jest.fn().mockReturnValue({
      common: { providerIngestionEnabled: providerEnabled },
      kis: {
        enabled: providerEnabled,
        canCallRestLive: providerEnabled,
        wsStreamingEnabled: input.websocketStreamingEnabled ?? true,
      },
    }),
  };
  const healthService = {
    checkActiveAssetCoverage: jest.fn().mockResolvedValue({
      assets: input.assets,
    }),
  };
  const restIngestionService = {
    ingestCurrentPrices: jest.fn().mockResolvedValue({
      success: true,
      provider: 'kis',
      ingestion: 'rest_current_price',
      dryRun: false,
      received: 1,
      created: 1,
      skipped: 0,
      wouldCreate: 0,
      failed: 0,
      snapshots: [],
    }),
  };

  return {
    configService,
    healthService,
    restIngestionService,
    service: new KisKrxStartupCatchUpService(
      configService as unknown as ProviderConfigService,
      healthService as unknown as MarketSnapshotHealthService,
      restIngestionService as unknown as KisRestCurrentPriceIngestionService,
    ),
  };
}

function missingKrxAsset(symbol: string) {
  return {
    assetId: `asset-${symbol}`,
    symbol,
    assetType: 'domestic_stock',
    market: 'KRX',
    state: 'unavailable',
    reason: 'LAST_COMPLETED_SESSION_PRICE_MISSING',
  };
}

function availableKrxAsset(symbol: string) {
  return {
    ...missingKrxAsset(symbol),
    state: 'available',
    reason: null,
  };
}

async function flushAsync() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
