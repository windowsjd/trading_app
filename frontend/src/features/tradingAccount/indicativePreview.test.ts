import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectDisplayPrice } from '../asset/displayPricePolicy.ts';
import {
  formatPreviewMoney,
  fxPreview,
  isPositiveInput,
  isPreviewFxAvailable,
  isPreviewPriceAvailable,
  orderPreview,
} from './indicativePreview.ts';
import type { FxRateDto } from '../wallet/api';

const now = Date.parse('2026-09-12T01:00:00Z');
const rate: FxRateDto = {
  state: 'available',
  baseCurrency: 'USD',
  quoteCurrency: 'KRW',
  rate: '1387.20',
  validUntil: new Date(now + 60_000).toISOString(),
  sourceType: 'provider_api',
  sourceName: 'exchange_rate',
};

test('long preview amounts retain significant digits when formatted', () => {
  assert.equal(
    formatPreviewMoney('25439999999977700.49', 'KRW'),
    '25,439,999,999,977,700원',
  );
  assert.equal(
    formatPreviewMoney('1234567890123456.78', 'USD'),
    '$1,234,567,890,123,456.78',
  );
});

test('empty, zero, negative, non-decimal and overprecision inputs never produce normal previews', () => {
  for (const quantity of [
    '',
    ' ',
    '0',
    '-1',
    'NaN',
    'Infinity',
    '1e3',
    '0x10',
    '1,000',
    '1.1234567',
  ]) {
    assert.equal(
      orderPreview({ quantity, price: '25430', feeRate: '0.001' }),
      null,
      quantity,
    );
  }
  for (const amount of [
    '',
    '0',
    '-1',
    'Infinity',
    '1e2',
    '0x10',
    '1.123456789',
  ]) {
    assert.equal(
      fxPreview({ amount, fromCurrency: 'KRW', rate, feeRate: '0.001', now }),
      null,
      amount,
    );
  }
  assert.equal(isPositiveInput('.5', 6), true);
  assert.equal(isPositiveInput('1'.repeat(101), 8), false);
});

test('quantity and ticker updates recalculate every buy amount without changing input', () => {
  const quantity = '10';
  assert.deepEqual(
    orderPreview({ quantity, price: '25430', feeRate: '0.001' }),
    {
      price: '25430',
      grossAmount: '254300.00000000',
      feeAmount: '254.30000000',
      totalAmount: '254554.30000000',
    },
  );
  assert.equal(
    orderPreview({ quantity, price: '25440', feeRate: '0.001' })?.totalAmount,
    '254654.40000000',
  );
  assert.equal(
    orderPreview({ quantity, price: '25420', feeRate: '0.001' })?.feeAmount,
    '254.20000000',
  );
  assert.equal(
    orderPreview({ quantity: '2', price: '25420', feeRate: '0.001' })
      ?.grossAmount,
    '50840.00000000',
  );
  assert.equal(quantity, '10');
});

test('market/limit amounts use the server round8 gross → fee → total chain, including crypto half-up', () => {
  assert.deepEqual(
    orderPreview({ quantity: '0.5', price: '0.00000001', feeRate: '0.5' }),
    {
      price: '0.00000001',
      grossAmount: '0.00000001',
      feeAmount: '0.00000001',
      totalAmount: '0.00000002',
    },
  );
  // A limit input is the basis regardless of any available realtime price.
  assert.equal(
    orderPreview({ quantity: '3', price: '50000', feeRate: '0.001' })
      ?.totalAmount,
    '150150.00000000',
  );
  for (const feeRate of [undefined, '', 'NaN', '-0.001', '1.1']) {
    assert.equal(orderPreview({ quantity: '10', price: '1', feeRate }), null);
  }
  assert.equal(
    orderPreview({ quantity: '10', price: '1', feeRate: '0' })?.feeAmount,
    '0.00000000',
  );
  assert.equal(
    orderPreview({ quantity: '10', price: '1', feeRate: '0.003' })?.feeAmount,
    '0.03000000',
  );
});

test('existing REST baseline is dated and labelled, stale/unavailable tickers never resurrect REST', () => {
  const restPrice = {
    state: 'available',
    currentPrice: '100',
    priceCapturedAt: new Date(now - 1000).toISOString(),
  };
  const baseline = selectDisplayPrice({ restPrice });
  assert.equal(baseline.basis, 'rest');
  assert.equal(isPreviewPriceAvailable(baseline, now), true);
  assert.equal(isPreviewPriceAvailable(baseline, now + 60_000), false);
  assert.equal(
    isPreviewPriceAvailable(
      selectDisplayPrice({
        restPrice: { ...restPrice, priceCapturedAt: null },
      }),
      now,
    ),
    false,
  );
  const latestTicker = {
    type: 'asset_ticker' as const,
    assetId: 'asset',
    priceLocal: '200',
    priceKrw: null,
    priceCapturedAt: new Date(now).toISOString(),
  };
  const live = selectDisplayPrice({ latestTicker, restPrice });
  assert.equal(live.priceLocal, '200');
  assert.equal(isPreviewPriceAvailable(live, now), true);
  assert.equal(isPreviewPriceAvailable(live, now + 60_001), false);
  assert.equal(
    isPreviewPriceAvailable(
      selectDisplayPrice({
        latestTicker: { ...latestTicker, priceLocal: null },
        restPrice,
      }),
      now,
    ),
    false,
  );
});

test('FX uses actual USD/KRW snapshot changes and deducts fees in the receiving currency', () => {
  const input = {
    amount: '1000000',
    fromCurrency: 'KRW' as const,
    feeRate: '0.001',
    now,
  };
  const first = fxPreview({ ...input, rate });
  assert.deepEqual(first, {
    grossTargetAmount: '720.87658593',
    feeAmount: '0.72087659',
    netTargetAmount: '720.15570934',
    feeCurrency: 'USD',
  });
  assert.equal(
    fxPreview({
      ...input,
      rate: { ...rate, rate: '1400', sourceName: 'korea_exim_exchange_rate' },
    })?.netTargetAmount,
    '713.57142857',
  );
  assert.deepEqual(
    fxPreview({ ...input, amount: '100', fromCurrency: 'USD', rate }),
    {
      grossTargetAmount: '138720.00000000',
      feeAmount: '138.72000000',
      netTargetAmount: '138581.28000000',
      feeCurrency: 'KRW',
    },
  );
  // FX must not round gross before multiplying fee, unlike an order.
  assert.equal(
    fxPreview({
      ...input,
      amount: '0.00000001',
      rate: { ...rate, rate: '3' },
      feeRate: '0.5',
    })?.feeAmount,
    '0.00000000',
  );
});

test('FX respects server display validity, unknown validity, unavailable data and currency direction', () => {
  assert.equal(isPreviewFxAvailable(rate, now + 60_000), true);
  assert.equal(isPreviewFxAvailable(rate, now + 60_001), false);
  for (const invalid of [
    undefined,
    { ...rate, state: 'unavailable' },
    { ...rate, validUntil: undefined },
    { ...rate, rate: '0' },
    { ...rate, baseCurrency: 'KRW' },
  ]) {
    assert.equal(
      fxPreview({
        amount: '100',
        fromCurrency: 'KRW',
        feeRate: '0.001',
        now,
        rate: invalid as FxRateDto,
      }),
      null,
    );
  }
});
