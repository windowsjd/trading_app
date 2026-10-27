import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { questProgress } from '../../../test/questFixtures.ts';

const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');
const guard = require('../../features/quest/questNavigationGuard.ts');
const amount = TEST_IDS.order.quantityInput;
const REMOVED = ['예상 수량은 서버 견적에서 확인됩니다.', '지갑이 비어있습니다', 'USD 환전하러 가기'];
const SPOT_EMPTY = '암호화폐 현물 지갑이 비어 있습니다.';
const SPOT_COMMITTED = '암호화폐 현물 지갑의 금액이 모두 다른 주문에 예약되어 있어 지금 주문할 수 있는 금액이 없습니다.';
const notice = (h: any) => {
  const message = h.node('order-wallet-funding-message');
  return message ? [message.props.children].flat().join('') : null;
};
const helper = (h: any) => ({
  notice: notice(h),
  estimate: h.node('order-estimated-quantity')?.props.children ?? null,
});
const actions = (h: any, id = 'order-wallet-funding') => ['transfer', 'fx'].filter((kind) => h.node(`${id}-${kind}`) !== undefined);
const removedShown = (h: any) => {
  const json = JSON.stringify(h.renderer.toJSON());
  return REMOVED.some((copy) => json.includes(copy));
};
const panels = (h: any, type: string) => h.renderer.root.findAll((node: any) => node.type === type);
const sheetOpen = (h: any, kind: 'transfer' | 'fx') => h.node(`order-${kind}-sheet`) !== undefined;

/** A BUY on the harness's asset (bnb: crypto Spot, paid from the account's crypto_spot USD wallet). */
async function buy(t: any, setup: (h: any) => void = () => {}) {
  const h = inlineTradingHarness();
  setup(h);
  await h.mount();
  t.after(h.close);
  return h;
}
const usStock = (h: any) => {
  h.assets.aapl = { ...h.assets.samsung, id: 'aapl', name: 'Apple', symbol: 'AAPL', assetType: 'us_stock', market: 'NASDAQ',
    priceCurrency: 'USD', settlementCurrency: 'USD', price: { ...h.assets.samsung.price, currentPrice: '200', priceCurrency: 'USD' } };
  h.assetId = 'aapl';
};

