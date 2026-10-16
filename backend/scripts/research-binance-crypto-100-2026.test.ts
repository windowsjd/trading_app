import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAY,
  EXISTING_FUTURES,
  EXISTING_SPOT,
  START,
  aggregateDaily,
  futuresCandidate,
  rankByVolume,
  selectFinal,
  spotCandidate,
  spotPolicyExclusion,
} from './research-binance-crypto-100-2026';

const END = Date.parse('2026-10-16T00:00:00Z');
const window = { start: START, end: END };
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
const period = (from = START, quote = '0.1') =>
  Array.from({ length: (END - from) / DAY }, (_, i) =>
    candle(from + DAY * i, quote),
  );

void test('the window holds exactly 288 completed UTC days and sums kline[7]', () => {
  const result = aggregateDaily(period(), window);
  assert.equal(result.dailyBars, 288);
  assert.equal(result.quoteVolumeUsdt, '28.8');
  assert.equal(result.lastOpenTime, '2026-10-15T00:00:00.000Z');
  assert.equal(result.complete, true);
});

void test('Spot gaps after the first bar, and Futures gaps after listing, are incomplete', () => {
  const rows = period();
  rows.splice(100, 1);
  assert.equal(aggregateDaily(rows, window).complete, false);
  assert.equal(aggregateDaily(rows, window).missingDays.length, 1);
  // A late Spot listing counts only its real bars, never annualized.
  const late = aggregateDaily(period(END - 3 * DAY, '1.5'), window);
  assert.deepEqual(
    [late.dailyBars, late.quoteVolumeUsdt, late.complete],
    [3, '4.5', true],
  );
  // A Futures contract listed before its first bar has a hole.
  const listed = END - 5 * DAY;
  assert.equal(
    aggregateDaily(period(END - 3 * DAY), window, listed).complete,
    false,
  );
  assert.equal(
    aggregateDaily(period(listed), window, listed + 3_600_000).complete,
    true,
  );
});

void test('unfinished, misaligned, out-of-window and non-decimal rows fail; identical duplicates count once', () => {
  for (const rows of [
    [candle(END, '1')],
    [candle(START + 1, '1')],
    [candle(START - DAY, '1')],
  ])
    assert.throws(
      () => aggregateDaily(rows, window),
      /INVALID_OR_INCOMPLETE_UTC_DAY/,
    );
  for (const volume of ['NaN', '-1', '1e5', ''])
    assert.throws(
      () => aggregateDaily([candle(START, volume)], window),
      /INVALID_QUOTE_VOLUME/,
    );
  const rows = period();
  assert.equal(
    aggregateDaily([...rows, rows[0]], window).quoteVolumeUsdt,
    '28.8',
  );
  assert.throws(
    () => aggregateDaily([...rows, candle(START, '9')], window),
    /CONFLICTING_DUPLICATE_DAY/,
  );
});

void test('Decimal keeps tiny and huge quote volumes exactly', () => {
  const from = END - 2 * DAY;
  const result = aggregateDaily(
    [
      candle(from, '999999999999999999999999.99999999'),
      candle(from + DAY, '0.00000001'),
    ],
    window,
  );
  assert.equal(result.quoteVolumeUsdt, '1000000000000000000000000.00000000');
});

void test('ranking is exact descending volume with symbol code-point ties', () => {
  const ranked = rankByVolume([
    { symbol: 'BBBUSDT', quoteVolumeUsdt: '10.00000001' },
    { symbol: 'ZZZUSDT', quoteVolumeUsdt: '10.00000002' },
    { symbol: 'AAAUSDT', quoteVolumeUsdt: '10.00000001' },
  ]);
  assert.deepEqual(
    ranked.map((row) => row.symbol),
    ['ZZZUSDT', 'AAAUSDT', 'BBBUSDT'],
  );
});

void test('existing entries stay first and in order; new picks skip them and fill to 100', () => {
  const eligible = Array.from({ length: 120 }, (_, i) => ({
    symbol: i < 5 ? EXISTING_SPOT[i] : `NEW${i}USDT`,
  }));
  const { added, final } = selectFinal(EXISTING_SPOT, eligible);
  assert.equal(final.length, 100);
  assert.deepEqual(final.slice(0, 25), [...EXISTING_SPOT]);
  assert.equal(added.length, 75);
  assert.equal(added[0].symbol, 'NEW5USDT');
  assert.equal(new Set(final).size, 100);
  assert.throws(
    () => selectFinal(EXISTING_FUTURES, eligible.slice(0, 50)),
    /INSUFFICIENT_ELIGIBLE_CANDIDATES/,
  );
});

void test('candidate filters and the plain-crypto Spot policy', () => {
  const spot = {
    symbol: 'NEWUSDT',
    baseAsset: 'NEW',
    quoteAsset: 'USDT',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00010000' }],
  };
  assert.equal(spotCandidate(spot), true);
  assert.equal(spotCandidate({ ...spot, status: 'BREAK' }), false);
  assert.equal(spotCandidate({ ...spot, quoteAsset: 'USDC' }), false);
  const meta = { assetCode: 'NEW', tags: ['Layer1_Layer2'] };
  assert.equal(spotPolicyExclusion(spot, meta), null);
  assert.equal(
    spotPolicyExclusion(spot, { ...meta, tags: ['stablecoin'] }),
    'stablecoin',
  );
  assert.equal(
    spotPolicyExclusion(spot, { ...meta, tags: ['bStocks'] }),
    'tokenized_stock_or_etf',
  );
  assert.equal(spotPolicyExclusion(spot, undefined), 'asset_metadata_missing');
  assert.equal(
    spotPolicyExclusion({ ...spot, symbol: 'NEW-USDT' }, meta),
    'symbol_identity_mismatch',
  );
  assert.equal(
    spotPolicyExclusion(
      {
        ...spot,
        filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.000000001' }],
      },
      meta,
    ),
    'price_precision_unsupported',
  );
  const contract = {
    symbol: 'NEWUSDT',
    pair: 'NEWUSDT',
    baseAsset: 'NEW',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    underlyingType: 'COIN',
    onboardDate: START,
  };
  assert.equal(futuresCandidate(contract), true);
  assert.equal(futuresCandidate({ ...contract, marginAsset: 'BNFCR' }), false);
  assert.equal(
    futuresCandidate({ ...contract, contractType: 'CURRENT_QUARTER' }),
    false,
  );
});
