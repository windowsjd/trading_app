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

it('현물 | 선물: 선물 reads the pinned account\'s 포지션 진입 / 포지션 종료 records; 현물 keeps the orders', async t => {
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
  // 포지션 진입 first: one page of the server's open/increase union, never a filter of another read.
  assert.equal(h.requests.some(r => r.path === '/trading-accounts/historical/futures/position-history?phase=entry&limit=20&offset=0'), true);
  assert.equal(h.requests.some(r => /\/futures\/(executions|liquidations)/.test(r.path)), false);
  assert.equal(has(h, /포지션 진입/) && has(h, /포지션 종료/), true);
  assert.equal(has(h, /체결 기록|강제청산 기록/), false);
  assert.equal(has(h, /BTCUSDT · 신규 진입\(Open\) · 롱\(Long\)/), true);
  assert.equal(has(h, /수량 \/ 체결가/) && has(h, /실현 손익 \/ 수수료/), true);
  assert.equal(has(h, /강제청산|시즌 종료 정산|수량 감소/), false);

  // Another account selected elsewhere never retargets this pinned history.
  h.selectedAccount = h.accounts[1]; await h.update();
  await h.press('futures-history-exits');
  assert.equal(h.requests.some(r => r.path === '/trading-accounts/historical/futures/position-history?phase=exit&limit=20&offset=0'), true);
  assert.equal(h.requests.filter(r => r.path.includes('/futures/')).every(r => r.path.startsWith('/trading-accounts/historical/')), true);
  // The server's order is kept: the Season exit, a reduce, then one liquidation event.
  const records = h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /^futures-history-(execution|liquidation|season-exit)-/.test(n.props.testID ?? ''))
    .map((n: any) => n.props.testID);
  assert.deepEqual(records, ['futures-history-season-exit-season-exit', 'futures-history-execution-reduce', 'futures-history-liquidation-liquidation']);
  assert.equal(has(h, /시즌 종료 정산 · 1개 포지션/) && has(h, /시즌 종료 가격 · 선물 Last/), true, 'the Season exit is not a user close');
  assert.equal(has(h, /BTCUSDT · 수량 감소\(Reduce\) · 숏\(Short\)/), true, 'a partial close is a position exit');
  assert.equal(has(h, /교차\(Cross\) 전량 강제청산 · 2개 포지션/), true, 'one event keeps both of its closes');
  assert.equal(has(h, /BTCUSDT · 롱\(Long\)/) && has(h, /BTCUSDT · 숏\(Short\)/), true);
  assert.equal(has(h, /경제적 실현 손익/) && has(h, /경제적 종료 수수료/), true);
  assert.equal(has(h, /정산 수수료/) && has(h, /현금 정산/) && has(h, /미충당 손실/), true);
  assert.equal(has(h, /종료 수량/) && has(h, /Mark 청산가/), true);
  assert.equal(has(h, /실제 |예상 청산가/), false);
  assert.equal(has(h, /신규 진입|수량 추가/), false, 'entries stay in 포지션 진입');

  await h.press('trade-history-spot');
  assert.equal(Boolean(h.find('record-order-list-screen')), true);
  assert.equal(h.orderOptions.enabled, true);
});

it('현물 rows: a BUY ends with 총액 = what it paid (fee included); a SELL keeps 총액·수수료·수령액; unfilled rows keep their reservation', async t => {
  const h = createRecordScreenHarness('history', { accountId: 'historical' }); t.after(h.close); await h.settle();
  h.pageLimit = 10;
  (h.orders as any[]).push(
    { id: 'buy-1', assetId: 'asset-3', asset: { name: 'SK하이닉스', symbol: '000660' }, side: 'buy', orderType: 'market', status: 'executed', quantity: '2',
      executedPrice: '100000', grossAmount: '200000', feeAmount: '200', netAmount: '200200', currencyCode: 'KRW',
      submittedAt: '2026-09-02T00:00:00Z', executedAt: '2026-09-02T00:00:00Z' },
    { id: 'buy-partial', assetId: 'asset-4', asset: { name: '비트코인', symbol: 'BTC' }, side: 'buy', orderType: 'market', status: 'executed', quantity: '0.6',
      executedPrice: '100.03333333', grossAmount: '60.02', feeAmount: '0.06002', netAmount: '60.08002', currencyCode: 'USD',
      submittedAt: '2026-09-03T00:00:00Z', executedAt: '2026-09-03T00:00:00Z',
      marketExecution: { status: 'partial', requestedQuantity: null, executedQuantity: '0.6', canceledQuantity: null, requestedAmount: '100',
        unspentAmount: '39.98', remainderCancelReason: 'insufficient_market_liquidity', remainderCanceledAt: '2026-09-03T00:00:00Z' } },
  );
  await h.refresh();
  const row = (id: string) => h.text(h.find(`record-order-item-${id}`));
  const buy = row('buy-1');
  assert.match(buy, /수량 2[\s\S]*체결가 100,000[\s\S]*수수료 200[\s\S]*총액 200,200$/);
  assert.equal(/총액 200,000|차감액|수령액/.test(buy), false, 'the gross amount is not a BUY\'s 총액');
  const partial = row('buy-partial');
  assert.match(partial, /주문 금액[\s\S]*체결 수량 0\.6[\s\S]*사용되지 않은 금액[\s\S]*평균 체결가[\s\S]*수수료[\s\S]*총액/);
  assert.equal(/차감액/.test(partial), false);
  const sell = row('sell-1');
  assert.match(sell, /체결가 70,000[\s\S]*총액 70,000[\s\S]*수수료 70[\s\S]*수령액 69,930$/);
  const open = row('limit-1');
  assert.match(open, /예약금 100,000/);
  assert.equal(/총액|수수료|차감액/.test(open), false, 'an unfilled limit shows no execution amounts');
});

