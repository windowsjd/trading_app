import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTrialPriceSource, trialCandleNotice } from './trialDataSource.ts';

describe('Tiingo trial data labelling', () => {
  it('recognizes only the Tiingo trial price source', () => {
    assert.equal(
      isTrialPriceSource({ sourceType: 'provider_api', sourceName: 'tiingo_equity_reference_price' }),
      true,
    );
    assert.equal(isTrialPriceSource('tiingo_equity_reference_price'), true);
    assert.equal(
      isTrialPriceSource({ sourceType: 'provider_api', sourceName: 'kis_us_delayed_trade' }),
      false,
    );
    assert.equal(isTrialPriceSource(null), false);
    assert.equal(isTrialPriceSource(undefined), false);
  });

  it('describes partial coverage and the forming candle', () => {
    assert.equal(
      trialCandleNotice({
        provider: 'tiingo',
        coverage: 'partial',
        requestedSessions: 96,
        coveredSessions: 30,
        currentCandleTime: '2026-10-13T17:30:00.000Z',
      }),
      'Tiingo 체험 차트 · 받은 30/96거래일 구간만 표시 · 마지막 봉은 조회 시점의 진행 중 봉',
    );
    assert.equal(
      trialCandleNotice({ provider: 'tiingo', coverage: 'empty', currentCandleTime: null }),
      'Tiingo 체험 차트 · 표시할 실제 데이터가 아직 없습니다',
    );
    assert.equal(
      trialCandleNotice({ provider: 'tiingo', coverage: 'complete' }),
      'Tiingo 체험 차트 · 서버에 저장하지 않는 임시 데이터',
    );
    assert.equal(trialCandleNotice({ provider: 'kis' }), null);
    assert.equal(trialCandleNotice(undefined), null);
  });
});
