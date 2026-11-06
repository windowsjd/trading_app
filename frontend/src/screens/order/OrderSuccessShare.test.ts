import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { marketResult } = require('../../../test/browser/marketExecutionFixtures.js');
const { ORDER_SHARE_NOTE } = require('../../features/share/orderShare.ts');

const ACCOUNT = 'account-1';
/** An executed market SELL of `asset` (the fixture's full fill, as a SELL). */
const sell = (order: Record<string, unknown> = {}, execution: Record<string, unknown> = {}) => {
  const result = marketResult('full');
  return {
    ...result,
    order: { ...result.order, id: 'sell-1', orderId: 'sell-1', assetId: 'asset', side: 'sell', ...order },
    execution: { ...result.execution, ...execution },
  };
};
const completed = (overrides: Record<string, unknown> = {}) => ({
  kind: 'spot', key: 'spot:asset', assetId: 'asset', symbol: 'EXAMPLE', name: 'Example', market: 'KRX',
  assetType: 'domestic_stock', currencyCode: 'KRW', buyAmount: '90090.00000000', realizedPnl: '9810.00000000',
  returnRate: '10.88911089', completedAt: '2026-10-02T01:00:00.000Z', lastSellOrderId: 'sell-1',
  averageBuyPrice: '90.00000000', averageSellPrice: '100.00000000', displayPriceDecimals: null, ...overrides,
});

function sheet(options: { trades?: () => Promise<unknown>; held?: string | null } = {}) {
  const h = interactionHarness();
  const reads: string[] = [];
  const calls: string[] = [];
  const api = {
    getCompletedTrades: async (accountId: string) => {
      reads.push(`completed-trades:${accountId}`);
      return options.trades ? options.trades() : { tradingAccountId: accountId, items: [], hasMore: false };
    },
    getTradingAccountPositions: async (accountId: string, params: { assetId: string }) => {
      reads.push(`positions:${accountId}:${params.assetId}`);
      if (options.held === null) throw new Error('positions unavailable');
      return { tradingAccountId: accountId, positions: options.held ? [{ assetId: params.assetId, quantity: options.held }] : [] };
    },
    getAccountPositionQuantity: (positions: any, assetId: string) =>
      positions?.positions.find((position: any) => position.assetId === assetId)?.quantity ?? '0',
  };
  const Sheet = h.load('src/screens/order/OrderSuccessBottomSheet.tsx', {
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/common/BottomSheetBackdrop': { default: 'BottomSheetBackdrop', __esModule: true },
    '../history/TradeShareSheet': { default: 'TradeShareSheet', __esModule: true },
    '../../features/tradingAccount/api': api,
  }).default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: any;
  // `null` renders the sheet without an account (as the older fixtures do).
  const element = (payload: unknown, accountId: string | null = ACCOUNT, visible = true) =>
    React.createElement(QueryClientProvider, { client }, React.createElement(Sheet, {
      visible, payload, accountId: accountId ?? undefined, displayPriceDecimals: null,
      onClose: () => calls.push('close'), onGoHome: () => calls.push('home'), onGoOrderHistory: () => calls.push('history'),
    }));
  // React Query notifies on a timer: wait past it, as the other screen harnesses do.
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return {
    reads, calls,
    async show(payload: unknown, accountId?: string | null, visible?: boolean) {
      if (renderer) act(() => renderer.update(element(payload, accountId, visible)));
      else renderer = h.render(element(payload, accountId, visible));
      await flush();
    },
    flush,
    close: () => act(() => renderer?.unmount()),
    button: (label: string) => renderer.root.findAll((node: any) => node.type === 'CTAButton' && node.props.label === label)[0],
    share: () => renderer.root.findAll((node: any) => node.type === 'CTAButton' && node.props.testID === 'order-success-share')[0],
    note: () => {
      const node = renderer.root.findAll((item: any) => item.type === 'Text' && item.props.testID === 'order-success-share-note')[0];
      return node ? [node.props.children].flat().join('') : null;
    },
    backdrop: () => renderer.root.findByType('BottomSheetBackdrop').props,
    scroll: () => Object.assign({}, ...[renderer.root.findByType('ScrollView').props.style].flat()),
    shareSheet: () => renderer.root.findAll((node: any) => node.type === 'TradeShareSheet').map((node: any) => node.props),
  };
}

