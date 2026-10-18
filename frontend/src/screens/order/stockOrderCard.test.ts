import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

const qty = TEST_IDS.order.quantityInput;
const limitPrice = TEST_IDS.order.limitPriceInput;
const sell = TEST_IDS.assetDetail.sellButton;
const now = new Date().toISOString();

/** testIDs of the host nodes under one node (small strings, never the tree). */
const idsWithin = (h: any, parentId: string): string[] => {
  const parent = h.node(parentId);
  return parent ? parent.findAll((n: any) => typeof n.type === 'string' && n.props.testID).map((n: any) => n.props.testID) : [];
};
const text = (node: any): string | undefined => node ? [node.props.children].flat().join('') : undefined;
/** All text under a node, nested Text included. */
const deepText = (node: any): string => !node ? '' : node.children.map((child: any) => typeof child === 'string' ? child : deepText(child)).join('');
/** A summary row's value (`<row>-value`) and its label (the row's first text). */
const value = (h: any, row: string) => text(h.node(`${row}-value`));
const label = (h: any, row: string) => text(h.node(row)?.findAll((n: any) => n.type === 'Text')[0]);
const count = (h: any, id: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id).length;
async function waitFor(h: any, ready: () => boolean) {
  for (let i = 0; i < 20 && !ready(); i += 1) await h.flush();
  assert.equal(ready(), true, 'the screen settles');
}
function stock(h: any, marketStatus = 'open') {
  h.accountId = 'general';
  h.assetId = 'samsung';
  h.assets.samsung.marketStatus = marketStatus;
  h.assets.samsung.tradable = marketStatus === 'open';
}
function holding(assetId: string, quantity: string, overrides: Record<string, unknown> = {}) {
  return {
    assetId, positionId: `general-${assetId}`, symbol: assetId.toUpperCase(), name: assetId, market: 'KRX', assetType: 'domestic_stock',
    currencyCode: 'KRW', quantity, averageCost: '60000', realizedPnl: '0', realizedPnlKrw: '0',
    valuation: { state: 'available', currentPrice: '70000', priceCurrency: 'KRW', assetPriceSnapshotId: 'snap', priceEffectiveAt: now,
      priceCapturedAt: now, priceSource: null, positionValue: '840000', positionValueKrw: '840000', unrealizedPnl: '120000',
      unrealizedPnlKrw: '120000', returnRate: '16.67' },
    ...overrides,
  };
}

