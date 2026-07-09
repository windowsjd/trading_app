import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatCurrency,
  formatKrw,
  formatMoney,
  formatPercent,
  formatUsd,
  getAssetNameDisplay,
  normalizeCurrencyCode,
} from './format.ts';

test('formatKrw', async (t) => {
  await t.test('null / undefined / "" render as "-"', () => {
    assert.equal(formatKrw(null), '-');
    assert.equal(formatKrw(undefined), '-');
    assert.equal(formatKrw(''), '-');
    assert.equal(formatKrw('not-a-number'), '-');
  });

  await t.test('rounds to an integer and adds thousands separators', () => {
    assert.equal(formatKrw(1234.5678), '1,235');
    assert.equal(formatKrw('1234.4'), '1,234');
    assert.equal(formatKrw(1000000), '1,000,000');
  });

  await t.test('handles negative amounts', () => {
    assert.equal(formatKrw(-1234.5678), '-1,235');
    assert.equal(formatKrw(-999), '-999');
  });
});

test('formatUsd', async (t) => {
  await t.test('null / undefined / "" render as "-"', () => {
    assert.equal(formatUsd(null), '-');
    assert.equal(formatUsd(undefined), '-');
    assert.equal(formatUsd(''), '-');
  });

  await t.test('fixes to 2 decimals with thousands separators', () => {
    assert.equal(formatUsd(1234.5678), '1,234.57');
    assert.equal(formatUsd(1000000), '1,000,000.00');
    assert.equal(formatUsd('0.1'), '0.10');
  });

  await t.test('handles negative amounts', () => {
    assert.equal(formatUsd(-1234.5678), '-1,234.57');
  });
});

test('normalizeCurrencyCode', () => {
  assert.equal(normalizeCurrencyCode('usd'), 'USD');
  assert.equal(normalizeCurrencyCode('USD '), 'USD');
  assert.equal(normalizeCurrencyCode('Usd'), 'USD');
  assert.equal(normalizeCurrencyCode('krw'), 'KRW');
  assert.equal(normalizeCurrencyCode(' KRW '), 'KRW');
  assert.equal(normalizeCurrencyCode('Krw'), 'KRW');
  assert.equal(normalizeCurrencyCode('EUR'), null);
  assert.equal(normalizeCurrencyCode(null), null);
  assert.equal(normalizeCurrencyCode(undefined), null);
});

test('formatCurrency (bare magnitude, currency shown separately)', async (t) => {
  await t.test('null / undefined / "" render as "-"', () => {
    assert.equal(formatCurrency(null, 'KRW'), '-');
    assert.equal(formatCurrency(undefined, 'USD'), '-');
    assert.equal(formatCurrency('', 'KRW'), '-');
  });

  await t.test('KRW renders as a bare integer', () => {
    assert.equal(formatCurrency(1234.5678, 'KRW'), '1,235');
    assert.equal(formatCurrency(1000000, 'KRW'), '1,000,000');
  });

  await t.test('USD renders as a bare 2-decimal number', () => {
    assert.equal(formatCurrency(1234.5678, 'USD'), '1,234.57');
    assert.equal(formatCurrency(1000000, 'USD'), '1,000,000.00');
  });

  await t.test('negative amounts keep their sign', () => {
    assert.equal(formatCurrency(-1234.5678, 'KRW'), '-1,235');
    assert.equal(formatCurrency(-1234.5678, 'USD'), '-1,234.57');
  });

  await t.test('lower-case / padded currency codes are normalized', () => {
    assert.equal(formatCurrency(1234.5678, 'usd'), '1,234.57');
    assert.equal(formatCurrency(1234.5678, 'USD '), '1,234.57');
    assert.equal(formatCurrency(1234.5678, 'krw'), '1,235');
    assert.equal(formatCurrency(1234.5678, 'KRW '), '1,235');
  });

  await t.test('unknown currency falls back to a plain 2-decimal number', () => {
    // No decoration and never silently treated as KRW.
    assert.equal(formatCurrency(1234.5678, 'EUR'), '1,234.57');
    assert.equal(formatCurrency(1234.5678, null), '1,234.57');
    assert.equal(formatCurrency(1234.5678, undefined), '1,234.57');
  });
});

