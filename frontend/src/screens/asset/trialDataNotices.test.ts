import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TRIAL_PRICE_NOTICE } from '../../features/asset/trialDataSource.ts';
import { ASSET_CHART_TIMEFRAMES } from '../../features/asset/chartTimeframes.ts';

const { inlineTradingHarness, act } = (() => {
  const require = createRequire(import.meta.url);
  return {
    ...require('../../../test/inlineTradingHarness.cjs'),
    act: require('react-test-renderer').act,
  };
})();

function usChart() {
  const h = inlineTradingHarness();
  h.Screen = h.Chart;
  h.assetId = 'samsung';
  Object.assign(h.assets.samsung, {
    assetType: 'us_stock',
    market: 'NAS',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
    marketStatus: 'open',
  });
  return h;
}

const candleQueries = (h: any) =>
  h.queries.filter((query: any) => query.queryKey[1] === 'candles');

describe('Tiingo trial data on the asset chart', () => {
  it('labels a Tiingo price and a partial Tiingo chart with its forming candle', async (t) => {
    const h = usChart();
    h.assets.samsung.price.priceSource = {
      sourceType: 'provider_api',
      sourceName: 'tiingo_equity_reference_price',
    };
    h.candleSource = {
      provider: 'tiingo',
      dataset: 'equity_intraday',
      persisted: false,
      coverage: 'partial',
      requestedSessions: 96,
      coveredSessions: 30,
      currentCandleTime: '2026-10-13T17:30:00.000Z',
    };
    await h.mount();
    t.after(h.close);
    assert.equal(h.node('asset-trial-price-notice').props.children, TRIAL_PRICE_NOTICE);
    assert.equal(
      h.node('asset-trial-candle-notice').props.children,
      'Tiingo 체험 차트 · 받은 30/96거래일 구간만 표시 · 마지막 봉은 조회 시점의 진행 중 봉',
    );
    // The chart never polls REST per client, trial data included.
    assert.equal(candleQueries(h).at(-1).refetchInterval, undefined);
  });

  it('shows no trial label for stored (KIS) data', async (t) => {
    const h = usChart();
    h.assets.samsung.price.priceSource = {
      sourceType: 'provider_api',
      sourceName: 'kis_us_delayed_trade',
    };
    await h.mount();
    t.after(h.close);
    for (const id of ['asset-trial-price-notice', 'asset-trial-candle-notice'])
      assert.equal(
        h.renderer.root.findAll((node: any) => node.props?.testID === id).length,
        0,
      );
  });

  it('requests the 96-session window for the US 4h tab', async (t) => {
    const h = usChart();
    await h.mount();
    t.after(h.close);
    const fourHour = ASSET_CHART_TIMEFRAMES.find((tab) => tab.interval === '4h');
    const selector = h.renderer.root.findAllByType('ChartTimeframeSelector')[0];
    await act(async () => selector.props.onSelect(fourHour));
    const key = candleQueries(h).at(-1).queryKey;
    assert.deepEqual(key.slice(3), ['96d', '4h', 600]);
  });
});
