import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASSET_CHART_TIMEFRAMES,
  DEFAULT_ASSET_CHART_TIMEFRAME,
  LONG_RANGE_FOUR_HOUR_TIMEFRAME,
  resolveAssetChartTimeframe,
} from './chartTimeframes.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const BINANCE_KLINE_MAX_LIMIT = 1000;

const INTERVAL_MINUTES: Record<string, number> = {
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
};

// Worst-case window length per range (crypto trades 24/7): prev_open ≈ 2 days,
// prev2_open ≈ 3 days, 3d = 3 days, 14d = 14 days, 30d = 30 days,
// 1y = 366 days.
const RANGE_WORST_CASE_DAYS: Record<string, number> = {
  prev_open: 2,
  prev2_open: 3,
  '3d': 3,
  '14d': 14,
  '30d': 30,
  '1y': 366,
};

// The backend aggregates 15m/30m/1h/4h from the stored 5m feed, which is kept
// for 45 days. No aggregated tab may ask for more than that.
const FIVE_MINUTE_RETENTION_DAYS = 45;
const AGGREGATED_INTERVALS = new Set(['15m', '30m', '1h', '4h']);

test('1m tab is not offered', () => {
  assert.ok(
    ASSET_CHART_TIMEFRAMES.every(
      (tab) => tab.interval !== ('1m' as string) && tab.label !== ('1m' as string),
    ),
    'no timeframe may expose 1m',
  );
});

test('expected tab order and count (no 1w tab, design v2.1 §5.5)', () => {
  assert.deepEqual(
    ASSET_CHART_TIMEFRAMES.map((tab) => tab.label),
    ['5m', '15m', '30m', '1h', '4h', '1d'],
  );
});

test('range and limit policy matches the backend candle windows', () => {
  assert.deepEqual(
    ASSET_CHART_TIMEFRAMES.map(({ interval, range, limit }) => ({
      interval,
      range,
      limit,
    })),
    [
      { interval: '5m', range: 'prev_open', limit: 600 },
      { interval: '15m', range: '3d', limit: 288 },
      { interval: '30m', range: '14d', limit: 672 },
      { interval: '1h', range: '14d', limit: 336 },
      { interval: '4h', range: '30d', limit: 200 },
      { interval: '1d', range: '1y', limit: 400 },
    ],
  );
});

test('default timeframe is 5m', () => {
  assert.equal(DEFAULT_ASSET_CHART_TIMEFRAME.interval, '5m');
});

test('limits cover the worst-case candle count without exceeding Binance cap', () => {
  for (const tab of ASSET_CHART_TIMEFRAMES) {
    const days = RANGE_WORST_CASE_DAYS[tab.range];
    assert.ok(days !== undefined, `unknown range ${tab.range} for ${tab.label}`);

    const expected = Math.ceil((days * 1440) / INTERVAL_MINUTES[tab.interval]);
    assert.ok(
      tab.limit >= expected,
      `${tab.label}: limit ${tab.limit} must cover expected ${expected} candles`,
    );
    assert.ok(
      tab.limit <= BINANCE_KLINE_MAX_LIMIT,
      `${tab.label}: limit ${tab.limit} exceeds Binance cap`,
    );
  }
});

test('5m request is not capped near the old 100 limit', () => {
  const fiveMinute = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '5m');
  assert.ok(fiveMinute && fiveMinute.limit > 100);
});

test('daily limit is fixed for 1y chart requests', () => {
  const daily = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '1d');
  assert.equal(daily?.limit, 400);
});

test('30m and 1h show the last 14 days at the crypto upper-bound limit', () => {
  const halfHour = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '30m');
  const hourly = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '1h');

  // 14 days x 48 half-hour candles, 14 days x 24 hourly candles. Stocks return
  // fewer (regular session only) — that is expected, not a truncation.
  assert.deepEqual(
    { range: halfHour?.range, limit: halfHour?.limit },
    { range: '14d', limit: 672 },
  );
  assert.deepEqual(
    { range: hourly?.range, limit: hourly?.limit },
    { range: '14d', limit: 336 },
  );
});

test('15m shows the last 3 days from the request clock', () => {
  const fifteen = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '15m');
  // 3 days x 96 fifteen-minute candles is the crypto upper bound; stocks
  // return fewer (regular session only), which is expected, not truncation.
  assert.deepEqual(
    { range: fifteen?.range, limit: fifteen?.limit },
    { range: '3d', limit: 288 },
  );
});

test('KRX stocks, US stocks and crypto read the long-range 4h window', () => {
  const fourHour = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '4h');
  assert.ok(fourHour);
  for (const assetType of ['domestic_stock', 'us_stock', 'crypto']) {
    assert.deepEqual(resolveAssetChartTimeframe(fourHour, assetType), {
      label: '4h',
      interval: '4h',
      range: '96d',
      limit: 600,
    });
  }
  // Unknown asset type: every tab waits instead of fetching (and caching) a
  // wrong window.
  for (const tab of ASSET_CHART_TIMEFRAMES) {
    assert.equal(resolveAssetChartTimeframe(tab, undefined) === null, true);
  }
  // Every other tab of US stocks and crypto is the base list.
  for (const tab of ASSET_CHART_TIMEFRAMES.filter((t) => t.interval !== '4h')) {
    for (const assetType of ['us_stock', 'crypto']) {
      assert.equal(resolveAssetChartTimeframe(tab, assetType), tab);
    }
  }
});

