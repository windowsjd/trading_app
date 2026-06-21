jest.mock('../generated/prisma/client', () => ({
  OperatorAuditResult: {
    success: 'success',
    failure: 'failure',
  },
  PrismaClient: class PrismaClient {},
  UserRole: {
    user: 'user',
    operator: 'operator',
    admin: 'admin',
  },
}));

import { HttpException } from '@nestjs/common';
import { UserRole } from '../generated/prisma/client';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorProviderIngestionService } from './operator-provider-ingestion.service';

describe('OperatorProviderIngestionService', () => {
  const actor = {
    userId: 'operator-1',
    role: UserRole.operator,
  };

  it('runs Binance ingestion as dry-run by default and writes safe audit metadata', async () => {
    const { audit, binance, service } = createService();
    binance.ingestPrices.mockResolvedValueOnce({
      success: true,
      provider: 'binance',
      dryRun: true,
      symbolCount: 1,
      created: 0,
      skipped: 0,
      wouldCreate: 1,
      failed: 0,
      symbols: [
        {
          symbol: 'BTCUSDT',
          state: 'would_create',
          assetId: 'asset-btc',
          price: '100.00000000',
          effectiveAt: '2026-06-21T00:00:00.000Z',
        },
      ],
    });

    const response = await service.runProviderIngestion(
      actor,
      'binance',
      {
        symbols: ['BTCUSDT'],
        reason: 'manual_smoke',
      },
      {
        requestId: 'request-1',
      },
    );

    expect(response.data).toMatchObject({
      provider: 'binance',
      dryRun: true,
      state: 'completed',
      wouldCreate: 1,
    });
    expect(binance.ingestPrices).toHaveBeenCalledWith({
      dryRun: true,
      requestedBy: actor.userId,
      symbols: ['BTCUSDT'],
    });
    expect(audit.recordSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'operator.provider_ingestion.run',
        actorRole: UserRole.operator,
        targetId: 'binance',
        metadataJson: expect.objectContaining({
          dryRun: true,
          reason: 'manual_smoke',
          state: 'completed',
          symbolCount: 1,
        }),
      }),
    );
    expect(JSON.stringify(audit.recordSuccess.mock.calls)).not.toMatch(
      /access_token|app_secret|approval_key|secret-value/i,
    );
  });

  it('allows explicit non-dry-run only when dryRun is false', async () => {
    const { binance, service } = createService();
    binance.ingestPrices.mockResolvedValueOnce({
      success: true,
      provider: 'binance',
      dryRun: false,
      symbolCount: 1,
      created: 1,
      skipped: 0,
      wouldCreate: 0,
      failed: 0,
      symbols: [],
    });

    const response = await service.runProviderIngestion(actor, 'binance', {
      dryRun: false,
      symbols: ['ETHUSDT'],
    });

    expect(response.data).toMatchObject({
      dryRun: false,
      created: 1,
    });
    expect(binance.ingestPrices).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
      }),
    );
  });

  it('returns skipped state for disabled providers and still audits the trigger', async () => {
    const { audit, exchangeRate, service } = createService();
    exchangeRate.ingestUsdKrw.mockResolvedValueOnce({
      success: false,
      provider: 'exchange_rate_api',
      dryRun: true,
      fromCurrency: 'USD',
      toCurrency: 'KRW',
      rate: null,
      effectiveAt: null,
      created: 0,
      skipped: 0,
      wouldCreate: 0,
      errorCode: 'PROVIDER_INGESTION_DISABLED',
      errorMessage: 'Provider ingestion is disabled.',
    });

    const response = await service.runProviderIngestion(
      actor,
      'exchange-rate',
      {},
    );

    expect(response.data).toMatchObject({
      provider: 'exchange-rate',
      state: 'skipped',
      errorCode: 'PROVIDER_INGESTION_DISABLED',
    });
    expect(audit.recordSuccess).toHaveBeenCalled();
  });

  it('runs KIS REST current-price and hoga modes through the trigger', async () => {
    const { kisCurrent, kisHoga, service } = createService();
    kisCurrent.ingestCurrentPrices.mockResolvedValueOnce({
      success: true,
      provider: 'kis',
      ingestion: 'rest_current_price',
      dryRun: true,
      received: 1,
      created: 0,
      skipped: 0,
      wouldCreate: 1,
      failed: 0,
      snapshots: [],
    });
    kisHoga.ingestHogaSnapshots.mockResolvedValueOnce({
      success: true,
      provider: 'kis',
      ingestion: 'rest_hoga',
      dryRun: true,
      received: 1,
      created: 0,
      skipped: 0,
      wouldCreate: 1,
      failed: 0,
      snapshots: [],
    });

    const response = await service.runProviderIngestion(actor, 'kis', {
      symbols: ['005930', 'NAS:AAPL'],
      maxSnapshots: 2,
      kisModes: ['current_price', 'orderbook'],
    });

    expect(response.data).toMatchObject({
      provider: 'kis',
      received: 2,
      wouldCreate: 2,
      state: 'completed',
    });
    expect(kisCurrent.ingestCurrentPrices).toHaveBeenCalledWith(
      expect.objectContaining({
        domesticSymbols: ['005930'],
        usSymbols: ['NAS:AAPL'],
        maxSnapshots: 2,
      }),
    );
    expect(kisHoga.ingestHogaSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        domesticSymbols: ['005930'],
        usSymbols: ['NAS:AAPL'],
      }),
    );
  });

  it('validates provider, symbols, maxSnapshots, and reason', async () => {
    const { service } = createService();

    await expectErrorCode(
      service.runProviderIngestion(actor, 'unknown', {}),
      'INVALID_PROVIDER',
    );
    await expectErrorCode(
      service.runProviderIngestion(actor, 'binance', {
        symbols: ['bad symbol'],
      }),
      'INVALID_SYMBOL',
    );
    await expectErrorCode(
      service.runProviderIngestion(actor, 'binance', {
        maxSnapshots: 0,
      }),
      'INVALID_MAX_SNAPSHOTS',
    );
    await expectErrorCode(
      service.runProviderIngestion(actor, 'binance', {
        reason: 'x'.repeat(121),
      }),
      'TEXT_TOO_LONG',
    );
  });
});

function createService() {
  const audit = {
    recordSuccess: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    recordFailure: jest.fn().mockResolvedValue({ id: 'audit-1' }),
  } as unknown as jest.Mocked<OperatorAuditService>;
  const exchangeRate = {
    ingestUsdKrw: jest.fn(),
  };
  const koreaExim = {
    ingestUsdKrw: jest.fn(),
  };
  const binance = {
    ingestPrices: jest.fn(),
  };
  const kisCurrent = {
    ingestCurrentPrices: jest.fn(),
  };
  const kisHoga = {
    ingestHogaSnapshots: jest.fn(),
  };
  const kisWebSocket = {
    runTradePriceIngestion: jest.fn(),
  };
  const service = new OperatorProviderIngestionService(
    audit,
    exchangeRate as never,
    koreaExim as never,
    binance as never,
    kisCurrent as never,
    kisHoga as never,
    kisWebSocket as never,
  );

  return {
    audit,
    exchangeRate,
    koreaExim,
    binance,
    kisCurrent,
    kisHoga,
    kisWebSocket,
    service,
  };
}

async function expectErrorCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(HttpException);

  try {
    await promise;
  } catch (error) {
    const response = (error as HttpException).getResponse() as {
      error: { code: string };
    };
    expect(response.error.code).toBe(code);
  }
}
