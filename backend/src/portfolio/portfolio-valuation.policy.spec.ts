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
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
  };
});

import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
} from '../generated/prisma/client';
import {
  calculatePortfolioValuation,
  PortfolioValuationError,
} from './portfolio-valuation.policy';

describe('portfolio valuation policy', () => {
  const valuationAt = new Date('2026-05-07T00:01:00.000Z');
  const freshUsdKrwSnapshot = {
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    rate: '1400.00000000',
    sourceType: FxRateSourceType.admin_manual,
    effectiveAt: new Date('2026-05-07T00:00:30.000Z'),
    capturedAt: new Date('2026-05-07T00:00:31.000Z'),
    createdAt: new Date('2026-05-07T00:00:32.000Z'),
    approvedByUserId: 'operator-1',
  };

  const wallets = (krw: string, usd = '0.00000000') => [
    {
      currencyCode: CurrencyCode.KRW,
      balanceAmount: krw,
    },
    {
      currencyCode: CurrencyCode.USD,
      balanceAmount: usd,
    },
  ];

  const price = (
    assetId: string,
    priceValue: string,
    currencyCode: CurrencyCode,
  ) => ({
    assetId,
    price: priceValue,
    currencyCode,
    sourceType: AssetPriceSourceType.admin_manual,
    effectiveAt: new Date('2026-05-07T00:00:00.000Z'),
    capturedAt: new Date('2026-05-07T00:00:01.000Z'),
    createdAt: new Date('2026-05-07T00:00:02.000Z'),
  });

  it('calculates cash-only KRW valuation', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('1000000.00000000'),
        positions: [],
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '1000000.00000000',
      returnRate: '0.00000000',
      krwCash: '1000000.00000000',
      usdCashKrw: '0.00000000',
      assetValueKrw: '0.00000000',
    });
  });

  it('returns percent returnRate for gains', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '10000000.00000000',
        cashWallets: wallets('10450000.00000000'),
        positions: [],
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '10450000.00000000',
      returnRate: '4.50000000',
    });
  });

  it('returns percent returnRate for losses', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '10000000.00000000',
        cashWallets: wallets('9500000.00000000'),
        positions: [],
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '9500000.00000000',
      returnRate: '-5.00000000',
    });
  });

  it('converts USD cash to KRW with approved fresh USD/KRW rate', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('900000.00000000', '100.00000000'),
        positions: [],
        usdKrwSnapshot: freshUsdKrwSnapshot,
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '1040000.00000000',
      returnRate: '4.00000000',
      krwCash: '900000.00000000',
      usdCashKrw: '140000.00000000',
    });
  });

  it('calculates KRW asset position value and PnL', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('900000.00000000'),
        positions: [
          {
            assetId: 'asset-krw',
            assetType: AssetType.domestic_stock,
            quantity: '10.00000000',
            averageCost: '10000.00000000',
            currencyCode: CurrencyCode.KRW,
            realizedPnl: '5000.00000000',
            realizedPnlKrw: '5000.00000000',
            latestPriceSnapshot: price(
              'asset-krw',
              '12000.00000000',
              CurrencyCode.KRW,
            ),
          },
        ],
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '1020000.00000000',
      returnRate: '2.00000000',
      assetValueKrw: '120000.00000000',
      realizedPnlKrw: '5000.00000000',
      unrealizedPnlKrw: '20000.00000000',
    });
  });

  it('calculates USD asset position value and PnL in KRW', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('0.00000000'),
        positions: [
          {
            assetId: 'asset-usd',
            assetType: AssetType.us_stock,
            quantity: '2.00000000',
            averageCost: '100.00000000',
            currencyCode: CurrencyCode.USD,
            realizedPnl: '10.00000000',
            realizedPnlKrw: '12500.00000000',
            latestPriceSnapshot: price(
              'asset-usd',
              '150.00000000',
              CurrencyCode.USD,
            ),
          },
        ],
        usdKrwSnapshot: freshUsdKrwSnapshot,
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '420000.00000000',
      returnRate: '-58.00000000',
      assetValueKrw: '420000.00000000',
      usStockValueKrw: '420000.00000000',
      realizedPnlKrw: '12500.00000000',
      unrealizedPnlKrw: '140000.00000000',
    });
  });

  it('calculates USD-settled crypto position value in cryptoValueKrw', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('0.00000000'),
        positions: [
          {
            assetId: 'asset-btc',
            assetType: AssetType.crypto,
            quantity: '0.01000000',
            averageCost: '40000.00000000',
            currencyCode: CurrencyCode.USD,
            realizedPnl: '0.00000000',
            realizedPnlKrw: '0.00000000',
            latestPriceSnapshot: price(
              'asset-btc',
              '50000.00000000',
              CurrencyCode.USD,
            ),
          },
        ],
        usdKrwSnapshot: freshUsdKrwSnapshot,
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '700000.00000000',
      assetValueKrw: '700000.00000000',
      cryptoValueKrw: '700000.00000000',
      domesticStockValueKrw: '0.00000000',
      usStockValueKrw: '0.00000000',
    });
  });

  it('rejects missing asset price snapshots', () => {
    expect(() =>
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('1000000.00000000'),
        positions: [
          {
            assetId: 'asset-krw',
            assetType: AssetType.domestic_stock,
            quantity: '1.00000000',
            averageCost: '10000.00000000',
            currencyCode: CurrencyCode.KRW,
            realizedPnl: '0.00000000',
            realizedPnlKrw: '0.00000000',
            latestPriceSnapshot: null,
          },
        ],
        valuationAt,
      }),
    ).toThrow(PortfolioValuationError);
  });

  it('allows realized-only closed positions without asset price snapshots', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('1000000.00000000'),
        positions: [
          {
            assetId: 'asset-krw',
            assetType: AssetType.domestic_stock,
            quantity: '0.00000000',
            averageCost: '10000.00000000',
            currencyCode: CurrencyCode.KRW,
            realizedPnl: '1234.00000000',
            realizedPnlKrw: '1234.00000000',
            latestPriceSnapshot: null,
          },
        ],
        valuationAt,
      }),
    ).toMatchObject({
      totalAssetKrw: '1000000.00000000',
      realizedPnlKrw: '1234.00000000',
      unrealizedPnlKrw: '0.00000000',
    });
  });

  it('rejects missing FX rate when USD conversion is required', () => {
    expect(() =>
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('1000000.00000000', '1.00000000'),
        positions: [],
        valuationAt,
      }),
    ).toThrow('USD/KRW FX rate snapshot is unavailable.');
  });

  it('rejects stale FX rate when USD conversion is required', () => {
    expect(() =>
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('1000000.00000000', '1.00000000'),
        positions: [],
        usdKrwSnapshot: {
          ...freshUsdKrwSnapshot,
          effectiveAt: new Date('2026-05-06T23:59:59.999Z'),
        },
        valuationAt,
      }),
    ).toThrow('USD/KRW FX rate snapshot is stale.');
  });

  it('allows older approved USD/KRW rate when settlement disables FX freshness', () => {
    expect(
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '1000000.00000000',
        cashWallets: wallets('1000000.00000000', '1.00000000'),
        positions: [],
        usdKrwSnapshot: {
          ...freshUsdKrwSnapshot,
          effectiveAt: new Date('2026-05-06T00:00:00.000Z'),
        },
        valuationAt,
        enforceAdminManualFxFreshness: false,
      }),
    ).toMatchObject({
      totalAssetKrw: '1001400.00000000',
      usdCashKrw: '1400.00000000',
    });
  });

  it('rejects non-positive initial capital', () => {
    expect(() =>
      calculatePortfolioValuation({
        seasonParticipantId: 'sp-1',
        initialCapitalKrw: '0.00000000',
        cashWallets: wallets('1000000.00000000'),
        positions: [],
        valuationAt,
      }),
    ).toThrow('initialCapitalKrw must be greater than 0.');
  });
});