// Design v2.1 §5.1: [sessions N, 5m-bucket count per KRX session for the
// interval, source max width in days from calc/krx_sessions.py].
const KRX_SESSION_POLICY: Record<
  string,
  { range: string; limit: number; sessions: number; perSession: number; maxDays: number }
> = {
  '5m': { range: 'prev3_open', limit: 600, sessions: 3, perSession: 78, maxDays: 12.6 },
  '15m': { range: 'prev6_open', limit: 288, sessions: 6, perSession: 26, maxDays: 17.8 },
  '30m': { range: 'prev12_open', limit: 672, sessions: 12, perSession: 13, maxDays: 25.8 },
  '1h': { range: 'prev24_open', limit: 336, sessions: 24, perSession: 7, maxDays: 41.8 },
  '1d': { range: 'prev576_open', limit: 600, sessions: 576, perSession: 1, maxDays: 867.6 },
};

test('KRX stocks read the confirmed session windows (design v2.1 §5.1)', () => {
  for (const tab of ASSET_CHART_TIMEFRAMES) {
    const resolved = resolveAssetChartTimeframe(tab, 'domestic_stock');
    if (tab.interval === '4h') {
      assert.equal(resolved, LONG_RANGE_FOUR_HOUR_TIMEFRAME);
      continue;
    }
    const policy = KRX_SESSION_POLICY[tab.interval];
    assert.ok(policy, `no KRX policy for ${tab.interval}`);
    assert.deepEqual(resolved, {
      label: tab.label,
      interval: tab.interval,
      range: policy.range,
      limit: policy.limit,
    });
    // N sessions + today all fit in one request, under the Binance cap.
    assert.ok(policy.limit >= (policy.sessions + 1) * policy.perSession);
    assert.ok(policy.limit <= BINANCE_KLINE_MAX_LIMIT);
    // 5m-aggregated windows stay inside the stored 5m retention.
    if (tab.interval !== '1d')
      assert.ok(policy.maxDays <= FIVE_MINUTE_RETENTION_DAYS);
  }
});

test('the long-range 4h limit carries 96 crypto days plus the current bucket within the 1000 cap', () => {
  // 96 days × 6 closed buckets + 1 in-progress bucket (crypto upper bound);
  // KRX returns at most 96 sessions × 2 + today's 2.
  assert.ok(LONG_RANGE_FOUR_HOUR_TIMEFRAME.limit >= 96 * 6 + 1);
  assert.ok(LONG_RANGE_FOUR_HOUR_TIMEFRAME.limit >= 96 * 2 + 2);
  assert.ok(LONG_RANGE_FOUR_HOUR_TIMEFRAME.limit <= BINANCE_KLINE_MAX_LIMIT);
  // The live-candle merge trims to this limit, so it must not cut history.
  assert.equal(
    QUERY_KEYS.asset.candles('asset-1', LONG_RANGE_FOUR_HOUR_TIMEFRAME).join('|'),
    'asset|candles|asset-1|96d|4h|600',
  );
});

test('4h shows the last 30 days', () => {
  const fourHour = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '4h');
  assert.deepEqual(
    { range: fourHour?.range, limit: fourHour?.limit },
    { range: '30d', limit: 200 },
  );
});

test('aggregated tabs stay inside the 45-day 5m retention window', () => {
  for (const tab of ASSET_CHART_TIMEFRAMES) {
    if (!AGGREGATED_INTERVALS.has(tab.interval)) continue;
    const days = RANGE_WORST_CASE_DAYS[tab.range];
    assert.ok(
      days !== undefined && days <= FIVE_MINUTE_RETENTION_DAYS,
      `${tab.label}: ${tab.range} exceeds the stored 5m retention window`,
    );
  }
});

test('each timeframe gets its own candle query key (14d never collides)', () => {
  const krx = ASSET_CHART_TIMEFRAMES.map(
    (tab) => resolveAssetChartTimeframe(tab, 'domestic_stock')!,
  );
  const windows = [
    ...ASSET_CHART_TIMEFRAMES,
    ...krx.filter((tab) => tab.interval !== '4h'),
  ];
  const keys = windows.map((tab) =>
    JSON.stringify(
      QUERY_KEYS.asset.candles('asset-1', {
        range: tab.range,
        interval: tab.interval,
        limit: tab.limit,
      }),
    ),
  );
  assert.equal(new Set(keys).size, keys.length, 'query keys must be distinct');

  const halfHour = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '30m')!;
  assert.deepEqual(
    QUERY_KEYS.asset.candles('asset-1', {
      range: halfHour.range,
      interval: halfHour.interval,
      limit: halfHour.limit,
    }),
    ['asset', 'candles', 'asset-1', '14d', '30m', 672],
  );
  // A 14d key must not be confused with the 1d or 1y windows.
  assert.notDeepEqual(
    QUERY_KEYS.asset.candles('asset-1', { range: '14d', interval: '1h' }),
    QUERY_KEYS.asset.candles('asset-1', { range: '1d', interval: '1h' }),
  );
});
