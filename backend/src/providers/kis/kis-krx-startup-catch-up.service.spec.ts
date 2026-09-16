jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

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
import { KIS_FIXED_DOMESTIC_SYMBOLS } from './kis-fixed-asset-universe';
import type { KisKrxSessionCloseIngestionService } from './kis-krx-session-close.ingestion.service';
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

  it('recovers a dated close then verifies consumer coverage', async () => {
    const { service, closeIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'completed',
      requestedSymbols: ['000270'],
      created: 1,
      skipped: 0,
    });
    expect(closeIngestionService.recoverSessionPrice).toHaveBeenCalledWith({
      assetId: 'asset-000270',
      symbol: '000270',
      now: POST_CLOSE,
    });
  });

  it('limits 15 missing KRX health assets to the configured two-symbol universe', async () => {
    const healthAssets = KIS_FIXED_DOMESTIC_SYMBOLS.slice(0, 15).map(
      missingKrxAsset,
    );
    expect(healthAssets).toHaveLength(15);
    const { service, closeIngestionService } = createService({
      domesticSymbols: [' 005930 ', '000270'],
      assets: healthAssets,
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toMatchObject({
      state: 'completed',
      requestedSymbols: ['005930', '000270'],
    });
    expect(closeIngestionService.recoverSessionPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'asset-005930',
        symbol: '005930',
        now: POST_CLOSE,
      }),
    );
    expect(
      closeIngestionService.recoverSessionPrice.mock.calls.map(
        (call: [{ symbol: string }]) => call[0].symbol,
      ),
    ).toEqual(['005930', '000270']);
  });

  it('still excludes configured symbols that do not meet the health conditions', async () => {
    const { service, closeIngestionService } = createService({
      domesticSymbols: ['005930', '000270'],
      assets: [missingKrxAsset('005930'), availableKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toMatchObject({
      state: 'completed',
      requestedSymbols: ['005930'],
    });
    expect(closeIngestionService.recoverSessionPrice).toHaveBeenCalledTimes(1);
    expect(closeIngestionService.recoverSessionPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'asset-005930',
        symbol: '005930',
        now: POST_CLOSE,
      }),
    );
  });

  it('does not report success when a row was created but coverage remains unavailable', async () => {
    const { service, healthService } = createService({
      assets: [missingKrxAsset('000270')],
    });
    healthService.checkActiveAssetCoverage
      .mockReset()
      .mockResolvedValue({ assets: [missingKrxAsset('000270')] });
    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'failed',
      reason: 'COMPLETED_SESSION_PRICE_UNAVAILABLE',
      failures: [
        {
          assetId: 'asset-000270',
          symbol: '000270',
          reason: 'LAST_COMPLETED_SESSION_PRICE_MISSING',
        },
      ],
    });
    expect(healthService.checkActiveAssetCoverage).toHaveBeenCalledTimes(2);
    expect(jest.spyOn(Logger.prototype, 'warn')).toHaveBeenCalledWith(
      'KIS KRX startup catch-up failed.',
      expect.objectContaining({
        completedSessionDate: '2026-08-24',
        failures: [
          {
            assetId: 'asset-000270',
            symbol: '000270',
            reason: 'LAST_COMPLETED_SESSION_PRICE_MISSING',
          },
        ],
      }),
    );
  });

  it('preserves the evidence failure reason when the second health read still fails', async () => {
    const { service, healthService, closeIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });
    closeIngestionService.recoverSessionPrice.mockResolvedValue({
      state: 'failed',
      reason: 'KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS',
    });
    healthService.checkActiveAssetCoverage
      .mockReset()
      .mockResolvedValue({ assets: [missingKrxAsset('000270')] });
    const result = await service.runStartupCatchUp(POST_CLOSE);
    expect(result).toMatchObject({
      state: 'failed',
      failures: [
        {
          symbol: '000270',
          reason: 'KIS_SESSION_CLOSE_DATE_MISSING_OR_AMBIGUOUS',
        },
      ],
    });
  });

  it('does not call KIS when the latest completed session is already covered', async () => {
    const { service, closeIngestionService } = createService({
      assets: [availableKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'not_needed',
      reason: 'LATEST_COMPLETED_SESSION_COVERED',
    });
    expect(closeIngestionService.recoverSessionPrice).not.toHaveBeenCalled();
  });

  it('does not call KIS on a KRX holiday', async () => {
    const { service, healthService, closeIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(
      service.runStartupCatchUp(new Date('2026-08-17T07:30:00.000Z')),
    ).resolves.toEqual({
      state: 'skipped',
      reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
    });
    expect(healthService.checkActiveAssetCoverage).not.toHaveBeenCalled();
    expect(closeIngestionService.recoverSessionPrice).not.toHaveBeenCalled();
  });

  it.each([
    ['pre-open', new Date('2026-08-23T23:00:00.000Z')], // 08:00 KST
    ['live session', new Date('2026-08-24T01:00:00.000Z')], // 10:00 KST
  ])('does not call KIS during %s startup', async (_label, now) => {
    const { service, closeIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(now)).resolves.toMatchObject({
      state: 'skipped',
      reason: 'NO_COMPLETED_KRX_SESSION_TODAY',
    });
    expect(closeIngestionService.recoverSessionPrice).not.toHaveBeenCalled();
  });

  it('keeps missing calendar coverage distinct from a holiday', async () => {
    const { service, healthService, closeIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });

    await expect(
      service.runStartupCatchUp(new Date('2028-08-24T07:30:00.000Z')),
    ).resolves.toEqual({
      state: 'skipped',
      reason: 'MARKET_CALENDAR_COVERAGE_MISSING',
    });
    expect(healthService.checkActiveAssetCoverage).not.toHaveBeenCalled();
    expect(closeIngestionService.recoverSessionPrice).not.toHaveBeenCalled();
  });

  it('skips safely when the KIS provider is disabled', async () => {
    const { service, healthService, closeIngestionService } = createService({
      providerEnabled: false,
      assets: [missingKrxAsset('000270')],
    });

    await expect(service.runStartupCatchUp(POST_CLOSE)).resolves.toEqual({
      state: 'skipped',
      reason: 'PROVIDER_DISABLED',
    });
    expect(healthService.checkActiveAssetCoverage).not.toHaveBeenCalled();
    expect(closeIngestionService.recoverSessionPrice).not.toHaveBeenCalled();
  });

  it('absorbs a REST failure so application bootstrap can continue', async () => {
    const { service, closeIngestionService } = createService({
      assets: [missingKrxAsset('000270')],
    });
    closeIngestionService.recoverSessionPrice.mockRejectedValueOnce(
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
  domesticSymbols?: string[];
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
        domesticSymbols: input.domesticSymbols ?? ['000270'],
      },
    }),
  };
  const healthService = {
    checkActiveAssetCoverage: jest
      .fn()
      .mockResolvedValue({
        assets: input.assets.map((asset) => ({
          ...asset,
          state: 'available',
          reason: null,
        })),
      })
      .mockResolvedValueOnce({ assets: input.assets }),
  };
  const closeIngestionService = {
    recoverSessionPrice: jest.fn().mockResolvedValue({
      state: 'created',
    }),
  };

  return {
    configService,
    healthService,
    closeIngestionService,
    service: new KisKrxStartupCatchUpService(
      configService as unknown as ProviderConfigService,
      healthService as unknown as MarketSnapshotHealthService,
      closeIngestionService as unknown as KisKrxSessionCloseIngestionService,
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
