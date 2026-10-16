import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { InfiniteData } from '@tanstack/react-query';
import { createRecordScreenHarness, act } from '../../../test/recordScreenHarness.cjs';
import type { RootStackParamList } from '../../app/navigation/types';
import type { TradingAccountOrdersDto } from '../../features/tradingAccount/api';

const scopes: RootStackParamList['TradeHistory'][] = [{ accountId: 'historical' }, { seasonId: 'record-0' }];
for (const scope of scopes) {
  it(`route ${JSON.stringify(scope)} pins read, filter, pagination, refresh and cancel across account switching`, async t => {
    const h = createRecordScreenHarness('history', scope); t.after(h.close); await h.settle();
    assert.ok(h.find('record-order-list-screen'));
    h.selectedAccount = h.accounts[1]; await h.update();
    const flat = h.renderer.root.findByType('FlatList');
    await act(async () => flat.props.onEndReached()); await h.settle();
    assert.ok(h.find('record-order-item-sell-1'));
    assert.deepEqual(h.requests.filter(r => r.params?.offset !== undefined).map(r => r.params.offset), [0, 1]);
    await h.press('record-order-filter-sell');
    assert.equal(h.requests.at(-1).params.side, 'sell');
    assert.equal(Boolean(h.find('record-order-item-limit-1')), false);
    await h.press('record-order-filter-all');
    const beforeRefresh = h.requests.length; await h.refresh();
    assert.ok(h.requests.length > beforeRefresh);
    const beforeCancel = h.requests.length;
    await h.press('record-order-cancel-limit-1');
    await act(async () => h.alerts.at(-1)[2].find(button => button.text === '주문 취소').onPress()); await h.settle();
    assert.ok(h.requests.some(r => r.method === 'POST' && r.path === '/trading-accounts/historical/orders/limit-1/cancel'));
    assert.ok(h.requests.every(r => r.path.startsWith('/trading-accounts/historical/')));
    assert.equal(Boolean(h.find('record-order-cancel-limit-1')), false);
    assert.equal(h.client.getQueryData<InfiniteData<TradingAccountOrdersDto>>(h.orderOptions.queryKey)?.pages[0].orders[0].status, 'canceled');
    assert.ok(h.requests.slice(beforeCancel).some(r => r.method !== 'POST' && r.params.offset === 0));
  });
}
it('submitted order polling respects focus, foreground and terminal state', async t => {
  const h = createRecordScreenHarness('history', { accountId: 'historical' }); t.after(h.close); await h.settle();
  const poll = () => h.orderOptions.refetchInterval({ state: { data: h.client.getQueryData(h.orderOptions.queryKey) } });
  const cachedData = h.client.getQueryData<InfiniteData<TradingAccountOrdersDto>>(h.orderOptions.queryKey);
  assert.ok(cachedData);
  const cachedOrder = cachedData.pages[0].orders[0];
  assert.equal(cachedOrder === h.orders[0], false, 'HTTP order rows must not share server fixture identity');
  assert.equal(cachedOrder.asset === h.orders[0].asset, false, 'nested HTTP objects must not share server fixture identity');
  assert.equal(poll(), 4000);
  h.focused = false; await h.update(); assert.equal(poll(), false);
  h.focused = true; await h.update();
  act(() => h.appState('background')); assert.equal(poll(), false);
  act(() => h.appState('active')); assert.equal(poll(), 4000);
  h.orders[0].status = 'canceled';
  assert.equal(cachedOrder.status, 'submitted', 'server changes must not mutate an earlier HTTP response');
  assert.equal(poll(), 4000, 'polling must use cached data until refetch');
  await h.refresh(); assert.equal(poll(), false);
  const refreshedData = h.client.getQueryData<InfiniteData<TradingAccountOrdersDto>>(h.orderOptions.queryKey);
  assert.ok(refreshedData);
  assert.equal(refreshedData === cachedData, false, 'refetch must publish changed order data');
  assert.equal(refreshedData.pages[0].orders[0].status, 'canceled');
  assert.equal(cachedOrder.status, 'submitted');
});
it('foreign/missing subjects cannot fall back to the selected account', async t => {
  const h = createRecordScreenHarness('history', { seasonId: 'foreign-season' }); t.after(h.close); await h.settle();
  assert.equal(h.orderOptions.enabled, false); assert.equal(h.requests.length, 0);
  assert.match(h.text(), /이 시즌의 계정을 찾을 수 없습니다/);
});

const has = (h: any, pattern: RegExp) => pattern.test(h.text());