describe('order: the paying wallet, named for its product (작업 1 · 4)', () => {
  it('crypto Spot: an empty wallet says so with 이체하기 ›, and no old line remains', async (t) => {
    const h = await buy(t, (h) => { h.usdBalance = '0.00000000'; h.usdReserved = '0'; h.usdAvailable = '0'; });
    assert.deepEqual(helper(h), { notice: SPOT_EMPTY, estimate: null });
    assert.deepEqual(actions(h), ['transfer'], 'a USD transfer is the route into crypto Spot');
    assert.equal(removedShown(h), false);
    // This account's wallet is the one read.
    const read = h.queries.findLast((query: any) => query.queryKey[1] === 'wallets');
    assert.deepEqual(read.queryKey, ['tradingAccount', 'wallets', h.accountId, 'balances']);
  });

  it('nothing while the wallet holds usable money', async (t) => {
    const h = await buy(t, (h) => { h.usdBalance = '10000'; h.usdAvailable = '9000'; });
    assert.deepEqual(helper(h), { notice: null, estimate: null });
    assert.equal(removedShown(h), false);
  });

  it('money only reserved by open orders is its own notice, never an empty wallet', async (t) => {
    const h = await buy(t, (h) => { h.usdBalance = '1000'; h.usdReserved = '1000'; h.usdAvailable = '0'; });
    assert.deepEqual(helper(h), { notice: SPOT_COMMITTED, estimate: null });
    assert.equal(notice(h)?.includes('비어 있습니다'), false);
    assert.deepEqual(actions(h), ['transfer']);
  });

  it('judges the crypto Spot wallet, never the securities one in the same currency', async (t) => {
    const cryptoEmpty = await buy(t, (h) => { h.usdBalance = '0'; h.usdAvailable = '0'; h.securitiesUsdBalance = '5000'; });
    assert.equal(notice(cryptoEmpty), SPOT_EMPTY);
    const securitiesEmpty = await buy(t, (h) => { h.usdBalance = '700'; h.securitiesUsdBalance = '0'; });
    assert.equal(notice(securitiesEmpty), null);
  });

  it('an unknown wallet (loading, failed, no such wallet row) is never called empty', async (t) => {
    const loading = await buy(t, (h) => { h.usdBalance = '0'; h.walletState = { isLoading: true, isPending: true, data: undefined }; });
    assert.deepEqual(helper(loading), { notice: null, estimate: null });
    const failed = await buy(t, (h) => { h.usdBalance = '0'; h.usdAvailable = '0'; h.walletState = { isError: true, error: new Error('offline') }; });
    assert.deepEqual(helper(failed), { notice: null, estimate: null }, 'a failed refresh does not trust the last zero');
    const missing = await buy(t, (h) => {
      h.walletState = { data: { wallets: [{ walletScope: 'securities', currencyCode: 'USD', balanceAmount: '0' }] } };
    });
    assert.deepEqual(helper(missing), { notice: null, estimate: null });
  });

  it('an entered amount shows its estimated quantity beside the wallet notice, never instead of it', async (t) => {
    for (const balance of ['10000', '0']) {
      const h = await buy(t, (h) => { h.usdBalance = balance; h.usdAvailable = balance; });
      await h.input(amount, '100');
      const { notice: shown, estimate } = helper(h);
      assert.equal(shown, balance === '0' ? SPOT_EMPTY : null, balance);
      assert.match(String(estimate), /^예상 수량 약 0\.13\d* BNB$/, balance);
      await h.input(amount, '');
      assert.deepEqual(helper(h), { notice: balance === '0' ? SPOT_EMPTY : null, estimate: null }, `${balance}: cleared amount`);
    }
  });

  it('short of usable cash for this amount: the same routes under the error, without calling the wallet empty', async (t) => {
    const h = await buy(t, (h) => { h.usdBalance = '100'; h.usdReserved = '0'; h.usdAvailable = '100'; });
    assert.deepEqual(actions(h, 'order-funding-actions'), []);
    await h.input(amount, '500');
    assert.equal(h.node('order-balance-insufficient') !== undefined, true);
    assert.equal(notice(h), null);
    assert.deepEqual(actions(h, 'order-funding-actions'), ['transfer']);
    assert.equal(h.node('order-funding-actions-message') === undefined, true, 'the error above already says it');
    await h.input(amount, '50');
    assert.deepEqual(actions(h, 'order-funding-actions'), []);
  });

  it('a SELL says nothing about the buy wallet', async (t) => {
    const h = await buy(t, (h) => { h.routeSide = 'sell'; h.usdBalance = '0'; h.usdAvailable = '0'; });
    assert.deepEqual(helper(h), { notice: null, estimate: null });
  });

  it('Korean stock: 증권 원화 지갑, reached only by 환전 (USD → KRW), never a USD transfer', async (t) => {
    const h = await buy(t, (h) => { h.assetId = 'samsung'; h.krwBalance = '0'; });
    assert.equal(notice(h), '증권 원화 지갑이 비어 있습니다.');
    assert.deepEqual(actions(h), ['fx']);
    await h.press('order-wallet-funding-fx');
    assert.equal(sheetOpen(h, 'fx'), true);
    const fx = panels(h, 'WalletFxPanel');
    assert.equal(fx.length, 1);
    assert.equal(fx[0].props.initialFromCurrency, 'USD');
    assert.equal(panels(h, 'WalletTransferPanel').length, 0);
  });

  it('US stock: 증권 달러 지갑, by 환전 (KRW → USD) or a USD transfer into securities', async (t) => {
    const h = await buy(t, (h) => { usStock(h); h.securitiesUsdBalance = '0'; h.usdAvailable = '0'; });
    assert.equal(notice(h), '증권 달러 지갑이 비어 있습니다.');
    assert.deepEqual(actions(h), ['transfer', 'fx']);
    await h.press('order-wallet-funding-transfer');
    assert.equal(panels(h, 'WalletTransferPanel')[0].props.initial.destination, 'securities');
  });
});

