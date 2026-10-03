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
