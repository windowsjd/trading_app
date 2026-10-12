import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const {
  inlineTradingHarness,
  deferred,
  act,
} = require('../../../test/inlineTradingHarness.cjs');
const qty = TEST_IDS.order.quantityInput;
const submit = TEST_IDS.order.executeSubmit;
const sell = TEST_IDS.assetDetail.sellButton;

describe('Order screen lifecycle with real React and query mutations', () => {
  for (const accountId of ['general', 'season'])
    it(`${accountId} sell offers no new limit: 시장가 only, the rest 준비 중`, async (t) => {
      const h = inlineTradingHarness();
      h.accountId = accountId;
      await h.mount();
      t.after(h.close);
      await h.press(sell);
      await h.press('order-type-select');
      assert.equal(h.node('order-method-limit') === undefined, true);
      assert.equal(h.node('order-method-market').props.disabled, false);
      for (const method of ['conditional', 'protection']) {
        assert.equal(h.node(`order-method-${method}`).props.disabled, true, method);
        assert.equal(h.node(`order-method-${method}-badge`).props.children, '준비 중');
      }
      // crypto has no LOC at all
      assert.equal(h.node('order-method-loc') === undefined, true);
    });
  for (const accountId of ['general', 'season'])
    for (const side of ['buy', 'sell'])
      for (const type of ['market', 'limit']) {
        // A new sell limit is not offered any more (see the test above);
        // accepted sell limits keep their server fill/list/cancel paths.
        if (side === 'sell' && type === 'limit') continue;
        it(`${accountId} ${type} ${side} preserves quote/create, canonical inputs, account and success`, async (t) => {
          const h = inlineTradingHarness();
          h.accountId = accountId;
          await h.mount();
          t.after(h.close);
          if (side === 'sell') await h.press(sell);
          if (type === 'limit') {
            await h.selectOrderType('limit');
            await h.input(TEST_IDS.order.limitPriceInput, '700.12345678');
          }
          await h.input(qty, '0.125');
          await h.press('asset-krw-toggle');
          await h.press(submit);
          await h.flush();
          assert.equal(h.requests.length, 2);
          assert.equal(
            h.requests[0].url,
            `/trading-accounts/${accountId}/orders/quote`,
          );
          assert.equal(
            h.requests[1].url,
            `/trading-accounts/${accountId}/orders`,
          );
          assert.equal(h.requests[1].body.side, side);
          assert.equal(h.requests[1].body[side === 'buy' ? 'amount' : 'quantity'], '0.125');
          assert.equal(h.requests[1].body[side === 'buy' ? 'quantity' : 'amount'], undefined);
          assert.equal(h.requests[1].body.orderType ?? 'market', type);
          assert.equal(
            h.requests[1].body.limitPrice,
            type === 'limit' ? '700.12345678' : undefined,
          );
          assert.ok(h.requests[1].body.quoteId);
          assert.ok(h.requests[1].body.idempotencyKey);
          assert.ok(!('currencyCode' in h.requests[1].body));
          assert.equal(h.success().visible, true);
          if (side === 'sell') assert.equal(h.success().quote.quantity, '0.125');
          else {
            assert.equal(h.success().quote.amount, '0.125');
            assert.ok(Number(h.success().quote.quantity) > 0);
          }
          assert.ok(
            h.invalidations.some((key: any[]) => key.includes(accountId)),
          );
          assert.ok(
            !h.invalidations.some(
              (key: any[]) =>
                key.includes(accountId === 'general' ? 'season' : 'general') ||
                key[0] === 'asset',
            ),
          );
          await act(async () => h.success().onGoAssetDetail());
          assert.equal(h.success().visible, false);
          assert.deepEqual(h.navigation, [['back']]);
        });
      }
  for (const change of ['account', 'asset', 'side']) {
    it(`a delayed buy quote cannot create after ${change} changes`, async (t) => {
      const h = inlineTradingHarness();
      h.quoteGate = deferred();
      await h.mount();
      t.after(h.close);
      await h.input(qty, '1');
      await h.press(submit);
      assert.equal(h.requests.length, 1);
      if (change === 'side') await h.press(sell);
      else {
        if (change === 'account') {
          h.accountId = 'season';
          h.routeAccountId = 'season';
        } else {
          h.assetId = 'btc';
        }
        await h.update();
      }
      // The replaced form keeps no draft: a side switch is re-picked empty,
      // an account/asset change starts without a method at all.
      if (change === 'side') assert.equal(h.node(qty).props.value, '');
      else assert.equal(h.freshForm(), true);
      await act(async () => h.quoteGate.resolve());
      await h.flush();
      assert.equal(h.requests.length, 1);
      assert.equal(h.success().visible, false);
    });
    it(`a delayed sell quote is discarded after ${change} changes`, async (t) => {
      const h = inlineTradingHarness();
      h.quoteGate = deferred();
      await h.mount();
      t.after(h.close);
      await h.press(sell);
      await h.input(qty, '1');
      await h.press(submit);
      if (change === 'side') await h.press(TEST_IDS.assetDetail.buyButton);
      else {
        if (change === 'account') {
          h.accountId = 'season';
          h.routeAccountId = 'season';
        } else {
          h.assetId = 'btc';
        }
        await h.update();
      }
      await act(async () => h.quoteGate.resolve());
      await h.flush();
      if (change === 'side') assert.equal(h.node(qty).props.value, '');
      else assert.equal(h.freshForm(), true);
      assert.equal(h.node(submit).props.state, 'disabled');
      assert.equal(h.requests.length, 1);
      assert.equal(h.success().visible, false);
    });
  }
  for (const side of ['buy', 'sell']) {
    it(`a late ${side} create refreshes only the original account without a stale success sheet`, async (t) => {
      const h = inlineTradingHarness();
      h.createGate = deferred();
      await h.mount();
      t.after(h.close);
      if (side === 'sell') await h.press(sell);
      await h.input(qty, '1');
      await h.press(submit);
      h.accountId = 'season';
      h.routeAccountId = 'season';
      await h.update();
      await act(async () => h.createGate.resolve());
      await h.flush();
      assert.equal(h.requests.length, 2);
      assert.equal(h.success().visible, false);
      assert.ok(h.invalidations.some((key: any[]) => key.includes('general')));
      assert.ok(h.invalidations.every((key: any[]) => !key.includes('season')));
    });
  }
  for (const side of ['buy', 'sell']) {
    it(`${side} ignores a second create press before React disables the button`, async (t) => {
      const h = inlineTradingHarness();
      h.createGate = deferred();
      await h.mount();
      t.after(h.close);
      if (side === 'sell') await h.press(sell);
      await h.input(qty, '0.5');
      const action = h.node(submit).props.onPress;
      await act(async () => {
        action();
        action();
      });
      assert.equal(h.requests.length, 2);
      await act(async () => h.createGate.resolve());
      await h.flush();
      assert.equal(h.requests.length, 2);
    });
    for (const code of [
      'QUOTE_EXPIRED',
      'RATE_CHANGED_REQUOTE_REQUIRED',
      'ORDER_IDEMPOTENCY_CONFLICT',
    ]) {
      it(`${side} clears the unusable quote after ${code}`, async (t) => {
        const h = inlineTradingHarness();
        h.failure = { response: { data: { error: { code } } } };
        await h.mount();
        t.after(h.close);
        if (side === 'sell') await h.press(sell);
        await h.input(qty, '0.5');
          await h.press(submit);
        await h.flush();
        assert.equal(h.success().visible, false);
        h.failure = null;
        await h.press(submit);
        await h.flush();
        assert.equal(
          h.requests.filter((r: any) => r.url.endsWith('/quote')).length,
          2,
        );
        assert.notEqual(
          h.requests[1].body.idempotencyKey,
          h.requests[3].body.idempotencyKey,
        );
        assert.equal(h.success().visible, true);
      });
    }
  }
  it('retries an uncertain buy with the same quote and idempotency key', async (t) => {
    const h = inlineTradingHarness();
    h.failure = new Error('connection lost');
    await h.mount();
    t.after(h.close);
    await h.input(qty, '1');
    await h.press(submit);
    await h.flush();
    h.failure = null;
    await h.press(submit);
    await h.flush();
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.requests[2], h.requests[1]);
    assert.equal(h.success().visible, true);
  });
  it('rejects an expired sell quote before create, then allows an explicit retry', async (t) => {
    const h = inlineTradingHarness(); h.ttl = -1;
    await h.mount(); t.after(h.close);
    await h.press(sell); await h.input(qty, '1'); await h.press(submit); await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.success().visible, false);
    h.ttl = 60000; await h.press(submit); await h.flush();
    assert.equal(h.requests.length, 3);
    assert.equal(h.success().visible, true);
  });
  it('locks input and the method field through quote and create, including direct stale callbacks', async (t) => {
    const h = inlineTradingHarness(); h.quoteGate = deferred();
    await h.mount(); t.after(h.close);
    await h.input(qty, '1');
    // A 지정가 row callback captured from the sheet before submitting.
    await h.press('order-type-select');
    const staleLimit = h.node('order-method-limit').props.onPress;
    await h.press('order-method-market');
    await h.press(submit); await h.flush();
    assert.equal(h.node(qty).props.editable, false);
    // The 주문방식 field refuses input while the command is in flight.
    assert.equal(h.node(TEST_IDS.order.typeSelect).props.disabled, true);
    assert.equal(h.node(TEST_IDS.order.typeSelect).props.accessibilityState.disabled, true);
    await h.input(qty, '2');
    await act(async () => staleLimit());
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node(qty).props.value, '1');
    await act(async () => h.quoteGate.resolve()); await h.flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].body.amount, '1');
    assert.equal(h.requests[1].body.orderType, undefined);
  });
  it('uses each account holdings for ratios and blocks overselling and suspended accounts', async (t) => {
    const h = inlineTradingHarness();
    await h.mount();
    t.after(h.close);
    await h.press(sell);
    await h.press('order-ratio-100');
    assert.equal(h.node(qty).props.value, '4');
    h.accountId = 'season';
      h.routeAccountId = 'season';
    await h.update();
    await h.press(sell);
    await h.press('order-ratio-100');
    assert.equal(h.node(qty).props.value, '1');
    await h.input(qty, '2');
    assert.equal(h.node(submit).props.state, 'disabled');
    h.accounts[1].status = 'suspended';
    await h.update();
    await h.input(qty, '0.5');
    assert.equal(h.node(submit).props.state, 'disabled');
  });
  it('keeps old account holdings and quotes away after switching A → B → A', async (t) => {
    const h = inlineTradingHarness();
    h.quoteGate = deferred();
    await h.mount();
    t.after(h.close);
    await h.input(qty, '1');
    await h.press(submit);
    h.accountId = 'season';
      h.routeAccountId = 'season';
    await h.update();
    h.accountId = 'general';
    h.routeAccountId = 'general';
    await h.update();
    await act(async () => h.quoteGate.resolve());
    await h.flush();
    assert.equal(h.freshForm(), true);
    assert.equal(h.requests.length, 1);
  });
});

