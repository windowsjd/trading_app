jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import type { TiingoAssetMapService } from './tiingo-asset-map.service';
import { readTiingoConfig, TiingoConfigService } from './tiingo.config';
import { TiingoDiagnosticsService } from './tiingo-diagnostics.service';
import { TiingoMarketDataStore } from './tiingo-market-data.store';
import { parseTiingoTimestamp } from './tiingo.parser';
import type { TiingoRestClient } from './tiingo-rest.client';

const TOKEN = 'synthetic-secret-token-123';

function create(env: Record<string, string> = {}) {
  const store = new TiingoMarketDataStore();
  const config = new TiingoConfigService(
    readTiingoConfig({
      TIINGO_ENABLED: 'true',
      TIINGO_API_TOKEN: TOKEN,
      TIINGO_ALLOWED_SYMBOLS: 'AAPL',
      ...env,
    }),
  );
  const assetMap = {
    cachedMapping: () => ({
      targets: [
        {
          assetId: 'asset-aapl',
          symbol: 'AAPL',
          market: 'NAS',
          ticker: 'aapl',
        },
      ],
      unmapped: [],
      loadedAt: '2026-10-13T14:00:00.000Z',
      lastLoadFailed: false,
    }),
  } as unknown as TiingoAssetMapService;
  const rest = {
    getStatus: () => ({
      networkRequests: 3,
      sharedRequests: 0,
      successes: 2,
      failuresByCode: { TIINGO_RATE_LIMITED: 1 },
      lastSuccessAt: '2026-10-13T14:29:00.000Z',
      lastFailureAt: '2026-10-13T14:29:30.000Z',
      lastErrorCode: 'TIINGO_RATE_LIMITED',
      lastFailureEndpoint: 'intraday',
      lastHttpStatus: 429,
      authState: 'ok',
      rateLimitedUntil: null,
      budget: {
        minuteUsed: 3,
        minuteLimit: 30,
        hourUsed: 3,
        hourLimit: 600,
        perSymbolMinuteLimit: 20,
      },
    }),
  } as unknown as TiingoRestClient;
  return {
    store,
    diagnostics: new TiingoDiagnosticsService(config, assetMap, store, rest),
  };
}

describe('TiingoDiagnosticsService', () => {
  it('reports state, counters and timestamps but never a price or the token', () => {
    const { store, diagnostics } = create();
    store.acceptReference({
      symbol: 'AAPL',
      price: '247.6131',
      timestamp: parseTiingoTimestamp('2026-10-13T10:29:50-04:00')!,
      capturedAt: new Date('2026-10-13T14:29:50.200Z'),
      origin: 'ws',
    });
    store.acceptLiquidity({
      symbol: 'AAPL',
      fields: {
        spread: '0.0004',
        bidPrice: '247.5921',
        bidSize: '317',
        askPrice: '247.6919',
        askSize: '211',
        referencePrice: '247.6131',
      },
      timestamp: parseTiingoTimestamp('2026-10-13T10:29:51-04:00')!,
      capturedAt: new Date('2026-10-13T14:29:51.000Z'),
      origin: 'ws',
    });
    const status = diagnostics.getStatus(new Date('2026-10-13T14:30:00.000Z'));
    expect(status).toMatchObject({
      provider: 'tiingo',
      state: 'enabled',
      persistence: 'disabled',
      trialMode: true,
      marketSegment: 'regular',
      lastFailure: { stage: 'rest', code: 'TIINGO_RATE_LIMITED' },
    });
    const symbol = (status as { symbols: Record<string, unknown>[] })
      .symbols[0];
    expect(symbol).toMatchObject({
      assetId: 'asset-aapl',
      referenceDataState: 'flowing',
      referenceAgeMs: 9_800,
    });
    const text = JSON.stringify(status);
    for (const secret of [
      TOKEN,
      '247.6131',
      '247.5921',
      '247.6919',
      '317',
      '211',
    ])
      expect(text.includes(secret)).toBe(false);
  });

  it('distinguishes an expected overnight silence from a quiet session', () => {
    const { store, diagnostics } = create();
    store.acceptReference({
      symbol: 'AAPL',
      price: '1',
      timestamp: parseTiingoTimestamp('2026-10-13T10:00:00-04:00')!,
      capturedAt: new Date('2026-10-13T14:00:00.000Z'),
      origin: 'ws',
    });
    const quiet = diagnostics.getStatus(
      new Date('2026-10-13T14:30:00.000Z'),
    ) as {
      symbols: { referenceDataState: string }[];
    };
    expect(quiet.symbols[0].referenceDataState).toBe('quiet');
    const overnight = diagnostics.getStatus(
      new Date('2026-10-14T03:00:00.000Z'),
    ) as {
      symbols: { referenceDataState: string }[];
      marketSegment: string;
    };
    expect(overnight.marketSegment).toBe('overnight');
    expect(overnight.symbols[0].referenceDataState).toBe('expected_quiet');
  });

  it('surfaces a configuration error without details beyond its code', () => {
    const { diagnostics } = create({ TIINGO_API_TOKEN: '' });
    expect(diagnostics.getStatus()).toMatchObject({
      state: 'config_error',
      configError: 'TIINGO_TOKEN_MISSING',
      lastFailure: { stage: 'config', code: 'TIINGO_TOKEN_MISSING' },
    });
  });

  it('is a single disabled line when not requested', () => {
    const { diagnostics } = create({ TIINGO_ENABLED: 'false' });
    expect(diagnostics.getStatus()).toMatchObject({
      state: 'disabled',
      enabled: false,
      persistence: 'disabled',
    });
  });
});
