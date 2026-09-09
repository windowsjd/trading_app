import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createLedgerHarness, elements } from '../../../test/ledgerTestHarness.cjs';
import {
  compatibleLedgerType, getLedgerTypeFilters, getLedgerRowDisplay,
  mergeLedgerPages, parseWalletLedgerResponse, WalletLedgerContractError,
} from './transactions.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

// The backend service test compares its serialized response to THIS SAME file.
const fixture = JSON.parse(readFileSync(new URL('../../../../backend/docs/fixtures/wallet-ledger.json', import.meta.url), 'utf8'));
const page = (currency: 'KRW' | 'USD' = 'KRW') => structuredClone(fixture[currency.toLowerCase()].data);
const listOf = (h) => elements(h.render(), 'FlatList')[0];
const labels = (node) => elements(node, 'Text').map((element) => element.props.children);
function chips(h, title) {
  const header = listOf(h).props.ListHeaderComponent;
  const group = elements(header, 'View').find((node) =>
    Array.isArray(node.props.children) && node.props.children[0]?.props.children === title,
  );
  return elements(group).filter((node) => typeof node.type === 'function' && node.props.onPress);
}
function press(h, group, label) {
  const chip = chips(h, group).find((node) => node.props.label === label);
  assert.ok(chip, `${group}: ${label}`);
  chip.props.onPress();
  h.render();
}
async function receive(h, response) {
  h.response = response;
  h.render();
  try {
    const data = await h.options.queryFn({ pageParam: 0 });
    h.query.data = { pages: [data] };
    h.query.isError = false;
  } catch (error) {
    h.query.error = error;
    h.query.isError = true;
  }
  return h.render();
}