describe('order success 공유하기 and 주문으로 돌아가기', () => {
  it('a BUY, an open limit or LOC registration and an account-less result offer no 공유하기 and read nothing', async (t) => {
    const h = sheet();
    t.after(h.close);
    for (const payload of [
      marketResult('full'),
      marketResult('limit'),
      sell({ orderType: 'limit', status: 'submitted', executedAt: null }, { state: 'submitted' }),
      sell({ orderType: 'limit', status: 'submitted', limitOnClose: { sessionDate: '2026-10-02' } }, { state: 'submitted' }),
    ]) {
      await h.show(payload);
      assert.equal(h.share() === undefined, true);
    }
    await h.show(sell(), null);
    assert.equal(h.share() === undefined, true, 'no account, no share');
    assert.equal(h.shareSheet().length, 0, 'no share sheet without an account');
    assert.deepEqual(h.reads, []);
  });

  it('the SELL that completed its trade opens that trade’s 수익 공유 sheet in place of the result; closing it brings the result back', async (t) => {
    const trade = completed();
    const h = sheet({ trades: async () => ({ tradingAccountId: ACCOUNT, items: [trade], hasMore: false }), held: '0' });
    t.after(h.close);
    await h.show(sell());
    assert.deepEqual(h.reads, [`completed-trades:${ACCOUNT}`, `positions:${ACCOUNT}:asset`]);
    assert.equal(h.share().props.state, 'enabled');
    assert.equal(h.note(), null);
    act(() => h.share().props.onPress());
    act(() => h.share().props.onPress());
    const [opened] = h.shareSheet();
    assert.equal(h.shareSheet().length, 1, 'one share sheet, however often 공유하기 is pressed');
    assert.equal(opened.trade === trade, true);
    assert.equal(opened.accountId, ACCOUNT);
    assert.equal(h.backdrop().visible, false, 'the result steps aside while sharing');
    act(() => opened.onClose());
    assert.equal(h.shareSheet()[0].trade, null);
    assert.equal(h.backdrop().visible, true, 'closing the share sheet returns to the result');
    assert.deepEqual(h.calls, [], 'sharing never closes the result or navigates');
    await h.flush();
    assert.equal(h.reads.length, 2, 'one check per executed order');
  });

  it('a SELL that left part of the holding cannot share yet and says why', async (t) => {
    const h = sheet({ held: '3' });
    t.after(h.close);
    await h.show(sell({ marketExecution: { status: 'partial', executedQuantity: '7', canceledQuantity: '3', requestedQuantity: '10' } }));
    assert.equal(h.share().props.state, 'disabled');
    assert.equal(h.note(), ORDER_SHARE_NOTE.holding);
    act(() => h.share().props.onPress());
    assert.equal(h.shareSheet()[0].trade, null);
  });

  it('a trade closed by another SELL, an older server or another account’s answer is never this order’s card', async (t) => {
    for (const answer of [
      { tradingAccountId: ACCOUNT, items: [completed({ lastSellOrderId: 'sell-0' })], hasMore: false },
      { tradingAccountId: ACCOUNT, items: [completed({ lastSellOrderId: undefined })], hasMore: false },
      { tradingAccountId: 'account-2', items: [completed()], hasMore: false },
    ]) {
      const h = sheet({ trades: async () => answer, held: '0' });
      await h.show(sell());
      assert.equal(h.share().props.state, 'disabled');
      assert.equal(h.note(), ORDER_SHARE_NOTE.unverified);
      act(() => h.share().props.onPress());
      assert.equal(h.shareSheet()[0].trade, null);
      h.close();
    }
  });

  it('a failed check is asked again on press; an unknown holding never claims one', async (t) => {
    let fail = true;
    const h = sheet({
      trades: async () => {
        if (fail) throw new Error('offline');
        return { tradingAccountId: ACCOUNT, items: [completed()], hasMore: false };
      },
      held: null,
    });
    t.after(h.close);
    await h.show(sell());
    assert.equal(h.share().props.state, 'enabled');
    assert.equal(h.note(), ORDER_SHARE_NOTE.failed);
    fail = false;
    act(() => h.share().props.onPress());
    await h.flush();
    assert.equal(h.reads.filter((read) => read.startsWith('completed-trades')).length, 2);
    assert.equal(h.note(), null);
    act(() => h.share().props.onPress());
    assert.equal(h.shareSheet()[0].trade.key, 'spot:asset');
  });

  it('주문으로 돌아가기 only closes the result; 홈으로 가기 and 주문내역 보기 keep their actions', async (t) => {
    const h = sheet();
    t.after(h.close);
    await h.show(sell());
    assert.equal(h.button('종목 상세로 돌아가기') === undefined, true);
    act(() => h.button('주문으로 돌아가기').props.onPress());
    act(() => h.button('홈으로 가기').props.onPress());
    await h.show(marketResult('limit'));
    act(() => h.button('주문내역 보기').props.onPress());
    assert.deepEqual(h.calls, ['close', 'home', 'history']);
  });

  it('the whole result stays on screen: the sheet is bounded and its result area scrolls first', async (t) => {
    const h = sheet();
    t.after(h.close);
    await h.show(marketResult('full'));
    // 320 × 568 at 2× text, no top inset in this harness: 24 dp stay above the sheet.
    assert.equal(h.backdrop().sheetStyle.maxHeight, 568 - 24);
    assert.equal(h.scroll().flexShrink, 1);
    assert.equal(h.scroll().maxHeight, 568 * 0.65);
    await h.show(sell());
    assert.equal(h.scroll().maxHeight, 568 * 0.55, '공유하기 leaves the result a little less room');
  });

  it('a hidden result reads nothing', async (t) => {
    const h = sheet();
    t.after(h.close);
    await h.show(sell(), ACCOUNT, false);
    assert.deepEqual(h.reads, []);
  });
});
