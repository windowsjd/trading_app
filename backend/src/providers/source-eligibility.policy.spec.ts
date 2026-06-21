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
  Prisma,
} from '../generated/prisma/client';
import {
  FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
  isProviderWorkflowAllowed,
  isProviderWorkflowDenied,
  PROVIDER_SOURCE_NAMES,
  resolveAssetProviderEligibility,
  resolveFxProviderEligibility,
  selectFreshProviderSnapshot,
  selectFreshProviderSnapshotBySourcePriority,
  selectProviderSnapshotAtOrBefore,
  selectProviderSnapshotAtOrBeforeBySourcePriority,
} from './source-eligibility.policy';

describe('provider source eligibility policy', () => {
  const now = new Date('2026-06-03T00:00:00.000Z');

  it('keeps approved provider workflows open while closed workflows stay denied', () => {
    expect(isProviderWorkflowAllowed('fx_quote')).toBe(true);
    expect(isProviderWorkflowAllowed('fx_execute')).toBe(true);
    expect(isProviderWorkflowAllowed('orders_quote')).toBe(true);
    expect(isProviderWorkflowAllowed('orders_execute')).toBe(true);
    expect(isProviderWorkflowAllowed('home_live_valuation')).toBe(true);
    expect(isProviderWorkflowAllowed('daily_portfolio_snapshot')).toBe(true);
    expect(isProviderWorkflowAllowed('season_settlement')).toBe(true);
    expect(isProviderWorkflowDenied('orders_create')).toBe(true);
    expect(isProviderWorkflowDenied('season_ranking')).toBe(true);
    expect(isProviderWorkflowDenied('reward_final_tier')).toBe(true);
    expect(isProviderWorkflowDenied('reward_fulfillment')).toBe(true);
  });

  it('resolves eligible provider source names by asset class and market family', () => {
    expect(
      resolveAssetProviderEligibility({
        workflow: 'orders_quote',
        asset: {
          assetType: AssetType.domestic_stock,
          market: 'KRX',
          currencyCode: CurrencyCode.KRW,
        },
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.domesticStockKrx,
    });

    expect(
      resolveAssetProviderEligibility({
        workflow: 'daily_portfolio_snapshot',
        asset: {
          assetType: AssetType.domestic_stock,
          market: 'KRX',
          currencyCode: CurrencyCode.KRW,
        },
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.domesticStockKrx,
    });

    expect(
      resolveAssetProviderEligibility({
        workflow: 'season_settlement',
        asset: {
          assetType: AssetType.domestic_stock,
          market: 'KRX',
          currencyCode: CurrencyCode.KRW,
        },
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.domesticStockKrx,
      freshnessThresholdSeconds: 60,
    });

    expect(
      resolveAssetProviderEligibility({
        workflow: 'orders_quote',
        asset: {
          assetType: AssetType.us_stock,
          market: 'NYS',
          currencyCode: CurrencyCode.USD,
        },
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.usStock,
    });

    expect(
      resolveAssetProviderEligibility({
        workflow: 'orders_quote',
        asset: {
          assetType: AssetType.crypto,
          market: 'BINANCE',
          currencyCode: CurrencyCode.USD,
        },
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
    });

    expect(
      resolveAssetProviderEligibility({
        workflow: 'orders_execute',
        asset: {
          assetType: AssetType.crypto,
          market: 'BINANCE',
          currencyCode: CurrencyCode.USD,
        },
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
      freshnessThresholdSeconds: 10,
    });
  });

  it('rejects ineligible asset market/source combinations and denied workflows', () => {
    expect(
      resolveAssetProviderEligibility({
        workflow: 'orders_quote',
        asset: {
          assetType: AssetType.us_stock,
          market: 'KRX',
          currencyCode: CurrencyCode.USD,
        },
      }),
    ).toEqual({
      eligible: false,
      reason: 'asset_ineligible',
    });

    expect(
      resolveAssetProviderEligibility({
        workflow: 'orders_create',
        asset: {
          assetType: AssetType.crypto,
          market: 'BINANCE',
          currencyCode: CurrencyCode.USD,
        },
      }),
    ).toEqual({
      eligible: false,
      reason: 'workflow_ineligible',
    });
  });

  it('allows only USD/KRW provider FX for eligible workflows with source priority', () => {
    expect(
      resolveFxProviderEligibility({
        workflow: 'fx_quote',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrw,
      sourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
    });

    expect(
      resolveFxProviderEligibility({
        workflow: 'daily_portfolio_snapshot',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrw,
      sourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
    });

    expect(
      resolveFxProviderEligibility({
        workflow: 'season_settlement',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrw,
      sourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      freshnessThresholdSeconds: 300,
    });

    expect(
      resolveFxProviderEligibility({
        workflow: 'fx_execute',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
      }),
    ).toMatchObject({
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrw,
      sourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      freshnessThresholdSeconds: 60,
    });
  });

  it('keeps closed financial workflows provider-ineligible', () => {
    for (const workflow of [
      'orders_create',
      'season_ranking',
      'reward_final_tier',
      'reward_fulfillment',
    ] as const) {
      expect(
        resolveFxProviderEligibility({
          workflow,
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
        }),
      ).toEqual({
        eligible: false,
        reason: 'workflow_ineligible',
      });
      expect(
        resolveAssetProviderEligibility({
          workflow,
          asset: {
            assetType: AssetType.crypto,
            market: 'BINANCE',
            currencyCode: CurrencyCode.USD,
          },
        }),
      ).toEqual({
        eligible: false,
        reason: 'workflow_ineligible',
      });
    }
  });

  it('selects a fresh matching provider candidate and records source decision metadata', () => {
    const selected = selectFreshProviderSnapshot({
      candidates: [
        {
          id: 'provider-1',
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
          effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
          capturedAt: new Date('2026-06-02T23:59:40.000Z'),
          price: new Prisma.Decimal('100.00000000'),
        },
      ],
      expectedSourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
      now,
      freshnessThresholdSeconds: 60,
      isPositiveValue: (candidate) => candidate.price.gt(0),
    });

    expect(selected).toMatchObject({
      state: 'selected',
      decision: {
        selectedSourceType: 'provider_api',
        selectedSourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
        selectedSnapshotId: 'provider-1',
        fallbackUsed: false,
        freshnessAgeSeconds: 20,
      },
    });
  });

  it('rejects stale or mismatched provider candidates instead of using them', () => {
    const stale = selectFreshProviderSnapshot({
      candidates: [
        {
          id: 'stale-provider',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrw,
          effectiveAt: new Date('2026-06-02T23:50:00.000Z'),
          capturedAt: new Date('2026-06-02T23:54:59.000Z'),
          rate: new Prisma.Decimal('1400.00000000'),
        },
      ],
      expectedSourceName: PROVIDER_SOURCE_NAMES.fxUsdKrw,
      now,
      freshnessThresholdSeconds: 300,
      isPositiveValue: (candidate) => candidate.rate.gt(0),
    });

    expect(stale).toMatchObject({
      state: 'not_selected',
      decision: {
        fallbackUsed: true,
        fallbackReason: 'provider_rejected',
        rejectedProviderReason: 'captured_at_stale',
      },
    });

    const mismatched = selectFreshProviderSnapshot({
      candidates: [
        {
          id: 'wrong-source',
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: 'unexpected_provider',
          effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
          capturedAt: new Date('2026-06-02T23:59:40.000Z'),
          price: new Prisma.Decimal('100.00000000'),
        },
      ],
      expectedSourceName: PROVIDER_SOURCE_NAMES.usStock,
      now,
      freshnessThresholdSeconds: 60,
      isPositiveValue: (candidate) => candidate.price.gt(0),
    });

    expect(mismatched).toMatchObject({
      state: 'not_selected',
      decision: {
        rejectedProviderReason: 'source_name_mismatch',
      },
    });
  });

  it('selects fresh USD/KRW provider candidates by Korea EXIM then ExchangeRate priority', () => {
    const selectedPrimary = selectFreshProviderSnapshotBySourcePriority({
      candidates: [
        {
          id: 'exchange-fx-1',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
          effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
          capturedAt: new Date('2026-06-02T23:59:40.000Z'),
          rate: new Prisma.Decimal('1401.00000000'),
        },
        {
          id: 'korea-exim-fx-1',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
          effectiveAt: new Date('2026-06-02T23:58:30.000Z'),
          capturedAt: new Date('2026-06-02T23:59:30.000Z'),
          rate: new Prisma.Decimal('1400.00000000'),
        },
      ],
      expectedSourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      now,
      freshnessThresholdSeconds: 60,
      isPositiveValue: (candidate) => candidate.rate.gt(0),
    });

    expect(selectedPrimary).toMatchObject({
      state: 'selected',
      snapshot: {
        id: 'korea-exim-fx-1',
      },
      decision: {
        selectedSourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
        fallbackUsed: false,
      },
    });

    const selectedFallback = selectFreshProviderSnapshotBySourcePriority({
      candidates: [
        {
          id: 'korea-exim-stale',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
          effectiveAt: new Date('2026-06-02T23:50:00.000Z'),
          capturedAt: new Date('2026-06-02T23:54:59.000Z'),
          rate: new Prisma.Decimal('1399.00000000'),
        },
        {
          id: 'exchange-fx-2',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
          effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
          capturedAt: new Date('2026-06-02T23:59:40.000Z'),
          rate: new Prisma.Decimal('1401.00000000'),
        },
      ],
      expectedSourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      now,
      freshnessThresholdSeconds: 60,
      isPositiveValue: (candidate) => candidate.rate.gt(0),
    });

    expect(selectedFallback).toMatchObject({
      state: 'selected',
      snapshot: {
        id: 'exchange-fx-2',
      },
      decision: {
        selectedSourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
      },
    });
  });

  it('rejects future, non-positive, and wrong sourceType provider candidates', () => {
    const cases = [
      {
        candidate: {
          id: 'future-effective',
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
          effectiveAt: new Date('2026-06-03T00:00:01.000Z'),
          capturedAt: new Date('2026-06-02T23:59:40.000Z'),
          price: new Prisma.Decimal('100.00000000'),
        },
        reason: 'effective_at_in_future',
      },
      {
        candidate: {
          id: 'future-captured',
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
          effectiveAt: new Date('2026-06-02T23:59:40.000Z'),
          capturedAt: new Date('2026-06-03T00:00:01.000Z'),
          price: new Prisma.Decimal('100.00000000'),
        },
        reason: 'captured_at_in_future',
      },
      {
        candidate: {
          id: 'non-positive',
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
          effectiveAt: new Date('2026-06-02T23:59:40.000Z'),
          capturedAt: new Date('2026-06-02T23:59:40.000Z'),
          price: new Prisma.Decimal('0.00000000'),
        },
        reason: 'non_positive_value',
      },
      {
        candidate: {
          id: 'wrong-source-type',
          sourceType: AssetPriceSourceType.admin_manual,
          sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
          effectiveAt: new Date('2026-06-02T23:59:40.000Z'),
          capturedAt: new Date('2026-06-02T23:59:40.000Z'),
          price: new Prisma.Decimal('100.00000000'),
        },
        reason: 'source_type_mismatch',
      },
    ];

    for (const testCase of cases) {
      expect(
        selectFreshProviderSnapshot({
          candidates: [testCase.candidate],
          expectedSourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
          now,
          freshnessThresholdSeconds: 60,
          isPositiveValue: (candidate) => candidate.price.gt(0),
        }),
      ).toMatchObject({
        state: 'not_selected',
        decision: {
          fallbackUsed: true,
          fallbackReason: 'provider_rejected',
          rejectedProviderReason: testCase.reason,
        },
      });
    }
  });

  it('selects settlement provider candidates by effectiveAt without capturedAt freshness', () => {
    const selected = selectProviderSnapshotAtOrBefore({
      candidates: [
        {
          id: 'settlement-provider',
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
          effectiveAt: new Date('2026-06-01T00:00:00.000Z'),
          capturedAt: new Date('2026-06-01T00:00:05.000Z'),
          price: new Prisma.Decimal('100.00000000'),
        },
      ],
      expectedSourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
      valuationAt: now,
      isPositiveValue: (candidate) => candidate.price.gt(0),
    });

    expect(selected).toMatchObject({
      state: 'selected',
      decision: {
        selectedSourceType: 'provider_api',
        selectedSnapshotId: 'settlement-provider',
        freshnessAgeSeconds: null,
      },
    });

    expect(
      selectProviderSnapshotAtOrBefore({
        candidates: [
          {
            id: 'future-effective',
            sourceType: AssetPriceSourceType.provider_api,
            sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
            effectiveAt: new Date('2026-06-03T00:00:01.000Z'),
            capturedAt: new Date('2026-06-02T23:59:59.000Z'),
            price: new Prisma.Decimal('100.00000000'),
          },
        ],
        expectedSourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
        valuationAt: now,
        isPositiveValue: (candidate) => candidate.price.gt(0),
      }),
    ).toMatchObject({
      state: 'not_selected',
      decision: {
        rejectedProviderReason: 'effective_at_in_future',
      },
    });
  });

  it('selects settlement USD/KRW provider candidates by Korea EXIM then ExchangeRate priority', () => {
    const selectedPrimary = selectProviderSnapshotAtOrBeforeBySourcePriority({
      candidates: [
        {
          id: 'exchange-settlement-fx',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
          effectiveAt: new Date('2026-06-02T23:59:00.000Z'),
          capturedAt: new Date('2026-06-02T23:59:05.000Z'),
          rate: new Prisma.Decimal('1401.00000000'),
        },
        {
          id: 'korea-exim-settlement-fx',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
          effectiveAt: new Date('2026-06-01T00:00:00.000Z'),
          capturedAt: new Date('2026-06-01T00:00:05.000Z'),
          rate: new Prisma.Decimal('1400.00000000'),
        },
      ],
      expectedSourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      valuationAt: now,
      isPositiveValue: (candidate) => candidate.rate.gt(0),
    });

    expect(selectedPrimary).toMatchObject({
      state: 'selected',
      snapshot: {
        id: 'korea-exim-settlement-fx',
      },
      decision: {
        selectedSourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
        freshnessAgeSeconds: null,
      },
    });

    const selectedFallback = selectProviderSnapshotAtOrBeforeBySourcePriority({
      candidates: [
        {
          id: 'korea-exim-future',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
          effectiveAt: new Date('2026-06-03T00:00:01.000Z'),
          capturedAt: new Date('2026-06-02T23:59:59.000Z'),
          rate: new Prisma.Decimal('1399.00000000'),
        },
        {
          id: 'exchange-settlement-fx',
          sourceType: FxRateSourceType.provider_api,
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
          effectiveAt: new Date('2026-06-02T23:59:00.000Z'),
          capturedAt: new Date('2026-06-02T23:59:05.000Z'),
          rate: new Prisma.Decimal('1401.00000000'),
        },
      ],
      expectedSourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
      valuationAt: now,
      isPositiveValue: (candidate) => candidate.rate.gt(0),
    });

    expect(selectedFallback).toMatchObject({
      state: 'selected',
      snapshot: {
        id: 'exchange-settlement-fx',
      },
      decision: {
        selectedSourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
      },
    });
  });
});