it('현물 | 선물: 선물 reads the pinned account\'s futures executions and liquidations; 현물 keeps the orders', async t => {
  const h = createRecordScreenHarness('history', { accountId: 'historical' }); t.after(h.close); await h.settle();
  assert.equal(Boolean(h.find('trade-history-market')), true);
  await act(async () => h.renderer.root.findByType('FlatList').props.onEndReached()); await h.settle();
  assert.equal(has(h, /체결가 70,000/), true, '현물 labels lose the 실제 prefix');
  assert.equal(has(h, /실제 /), false);
  assert.equal(has(h, /총액 70,000/) && has(h, /수수료 70/) && has(h, /수령액 69,930/), true);
  assert.equal(has(h, /예약금 100,000/), true, 'a reservation stays a reservation');

  await h.press('trade-history-futures');
  assert.equal(Boolean(h.find('trade-history-futures-screen')), true);
  assert.equal(h.orderOptions.enabled, false, 'the order list and its polling wait while 선물 is shown');
  assert.equal(h.requests.some(r => r.path === '/trading-accounts/historical/futures/executions?limit=20&offset=0'), true);
  assert.equal(has(h, /BTCUSDT · 신규 진입\(Open\) · 롱\(Long\)/), true);
  assert.equal(has(h, /수량 \/ 체결가/) && has(h, /실현 손익 \/ 수수료/), true);

  // Another account selected elsewhere never retargets this pinned history.
  h.selectedAccount = h.accounts[1]; await h.update();
  await h.press('futures-history-liquidations');
  assert.equal(h.requests.some(r => r.path === '/trading-accounts/historical/futures/liquidations?limit=20&offset=0'), true);
  assert.equal(h.requests.filter(r => r.path.includes('/futures/')).every(r => r.path.startsWith('/trading-accounts/historical/')), true);
  assert.equal(has(h, /전량 강제청산/) && has(h, /경제적 실현 손익/) && has(h, /경제적 종료 수수료/), true);
  assert.equal(has(h, /정산 수수료/) && has(h, /현금 정산/) && has(h, /미충당 손실/), true);
  assert.equal(has(h, /종료 수량/) && has(h, /Mark 청산가/), true);
  assert.equal(has(h, /실제 |예상 청산가/), false);

  await h.press('trade-history-spot');
  assert.equal(Boolean(h.find('record-order-list-screen')), true);
  assert.equal(h.orderOptions.enabled, true);
});

it('선물 records: a failed read offers a retry, and no records is a normal empty state', async t => {
  const h = createRecordScreenHarness('history', { accountId: 'historical' }); t.after(h.close); await h.settle();
  h.futuresFailure = new Error('offline');
  await h.press('trade-history-futures');
  assert.equal(has(h, /기록을 불러오지 못했습니다/), true);
  h.futuresFailure = null;
  h.futuresData = (key: string) => (key === 'executions'
    ? { tradingAccountId: 'historical', pagination: { limit: 20, offset: 0, total: 0, returned: 0, nextOffset: null }, executions: [] }
    : undefined);
  const retry = h.renderer.root.findAll((n: any) => n.props?.label === '기록 다시 불러오기')[0];
  await act(async () => retry.props.onPress()); await h.settle();
  assert.equal(has(h, /기록이 없습니다/), true);
  assert.equal(has(h, /기록을 불러오지 못했습니다/), false);
});

it('선물 records page 20 at a time with 이전/다음; a page replaces the previous one', async t => {
  const h = createRecordScreenHarness('history', { accountId: 'historical' }); t.after(h.close); await h.settle();
  const row = (id: string) => ({ id, operation: 'open', direction: 'long', quantity: '1', executionPrice: '100', realizedPnl: '0', feeAmount: '0.1',
    executedAt: '2026-10-16T00:00:00.000Z', instrument: { id: 'btc', underlying: { symbol: 'BTCUSDT', displayPriceDecimals: 2 } } });
  const page = (offset: number) => ({ tradingAccountId: 'historical', pagination: { limit: 20, offset, total: 21, returned: offset ? 1 : 20, nextOffset: offset ? null : 20 },
    executions: Array.from({ length: offset ? 1 : 20 }, (_, i) => row(`execution-${offset + i}`)) });
  h.futuresData = (key: string, path: string) => (key === 'executions' ? page(/offset=20/.test(path) ? 20 : 0) : undefined);
  await h.press('trade-history-futures');
  const pageButton = (label: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.accessibilityLabel === label)[0];
  assert.equal(pageButton('이전').props.accessibilityState.disabled, true);
  await act(async () => pageButton('다음').props.onPress()); await h.settle();
  assert.equal(h.requests.some(r => r.path === '/trading-accounts/historical/futures/executions?limit=20&offset=20'), true);
  assert.equal(pageButton('다음').props.accessibilityState.disabled, true, 'no page after the last');
  assert.equal(pageButton('이전').props.accessibilityState.disabled, false);
});
