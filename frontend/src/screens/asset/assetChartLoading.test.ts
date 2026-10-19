import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { ASSET_CHART_TIMEFRAMES } from '../../features/asset/chartTimeframes.ts';

const { inlineTradingHarness, act } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);

const timeframe = (interval: string) => ASSET_CHART_TIMEFRAMES.find((value) => value.interval === interval)!;
const candle = (close: string) => ({ time: '2026-10-19T00:00:00Z', open: '760', high: '770', low: '750', close, volume: '1' });

/**
 * The chart's candle reads go through the real query client; each read waits
 * until the test answers it (`answer(key, candles)` or `fail(key)`).
 */
function chartHarness(screen: 'Chart' | 'Detail') {
  const h = inlineTradingHarness();
  h.realCandles = true;
  const pending = new Map<string, Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>>();
  h.candleReads = [] as string[];
  h.getAssetCandles = (assetId: string, params: { interval: string }) => {
    const key = `${assetId}:${params.interval}`;
    h.candleReads.push(key);
    return new Promise((resolve, reject) => pending.set(key, [...(pending.get(key) ?? []), { resolve, reject }]));
  };
  const settle = async (key: string, run: (read: { resolve: (value: unknown) => void; reject: (error: unknown) => void }) => void) => {
    const reads = pending.get(key) ?? [];
    assert.equal(reads.length > 0, true, `a read for ${key} is out`);
    pending.delete(key);
    await act(async () => { reads.forEach(run); });
    await h.flush();
  };
  h.answer = (key: string, candles: unknown[]) => settle(key, (read) => read.resolve({ interval: key.split(':')[1], candles }));
  h.fail = (key: string) => settle(key, (read) => read.reject(Object.assign(new Error('candles unavailable'), { code: 'ERR_NETWORK' })));
  h.Screen = h[screen];
  h.loading = () => h.renderer.root.findAllByType('ChartLoading').length > 0;
  h.chart = () => h.renderer.root.findAllByType('CandlestickChart')[0]?.props ?? null;
  h.select = (interval: string) => act(async () => h.renderer.root.findByType('ChartTimeframeSelector').props.onSelect(timeframe(interval)));
  return h;
}

for (const screen of ['Chart', 'Detail'] as const) {
  test(`${screen}: the whale on first load and on a new 봉 시간, never the previous interval's candles; a cached one draws at once`, async (t) => {
    const h = chartHarness(screen);
    await h.mount();
    t.after(h.close);
    await h.flush();
    // First load: the chart box shows the whale, nothing is drawn yet.
    assert.equal(h.loading(), true);
    assert.equal(h.chart() === null, true, 'no chart drawn');
    await h.answer('bnb:5m', [candle('765')]);
    assert.equal(h.loading(), false);
    assert.equal(h.chart().candles[0].close, '765');
    assert.equal(h.chart().viewportResetKey, 'bnb:5m');

    // Another 봉 시간 with no data yet: the whale again, not the 5m candles.
    await h.select('1h');
    assert.equal(h.loading(), true);
    assert.equal(h.chart() === null, true, 'no chart drawn');
    await h.answer('bnb:1h', [candle('888')]);
    assert.equal(h.loading(), false);
    assert.equal(h.chart().candles[0].close, '888');
    assert.equal(h.chart().viewportResetKey, 'bnb:1h');

    // Back to the cached 5m: drawn at once while it refreshes behind the chart (no flash).
    const before = h.candleReads.length;
    await h.select('5m');
    assert.equal(h.loading(), false);
    assert.equal(h.chart().candles[0].close, '765');
    assert.equal(h.candleReads.length > before, true, 'the cached interval is read again in the background');
    await h.answer('bnb:5m', [candle('766')]);
    assert.equal(h.loading(), false);
    assert.equal(h.chart().candles[0].close, '766');
  });
}

test('a failed read shows its error (no whale); 차트 다시 시도 loads with the whale; an empty answer shows the empty state', async (t) => {
  const h = chartHarness('Chart');
  await h.mount();
  t.after(h.close);
  await h.flush();
  await h.fail('bnb:5m');
  assert.equal(h.loading(), false, 'an error is never left as a loader');
  assert.equal(h.chart() === null, true, 'no chart drawn');
  assert.equal(h.node(TEST_IDS.assetDetail.chartRetry) === undefined, false);
  await h.press(TEST_IDS.assetDetail.chartRetry);
  await h.flush();
  assert.equal(h.loading(), true, 'the retry reads again with the whale');
  assert.equal(h.node(TEST_IDS.assetDetail.chartRetry) === undefined, true);
  await h.answer('bnb:5m', []);
  assert.equal(h.loading(), false, 'an empty answer is not a loader either');
  assert.equal(h.chart() === null, true, 'no chart drawn');
  assert.equal(h.renderer.root.findAllByType('InlineEmptyState').some((node: any) => node.props.message === '표시할 차트 데이터가 없습니다.'), true);
});

test('another asset starts on the whale and never shows the previous asset\'s candles', async (t) => {
  const h = chartHarness('Detail');
  await h.mount();
  t.after(h.close);
  await h.flush();
  await h.answer('bnb:5m', [candle('765')]);
  h.assetId = 'btc';
  await h.update();
  await h.flush();
  assert.equal(h.loading(), true);
  assert.equal(h.chart() === null, true, 'no chart drawn');
  await h.answer('btc:5m', [candle('99000')]);
  assert.equal(h.chart().candles[0].close, '99000');
  assert.equal(h.chart().viewportResetKey, 'btc:5m');
});
