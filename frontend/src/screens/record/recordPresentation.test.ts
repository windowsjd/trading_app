import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRecordScreenHarness } from '../../../test/recordScreenHarness.cjs';
import { recordDetail } from '../../../test/recordFixtures.ts';
import { financial } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';
import { getRecordFinancialDisplay } from '../../features/record/financialDisplay.ts';

for (const screen of ['detail', 'profit']) {
  it(`${screen}: canonical results, lean information and scoped history CTA`, async t => {
    const h = createRecordScreenHarness(screen); t.after(h.close); await h.settle();
    const history = h.find(screen === 'detail' ? 'record-season-detail-orders-cta' : 'record-profit-orders-cta');
    assert.equal(Object.assign({}, ...history.props.style.filter(Boolean)).backgroundColor, semantic.secondaryActionSurface);
    if (screen === 'detail') {
      const profit = h.find('record-season-detail-profit-analysis-cta');
      assert.equal(Object.assign({}, ...profit.props.style.filter(Boolean)).backgroundColor, semantic.selected);
    }
    assert.doesNotMatch(h.text(), /MDD|private snapshot|private timestamp|RAW_|domestic_stock|open|available|총 주문|거래 요약|환전 내역/);
    if (screen === 'detail') {
      assert.equal(h.text(h.find('record-detail-return')), '+12.34%');
      assert.equal(h.text(h.find('record-detail-assets')), '11,234,000원');
      assert.equal(h.text(h.find('record-detail-pnl')), '+777,777원', 'backend PnL differs from assets minus capital');
      assert.equal(h.text(h.find('record-detail-rank')), '#100000');
      assert.doesNotMatch(h.text(), /실현 손익|평가 손익|대표 손익|최고 수익/);
      await h.press('record-season-detail-orders-cta');
    } else {
      assert.equal(h.text(h.find('record-profit-total')), '+777,777원');
      assert.equal(h.text(h.find('record-profit-realized')), '+900,000원');
      assert.equal(h.text(h.find('record-profit-unrealized')), '-122,223원');
      assert.match(h.text(h.find('record-profit-best')), /삼성전자/);
      assert.match(h.text(h.find('record-profit-worst')), /Tesla/);
      assert.doesNotMatch(h.text(), /순위|등급|최종 자산/);
      const chart = h.renderer.root.findByType('LineChart');
      assert.deepEqual(chart.props.points.map(p => [p.x, p.y]), [['2026-09-01', '10000000'], ['2026-09-12', '12000000'], ['2026-09-30', '11234000']]);
      assert.equal(chart.props.xScale, 'time'); assert.equal(chart.props.selectionDisplay, 'tooltip');
      assert.equal(chart.props.pointValueFormatter({ y: '1234567890123456' }), '1,234,567,890,123,456원');
      await h.press('record-profit-orders-cta');
    }
    assert.deepEqual(h.navigation.at(-1), ['TradeHistory', { seasonId: 'record-0' }]);
    const before = h.requests.length; await h.refresh();
    assert.equal(h.requests.length - before, screen === 'detail' ? 1 : 2);
    assert.ok(h.requests.every(r => r.path.startsWith('/records/me/seasons/record-0')));
  });
  for (const state of ['unavailable', 'partial_unavailable']) {
    it(`${screen}: ${state} hides incomplete totals and technical errors`, async t => {
      const h = createRecordScreenHarness(screen, undefined, { detail: recordDetail({ state }) }); t.after(h.close); await h.settle();
      assert.equal(h.text(h.find(screen === 'detail' ? 'record-detail-pnl' : 'record-profit-total')), '-');
      assert.doesNotMatch(h.text(), /RAW_|partial_unavailable|valuationState/);
      if (screen === 'profit') {
        assert.equal(h.text(h.find('record-profit-unrealized')), '-');
        assert.equal(h.text(h.find('record-profit-realized')), state === 'unavailable' ? '-' : '+900,000원');
        if (state === 'partial_unavailable') {
          assert.equal(h.text(h.find('record-profit-asset-missing-pnl')), '-');
          assert.equal(h.text(h.find('record-profit-asset-missing-return')), '-');
          assert.equal(h.text(h.find('record-profit-asset-best-pnl')), '+520,000원');
        }
      } else if (state === 'unavailable') {
        assert.equal(h.text(h.find('record-detail-return')), '-');
        assert.equal(h.text(h.find('record-detail-assets')), '-');
      }
    });
  }
}
it('active/ended seasons never label rank/tier or performance as final', async t => {
  for (const status of ['active', 'ended']) {
    const h = createRecordScreenHarness('detail', undefined, { detail: recordDetail({ status }) }); t.after(h.close); await h.settle();
    assert.doesNotMatch(h.text(), /최종|#100000|Gold/);
    assert.equal(h.text(h.find('record-detail-rank')), '-');
    assert.equal(h.text(h.find('record-detail-tier')), '-');
  }
});
it('all displayed signs use semantic financial roles; zero/missing and assets are neutral', () => {
  assert.equal(getRecordFinancialDisplay('18.2', 'rate').color, financial.rise);
  assert.equal(getRecordFinancialDisplay('-180000').color, financial.fall);
  for (const value of ['0', null, undefined, 'invalid']) assert.equal(getRecordFinancialDisplay(value).color, semantic.text);
  assert.equal(getRecordFinancialDisplay('11234000', 'money', false).color, semantic.text);
  assert.equal(getRecordFinancialDisplay('0').text, '0원');
});

for (const role of ['admin', 'user', 'operator']) {
  it(`profit analysis forwards selection diagnostics through the existing ${role} role gate`, async t => {
    const detail = recordDetail({ state: 'partial_unavailable' });
    const failure = { assetId: 'missing', code: 'FX_RATE_UNAVAILABLE', message: 'FX unavailable', diagnostic: {
      version: 1 as const, timestamp: '2026-07-20T00:00:00Z', truncated: false, code: 'FX_RATE_UNAVAILABLE', httpStatus: 200, requestId: 'selection-test', domain: 'RECORDS', operation: 'PROFIT_ANALYSIS', failureStage: 'fx_rate_selection',
      evidence: { workflow: 'positions_live_valuation', freshnessThresholdSeconds: 7200, providerCandidates: [{ sourceName: 'korea_exim_exchange_rate', reason: 'captured_at_stale' }] },
      exception: { type: 'RecordsValuationError', truncated: false, message: 'FX unavailable', stack: [], applicationStack: [] },
      diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false }, nextInvestigation: [],
    } };
    detail.profitAnalysis.valuationErrors = [failure];
    const h = createRecordScreenHarness('profit', undefined, { detail, role }); t.after(h.close); await h.settle();
    // The diagnostic enables /me only after the record response has rendered.
    await h.settle();
    if (role === 'admin') {
      assert.ok(h.find('admin-diagnostic-toggle'));
      await h.press('admin-diagnostic-toggle');
      assert.match(h.text(), /captured_at_stale/);
      assert.match(h.text(), /positions_live_valuation/);
    } else {
      assert.equal(h.find('admin-diagnostic-toggle'), undefined);
      assert.doesNotMatch(h.text(), /captured_at_stale|positions_live_valuation/);
    }
  });
}
