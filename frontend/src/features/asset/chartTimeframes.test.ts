import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASSET_CHART_TIMEFRAMES,
  DEFAULT_ASSET_CHART_TIMEFRAME,
} from './chartTimeframes.ts';

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
// prev2_open ≈ 3 days, 30d = 30 days, 1y = 366 days.
const RANGE_WORST_CASE_DAYS: Record<string, number> = {
  prev_open: 2,
  prev2_open: 3,
  '30d': 30,
  '1y': 366,
};

test('1m tab is not offered', () => {
  assert.ok(
    ASSET_CHART_TIMEFRAMES.every(
      (tab) => tab.interval !== ('1m' as string) && tab.label !== ('1m' as string),
    ),
    'no timeframe may expose 1m',
  );
});

test('expected tab order and count', () => {
  assert.deepEqual(
    ASSET_CHART_TIMEFRAMES.map((tab) => tab.label),
    ['5m', '15m', '30m', '1h', '4h', '1d', '1w'],
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
      { interval: '15m', range: 'prev_open', limit: 200 },
      { interval: '30m', range: 'prev2_open', limit: 160 },
      { interval: '1h', range: 'prev2_open', limit: 80 },
      { interval: '4h', range: '30d', limit: 200 },
      { interval: '1d', range: '1y', limit: 400 },
      { interval: '1w', range: '1y', limit: 60 },
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

test('daily and weekly limits are fixed for 1y chart requests', () => {
  const daily = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '1d');
  const weekly = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '1w');

  assert.equal(daily?.limit, 400);
  assert.equal(weekly?.limit, 60);
});
