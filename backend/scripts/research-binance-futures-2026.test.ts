import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregate,
  basicEligible,
  underlyingExclusion,
  START,
  END,
} from './research-binance-futures-2026';

const DAY = 86400000;
void test('existing plain-crypto policy rejects representations and unverified metadata', () => {
  assert.equal(
    underlyingExclusion('NEW', { assetCode: 'NEW', tags: ['Layer 1'] }),
    null,
  );
  assert.equal(
    underlyingExclusion('USDC', { assetCode: 'USDC', tags: ['stablecoin'] }),
    'stablecoin',
  );
  assert.equal(
    underlyingExclusion('USTC', { assetCode: 'USTC' }),
    'stablecoin',
  );
  assert.equal(
    underlyingExclusion('PAXG', { assetCode: 'PAXG', tags: ['tCommodities'] }),
    'commodity_pegged_representation',
  );
  assert.equal(
    underlyingExclusion('WBTC', { assetCode: 'WBTC' }),
    'wrapped_or_staked_representation',
  );
  assert.equal(underlyingExclusion('NEW'), 'asset_metadata_missing');
});
const contract = {
  symbol: 'BTCUSDT',
  pair: 'BTCUSDT',
  baseAsset: 'BTC',
  contractType: 'PERPETUAL',
  status: 'TRADING',
  quoteAsset: 'USDT',
  marginAsset: 'USDT',
  underlyingType: 'COIN',
  onboardDate: START - DAY,
};
const candle = (t: number, quote: string) => [
  t,
  '1',
  '2',
  '1',
  '2',
  '999999',
  t + DAY - 1,
  quote,
  1,
  '0',
  '0',
  '0',
];
const period = (start = START, quote = '0.1') =>
  Array.from({ length: (END - start) / DAY }, (_, i) =>
    candle(start + DAY * i, quote),
  );

void test('fixed window contains exactly 282 completed UTC days and sums index 7', () => {
  const result = aggregate(contract, period());
  assert.equal(result.dailyBars, 282);
  assert.equal(result.quoteVolumeUsdt, '28.2');
  assert.equal(result.complete, true);
  assert.equal(result.lastOpenTime, '2026-10-09T00:00:00.000Z');
  assert.equal(result.decimalIntegerCrossCheck, true);
});

void test('late listing includes its first trading day and never annualizes', () => {
  const start = END - 2 * DAY;
  const result = aggregate(
    { ...contract, onboardDate: start + 3600000 },
    period(start),
  );
  assert.equal(result.quoteVolumeUsdt, '0.2');
  assert.equal(result.expectedDays, 2);
  assert.equal(result.preListingDays, 280);
  assert.equal(result.complete, true);
});

void test('missing first, interior or final listed day makes the aggregate incomplete', () => {
  for (const index of [0, 100, 281]) {
    const rows = period();
    rows.splice(index, 1);
    const result = aggregate(contract, rows);
    assert.equal(result.complete, false);
    assert.equal(result.missingDays.length, 1);
  }
  assert.equal(aggregate(contract, []).complete, false);
});

void test('identical duplicates are counted once; conflicting duplicates fail', () => {
  const rows = period();
  assert.equal(aggregate(contract, [...rows, rows[0]]).quoteVolumeUsdt, '28.2');
  assert.equal(aggregate(contract, [...rows, rows[0]]).duplicateDays, 1);
  assert.throws(
    () => aggregate(contract, [...rows, candle(START, '9')]),
    /CONFLICTING_DUPLICATE_DAY/,
  );
});

void test('unfinished, misaligned and out-of-window daily rows fail', () => {
  for (const rows of [
    [candle(END, '1')],
    [candle(START + 1, '1')],
    [candle(START - DAY, '1')],
  ]) {
    assert.throws(
      () => aggregate(contract, rows),
      /INVALID_OR_INCOMPLETE_UTC_DAY/,
    );
  }
  const row = candle(START, '1');
  row[6] = END;
  assert.throws(
    () => aggregate(contract, [row]),
    /INVALID_OR_INCOMPLETE_UTC_DAY/,
  );
});

void test('Decimal retains tiny quote amounts and BigInt cross-check detects rounding', () => {
  const start = END - 2 * DAY;
  const result = aggregate({ ...contract, onboardDate: start }, [
    candle(start, '999999999999999999999999.99999999'),
    candle(start + DAY, '0.00000001'),
  ]);
  assert.equal(result.quoteVolumeUsdt, '1000000000000000000000000.00000000');
  assert.throws(
    () =>
      aggregate({ ...contract, onboardDate: start }, [
        candle(start, '9'.repeat(100)),
        candle(start + DAY, '0.1'),
      ]),
    /DECIMAL_PRECISION_MISMATCH/,
  );
});

void test('reset onboardDate does not discard genuine historical volume', () => {
  const result = aggregate({ ...contract, onboardDate: END - DAY }, period());
  assert.equal(result.complete, true);
  assert.equal(result.historicalRowsBeforeOnboardDate, 281);
  assert.equal(result.dailyBars, 282);
});

void test('invalid volume and invalid listing date are rejected', () => {
  for (const volume of ['NaN', '-1', 'Infinity', '1e10'])
    assert.throws(
      () => aggregate(contract, [candle(START, volume)]),
      /INVALID_QUOTE_VOLUME/,
    );
  assert.throws(
    () => aggregate({ ...contract, onboardDate: NaN }, []),
    /INVALID_ONBOARD_DATE/,
  );
});

void test('current USDT perpetual base filter has no app-universe restriction', () => {
  assert.equal(
    basicEligible({ ...contract, symbol: 'NEWUSDT', baseAsset: 'NEW' }),
    true,
  );
  for (const override of [
    { status: 'SETTLING' },
    { contractType: 'CURRENT_QUARTER' },
    { quoteAsset: 'USDC' },
    { marginAsset: 'BTC' },
  ])
    assert.equal(basicEligible({ ...contract, ...override }), false);
});