describe('wallet ledger contract and real screen integration', () => {
  it('renders backend transactions/id through the actual API and screen (old screen threw at page.items.forEach)', async () => {
    const h = createLedgerHarness();
    await receive(h, fixture.krw);
    const list = listOf(h);
    assert.deepEqual(list.props.data.map(list.props.keyExtractor), ['wtx-fx-source', 'wtx-ad', 'wtx-buy']);
    assert.equal(new Set(list.props.data.map(list.props.keyExtractor)).size, 3);
    assert.equal(h.requests[0].path, '/trading-accounts/ta-1/wallet-transactions');
    assert.deepEqual(h.requests[0].params, { currency: 'KRW', limit: 20, offset: 0 });
    const buy = list.props.renderItem({ item: list.props.data[2] });
    assert.ok(labels(buy).includes('매수'));
    assert.ok(labels(buy).includes('삼성전자 · 005930'));
    assert.ok(labels(buy).includes('- 1,000,000원'));
    assert.ok(labels(buy).includes('잔액 9,000,000원'));
    assert.ok(labels(buy).includes('2026-09-02 09:00'));
    assert.equal(h.requests.length, 1, 'rendering trade rows makes no Order/Asset network calls');
  });

  it('renders USD sell and FX target using their persisted USD balances, never KRW valuation', async () => {
    const h = createLedgerHarness({ currencyCode: 'USD' });
    await receive(h, fixture.usd);
    const list = listOf(h);
    const sell = labels(list.props.renderItem({ item: list.props.data[0] }));
    assert.ok(sell.includes('매도'));
    assert.ok(sell.includes('Apple · AAPL'));
    assert.ok(sell.includes('+ $450'));
    assert.ok(sell.includes('잔액 $1,200'));
    const fx = labels(list.props.renderItem({ item: list.props.data[1] }));
    assert.ok(fx.includes('환전'));
    assert.ok(fx.includes('잔액 $750'));
    assert.ok(!sell.some((label) => typeof label === 'string' && label.includes('원')));
  });

  it('only offers KRW/USD, defaults to KRW and honors route USD with separate query keys', () => {
    const h = createLedgerHarness({ data: page() });
    assert.deepEqual(chips(h, '통화').map((chip) => chip.props.label), ['KRW', 'USD']);
    assert.equal(chips(h, '통화').find((chip) => chip.props.active).props.label, 'KRW');
    const krwKey = h.options.queryKey;
    press(h, '통화', 'USD');
    assert.notDeepEqual(h.options.queryKey, krwKey);
    assert.equal(chips(h, '통화').find((chip) => chip.props.active).props.label, 'USD');
    const usd = createLedgerHarness({ currencyCode: 'USD', data: page('USD') });
    usd.render();
    assert.deepEqual(usd.options.queryKey, h.options.queryKey);
    h.account.selectedAccountId = 'ta-2';
    h.render();
    assert.notDeepEqual(h.options.queryKey, usd.options.queryKey);
  });

  it('shows direction-compatible types and atomically resets an invalid selection to all', () => {
    const h = createLedgerHarness({ data: page() });
    assert.deepEqual(chips(h, '유형').map((chip) => chip.props.label), ['전체', '매수', '매도', '환전', '광고 보상']);
    press(h, '방향', '출금');
    assert.deepEqual(chips(h, '유형').map((chip) => chip.props.label), ['전체', '매수', '환전']);
    press(h, '유형', '매수');
    assert.deepEqual(h.options.queryKey, QUERY_KEYS.tradingAccount.walletTransactions('ta-1', { currency: 'KRW', direction: 'debit', txType: 'order_buy', limit: 20 }));
    press(h, '방향', '입금');
    assert.deepEqual(chips(h, '유형').map((chip) => chip.props.label), ['전체', '매도', '환전', '광고 보상']);
    assert.equal(chips(h, '유형').find((chip) => chip.props.active).props.label, '전체');
    assert.deepEqual(h.options.queryKey, QUERY_KEYS.tradingAccount.walletTransactions('ta-1', { currency: 'KRW', direction: 'credit', txType: undefined, limit: 20 }));
    press(h, '유형', '매도');
    press(h, '방향', '출금');
    assert.equal(chips(h, '유형').find((chip) => chip.props.active).props.label, '전체');
  });

  it('keeps exchange selected for either direction and limits ad reward to its real writer scope', () => {
    assert.equal(compatibleLedgerType('exchange', 'credit', 'season', 'USD'), 'exchange');
    assert.equal(compatibleLedgerType('exchange', 'debit', 'general', 'KRW'), 'exchange');
    const h = createLedgerHarness({ data: page() });
    press(h, '유형', '광고 보상');
    press(h, '통화', 'USD');
    assert.ok(!chips(h, '유형').some((chip) => chip.props.label === '광고 보상'));
    assert.equal(chips(h, '유형').find((chip) => chip.props.active).props.label, '전체');
    assert.ok(!getLedgerTypeFilters('all', 'season', 'KRW').some((type) => type.key === 'ad_reward'));
    for (const direction of ['all', 'credit', 'debit'] as const) {
      assert.ok(!getLedgerTypeFilters(direction, 'general', 'KRW').some((type) => ['fee', 'adjustment', 'settlement'].includes(type.key)));
    }
  });

  it('merges pages by canonical id, follows nextOffset and retains first trade balanceAfter', () => {
    const first = page();
    first.transactions = first.transactions.slice(0, 2);
    first.pagination = { limit: 2, offset: 0, total: 3, returned: 2, nextOffset: 2 };
    const second = page();
    second.transactions = second.transactions.slice(2);
    second.pagination = { limit: 2, offset: 2, total: 3, returned: 1, nextOffset: null };
    parseWalletLedgerResponse(first, 'ta-1', { currency: 'KRW', limit: 2 });
    parseWalletLedgerResponse(second, 'ta-1', { currency: 'KRW', limit: 2, offset: 2 });
    assert.equal(mergeLedgerPages([first, second, first]).length, 3);
    assert.equal(mergeLedgerPages([first, second]).at(-1).balanceAfter, '9000000.00000000');
    const h = createLedgerHarness({ data: first });
    h.query.data.pages.push(second);
    assert.equal(listOf(h).props.data.length, 3);
    assert.equal(h.options.getNextPageParam(first), 2);
    assert.equal(h.options.getNextPageParam(second), undefined);
    let fetched = 0;
    h.query.hasNextPage = true;
    h.query.fetchNextPage = () => { fetched += 1; };
    listOf(h).props.onEndReached();
    assert.equal(fetched, 1);
    h.query.isFetchingNextPage = true;
    listOf(h).props.onEndReached();
    assert.equal(fetched, 1);
  });

  it('does not silently discard unknown/historical financial rows or mislabel ad funding as profit', () => {
    const historical = page();
    for (const txType of ['fee', 'adjustment', 'settlement', 'future_financial_type']) {
      const row = { ...historical.transactions[1], txType };
      const data = { ...historical, transactions: [row], pagination: { ...historical.pagination, total: 1, returned: 1 } };
      assert.equal(parseWalletLedgerResponse(data, 'ta-1', { currency: 'KRW' }).transactions.length, 1);
      assert.ok(getLedgerRowDisplay(row).title);
    }
    const h = createLedgerHarness({ data: page() });
    const list = listOf(h);
    const reward = labels(list.props.renderItem({ item: list.props.data[1] }));
    assert.ok(reward.includes('광고 보상'));
    assert.ok(reward.includes('외부 가상자금 유입'));
    assert.ok(reward.includes('+ 1,000원'));
  });

  it('turns malformed API success into ErrorState without optional shape fallbacks', async () => {
    const broken = [
      (p) => { p.items = p.transactions; delete p.transactions; },
      (p) => { p.transactions[0].transactionId = p.transactions[0].id; delete p.transactions[0].id; },
      (p) => { delete p.filters; },
      (p) => { delete p.transactions[0].createdAt; },
      (p) => { delete p.transactions[0].referenceId; },
      (p) => { p.transactions[0].amount = 1000000; },
      (p) => { p.transactions[0].balanceAfter = 'invalid'; },
      (p) => { p.transactions[0].currencyCode = 'USD'; },
      (p) => { p.transactions[2].asset = null; },
      (p) => { p.transactions[0].txType = 'initial_grant'; },
      (p) => { p.transactions[0].id = p.transactions[1].id; },
      (p) => { p.pagination.returned = 100; },
      (p) => { p.pagination.nextOffset = 0; },
      (p) => { p.tradingAccountId = undefined; },
    ];
    for (const corrupt of broken) {
      const data = page();
      corrupt(data);
      const h = createLedgerHarness();
      const tree = await receive(h, { success: true, data });
      assert.ok(h.query.error instanceof WalletLedgerContractError);
      assert.equal(tree.type, 'ErrorState');
      assert.equal(elements(tree, 'FlatList').length, 0);
    }
  });

  it('uses empty/error/integrity states correctly for both account modes', async () => {
    for (const mode of ['general', 'season']) {
      const h = createLedgerHarness({ mode });
      const empty = page();
      empty.transactions = [];
      empty.pagination = { limit: 20, offset: 0, total: 0, returned: 0, nextOffset: null };
      await receive(h, { success: true, data: empty });
      assert.equal(listOf(h).props.ListEmptyComponent.type, 'EmptyState');
      h.query.isError = true;
      h.query.error = new Error('offline');
      assert.equal(h.render().type, 'ErrorState');
      h.query.error = { response: { status: 500, data: { error: { code: mode === 'general' ? 'GENERAL_ACCOUNT_INTEGRITY' : 'FINANCIAL_SCOPE_REPAIR_REQUIRED' } } } };
      assert.equal(h.render().props.title, '데이터를 안전하게 표시할 수 없습니다.');
      h.account.selectedAccountId = null;
      h.account.isEmpty = true;
      assert.ok(elements(h.render(), 'AccountSwitcher').length);
      assert.equal(h.options.enabled, false);
    }
  });

  it('keeps long asset names, amounts, balance and date on wrapping vertical rows', () => {
    const h = createLedgerHarness({ data: page() });
    const list = listOf(h);
    const row = structuredClone(list.props.data[2]);
    row.asset.name = '아주 긴 종목 이름 '.repeat(10);
    row.amount = '123456789012.00000000';
    const rendered = list.props.renderItem({ item: row });
    assert.ok(labels(rendered).includes(`${row.asset.name} · 005930`));
    assert.notEqual(rendered.props.style.flexDirection, 'row');
    assert.ok(elements(rendered, 'Text').every((text) => text.props.numberOfLines === undefined));
    const currencyChip = chips(h, '통화')[0];
    assert.equal(currencyChip.type(currencyChip.props).props.accessibilityState.selected, true);
  });
});
