import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRICE_PREPARING_TEXT,
  formatAssetPrice,
  formatCurrency,
  formatKrw,
  formatMoney,
  getAssetPriceText,
} from './format.ts';

/**
 * Asset UNIT price display vs money display.
 *
 * `formatAssetPrice` honors the provider's tick-size decimals so a 0.24560 coin
 * is not shown as $0.25; wallet balances / order totals keep going through
 * `formatMoney`/`formatCurrency` with their unchanged 2-decimal USD policy.
 */
describe('formatAssetPrice', () => {
  it('uses the declared decimals for Binance USD prices', () => {
    // BTCUSDT tickSize 0.01 → 2
    assert.equal(formatAssetPrice('106234.56000000', 'USD', 2), '$106,234.56');
    // LINKUSDT tickSize 0.001 → 3
    assert.equal(formatAssetPrice('21.85000000', 'USD', 3), '$21.850');
    // XRPUSDT / TRXUSDT / XLMUSDT tickSize 0.0001 → 4
    assert.equal(formatAssetPrice('2.14570000', 'USD', 4), '$2.1457');
    assert.equal(formatAssetPrice('0.28950000', 'USD', 4), '$0.2895');
    // DOGEUSDT tickSize 0.00001 → 5
    assert.equal(formatAssetPrice('0.24560000', 'USD', 5), '$0.24560');
  });

  it('does not truncate low-priced coins to two decimals', () => {
    assert.notEqual(formatAssetPrice('0.24560000', 'USD', 5), '$0.25');
    assert.notEqual(formatAssetPrice('0.28950000', 'USD', 4), '$0.29');
    assert.equal(formatMoney('0.24560000', 'USD'), '$0.25');
  });

  it('keeps trailing zeros so the column matches the exchange display', () => {
    assert.equal(formatAssetPrice('0.20000000', 'USD', 5), '$0.20000');
    assert.equal(formatAssetPrice('3', 'USD', 3), '$3.000');
  });

  it('keeps thousands separators', () => {
    assert.equal(formatAssetPrice('1234567.80000000', 'USD', 2), '$1,234,567.80');
  });

  it('rounds half-up on the decimal string, without float drift', () => {
    assert.equal(formatAssetPrice('0.245655', 'USD', 5), '$0.24566');
    assert.equal(formatAssetPrice('0.999999', 'USD', 5), '$1.00000');
    assert.equal(formatAssetPrice('9.9999', 'USD', 2), '$10.00');
    // 1.005 is 1.00499999... in binary; the string path still rounds up.
    assert.equal(formatAssetPrice('1.005', 'USD', 2), '$1.01');
  });

  it('never shows exponent notation', () => {
    assert.ok(!formatAssetPrice('0.00000012', 'USD', 8).includes('e'));
    assert.equal(formatAssetPrice(0.00000012, 'USD', 8), '$0.00000012');
  });

  it('falls back to the 2-decimal policy without declared decimals', () => {
    assert.equal(formatAssetPrice('0.24560000', 'USD', null), '$0.25');
    assert.equal(formatAssetPrice('0.24560000', 'USD', undefined), '$0.25');
    assert.equal(formatAssetPrice('0.24560000', 'USD', -1), '$0.25');
    assert.equal(formatAssetPrice('0.24560000', 'USD', 1.5), '$0.25');
  });

  it('keeps KRW asset prices in 원 units even if decimals are sent', () => {
    assert.equal(formatAssetPrice('70123.00000000', 'KRW', 5), '70,123원');
    assert.equal(formatAssetPrice('70123.60000000', 'KRW', null), '70,124원');
  });

  it('renders missing/invalid values as the shared placeholder', () => {
    assert.equal(formatAssetPrice(null, 'USD', 5), '-');
    assert.equal(formatAssetPrice(undefined, 'USD', 5), '-');
    assert.equal(formatAssetPrice('', 'USD', 5), '-');
    assert.equal(formatAssetPrice('not-a-number', 'USD', 5), '-');
  });

  it('handles negative values', () => {
    assert.equal(formatAssetPrice('-1.23456', 'USD', 4), '$-1.2346');
  });
});

describe('money display is unchanged', () => {
  it('keeps wallet/total USD amounts at 2 decimals', () => {
    assert.equal(formatMoney('1234.5', 'USD'), '$1,234.50');
    assert.equal(formatCurrency('1234.567', 'USD'), '1,234.57');
  });

  it('keeps KRW amounts as whole 원', () => {
    assert.equal(formatKrw('1234.6'), '1,235');
    assert.equal(formatMoney('1234.6', 'KRW'), '1,235원');
  });
});

describe('getAssetPriceText', () => {
  const dogeRow = {
    assetType: 'crypto',
    marketStatus: 'always_open',
    displayPriceDecimals: 5,
    price: {
      state: 'available',
      currentPrice: '0.24560000',
      priceCurrency: 'USD',
    },
  } as const;

  it('formats a list row with the asset precision', () => {
    assert.equal(getAssetPriceText(dogeRow), '$0.24560');
  });

  it('produces the same string the detail screen shows', () => {
    assert.equal(
      getAssetPriceText(dogeRow),
      formatAssetPrice('0.24560000', 'USD', 5),
    );
  });

  it('still shows the placeholder when no price is available', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'crypto',
        marketStatus: 'always_open',
        displayPriceDecimals: 5,
        price: { state: 'unavailable', currentPrice: null },
      }),
      PRICE_PREPARING_TEXT,
    );
  });

  it('keeps the previous formatting for assets without declared decimals', () => {
    assert.equal(
      getAssetPriceText({
        assetType: 'us_stock',
        marketStatus: 'open',
        price: {
          state: 'available',
          currentPrice: '190.12500000',
          priceCurrency: 'USD',
        },
      }),
      '$190.13',
    );
  });
});
