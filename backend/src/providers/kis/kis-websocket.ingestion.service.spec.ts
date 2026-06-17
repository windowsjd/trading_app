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
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderConfigService } from '../provider-config.service';
import { parseKisWebSocketMessage } from './kis-websocket.trade-parser';
import { KisWebSocketIngestionService } from './kis-websocket.ingestion.service';
import type { KisWebSocketTradeTick } from './kis-websocket.types';

const receivedAt = new Date('2026-05-27T01:00:00.000Z');

describe('KIS WebSocket ingestion service', () => {
  it('creates provider_api snapshots for mapped domestic assets', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-samsung', market: 'KRX', symbol: '005930' }],
    });
    const service = createService(prisma);
    const trade = parseOneTrade(
      domesticFrame([
        domesticRecord({
          symbol: '005930',
          time: '093015',
          price: '70123',
          businessDate: '20260527',
        }),
      ]),
    );

    const result = await service.ingestTrade(trade, {
      requestedBy: 'operator',
    });

    expect(result).toMatchObject({
      state: 'created',
      assetId: 'asset-samsung',
      price: '70123.00000000',
    });
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-samsung',
          price: '70123.00000000',
          currencyCode: 'KRW',
          sourceType: 'provider_api',
          sourceName: 'kis_krx_realtime_trade',
          note: 'provider_api KIS WebSocket trade ingestion requested by operator',
        }),
      }),
    );
  });

  it('skips unmapped domestic assets without creating fake assets', async () => {
    const prisma = createPrismaMock({ assets: [] });
    const service = createService(prisma);

    const result = await service.ingestTrade(
      parseOneTrade(
        domesticFrame([
          domesticRecord({
            symbol: '005930',
            time: '093015',
            price: '70123',
            businessDate: '20260527',
          }),
        ]),
      ),
    );

    expect(result).toMatchObject({
      state: 'skipped',
      reason: 'ASSET_MAPPING_NOT_FOUND',
    });
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('creates provider_api snapshots for mapped US assets', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-aapl', market: 'NASDAQ', symbol: 'AAPL' }],
    });
    const service = createService(prisma);

    const result = await service.ingestTrade(
      parseOneTrade(
        overseasFrame([
          overseasRecord({
            rsym: 'DNASAAPL',
            symbol: 'AAPL',
            zdiv: '2',
            koreanDate: '20260527',
            koreanTime: '231500',
            last: '19012',
            marketType: 'NAS',
          }),
        ]),
      ),
    );

    expect(result).toMatchObject({
      state: 'created',
      assetId: 'asset-aapl',
      price: '190.12000000',
    });
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-aapl',
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName: 'kis_us_delayed_trade',
        }),
      }),
    );
  });

  it('skips US delayed trades for non-US market codes', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-foreign', market: 'TSE', symbol: '7203' }],
    });
    const service = createService(prisma);
    const trade = {
      ...parseOneTrade(
        overseasFrame([
          overseasRecord({
            rsym: 'DTSE7203',
            symbol: '7203',
            zdiv: '0',
            koreanDate: '20260527',
            koreanTime: '231500',
            last: '1000',
            marketType: 'TSE',
          }),
        ]),
      ),
      marketCode: 'TSE',
    };

    const result = await service.ingestTrade(trade);

    expect(result).toMatchObject({
      state: 'skipped',
      reason: 'US_MARKET_NOT_ALLOWED',
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('dry-run does not write DB snapshots', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-samsung', market: 'KRX', symbol: '005930' }],
    });
    const service = createService(prisma);

    const result = await service.ingestTrade(
      parseOneTrade(
        domesticFrame([
          domesticRecord({
            symbol: '005930',
            time: '093015',
            price: '70123',
            businessDate: '20260527',
          }),
        ]),
      ),
      { dryRun: true },
    );

    expect(result.state).toBe('would_create');
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('skips duplicate snapshots by asset/source/effectiveAt/price', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-samsung', market: 'KRX', symbol: '005930' }],
    });
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'duplicate',
    });
    const service = createService(prisma);

    const result = await service.ingestTrade(
      parseOneTrade(
        domesticFrame([
          domesticRecord({
            symbol: '005930',
            time: '093015',
            price: '70123',
            businessDate: '20260527',
          }),
        ]),
      ),
    );

    expect(result).toMatchObject({
      state: 'skipped',
      reason: 'DUPLICATE_PROVIDER_SNAPSHOT',
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('skips snapshots inside the per-asset throttle window', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-samsung', market: 'KRX', symbol: '005930' }],
    });
    prisma.assetPriceSnapshot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'recent' });
    const service = createService(prisma);

    const result = await service.ingestTrade(
      parseOneTrade(
        domesticFrame([
          domesticRecord({
            symbol: '005930',
            time: '093016',
            price: '70124',
            businessDate: '20260527',
          }),
        ]),
      ),
    );

    expect(result).toMatchObject({
      state: 'skipped',
      reason: 'THROTTLED_PROVIDER_SNAPSHOT',
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('does not write DB rows for encrypted or invalid frames', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-samsung', market: 'KRX', symbol: '005930' }],
    });
    const service = createService(prisma);

    const encrypted = await service.ingestParsedMessage(
      parseKisWebSocketMessage({
        frame: `1|H0STCNT0|001|${domesticRecord({
          symbol: '005930',
          time: '093015',
          price: '70123',
          businessDate: '20260527',
        }).join('^')}`,
        receivedAt,
      }),
    );
    const invalid = await service.ingestParsedMessage(
      parseKisWebSocketMessage({
        frame: 'invalid-frame',
        receivedAt,
      }),
    );

    expect(encrypted.skipped).toBe(1);
    expect(invalid.failed).toBe(1);
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('redacts configured secrets from rawPayloadJson', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-samsung', market: 'KRX', symbol: '005930' }],
    });
    const service = createService(prisma, {
      appKey: 'kis-app-key',
      appSecret: 'kis-app-secret',
    });
    const trade = {
      ...parseOneTrade(
        domesticFrame([
          domesticRecord({
            symbol: '005930',
            time: '093015',
            price: '70123',
            businessDate: '20260527',
          }),
        ]),
      ),
      rawFrame: 'contains kis-app-key and kis-app-secret and approval-secret',
    };

    await service.ingestTrade(trade, {
      secrets: ['approval-secret'],
    });

    const createArg = prisma.assetPriceSnapshot.create.mock.calls[0][0];
    const rawPayload = JSON.stringify(createArg.data.rawPayloadJson);
    expect(rawPayload).not.toContain('kis-app-key');
    expect(rawPayload).not.toContain('kis-app-secret');
    expect(rawPayload).not.toContain('approval-secret');
    expect(rawPayload).toContain('[REDACTED]');
  });

  it('fails KIS subscription target building when the watchlist exceeds 41', async () => {
    const prisma = createPrismaMock({ assets: [] });
    const service = createService(prisma);

    await expect(
      service.buildSubscriptionTargets({
        domesticSymbols: Array.from({ length: 42 }, (_, index) =>
          String(index).padStart(6, '0'),
        ),
      }),
    ).rejects.toThrow('KIS watchlist allows at most 41 symbols.');
  });

  it('does not add KIS order, account, balance, or trading API surfaces', () => {
    const dir = join(__dirname);
    const text = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');

    expect(text).not.toMatch(
      /placeOrder|cancelOrder|accountNumber|balanceEndpoint|orderEndpoint|tradingAccount|\/uapi\/.*(?:order|account|balance|trading)/u,
    );
  });
});

