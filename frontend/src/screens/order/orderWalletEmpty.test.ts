import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');
const amount = TEST_IDS.order.quantityInput;
const EMPTY = '지갑이 비어있습니다';
const REMOVED = '예상 수량은 서버 견적에서 확인됩니다.';
const helper = (h: any) => ({
  empty: h.node('order-wallet-empty')?.props.children ?? null,
  estimate: h.node('order-estimated-quantity')?.props.children ?? null,
});
const removedShown = (h: any) => JSON.stringify(h.renderer.toJSON()).includes(REMOVED);

/** Crypto Spot BUY (매수 금액 input) on the harness's bnb, paid from the account's crypto_spot USD wallet. */
async function cryptoBuy(t: any, setup: (h: any) => void = () => {}) {
  const h = inlineTradingHarness();
  setup(h);
  await h.mount();
  t.after(h.close);
  return h;
}

describe('crypto spot buy: 지갑이 비어있습니다 under the 매수 금액 input', () => {
  it('shows when the buy wallet holds exactly nothing; the old default line is gone', async (t) => {
    const h = await cryptoBuy(t, (h) => { h.usdBalance = '0.00000000'; h.usdReserved = '0'; h.usdAvailable = '0'; });
    assert.deepEqual(helper(h), { empty: EMPTY, estimate: null });
    assert.equal(removedShown(h), false);
    // This account's wallet is the one read.
    const read = h.queries.findLast((query: any) => query.queryKey[1] === 'wallets');
    assert.deepEqual(read.queryKey, ['tradingAccount', 'wallets', h.accountId, 'balances']);
  });

  it('nothing under the input while the wallet holds money and no amount is entered', async (t) => {
    const h = await cryptoBuy(t, (h) => { h.usdBalance = '10000'; h.usdAvailable = '9000'; });
    assert.deepEqual(helper(h), { empty: null, estimate: null });
    assert.equal(removedShown(h), false, 'the old default line is not drawn');
  });

  it('cash only reserved by open orders is not an empty wallet', async (t) => {
    const h = await cryptoBuy(t, (h) => { h.usdBalance = '1000'; h.usdReserved = '1000'; h.usdAvailable = '0'; });
    assert.deepEqual(helper(h), { empty: null, estimate: null });
  });

  it('judges the crypto Spot wallet, never the securities one in the same currency', async (t) => {
    const cryptoEmpty = await cryptoBuy(t, (h) => { h.usdBalance = '0'; h.usdAvailable = '0'; h.securitiesUsdBalance = '5000'; });
    assert.equal(helper(cryptoEmpty).empty, EMPTY);
    const securitiesEmpty = await cryptoBuy(t, (h) => { h.usdBalance = '700'; h.securitiesUsdBalance = '0'; });
    assert.equal(helper(securitiesEmpty).empty, null);
  });

  it('an unknown wallet (loading, failed, no such wallet row) is never called empty', async (t) => {
    const loading = await cryptoBuy(t, (h) => { h.usdBalance = '0'; h.walletState = { isLoading: true, isPending: true, data: undefined }; });
    assert.deepEqual(helper(loading), { empty: null, estimate: null });
    const failed = await cryptoBuy(t, (h) => { h.usdBalance = '0'; h.usdAvailable = '0'; h.walletState = { isError: true, error: new Error('offline') }; });
    assert.deepEqual(helper(failed), { empty: null, estimate: null }, 'a failed refresh does not trust the last zero');
    const missing = await cryptoBuy(t, (h) => {
      h.walletState = { data: { wallets: [{ walletScope: 'securities', currencyCode: 'USD', balanceAmount: '0' }] } };
    });
    assert.deepEqual(helper(missing), { empty: null, estimate: null });
  });

  it('an entered amount keeps showing its estimated quantity (empty wallet or not)', async (t) => {
    for (const balance of ['10000', '0']) {
      const h = await cryptoBuy(t, (h) => { h.usdBalance = balance; h.usdAvailable = balance; });
      await h.input(amount, '100');
      const { empty, estimate } = helper(h);
      assert.equal(empty, null, balance);
      assert.match(String(estimate), /^예상 수량 약 0\.13\d* BNB$/, balance);
      await h.input(amount, '');
      assert.equal(helper(h).empty, balance === '0' ? EMPTY : null, `${balance}: back to the wallet state`);
    }
  });

  it('a SELL has no 매수 금액 line', async (t) => {
    const h = await cryptoBuy(t, (h) => { h.routeSide = 'sell'; h.usdBalance = '0'; h.usdAvailable = '0'; });
    assert.deepEqual(helper(h), { empty: null, estimate: null });
  });
});