test('formatMoney (unit-carrying display)', async (t) => {
  await t.test('null / undefined / "" render as "-"', () => {
    assert.equal(formatMoney(null, 'KRW'), '-');
    assert.equal(formatMoney(undefined, 'USD'), '-');
    assert.equal(formatMoney('', 'KRW'), '-');
  });

  await t.test('KRW renders as an integer with the 원 unit', () => {
    assert.equal(formatMoney(1234.5678, 'KRW'), '1,235원');
    assert.equal(formatMoney(1000000, 'KRW'), '1,000,000원');
  });

  await t.test('USD renders with a $ prefix and 2 decimals', () => {
    assert.equal(formatMoney(1234.5678, 'USD'), '$1,234.57');
    assert.equal(formatMoney(1000000, 'USD'), '$1,000,000.00');
  });

  await t.test('negative amounts keep their sign', () => {
    assert.equal(formatMoney(-1234.5678, 'KRW'), '-1,235원');
    assert.equal(formatMoney(-1234.5678, 'USD'), '$-1,234.57');
  });

  await t.test('lower-case / padded currency codes are normalized', () => {
    assert.equal(formatMoney(1234.5678, 'usd'), '$1,234.57');
    assert.equal(formatMoney(1234.5678, 'USD '), '$1,234.57');
    assert.equal(formatMoney(1234.5678, 'krw'), '1,235원');
    assert.equal(formatMoney(1234.5678, 'KRW '), '1,235원');
  });

  await t.test('unknown currency falls back to a plain 2-decimal number', () => {
    assert.equal(formatMoney(1234.5678, 'EUR'), '1,234.57');
    assert.equal(formatMoney(1234.5678, null), '1,234.57');
    assert.equal(formatMoney(1234.5678, undefined), '1,234.57');
  });
});

test('formatPercent', async (t) => {
  await t.test('null / undefined / "" render as "-"', () => {
    assert.equal(formatPercent(null), '-');
    assert.equal(formatPercent(undefined), '-');
    assert.equal(formatPercent(''), '-');
  });

  await t.test('fixes to the requested number of decimals', () => {
    assert.equal(formatPercent(12.3456), '12.35');
    assert.equal(formatPercent(-1.5), '-1.50');
    assert.equal(formatPercent(12.3456, 1), '12.3');
  });
});

test('getAssetNameDisplay', async (t) => {
  await t.test('name primary, symbol secondary when both present', () => {
    assert.deepEqual(getAssetNameDisplay({ name: '삼성전자', symbol: '005930' }), {
      primary: '삼성전자',
      secondary: '005930',
    });
  });

  await t.test('falls back to symbol as primary when name is missing', () => {
    assert.deepEqual(getAssetNameDisplay({ name: null, symbol: 'AAPL' }), {
      primary: 'AAPL',
      secondary: null,
    });
    assert.deepEqual(getAssetNameDisplay({ symbol: 'BTCUSDT' }), {
      primary: 'BTCUSDT',
      secondary: null,
    });
  });

  await t.test('name-only keeps secondary null', () => {
    assert.deepEqual(getAssetNameDisplay({ name: 'Tesla', symbol: null }), {
      primary: 'Tesla',
      secondary: null,
    });
  });

  await t.test('identical name and symbol are not duplicated', () => {
    assert.deepEqual(getAssetNameDisplay({ name: 'AAPL', symbol: 'AAPL' }), {
      primary: 'AAPL',
      secondary: null,
    });
  });

  await t.test('empty asset renders as "-"', () => {
    assert.deepEqual(getAssetNameDisplay(null), { primary: '-', secondary: null });
    assert.deepEqual(getAssetNameDisplay({}), { primary: '-', secondary: null });
  });
});
