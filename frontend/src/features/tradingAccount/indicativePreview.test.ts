import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectDisplayPrice } from '../asset/displayPricePolicy.ts';
import {
  amountSellPreview,
  estimatedAmountForQuantity,
  formatPreviewMoney,
  fxPreview,
  indicativeQuantityForAmount,
  isPositiveInput,
  isPreviewFxAvailable,
  isPreviewPriceAvailable,
  orderPreview,
  sellQuantityAtRatio,
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

test('sell preview subtracts the same decimal fee from proceeds without changing buy estimates', () => {
  const input = {quantity:'1.234567',price:'100.12',feeRate:'0.001'};
  const buy=orderPreview(input)!,sell=orderPreview({...input,side:'sell'})!;
  assert.equal(sell.grossAmount,buy.grossAmount);
  assert.equal(sell.feeAmount,buy.feeAmount);
  assert.equal(sell.totalAmount,'123.48124319');
  assert.equal(buy.totalAmount,'123.72845289');
});

test('crypto SELL by amount: the amount is pre-fee proceeds, the fee comes out of them (2026-11-10)', () => {
  assert.deepEqual(amountSellPreview('123.45', '0.001'), {
    grossAmount: '123.45000000',
    feeAmount: '0.12345000',
    totalAmount: '123.32655000',
  });
  // Same rounding chain as the server quote for the quantity it derives.
  assert.equal(indicativeQuantityForAmount('123.45', '100'), '1.234500');
  assert.equal(indicativeQuantityForAmount('250', '97123.45'), '0.002574');
  assert.equal(indicativeQuantityForAmount('0.00001', '100'), '0.000000', 'too small to sell a unit: zero, never rounded up');
  for (const bad of ['', '0', '-1', '1.123456789', 'abc'])
    assert.equal(amountSellPreview(bad, '0.001') === null, true, bad);
  assert.equal(amountSellPreview('10', null) === null, true, 'no fee policy, no preview');
});

test('a SELL ratio is that share of the sellable quantity, exact at 100% (no float flooring)', () => {
  // 0.767497 × 1e6 is not an integer in binary floating point; decimals keep it.
  assert.equal(sellQuantityAtRatio('0.767497', 1), '0.767497');
  assert.equal(sellQuantityAtRatio('2.767497', 1), '2.767497');
  assert.equal(sellQuantityAtRatio('2.767497', 0.25), '0.691874');
  assert.equal(sellQuantityAtRatio('2.767497', 0.5), '1.383748');
  assert.equal(sellQuantityAtRatio('0.000001', 0.25) === null, true, 'nothing below one unit');
  assert.equal(sellQuantityAtRatio('4', 0.25), '1', 'canonical, no trailing zeros');
  assert.equal(sellQuantityAtRatio('0.000007', 0.5), '0.000003');
  assert.equal(sellQuantityAtRatio('4', 0.37), '1.48');
  for (const bad of [null, '', '0', '-1'])
    assert.equal(sellQuantityAtRatio(bad, 1) === null, true, String(bad));
  assert.equal(sellQuantityAtRatio('1', 0) === null, true);
  assert.equal(sellQuantityAtRatio('1', 1.5) === null, true);
  // The amount field shows the estimate in cents, never rounded up.
  assert.equal(estimatedAmountForQuantity('0.767497', '100.2'), '76.90');
  assert.equal(estimatedAmountForQuantity('0.000001', '100') === null, true, 'under a cent');
  assert.equal(estimatedAmountForQuantity('1', null) === null, true);
});
