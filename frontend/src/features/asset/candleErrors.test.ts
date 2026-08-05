import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANDLE_BASELINE_NOT_READY_CODE,
  CANDLE_BASELINE_NOT_READY_MESSAGE,
  describeCandleError,
  getApiErrorCode,
  getApiErrorStatus,
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

describe('describeCandleError (what the chart area says)', () => {
  it('keeps the preparing state for a baseline error', () => {
    const view = describeCandleError(apiError(CANDLE_BASELINE_NOT_READY_CODE));
    assert.equal(view.kind, 'baseline_preparing');
    assert.equal(view.title, CANDLE_BASELINE_NOT_READY_MESSAGE);
  });

  it('shows a real failure AS a failure, with the backend error code', () => {
    // Hiding this behind a loading skeleton is what made an outage look like
    // a slow request and hid the reason.
    const view = describeCandleError(
      apiError('ASSET_CANDLES_PROVIDER_UNAVAILABLE'),
    );
    assert.equal(view.kind, 'failed');
    assert.equal(view.title, '차트를 불러오지 못했습니다.');
    assert.ok(view.message.includes('ASSET_CANDLES_PROVIDER_UNAVAILABLE'));
  });

  it('falls back to the HTTP status, then to a network hint', () => {
    const statusOnly = describeCandleError({ response: { status: 502 } });
    assert.equal(statusOnly.kind, 'failed');
    assert.ok(statusOnly.message.includes('502'));
    assert.equal(getApiErrorStatus({ response: { status: 502 } }), 502);

    const networkError = describeCandleError(new Error('Network Error'));
    assert.equal(networkError.kind, 'failed');
    assert.ok(networkError.message.includes('네트워크'));
    assert.equal(getApiErrorStatus(new Error('x')), null);
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
      screenSource.includes('describeCandleError(candlesQuery.error)'),
      'the chart error branch describes the actual error',
    );
    assert.ok(
      !/candlesQuery\.isError[\s\S]{0,400}<SectionSkeleton/.test(screenSource),
      'a failed candle request must not render as a loading skeleton',
    );
    assert.ok(
      screenSource.includes('TEST_IDS.assetDetail.chartRetry'),
      'retry stays available in the baseline state',
    );
    assert.ok(
      // `void` is how the lint gate requires a fire-and-forget refetch to be
      // written; what matters here is that the button refetches the CANDLES.
      /onPress=\{\(\) => (void )?candlesQuery\.refetch\(\)\}/.test(screenSource),
      'retry refetches the candles query',
    );
  });

  it('keeps the timeframe tabs driving the request windows', () => {
    assert.ok(screenSource.includes('ASSET_CHART_TIMEFRAMES.map'));
    assert.ok(screenSource.includes('range: selectedTimeframe.range'));
    assert.ok(screenSource.includes('limit: selectedTimeframe.limit'));
  });
});
