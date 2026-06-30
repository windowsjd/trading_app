jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: {
    KRW: 'KRW',
    USD: 'USD',
  },
  PrismaClient: class PrismaClient {},
}));

import { AssetType, CurrencyCode } from '../generated/prisma/client';
import {
  ProviderTargetResolverService,
  resolveActiveAssetTargetsFromRecords,
} from './provider-target-resolver.service';

describe('ProviderTargetResolverService', () => {
  it('builds Binance BTCUSDT target from active BTC crypto asset', () => {
    const targets = resolveActiveAssetTargetsFromRecords([
      asset({
        id: 'asset-btc',
        symbol: 'BTC',
        assetType: AssetType.crypto,
        market: 'BINANCE',
        currencyCode: CurrencyCode.USD,
      }),
    ]);

    expect(targets.binanceSymbols).toEqual(['BTCUSDT']);
    expect(targets.unsupportedAssets).toEqual([]);
  });

  it('keeps active BTCUSDT crypto asset as BTCUSDT target', () => {
    const targets = resolveActiveAssetTargetsFromRecords([
      asset({
        id: 'asset-btcusdt',
        symbol: 'BTCUSDT',
        assetType: AssetType.crypto,
        market: 'BINANCE',
        currencyCode: CurrencyCode.USD,
      }),
    ]);

    expect(targets.binanceSymbols).toEqual(['BTCUSDT']);
  });

  it('builds KIS domestic and US targets from active stock assets', () => {
    const targets = resolveActiveAssetTargetsFromRecords([
      asset({
        id: 'asset-samsung',
        symbol: '005930',
        assetType: AssetType.domestic_stock,
        market: 'KRX',
        currencyCode: CurrencyCode.KRW,
      }),
      asset({
        id: 'asset-aapl',
        symbol: 'AAPL',
        assetType: AssetType.us_stock,
        market: 'NASDAQ',
        currencyCode: CurrencyCode.USD,
      }),
    ]);

    expect(targets.kisDomesticSymbols).toEqual(['005930']);
    expect(targets.kisUsSymbols).toEqual(['AAPL']);
  });

  it('reports unsupported active assets with reasons', () => {
    const targets = resolveActiveAssetTargetsFromRecords([
      asset({
        id: 'asset-invalid-domestic',
        symbol: 'SAMSUNG',
        assetType: AssetType.domestic_stock,
        market: 'KRX',
        currencyCode: CurrencyCode.KRW,
      }),
      asset({
        id: 'asset-unsupported',
        symbol: '7203',
        assetType: AssetType.us_stock,
        market: 'TSE',
        currencyCode: CurrencyCode.USD,
      }),
    ]);

    expect(targets.unsupportedAssets).toEqual([
      expect.objectContaining({
        assetId: 'asset-invalid-domestic',
        symbol: 'SAMSUNG',
        reason: 'INVALID_KIS_DOMESTIC_SYMBOL',
      }),
      expect.objectContaining({
        assetId: 'asset-unsupported',
        symbol: '7203',
        reason: 'NO_PROVIDER_TARGET',
      }),
    ]);
  });

  it('merges env targets with active asset targets without duplicates', async () => {
    const prisma = {
      asset: {
        findMany: jest.fn().mockResolvedValue([
          asset({
            id: 'asset-btc',
            symbol: 'BTC',
            assetType: AssetType.crypto,
            market: 'BINANCE',
            currencyCode: CurrencyCode.USD,
          }),
          asset({
            id: 'asset-aapl',
            symbol: 'AAPL',
            assetType: AssetType.us_stock,
            market: 'NAS',
            currencyCode: CurrencyCode.USD,
          }),
        ]),
      },
    };
    const service = new ProviderTargetResolverService(prisma as never);

    const targets = await service.resolveProviderTargets({
      targetSource: 'merged',
      env: {
        BINANCE_CRYPTO_SYMBOLS: 'BTCUSDT,ETHUSDT',
        KIS_DOMESTIC_SYMBOLS: '005930',
        KIS_US_SYMBOLS: 'AAPL,TSLA',
      },
    });

    expect(targets.binanceSymbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(targets.kisDomesticSymbols).toEqual(['005930']);
    expect(targets.kisUsSymbols).toEqual(['AAPL', 'TSLA']);
  });
});

function asset(input: {
  id: string;
  symbol: string;
  assetType: AssetType;
  market: string;
  currencyCode: CurrencyCode;
}) {
  return {
    ...input,
    isActive: true,
  };
}
