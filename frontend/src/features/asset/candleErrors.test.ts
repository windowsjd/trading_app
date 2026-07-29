import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANDLE_BASELINE_NOT_READY_CODE,
  CANDLE_BASELINE_NOT_READY_MESSAGE,
  getApiErrorCode,
  isCandleBaselineNotReadyError,
} from './candleErrors.ts';

const apiError = (code: string) => ({
  response: { status: 503, data: { success: false, error: { code } } },
});

describe('candle baseline-not-ready classification', () => {
  it('recognizes the backend baseline code', () => {
    assert.equal(
      isCandleBaselineNotReadyError(apiError(CANDLE_BASELINE_NOT_READY_CODE)),
      true,
    );
    assert.equal(CANDLE_BASELINE_NOT_READY_CODE, 'ASSET_CANDLES_BASELINE_NOT_READY');
    assert.equal(CANDLE_BASELINE_NOT_READY_MESSAGE, '차트 데이터를 준비 중입니다.');
  });

  it('leaves every other candle failure on the generic error path', () => {
    // A real provider outage must still read as a failure, not "preparing".
    assert.equal(
      isCandleBaselineNotReadyError(apiError('ASSET_CANDLES_PROVIDER_UNAVAILABLE')),
      false,
    );
    assert.equal(
      isCandleBaselineNotReadyError(apiError('ASSET_CANDLES_PROVIDER_ERROR')),
      false,
    );
    assert.equal(
      isCandleBaselineNotReadyError(apiError('ASSET_CANDLES_INVALID_RANGE')),
      false,
    );
  });

  it('is safe with network errors and junk', () => {
    assert.equal(isCandleBaselineNotReadyError(new Error('Network Error')), false);
    assert.equal(isCandleBaselineNotReadyError(null), false);
    assert.equal(isCandleBaselineNotReadyError(undefined), false);
    assert.equal(isCandleBaselineNotReadyError({ response: {} }), false);
    assert.equal(isCandleBaselineNotReadyError({ response: { data: {} } }), false);
    assert.equal(
      isCandleBaselineNotReadyError({ response: { data: { error: {} } } }),
      false,
    );
    assert.equal(getApiErrorCode({ response: { data: { error: { code: 5 } } } }), null);
    assert.equal(getApiErrorCode(apiError('X_CODE')), 'X_CODE');
  });
});

describe('asset detail screen wiring', () => {
  // No React renderer in this test runner (node --test over .ts), so the
  // screen's use of the preparing state is asserted against its source.
  const screenSource = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../screens/asset/AssetDetailScreen.tsx',
    ),
    'utf8',
  );

  it('shows the preparing state for a baseline error and keeps the retry button', () => {
    assert.ok(
      screenSource.includes('isCandleBaselineNotReadyError(candlesQuery.error)'),
      'the chart error branch classifies the baseline error',
    );
    assert.ok(screenSource.includes('CANDLE_BASELINE_NOT_READY_MESSAGE'));
    assert.ok(screenSource.includes('CANDLE_BASELINE_NOT_READY_HELPER'));
    assert.ok(
      screenSource.includes('TEST_IDS.assetDetail.chartRetry'),
      'retry stays available in the baseline state',
    );
    assert.ok(
      screenSource.includes('onPress={() => candlesQuery.refetch()}'),
      'retry refetches the candles query',
    );
  });

  it('keeps the timeframe tabs driving the request windows', () => {
    assert.ok(screenSource.includes('ASSET_CHART_TIMEFRAMES.map'));
    assert.ok(screenSource.includes('range: selectedTimeframe.range'));
    assert.ok(screenSource.includes('limit: selectedTimeframe.limit'));
  });
});
