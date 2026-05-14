jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
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
  };
});

import {
  assertUsableAssetForPriceInput,
  buildAdminAssetPriceSnapshotPayload,
  buildAdminAssetUpsertPayload,
} from './asset-admin-input.validation';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
} from '../generated/prisma/client';

describe('buildAdminAssetUpsertPayload', () => {
  it('parses valid admin asset input', () => {
    expect(
      buildAdminAssetUpsertPayload({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        market: 'NASDAQ',
        currencyCode: 'USD',
        assetType: 'us_stock',
      }),
    ).toEqual({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      market: 'NASDAQ',
      currencyCode: CurrencyCode.USD,
      assetType: AssetType.us_stock,
      isActive: true,
    });
  });

  it('parses explicit inactive asset input', () => {
    expect(
      buildAdminAssetUpsertPayload({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        market: 'NASDAQ',
        currencyCode: 'USD',
        assetType: 'us_stock',
        isActive: 'false',
      }).isActive,
    ).toBe(false);
  });

  it('parses Binance USD-settled crypto asset input', () => {
    expect(
      buildAdminAssetUpsertPayload({
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        market: 'BINANCE',
        currencyCode: 'USD',
        assetType: 'crypto',
      }),
    ).toEqual({
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      market: 'BINANCE',
      currencyCode: CurrencyCode.USD,
      assetType: AssetType.crypto,
      isActive: true,
    });
  });

  it.each(['symbol', 'name', 'market'] as const)(
    'rejects empty %s',
    (fieldName) => {
      expect(() =>
        buildAdminAssetUpsertPayload({
          symbol: fieldName === 'symbol' ? '' : 'AAPL',
          name: fieldName === 'name' ? '' : 'Apple Inc.',
          market: fieldName === 'market' ? '' : 'NASDAQ',
          currencyCode: 'USD',
          assetType: 'us_stock',
        }),
      ).toThrow(`--${fieldName}`);
    },
  );

  it('rejects invalid currencyCode', () => {
    expect(() =>
      buildAdminAssetUpsertPayload({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        market: 'NASDAQ',
        currencyCode: 'EUR',
        assetType: 'us_stock',
      }),
    ).toThrow('Invalid --currency-code');
  });

  it('rejects invalid assetType', () => {
    expect(() =>
      buildAdminAssetUpsertPayload({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        market: 'NASDAQ',
        currencyCode: 'USD',
        assetType: 'fund',
      }),
    ).toThrow('Invalid --asset-type');
  });
});

describe('buildAdminAssetPriceSnapshotPayload', () => {
  const now = new Date('2026-05-01T01:02:03.000Z');
  const activeUsdAsset = {
    id: 'asset-1',
    symbol: 'AAPL',
    market: 'NASDAQ',
    currencyCode: CurrencyCode.USD,
    isActive: true,
  };
  const activeBinanceCryptoAsset = {
    id: 'asset-btc',
    symbol: 'BTCUSDT',
    market: 'BINANCE',
    currencyCode: CurrencyCode.USD,
    isActive: true,
  };

  it('parses valid admin_manual price input by assetId', () => {
    const payload = buildAdminAssetPriceSnapshotPayload(
      {
        assetId: 'asset-1',
        price: '123.45670000',
        currencyCode: 'USD',
        sourceName: 'manual-approved-equity-close',
        effectiveAt: '2026-05-01T00:00:00.000Z',
        capturedAt: '2026-05-01T01:02:03.004Z',
      },
      activeUsdAsset,
      now,
    );

    expect(payload).toMatchObject({
      assetId: 'asset-1',
      price: '123.45670000',
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.admin_manual,
      sourceName: 'manual-approved-equity-close',
    });
    expect(payload.effectiveAt.toISOString()).toBe(
      '2026-05-01T00:00:00.000Z',
    );
    expect(payload.capturedAt.toISOString()).toBe(
      '2026-05-01T01:02:03.004Z',
    );
  });

  it('defaults effectiveAt and capturedAt to now', () => {
    const payload = buildAdminAssetPriceSnapshotPayload(
      {
        market: 'NASDAQ',
        symbol: 'AAPL',
        price: '123.45670000',
        currencyCode: 'USD',
        sourceName: 'manual-approved-equity-close',
      },
      activeUsdAsset,
      now,
    );

    expect(payload.effectiveAt).toBe(now);
    expect(payload.capturedAt).toBe(now);
  });

  it('parses Binance USD crypto price input', () => {
    const payload = buildAdminAssetPriceSnapshotPayload(
      {
        market: 'BINANCE',
        symbol: 'BTCUSDT',
        price: '50000.12345678',
        currencyCode: 'USD',
        sourceName: 'manual-approved-binance-btcusdt',
      },
      activeBinanceCryptoAsset,
      now,
    );

    expect(payload).toMatchObject({
      market: 'BINANCE',
      symbol: 'BTCUSDT',
      price: '50000.12345678',
      currencyCode: CurrencyCode.USD,
      sourceType: AssetPriceSourceType.admin_manual,
      sourceName: 'manual-approved-binance-btcusdt',
    });
  });

  it('rejects price <= 0', () => {
    expect(() =>
      buildAdminAssetPriceSnapshotPayload({
        assetId: 'asset-1',
        price: '0',
        currencyCode: 'USD',
        sourceName: 'manual-approved-equity-close',
      }),
    ).toThrow('Invalid price');
  });

  it('rejects sourceType other than admin_manual', () => {
    expect(() =>
      buildAdminAssetPriceSnapshotPayload({
        assetId: 'asset-1',
        price: '123.45670000',
        currencyCode: 'USD',
        sourceType: 'provider_api',
        sourceName: 'manual-approved-equity-close',
      }),
    ).toThrow('Only --source-type admin_manual is allowed');
  });

  it('rejects missing asset lookup identity', () => {
    expect(() =>
      buildAdminAssetPriceSnapshotPayload({
        price: '123.45670000',
        currencyCode: 'USD',
        sourceName: 'manual-approved-equity-close',
      }),
    ).toThrow('Provide either --asset-id or both --market and --symbol');
  });

  it('rejects assetId mixed with market or symbol', () => {
    expect(() =>
      buildAdminAssetPriceSnapshotPayload({
        assetId: 'asset-1',
        market: 'NASDAQ',
        price: '123.45670000',
        currencyCode: 'USD',
        sourceName: 'manual-approved-equity-close',
      }),
    ).toThrow('Use either --asset-id or --market/--symbol');
  });

  it('rejects asset currency mismatch', () => {
    expect(() =>
      buildAdminAssetPriceSnapshotPayload(
        {
          assetId: 'asset-1',
          price: '123.45670000',
          currencyCode: 'KRW',
          sourceName: 'manual-approved-equity-close',
        },
        activeUsdAsset,
        now,
      ),
    ).toThrow('does not match price currency');
  });

  it('rejects inactive assets for price input', () => {
    expect(() =>
      assertUsableAssetForPriceInput(
        {
          ...activeUsdAsset,
          isActive: false,
        },
        CurrencyCode.USD,
      ),
    ).toThrow('Asset is inactive');
  });
});
