jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    Prisma: {
      Decimal,
    },
  };
});

import { AssetType } from '../generated/prisma/client';
import {
  calculateChangeBps,
  isWithinMaxChangeBps,
  resolveDefaultMaxChangeBps,
  resolveExecuteFreshnessThresholdSeconds,
  validateExecutionProviderSource,
  validateLimitOrderExecutionPrice,
  validateMarketOrderExecutionPrice,
  validateQuoteExpiry,
} from './realtime-execution-policy';

describe('realtime execution policy', () => {
  it('calculates absolute price change in bps', () => {
    expect(calculateChangeBps('100', '100').toFixed()).toBe('0');
    expect(calculateChangeBps('100', '100.30').toFixed()).toBe('30');
    expect(calculateChangeBps('100', '99.70').toFixed()).toBe('30');
  });

  it('checks max change thresholds inclusively', () => {
    expect(isWithinMaxChangeBps('100', '100.30', 30)).toBe(true);
    expect(isWithinMaxChangeBps('100', '100.31', 30)).toBe(false);
  });

  it('validates market order execution price against quoted price threshold', () => {
    expect(
      validateMarketOrderExecutionPrice({
        quotedPrice: '100',
        executionPrice: '100.30',
        maxChangeBps: 30,
      }),
    ).toMatchObject({
      ok: true,
    });

    expect(
      validateMarketOrderExecutionPrice({
        quotedPrice: '100',
        executionPrice: '100.31',
        maxChangeBps: 30,
      }),
    ).toMatchObject({
      ok: false,
      errorCode: 'PRICE_CHANGED_REQUOTE_REQUIRED',
    });
  });

  it('validates limit buy execution price marketability', () => {
    expect(
      validateLimitOrderExecutionPrice({
        side: 'buy',
        limitPrice: '100',
        executionPrice: '100',
      }),
    ).toEqual({
      ok: true,
    });
    expect(
      validateLimitOrderExecutionPrice({
        side: 'buy',
        limitPrice: '100',
        executionPrice: '100.01',
      }),
    ).toEqual({
      ok: false,
      errorCode: 'ORDER_LIMIT_NOT_MARKETABLE',
    });
  });

  it('validates limit sell execution price marketability', () => {
    expect(
      validateLimitOrderExecutionPrice({
        side: 'sell',
        limitPrice: '100',
        executionPrice: '100',
      }),
    ).toEqual({
      ok: true,
    });
    expect(
      validateLimitOrderExecutionPrice({
        side: 'sell',
        limitPrice: '100',
        executionPrice: '99.99',
      }),
    ).toEqual({
      ok: false,
      errorCode: 'ORDER_LIMIT_NOT_MARKETABLE',
    });
  });

  it('validates quote expiry inclusively at expiresAt', () => {
    const expiresAt = new Date('2026-06-05T00:00:10.000Z');

    expect(
      validateQuoteExpiry({
        now: expiresAt,
        expiresAt,
      }),
    ).toEqual({
      ok: true,
    });
    expect(
      validateQuoteExpiry({
        now: new Date('2026-06-05T00:00:10.001Z'),
        expiresAt,
      }),
    ).toEqual({
      ok: false,
      errorCode: 'QUOTE_EXPIRED',
    });
  });

  it('resolves default max change bps and execute freshness thresholds', () => {
    expect(
      resolveDefaultMaxChangeBps({
        quoteType: 'order',
        assetType: AssetType.domestic_stock,
        market: 'KRX',
      }),
    ).toBe(30);
    expect(
      resolveExecuteFreshnessThresholdSeconds({
        quoteType: 'order',
        assetType: AssetType.domestic_stock,
        market: 'KRX',
      }),
    ).toBe(10);

    expect(
      resolveDefaultMaxChangeBps({
        quoteType: 'order',
        assetType: AssetType.us_stock,
        market: 'NYS',
      }),
    ).toBe(30);
    expect(
      resolveExecuteFreshnessThresholdSeconds({
        quoteType: 'order',
        assetType: AssetType.us_stock,
        market: 'NYS',
      }),
    ).toBe(10);

    expect(
      resolveDefaultMaxChangeBps({
        quoteType: 'order',
        assetType: AssetType.crypto,
        market: 'BINANCE',
      }),
    ).toBe(30);
    expect(
      resolveExecuteFreshnessThresholdSeconds({
        quoteType: 'order',
        assetType: AssetType.crypto,
        market: 'BINANCE',
      }),
    ).toBe(10);

    expect(
      resolveDefaultMaxChangeBps({
        quoteType: 'fx',
        baseCurrency: 'USD',
        quoteCurrency: 'KRW',
      }),
    ).toBe(30);
    expect(
      resolveExecuteFreshnessThresholdSeconds({
        quoteType: 'fx',
        baseCurrency: 'USD',
        quoteCurrency: 'KRW',
      }),
    ).toBe(60);
  });

  it('requires provider_api as the future execute source and rejects admin_manual fallback', () => {
    expect(
      validateExecutionProviderSource({
        sourceType: 'provider_api',
      }),
    ).toEqual({
      ok: true,
    });
    expect(
      validateExecutionProviderSource({
        sourceType: 'admin_manual',
      }),
    ).toEqual({
      ok: false,
      errorCode: 'EXECUTION_PROVIDER_REQUIRED',
    });
  });
});