function parseOneTrade(frame: string): KisWebSocketTradeTick {
  const parsed = parseKisWebSocketMessage({
    frame,
    receivedAt,
  });
  if (parsed.state !== 'trades') {
    throw new Error(`Expected trade frame, got ${parsed.state}`);
  }

  return parsed.trades[0];
}

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  secrets: { appKey?: string; appSecret?: string } = {},
) {
  const configService = {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: {
        enabled: false,
        baseUrl: 'https://example.test',
      },
      binance: {
        enabled: false,
        restBaseUrl: 'https://example.test',
        wsMarketDataBaseUrl: 'wss://example.test',
        symbols: [],
        usdtAsUsdEquivalent: true,
      },
      kis: {
        enabled: true,
        appKey: secrets.appKey ?? 'app-key',
        appSecret: secrets.appSecret ?? 'app-secret',
        restBaseUrl: 'https://example.test',
        wsBaseUrl: 'ws://example.test',
        wsCustType: 'P',
        wsDomesticTrId: 'H0STCNT0',
        wsOverseasDelayedTrId: 'HDFSCNT0',
        wsSnapshotThrottleMs: 5000,
        wsMaxRuntimeMs: 30000,
        wsAllowUsDelayed: true,
        maxWatchlistSize: 41,
        domesticSymbols: [],
        usSymbols: [],
        allSymbols: [],
        canCallRestLive: true,
        canCallWebSocketLive: true,
      },
    }),
  } as unknown as ProviderConfigService;

  return new KisWebSocketIngestionService(prisma as never, configService);
}

function createPrismaMock(input: {
  assets: Array<{ id: string; market: string; symbol: string }>;
}) {
  return {
    asset: {
      findMany: jest.fn().mockResolvedValue(input.assets),
      create: jest.fn(),
    },
    assetPriceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'kis-price-1' }),
    },
  };
}

function domesticFrame(records: string[][]): string {
  return `0|H0STCNT0|${String(records.length).padStart(3, '0')}|${records
    .flat()
    .join('^')}`;
}

function domesticRecord(input: {
  symbol: string;
  time: string;
  price: string;
  businessDate: string;
}): string[] {
  const fields = Array.from({ length: 46 }, () => '');
  fields[0] = input.symbol;
  fields[1] = input.time;
  fields[2] = input.price;
  fields[33] = input.businessDate;
  fields[35] = 'N';
  return fields;
}

function overseasFrame(records: string[][]): string {
  return `0|HDFSCNT0|${String(records.length).padStart(3, '0')}|${records
    .flat()
    .join('^')}`;
}

function overseasRecord(input: {
  rsym: string;
  symbol: string;
  zdiv: string;
  koreanDate: string;
  koreanTime: string;
  last: string;
  marketType: string;
}): string[] {
  const fields = Array.from({ length: 26 }, () => '');
  fields[0] = input.rsym;
  fields[1] = input.symbol;
  fields[2] = input.zdiv;
  fields[6] = input.koreanDate;
  fields[7] = input.koreanTime;
  fields[11] = input.last;
  fields[25] = input.marketType;
  return fields;
}