describe('order: 이체 / 환전 open over the order and come back to it (작업 2 · 3)', () => {
  it('이체하기 › opens the transfer sheet on this order, into crypto Spot, and closes on success', async (t) => {
    const h = await buy(t, (h) => { h.usdBalance = '0'; h.usdReserved = '0'; h.usdAvailable = '0'; });
    const navigations = h.navigation.length;
    await h.press('order-wallet-funding-transfer');
    assert.equal(h.navigation.length, navigations, 'no page change: the sheet is over the order');
    assert.equal(sheetOpen(h, 'transfer'), true);
    const [panel] = panels(h, 'WalletTransferPanel');
    assert.deepEqual(panel.props.initial, { source: undefined, destination: 'crypto_spot' });
    assert.equal(panel.props.onGoMarket, undefined, 'already at an order: no 마켓으로 가기');
    assert.equal(typeof panel.props.onSucceeded, 'function');
    // A completed transfer closes the sheet; the order form is still there with its wallet re-read.
    await h.input(amount, '50');
    await act(h, () => panel.props.onSucceeded());
    assert.equal(sheetOpen(h, 'transfer'), false);
    assert.equal(panels(h, 'WalletTransferPanel').length, 0);
    assert.equal(h.node(amount).props.value, '50', 'the order input is kept');
  });

  it('a transfer in flight cannot be dismissed; closing otherwise returns to the order', async (t) => {
    const h = await buy(t, (h) => { h.usdBalance = '0'; h.usdAvailable = '0'; });
    await h.press('order-wallet-funding-transfer');
    const [panel] = panels(h, 'WalletTransferPanel');
    await act(h, () => panel.props.onBusyChange(true));
    assert.equal(h.node('order-transfer-sheet-close').props.disabled, true);
    await act(h, () => panel.props.onBusyChange(false));
    await h.press('order-transfer-sheet-close');
    assert.equal(sheetOpen(h, 'transfer'), false);
  });

  it('환전하기 › from the transfer steps to 환전 in the same sheet and back, the transfer never sent by itself', async (t) => {
    const h = await buy(t, (h) => { usStock(h); h.securitiesUsdBalance = '0'; h.usdAvailable = '0'; });
    await h.press('order-wallet-funding-transfer');
    const draft = { source: 'securities', destination: 'crypto_spot', amount: '25' };
    await act(h, () => panels(h, 'WalletTransferPanel')[0].props.onExchange(draft));
    // One sheet at a time: the transfer panel gives way to 환전 (KRW → USD).
    assert.equal(sheetOpen(h, 'transfer'), false);
    assert.equal(sheetOpen(h, 'fx'), true);
    assert.equal(panels(h, 'WalletTransferPanel').length, 0);
    const [fx] = panels(h, 'WalletFxPanel');
    assert.equal(fx.props.initialFromCurrency, 'KRW');
    await act(h, () => fx.props.onExchanged({ exchangeId: 'fx-1' }));
    assert.equal(sheetOpen(h, 'transfer'), true);
    const [back] = panels(h, 'WalletTransferPanel');
    assert.deepEqual(back.props.initial, draft, 'wallets and amount kept');
    assert.match(String(back.props.notice), /환전이 완료되었습니다/);
    assert.equal(h.requests.some((request: any) => /wallet-transfers/.test(request.url)), false, 'nothing transferred');
    // Closing an 환전 reached from the transfer also goes back to that transfer.
    await act(h, () => back.props.onExchange(draft));
    await h.press('order-fx-sheet-close');
    assert.equal(sheetOpen(h, 'transfer'), true);
    assert.deepEqual(panels(h, 'WalletTransferPanel')[0].props.initial, draft);
  });

  it('leaving the order screen or its account closes the sheet for good', async (t) => {
    const h = await buy(t, (h) => { h.usdBalance = '0'; h.usdAvailable = '0'; });
    await h.press('order-wallet-funding-transfer');
    h.focused = false;
    await h.update();
    assert.equal(sheetOpen(h, 'transfer'), false, 'never over another screen');
    h.focused = true;
    await h.update();
    assert.equal(sheetOpen(h, 'transfer'), false, 'coming back shows the order, not an old sheet');
    await h.press('order-wallet-funding-transfer');
    assert.equal(sheetOpen(h, 'transfer'), true);
    h.accountId = 'season';
    await h.update();
    assert.equal(sheetOpen(h, 'transfer'), false, 'another account selected: closed');
    h.accountId = 'general';
    await h.update();
    assert.equal(sheetOpen(h, 'transfer'), false, "the previous account's request does not come back");
    assert.equal(panels(h, 'WalletTransferPanel').length, 0);
  });
});