describe('trading and chart screen boundaries', () => {
  it('resets the display toggle and inputs on pair replacement and changes the pair in place', async (t) => {
    const h = inlineTradingHarness();
    await h.mount();
    t.after(h.close);
    await h.press('asset-krw-toggle');
    await h.input(qty, '1');
    await h.press('asset-change-pair');
    assert.equal(h.node('order-asset-sheet') !== undefined, true);
    await h.press('order-asset-sheet-close');
    await h.press('asset-open-chart');
    assert.deepEqual(h.navigation, [['AssetChart', { assetId: 'bnb' }]]);
    h.assetId = 'btc';
    await h.update();
    assert.equal(h.freshForm(), true);
    assert.equal(
      h.node('asset-krw-toggle').props.accessibilityState.selected,
      false,
    );
    assert.ok(h.queries.every((q: any) => q.queryKey[1] !== 'candles'));
    assert.equal(h.candleOptions, undefined);
  });
  it('keeps all candle work on the focused chart, merges live data and resyncs REST', async (t) => {
    const h = inlineTradingHarness();
    h.Screen = h.Chart;
    await h.mount();
    t.after(h.close);
    assert.equal(h.candleOptions.enabled, true);
    const baseline =
      h.renderer.root.findByType('CandlestickChart').props.candles;
    h.candle = {
      assetId: 'bnb',
      interval: '5m',
      candle: { ...baseline[0], close: '768' },
    };
    await h.update();
    assert.equal(
      h.renderer.root.findByType('CandlestickChart').props.candles[0].close,
      '768',
    );
    h.candleStale = true;
    h.resync = 1;
    await h.update();
    assert.equal(
      h.renderer.root.findByType('CandlestickChart').props.candles[0].close,
      '765',
    );
    assert.equal(h.refetches, 1);
    h.focused = false;
    h.queries = [];
    await h.update();
    assert.equal(h.candleOptions.enabled, false);
    assert.ok(h.queries.every((q: any) => q.enabled === false));
    assert.equal(h.node('inline-order-panel') === undefined, true);
    await h.press('asset-chart-back');
    assert.deepEqual(h.navigation, [['back']]);
  });
});