describe('stock order card (A-2)', () => {
  it('keeps the inputs left and draws 시세, 내 보유 and 예상 주문 right; the list below holds only the other holdings', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.holdings = { general: [holding('samsung', '12'), holding('hynix', '3', { name: 'SK Hynix', symbol: '000660' })] };
    await h.mount(); t.after(h.close);
    await waitFor(h, () => h.node('order-holding-quantity-value') !== undefined);
    const right = idsWithin(h, 'asset-price-column'), left = idsWithin(h, 'asset-order-column');
    assert.deepEqual(['asset-current-price', 'order-quote-toggle', 'order-holding-summary', 'order-indicative-preview'].map((id) => right.includes(id)),
      [true, true, true, true]);
    assert.deepEqual(['order-indicative-preview', 'order-holding-summary'].map((id) => left.includes(id)), [false, false]);
    assert.deepEqual([qty, 'order-type-select', 'order-available-helper', TEST_IDS.order.executeSubmit].map((id) => left.includes(id)), [true, true, true, true]);
    assert.equal(h.node(`${qty}-unit`).props.children, '주');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매수 주문');
    // 내 보유 from the account's own holdings read.
    assert.deepEqual(['order-holding-quantity', 'order-holding-average'].map((id) => value(h, id)), ['12주', '60,000원']);
    assert.equal(text(h.node('order-holding-return')), '+16.67%');
    // The current holding is not listed again below.
    assert.deepEqual([count(h, 'holding-samsung'), count(h, 'holding-hynix'), count(h, 'order-holding-summary')], [0, 1, 1]);
    assert.equal(text(h.node('holdings-count')), '다른 보유 종목 1');
    assert.equal(h.node('holdings-filter-current') === undefined, true);
    // The change rate only (no amount or day range exists in the price contract).
    assert.equal(deepText(h.node('order-change-rate')), '전일대비 ▲ +0.33%');
  });

  it('예상 주문 follows price, quantity and ratio in the same render', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    await h.mount(); t.after(h.close);
    assert.deepEqual([text(h.node('order-summary-badge')), value(h, 'order-summary-price'), value(h, 'order-summary-quantity')], ['즉시 체결', '시장가', '-']);
    await h.input(qty, '2');
    // 70,000 × 2 with the 0.1% fee: the existing indicative preview, now in the card.
    assert.deepEqual(['order-summary-quantity', 'order-summary-fee', 'order-summary-total', 'order-summary-after'].map((id) => value(h, id)),
      ['2주', '140원', '140,140원', '859,860원']);
    assert.deepEqual([label(h, 'order-summary-total'), label(h, 'order-summary-after')], ['예상 결제금액', '주문 후 사용 가능']);

    await h.selectOrderType('limit');
    assert.deepEqual([text(h.node('order-summary-badge')), value(h, 'order-summary-price'), value(h, 'order-max-quantity')], ['체결 대기', '-', '-']);
    await h.input(limitPrice, '69000');
    await h.input(qty, '3');
    assert.deepEqual(['order-summary-price', 'order-summary-quantity', 'order-summary-fee', 'order-summary-total', 'order-summary-after'].map((id) => value(h, id)),
      ['69,000원', '3주', '207원', '207,207원', '792,793원']);
    // A pending limit reserves; it is never shown as a payment.
    assert.equal(label(h, 'order-summary-total'), '예상 예약금액');
    // 1,000,000 / (69,000 × 1.002) = 14.46…: whole shares for a limit order.
    assert.equal(value(h, 'order-max-quantity'), '14주');
    assert.equal(value(h, 'order-available-amount'), '1,000,000 KRW');
    await h.press('order-ratio-50');
    assert.deepEqual([h.node(qty).props.value, value(h, 'order-summary-quantity'), value(h, 'order-summary-total')], ['7', '7주', '483,483원']);
  });

  it('a closed market: 지정가 waits for the regular session, 시장가 is not accepted', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'closed');
    await h.mount(); t.after(h.close);
    assert.deepEqual([text(h.node('order-summary-badge')), value(h, 'order-summary-total')], ['주문 불가', '-']);
    await h.input(qty, '1');
    assert.deepEqual(['order-summary-fee', 'order-summary-total', 'order-summary-after'].map((id) => value(h, id)), ['-', '-', '-'],
      'an order the session does not accept shows no amounts');
    await h.selectOrderType('limit');
    await h.input(limitPrice, '70000');
    await h.input(qty, '1');
    assert.deepEqual([text(h.node('order-summary-badge')), value(h, 'order-summary-total')], ['정규장 대기', '70,070원']);
    assert.equal(text(h.node('asset-market-status')), '장마감');
  });

  it('a total above what can be used reads 부족; a sell card has no 주문 후 매도 가능 row', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.krwBalance = '100000';
    await h.mount(); t.after(h.close);
    await h.selectOrderType('limit');
    await h.input(limitPrice, '69000');
    await h.input(qty, '2');
    assert.deepEqual([value(h, 'order-summary-total'), value(h, 'order-summary-after')], ['138,138원', '부족']);
    assert.equal(h.node('order-balance-insufficient') !== undefined, true, 'the existing pre-check still blocks it');
    await h.press(sell);
    await h.input(qty, '1');
    assert.equal(label(h, 'order-summary-total'), '예상 수령액');
    // The row (and its value) is gone; the card's last row is 예상 수령액.
    assert.equal(h.node('order-summary-after') === undefined, true);
    assert.deepEqual(idsWithin(h, 'order-indicative-preview').filter((id) => id.startsWith('order-summary-') && !id.endsWith('-value')),
      ['order-summary-badge', 'order-summary-price', 'order-summary-quantity', 'order-summary-amounts', 'order-summary-fee', 'order-summary-total']);
    // What stays sellable is still computed and shown where it was before.
    assert.deepEqual([value(h, 'order-sell-capacity'), h.node(TEST_IDS.order.executeSubmit).props.label], ['4주', '매도 주문']);
    await h.input(qty, '5');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'disabled', 'above the sellable quantity is still refused');
  });

  it('a LOC SELL above the unreserved part leaves nothing sellable, not a shortfall', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.method = null;
    h.positions.general = '10';
    h.positionAvailable = { general: '4' };
    h.positionReserved = { general: '6' };
    h.orderCapabilities = { tradingAccountId: 'general', limitOrder: { enabled: true, autoExecutionEnabled: true },
      limitOnClose: { enabled: false, markets: ['KRX'], sides: ['buy'], attachedProtection: false }, limitOnCloseSell: { enabled: true, markets: ['KRX'] } };
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.selectOrderType('loc');
    await h.input(limitPrice, '70000');
    await h.input(qty, '10');
    assert.equal(h.node('loc-sell-adjust-notice') !== undefined, true, 'the form says only the unreserved part is accepted');
    assert.deepEqual([text(h.node('order-summary-badge')), value(h, 'order-summary-quantity')], ['종가 대기', '10주']);
    assert.equal(h.node('order-summary-after') === undefined, true, 'no 주문 후 매도 가능 row on a SELL');
    await h.input(qty, '11');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'disabled', 'above the holding itself is still refused');
  });

  it('a side change or a moved account never leaves the previous form\'s 예상 주문', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    await h.mount(); t.after(h.close);
    await h.input(qty, '2');
    assert.equal(value(h, 'order-summary-quantity'), '2주');
    await h.press(sell);
    assert.deepEqual([count(h, 'order-indicative-preview'), value(h, 'order-summary-quantity'), label(h, 'order-summary-total')], [1, '-', '예상 수령액']);
    // The selection moving to another account blocks this route's form; its card goes with it.
    h.accountId = 'season';
    await h.update();
    assert.equal(count(h, 'order-indicative-preview'), 0);
  });

  it('접기 folds 시세 only; 내 보유 and 예상 주문 stay', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    await h.mount(); t.after(h.close);
    await h.press('order-quote-toggle');
    assert.deepEqual([count(h, 'asset-current-price'), count(h, 'order-holding-summary'), count(h, 'order-indicative-preview')], [0, 1, 1]);
    assert.deepEqual([text(h.node('order-quote-toggle').findByType('Text')), h.node('order-quote-toggle').props.accessibilityState.expanded], ['펼치기', false]);
    await h.press('order-quote-toggle');
    assert.equal(count(h, 'asset-current-price'), 1);
  });

  it('folding never hides the trial-price notice the amounts are based on', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.assets.samsung.price = { ...h.assets.samsung.price, priceSource: { sourceType: 'provider_api', sourceName: 'tiingo_equity_reference_price' } };
    await h.mount(); t.after(h.close);
    assert.equal(count(h, 'asset-trial-price-notice'), 1);
    await h.press('order-quote-toggle');
    assert.deepEqual([count(h, 'asset-current-price'), count(h, 'asset-trial-price-notice')], [0, 1]);
  });

  it('the submit button reads the expected total (예상 주문 is read after it), and the amounts are the guide\'s target', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    await h.mount(); t.after(h.close);
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.accessibilityHint, undefined, 'nothing to read before an amount');
    await h.input(qty, '2');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.accessibilityHint, '예상 결제금액 140,140원');
    // The guide's 금액과 수수료 step points at the fee and total rows only.
    assert.deepEqual(idsWithin(h, 'order-summary-amounts').filter((id) => id.endsWith('-value')),
      ['order-summary-fee-value', 'order-summary-total-value']);
    assert.equal(idsWithin(h, 'order-indicative-preview').includes('order-summary-amounts'), true);
  });

  it('a failed holdings read shows its error in 내 보유 without the 손절가/익절가 action', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.holdings = { general: [holding('samsung', '12')] };
    await h.mount(); t.after(h.close);
    await waitFor(h, () => h.node('holding-samsung-tp-sl') !== undefined);
    h.holdingsError = new Error('holdings unavailable');
    await h.client.refetchQueries({ queryKey: ['tradingAccount'] });
    await waitFor(h, () => h.node('order-holding-retry') !== undefined);
    assert.equal(h.node('holding-samsung-tp-sl') === undefined, true);
  });

  it('a US stock uses the same card in USD', async (t) => {
    const h = inlineTradingHarness();
    h.assets.aapl = { ...h.assets.samsung, id: 'aapl', name: 'Apple', symbol: 'AAPL', assetType: 'us_stock', market: 'NASDAQ',
      priceCurrency: 'USD', settlementCurrency: 'USD', displayPriceDecimals: 2, marketStatus: 'open', tradable: true,
      price: { ...h.assets.samsung.price, currentPrice: '190.12', priceCurrency: 'USD', changeRate: '-0.46', priceCapturedAt: new Date().toISOString() } };
    h.accountId = 'general';
    h.assetId = 'aapl';
    await h.mount(); t.after(h.close);
    await h.input(qty, '2');
    assert.deepEqual(['order-summary-fee', 'order-summary-total', 'order-summary-after'].map((id) => value(h, id)), ['$0.38', '$380.62', '$9,619.38']);
    assert.equal(deepText(h.node('order-change-rate')), '전일대비 ▼ -0.46%');
    assert.equal(text(h.node('asset-current-price').findAll((n: any) => n.type === 'Text')[0]), '현재가 · USD');
  });

  it('crypto keeps its form beside the order book', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.input(qty, '0.5');
    assert.deepEqual(['order-quote-toggle', 'order-holding-summary'].map((id) => count(h, id)), [0, 0]);
    assert.equal(idsWithin(h, 'asset-order-column').includes('order-indicative-preview'), true, 'the preview stays under the inputs');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.label, '매수');
    assert.equal(h.node(`${qty}-unit`) === undefined, true);
    assert.equal(h.node('holdings-filter-current') !== undefined, true);
  });
});