describe('order: funding obeys the guide and the learning gates', () => {
  it('a quest that holds 이체 keeps the sheet closed; its own practice opens it', async (t) => {
    const owner = () => undefined;
    t.after(() => guard.setQuestNavigationGuard(owner, null));
    const h = await buy(t, (h) => { h.usdBalance = '0'; h.usdAvailable = '0'; });
    guard.setQuestNavigationGuard(owner, 'exchange');
    await h.press('order-wallet-funding-transfer');
    assert.equal(sheetOpen(h, 'transfer'), false, 'held during the exchange practice');
    guard.setQuestNavigationGuard(owner, 'transfer');
    await h.press('order-wallet-funding-transfer');
    assert.equal(sheetOpen(h, 'transfer'), true);
  });

  it('QUEST 03 short of cash: the guide gets the form’s own reason and opens this form’s 이체 sheet; cancel or success keeps the order', async (t) => {
    const bridge = require('../../features/quest/questGuideBridge.ts');
    const owner = () => undefined;
    t.after(() => guard.setQuestNavigationGuard(owner, null));
    // The report: about 10 USD usable, 10 USD entered, 0.01 USD fee.
    const h = await buy(t, (h) => {
      h.accounts.push({ id: 'beginner-1', mode: 'beginner', status: 'active', season: null });
      h.accountId = 'beginner-1';
      h.questProgress = questProgress(2);
      h.usdBalance = '10'; h.usdReserved = '0'; h.usdAvailable = '10';
    });
    guard.setQuestNavigationGuard(owner, 'marketBuy');
    const facts = () => bridge.getQuestGuideFacts('order');
    const guideFacts = () => [facts().insufficientBalance ?? null, facts().transferFunding, facts().fundingOpen, facts().amountValid];
    await h.input(amount, '5');
    assert.deepEqual(guideFacts(), [null, true, false, true], 'enough: nothing to say');
    await h.input(amount, '10');
    assert.equal(h.node('order-balance-insufficient').props.children, '잔액이 부족합니다.');
    assert.deepEqual(guideFacts(), ['잔액이 부족합니다.', true, false, false], 'the same line, for the card');
    // The card's 이체하기: this form's sheet into crypto Spot; nothing is sent by opening it.
    await act(h, () => assert.equal(bridge.openQuestGuideFunding('order'), true));
    assert.equal(sheetOpen(h, 'transfer'), true, 'the marketBuy guide lets the sheet through');
    assert.deepEqual(panels(h, 'WalletTransferPanel')[0].props.initial, { source: undefined, destination: 'crypto_spot' });
    assert.equal(facts().fundingOpen, true, 'the guide steps aside while the sheet is open');
    assert.equal(h.requests.some((request: any) => /wallet-transfers/.test(request.url)), false);
    // Cancel: the same form, amount and account; still short.
    await h.press('order-transfer-sheet-close');
    assert.equal(sheetOpen(h, 'transfer'), false);
    assert.deepEqual([h.node(amount).props.value, facts().accountId], ['10', 'beginner-1']);
    assert.deepEqual(guideFacts(), ['잔액이 부족합니다.', true, false, false]);
    // A completed transfer closes the sheet; the re-read balance lifts the notice.
    await act(h, () => bridge.openQuestGuideFunding('order'));
    h.usdBalance = '60'; h.usdAvailable = '60';
    await act(h, () => panels(h, 'WalletTransferPanel')[0].props.onSucceeded());
    await h.update();
    assert.equal(sheetOpen(h, 'transfer'), false);
    assert.equal(h.node('order-balance-insufficient') === undefined, true);
    assert.deepEqual(guideFacts(), [null, true, false, true]);
    assert.equal(h.node(amount).props.value, '10', 'the order input is kept');
  });

  for (const completed of [0, 1]) it(`beginner with ${completed} quest(s) done: 이체 ${completed ? 'opens' : 'explains its lock'}`, async (t) => {
    const h = await buy(t, (h) => {
      h.accounts.push({ id: 'beginner-1', mode: 'beginner', status: 'active', season: null });
      h.accountId = 'beginner-1';
      h.questProgress = questProgress(completed);
      h.usdBalance = '0'; h.usdAvailable = '0';
    });
    await h.press('order-wallet-funding-transfer');
    assert.equal(sheetOpen(h, 'transfer'), completed === 1);
    assert.equal(h.alerts.length, completed ? 0 : 1);
    if (!completed) assert.equal(h.alerts[0][1], '환전하기 퀘스트를 완료하면 사용할 수 있어요.');
  });
});

async function act(h: any, fn: () => unknown) {
  const { act: run } = require('../../../test/inlineTradingHarness.cjs');
  await run(async () => { await fn(); });
  await h.flush();
}
