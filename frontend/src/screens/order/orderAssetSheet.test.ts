import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const { inlineTradingHarness, deferred, act } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const qty = TEST_IDS.order.quantityInput;
const submit = TEST_IDS.order.executeSubmit;
const row = (id: string) => TEST_IDS.market.item(id);
const has = (h: any, id: string) => h.node(id) !== undefined;
const emptyTitle = (h: any): string | undefined =>
  h.renderer.root.findAll((n: any) => n.type === 'InlineEmptyState')[0]?.props.title;

describe('order screen asset sheet', () => {
  it('opens over the order screen and lists assets before any search text', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.press('asset-change-pair');
    assert.equal(has(h, 'order-asset-sheet'), true);
    assert.equal(has(h, TEST_IDS.order.screen), true, 'the order screen stays mounted behind the sheet');
    assert.equal(h.navigation.length, 0, 'no MarketSearch or AssetDetail navigation');
    await h.flush();
    assert.equal(h.marketRequests.length, 1);
    assert.equal(h.marketRequests[0].search, undefined);
    assert.equal(h.marketRequests[0].assetType, undefined);
    assert.equal(h.marketRequests[0].withPrice, true);
    assert.equal(h.marketRequests[0].sortBy, 'turnover');
    assert.deepEqual([has(h, row('bnb')), has(h, row('btc')), has(h, row('samsung'))], [true, true, true]);
    assert.equal(h.marketTickerOptions.enabled, true);
    assert.deepEqual(h.marketTickerOptions.assetIds, ['bnb', 'btc', 'samsung']);
  });

  it('searches and filters with the shared query, and an older response never replaces a newer search', async (t) => {
    const h = inlineTradingHarness();
    h.marketGates = { B: deferred() };
    await h.mount(); t.after(h.close);
    await h.press('asset-change-pair'); await h.flush();
    await h.input('order-asset-search-input', 'B');
    await h.input('order-asset-search-input', 'BTC');
    await h.flush();
    assert.deepEqual(h.marketRequests.map((r: any) => r.search ?? ''), ['', 'B', 'BTC']);
    assert.deepEqual([has(h, row('bnb')), has(h, row('btc'))], [false, true]);
    await act(async () => h.marketGates.B.resolve()); await h.flush();
    assert.deepEqual([has(h, row('bnb')), has(h, row('btc'))], [false, true], 'the late "B" page stays in its own cache entry');
    await h.press('order-asset-scope-domestic_stock'); await h.flush();
    assert.equal(h.marketRequests.at(-1).assetType, 'domestic_stock');
    assert.equal(h.marketRequests.at(-1).search, 'BTC');
    assert.equal(has(h, 'order-asset-sheet-empty'), true);
    assert.equal(emptyTitle(h), '검색 결과가 없습니다.');
    await h.input('order-asset-search-input', '');
    await h.flush();
    assert.deepEqual([has(h, row('samsung')), has(h, row('btc'))], [true, false]);
    assert.equal(h.node('order-asset-scope-domestic_stock').props.accessibilityState.selected, true);
  });

  it('separates loading and error from an empty list, and retries the same request', async (t) => {
    const h = inlineTradingHarness();
    h.marketGates = { '': deferred() };
    await h.mount(); t.after(h.close);
    await h.press('asset-change-pair');
    assert.equal(has(h, 'order-asset-sheet-loading'), true);
    assert.equal(has(h, 'order-asset-sheet-empty'), false);
    h.marketFailure = new Error('network');
    await act(async () => h.marketGates[''].resolve()); await h.flush();
    assert.equal(has(h, 'order-asset-sheet-error'), true);
    assert.equal(has(h, 'order-asset-sheet-empty'), false);
    h.marketFailure = null;
    await act(async () => h.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === '다시 시도')[0].props.onPress());
    await h.flush();
    assert.equal(has(h, row('bnb')), true);
  });

  it('selecting an asset keeps the bound account and side, and starts a clean order for it', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.press(TEST_IDS.assetDetail.sellButton);
    await h.input(qty, '1');
    await h.press('asset-change-pair'); await h.flush();
    await h.press(row('btc'));
    assert.deepEqual(h.navigation, [['setParams', { assetId: 'btc', side: 'sell' }]]);
    assert.equal(has(h, 'order-asset-sheet'), false);
    assert.ok(h.keyboardDismissals >= 1);
    await h.update();
    assert.equal(h.routeAccountId, 'general');
    assert.equal(h.node(qty).props.value, '');
    assert.equal(h.node(TEST_IDS.assetDetail.sellButton).props.accessibilityState.selected, true);
    assert.equal(h.node(submit).props.label, '매도');
    assert.equal(h.orderType(), '시장가');
    await h.input(qty, '0.5');
    await h.press(submit); await h.flush();
    assert.match(h.requests[0].url, /\/trading-accounts\/general\//);
    assert.equal(h.requests[0].body.assetId, 'btc');
    assert.equal(h.requests[0].body.side, 'sell');
  });

  it('returns to the traded asset detail: back for the entry asset, popTo after an in-place change', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.input(qty, '1');
    await h.press(submit); await h.flush();
    await act(async () => h.success().onGoAssetDetail());
    assert.deepEqual(h.navigation, [['back']]);
    await h.press('asset-change-pair'); await h.flush();
    await h.press(row('btc'));
    await h.update();
    await h.input(qty, '1');
    await h.press(submit); await h.flush();
    assert.equal(h.success().visible, true);
    await act(async () => h.success().onGoAssetDetail());
    assert.deepEqual(h.navigation.at(-1), ['popTo', 'AssetDetail', { assetId: 'btc' }]);
  });

  it('discards a pending quote of the previous asset after a selection', async (t) => {
    const h = inlineTradingHarness();
    h.quoteGate = deferred();
    await h.mount(); t.after(h.close);
    await h.input(qty, '1');
    await h.press(submit);
    await h.press('asset-change-pair'); await h.flush();
    await h.press(row('btc'));
    await h.update();
    await act(async () => h.quoteGate.resolve()); await h.flush();
    assert.equal(h.requests.length, 1, 'the old quote never reaches create');
    assert.equal(h.node(qty).props.value, '');
    assert.equal(h.success().visible, false);
  });

  it('closing by button, backdrop, Android back or the current asset keeps the order inputs', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.selectOrderType('limit');
    await h.input(TEST_IDS.order.limitPriceInput, '700');
    await h.input(qty, '2');
    const close = [
      () => h.press('order-asset-sheet-close'),
      () => h.press('order-asset-sheet-backdrop'),
      () => act(async () => h.node('order-asset-sheet-modal').props.onRequestClose()),
      () => h.press(row('bnb')),
    ];
    for (const action of close) {
      await h.press('asset-change-pair'); await h.flush();
      await action();
      assert.equal(has(h, 'order-asset-sheet'), false);
      assert.equal(h.node(qty).props.value, '2');
      assert.equal(h.node(TEST_IDS.order.limitPriceInput).props.value, '700');
      assert.equal(h.orderType(), '지정가');
    }
    assert.equal(h.navigation.length, 0);
    assert.ok(h.keyboardDismissals >= 4);
  });

  it('slides up and back down, and Reduced Motion opens and closes without motion', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.press('asset-change-pair');
    assert.deepEqual(h.animations.map((a: any) => [a.toValue, a.duration]), [[1, 280]]);
    await h.press('order-asset-sheet-close');
    assert.deepEqual(h.animations.map((a: any) => [a.toValue, a.duration]), [[1, 280], [0, 220]]);
    assert.equal(has(h, 'order-asset-sheet-modal'), false);
    h.reduced = true;
    await h.update();
    await h.press('asset-change-pair');
    assert.equal(has(h, 'order-asset-sheet'), true);
    await h.press('order-asset-sheet-close');
    assert.equal(has(h, 'order-asset-sheet-modal'), false);
    assert.equal(h.animations.length, 2);
  });

  it('drags down on the handle to close and snaps back from a short drag', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.input(qty, '1');
    await h.press('asset-change-pair');
    const gesture = (dy: number, vy = 0) => ({ dx: 0, dy, vy });
    assert.equal(h.panConfig.onMoveShouldSetPanResponder({}, gesture(10)), true);
    assert.equal(h.panConfig.onMoveShouldSetPanResponder({}, { dx: 20, dy: 10 }), false);
    await act(async () => h.panConfig.onPanResponderRelease({}, gesture(40)));
    assert.equal(has(h, 'order-asset-sheet'), true);
    assert.equal(h.animations.at(-1).toValue, 0);
    await act(async () => h.panConfig.onPanResponderRelease({}, gesture(140)));
    assert.equal(has(h, 'order-asset-sheet'), false);
    assert.equal(h.node(qty).props.value, '1');
  });
});