for (const [futuresView, phase] of [['liquidations', 'exit'], ['exits', 'exit'], ['executions', 'entry'], [undefined, 'entry']] as const) {
  it(`a ${futuresView ?? 'plain futures'} push opens ${phase === 'exit' ? '포지션 종료' : '포지션 진입'}`, async t => {
    const h = createRecordScreenHarness('history', { accountId: 'historical', market: 'futures', ...(futuresView ? { futuresView } : {}), pushAt: 1 });
    t.after(h.close); await h.settle();
    const reads = h.requests.filter(r => r.path.includes('/position-history')).map(r => r.path);
    assert.deepEqual(reads, [`/trading-accounts/historical/futures/position-history?phase=${phase}&limit=20&offset=0`]);
    assert.equal(h.find(phase === 'exit' ? 'futures-history-exits' : 'futures-history-entries').props['aria-selected'], true);
  });
}

it('선물 records: a failed read offers a retry, and no records is a normal empty state', async t => {
  const h = createRecordScreenHarness('history', { accountId: 'historical' }); t.after(h.close); await h.settle();
  h.futuresFailure = new Error('offline');
  await h.press('trade-history-futures');
  assert.equal(has(h, /기록을 불러오지 못했습니다/), true);
  h.futuresFailure = null;
  h.futuresData = (key: string) => (key === 'entries'
    ? { tradingAccountId: 'historical', phase: 'entry', pagination: { limit: 20, offset: 0, total: 0, returned: 0, nextOffset: null }, records: [] }
    : undefined);
  const retry = h.renderer.root.findAll((n: any) => n.props?.label === '기록 다시 불러오기')[0];
  await act(async () => retry.props.onPress()); await h.settle();
  assert.equal(has(h, /기록이 없습니다/), true);
  assert.equal(has(h, /기록을 불러오지 못했습니다/), false);
});

it('선물 records page 20 at a time with 이전/다음; a page replaces the previous one', async t => {
  const h = createRecordScreenHarness('history', { accountId: 'historical' }); t.after(h.close); await h.settle();
  const row = (id: string) => ({ kind: 'execution', id, executedAt: '2026-10-16T00:00:00.000Z', execution: { id, operation: 'open', direction: 'long', quantity: '1',
    executionPrice: '100', realizedPnl: '0', feeAmount: '0.1', executedAt: '2026-10-16T00:00:00.000Z',
    instrument: { id: 'btc', underlying: { symbol: 'BTCUSDT', displayPriceDecimals: 2 } } } });
  const page = (offset: number) => ({ tradingAccountId: 'historical', phase: 'entry', pagination: { limit: 20, offset, total: 21, returned: offset ? 1 : 20, nextOffset: offset ? null : 20 },
    records: Array.from({ length: offset ? 1 : 20 }, (_, i) => row(`execution-${offset + i}`)) });
  h.futuresData = (key: string, path: string) => (key === 'entries' ? page(/offset=20/.test(path) ? 20 : 0) : undefined);
  await h.press('trade-history-futures');
  const pageButton = (label: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.accessibilityLabel === label)[0];
  assert.equal(pageButton('이전').props.accessibilityState.disabled, true);
  await act(async () => pageButton('다음').props.onPress()); await h.settle();
  assert.equal(h.requests.some(r => r.path === '/trading-accounts/historical/futures/position-history?phase=entry&limit=20&offset=20'), true);
  assert.equal(pageButton('다음').props.accessibilityState.disabled, true, 'no page after the last');
  assert.equal(pageButton('이전').props.accessibilityState.disabled, false);
});

for (const scope of scopes) {
  it(`거래 완료 (route ${JSON.stringify(scope)}): the pinned account's completed trades with 공유; another selected account never retargets it`, async t => {
    const h = createRecordScreenHarness('history', scope); t.after(h.close); await h.settle();
    await h.press('trade-history-completed');
    assert.equal(h.orderOptions.enabled, false, 'the order list and its polling wait while 거래 완료 is shown');
    assert.equal(h.requests.some(r => r.path === '/trading-accounts/historical/completed-trades'), true,
      'a settled season record reads its own (closed) season account');
    assert.equal(has(h, /실현 손익 \+\$152\.34 · 수익률 \+3\.42%/), true);
    assert.equal(has(h, /2026-11-05 21:44:04 완료 · 10x/), true);
    h.selectedAccount = h.accounts[1]; await h.update();
    assert.equal(h.requests.filter(r => r.path.endsWith('/completed-trades')).every(r => r.path === '/trading-accounts/historical/completed-trades'), true);
    await h.press('completed-trade-futures:lifetime-1-share');
    assert.equal(Boolean(h.find('trade-share-body')), true, 'the 수익 공유 sheet opens over the list');
    assert.equal(h.text(h.find('trade-share-card-nickname')), '기록왕');
    assert.equal(h.text(h.find('trade-share-card-headline')), '+152.34');
    await h.press('trade-history-spot');
    assert.equal(Boolean(h.find('record-order-list-screen')), true);
    assert.equal(h.orderOptions.enabled, true);
  });
}
