import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const { inlineTradingHarness } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const text = (node: any): string =>
  typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const panel = (h: any) => h.node(TEST_IDS.order.screen);
const panelText = (h: any) => text(panel(h)).replace(/\u200b/g, '');

function stockHarness(type: 'domestic_stock' | 'us_stock' = 'domestic_stock') {
  const h = inlineTradingHarness();
  h.Screen = h.OrderScreen;
  h.assetId = 'samsung';
  h.assets.samsung.assetType = type;
  h.assets.samsung.marketStatus = 'open';
  h.assets.samsung.tradable = true;
  h.assets.samsung.tradeBlockedReason = null;
  return h;
}

describe('order screen warning meaning', () => {
  it('calls an available but stale REST display price old, never absent, and keeps server Quote reachable', async (t) => {
    const h = stockHarness();
    h.role = 'admin';
    h.assets.samsung.price.priceCapturedAt = new Date(Date.now() - 90_000).toISOString();
    await h.mount(); t.after(h.close); await h.flush();
    await h.input(TEST_IDS.order.quantityInput, '2');
    assert.match(panelText(h), /현재 화면 시세가 오래되어 비율 수량 계산은 제한됩니다/);
    assert.doesNotMatch(panelText(h), /현재 화면 시세가 없어|현재가가 없어/);
    assert.ok(h.node('admin-diagnostic-toggle'));
    await h.press('admin-diagnostic-toggle');
    assert.match(panelText(h), /displayedPriceBasisrest/);
    assert.match(panelText(h), /displayedPriceAvailabletrue/);
    assert.match(panelText(h), /previewPriceAvailablefalse/);
    assert.doesNotMatch(panelText(h), /Backend Exception|Request ID/);
    await h.press(TEST_IDS.order.executeSubmit); await h.flush();
    assert.equal(h.requests[0].url.endsWith('/quote'), true);
  });

  it('uses the absent-price copy only when the display price is actually absent', async (t) => {
    const h = stockHarness();
    h.assets.samsung.price = { state: 'unavailable' };
    await h.mount(); t.after(h.close); await h.flush();
    await h.input(TEST_IDS.order.quantityInput, '2');
    assert.match(panelText(h), /현재 화면 시세가 없어 비율 수량 계산은 제한됩니다/);
    assert.doesNotMatch(panelText(h), /현재 화면 시세가 오래되어/);
  });

  for (const type of ['domestic_stock', 'us_stock'] as const) {
    it(`${type} CLOSED market has one session warning and CLOSED limit has no session/price warning`, async (t) => {
      const h = stockHarness(type);
      h.role = 'admin';
      h.dimensions = { width: 320, height: 700, fontScale: 2 };
      h.assets.samsung.marketStatus = 'closed';
      h.assets.samsung.tradable = false;
      h.assets.samsung.tradeBlockedReason = 'MARKET_CLOSED';
      h.assets.samsung.price.priceCapturedAt = new Date(Date.now() - 90_000).toISOString();
      await h.mount(); t.after(h.close); await h.flush();
      await h.input(TEST_IDS.order.quantityInput, '2');
      const marketText = panelText(h);
      assert.equal((marketText.match(/정규장 외에는 시장가 주문을 할 수 없습니다/g) ?? []).length, 1);
      assert.doesNotMatch(marketText, /현재 화면 시세가 없어|현재 화면 시세가 오래되어|현재 시장이 닫혀 있습니다/);
      assert.equal(panel(h).findAll((n: any) => n.props.testID === 'admin-diagnostic-panel').length, 0);
      assert.ok(panel(h).findAllByType('Text').every((n: any) => n.props.numberOfLines === undefined));
      await h.selectOrderType('limit');
      await h.input(TEST_IDS.order.limitPriceInput, '70000');
      assert.doesNotMatch(panelText(h), /정규장 외 지정가는|정규장 외에는 시장가|현재 화면 시세가 없어|현재 화면 시세가 오래되어/);
      assert.equal(h.orderType(), '지정가');
      assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'enabled');
      await h.press(TEST_IDS.order.executeSubmit); await h.flush();
      assert.equal(h.requests[0].body.orderType, 'limit');
      assert.equal(h.success().payload.execution.state, 'submitted');
    });
  }

  it('keeps fresh OPEN stock and crypto UX without a new warning', async (t) => {
    const h = stockHarness();
    await h.mount(); t.after(h.close); await h.flush();
    await h.input(TEST_IDS.order.quantityInput, '2');
    assert.doesNotMatch(panelText(h), /현재 화면 시세가 없어|현재 화면 시세가 오래되어|정규장 외/);
    const crypto = inlineTradingHarness();
    crypto.Screen = crypto.OrderScreen;
    crypto.assets.bnb.price.priceCapturedAt = new Date(Date.now() - 90_000).toISOString();
    await crypto.mount(); t.after(crypto.close); await crypto.flush();
    assert.match(panelText(crypto), /현재 화면 시세가 오래되어 예상 수량을 표시할 수 없습니다/);
    assert.doesNotMatch(panelText(crypto), /현재 화면 시세가 없어/);
  });

  for (const mode of ['general', 'season'] as const) {
    it(`removes duplicate ${mode} account labels from order and holdings while pending remains scoped`, async (t) => {
      const h = inlineTradingHarness();
      h.accountId = mode;
      h.accounts[1].season.seasonName = 'Season 1';
      h.orders = { [mode]: [{
        id: `pending-${mode}`, asset: { id: 'bnb', name: 'BNB', symbol: 'BNBUSDT' },
        side: 'buy', orderType: 'limit', status: 'submitted', quantity: '1',
        limitPrice: '700', currencyCode: 'USD', submittedAt: '2026-09-29T00:00:00.000Z',
      }] };
      await h.mount(); t.after(h.close); await h.flush();
      assert.doesNotMatch(panelText(h), /운영 중|Season 1|일반 투자/);
      assert.doesNotMatch(text(h.node('account-holdings')), /운영 중|Season 1|일반 투자/);
      await h.press('holdings-filter-pending'); await h.flush();
      assert.ok(h.node(`pending-order-pending-${mode}`));
      assert.doesNotMatch(text(h.node('account-holdings')), /운영 중|Season 1|일반 투자/);
      assert.equal(h.orderReads.at(-1).id, mode);
    });
  }
});
