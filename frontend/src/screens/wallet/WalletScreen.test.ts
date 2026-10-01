import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { createHomeHarness, elements } from '../../../test/homeTestHarness.cjs';
import { holding } from '../../../test/positionFixture.ts';
import { HoldingsContractError } from '../../features/tradingAccount/holdings.ts';

const text = (tree) => elements(tree, 'Text').flatMap((node) => node.props.children).join(' ');
const find = (tree, testID) => elements(tree).find((node) => node.props.testID === testID);

describe('selected account Wallet and shared Home holdings', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} shares the Hero and value/quantity/return rows and preserves preview vs full holdings`, (t) => {
      const h = createHomeHarness(mode); t.after(h.close);
      h.seed(h.account, { points: [] });
      const positions = Array.from({ length: 7 }, (_, i) => holding(String(i), { quantity: '10.000000' }));
      Object.assign(positions[1], { name: 'Apple', assetType: 'us_stock', symbol: 'AAPL', quantity: '0.125000' });
      Object.assign(positions[2], { name: 'Bitcoin', assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT', quantity: '0.00080500' });
      h.client.setQueryData(QUERY_KEYS.tradingAccount.wallets(h.account.id), {
        tradingAccountId: h.account.id, wallets: [
          { currencyCode: 'KRW', balance: '9900000' }, { currencyCode: 'USD', balance: '50.39' },
        ],
      });
      h.client.setQueryData(QUERY_KEYS.tradingAccount.positions(h.account.id, { limit: 5 }), { positions: positions.slice(0, 5) });
      h.client.setQueryData(QUERY_KEYS.tradingAccount.holdings(h.account.id), { tradingAccountId: h.account.id, positions });
      const home = h.render().tree, wallet = h.renderWallet().tree;
      assert.equal(text(find(home, 'home-summary-card')), text(find(wallet, 'home-summary-card')));
      assert.equal(text(find(home, 'home-position-item-0')), text(find(wallet, 'wallet-position-0')));
      for (const [index, quantity] of ['10주', '0.125주', '0.000805 BTC'].entries()) {
        assert.equal(find(home, `home-position-item-${index}-quantity`).props.children, quantity);
        assert.equal(find(wallet, `wallet-position-${index}-quantity`).props.children, quantity);
        for (const part of ['name', 'value', 'quantity', 'return']) {
          assert.equal(find(home, `home-position-item-${index}-${part}`).props.children, find(wallet, `wallet-position-${index}-${part}`).props.children);
        }
      }
      assert.equal(elements(home, 'Pressable').filter((row) => row.props.testID?.startsWith('home-position-item-')).length, 5);
      assert.equal(elements(wallet, 'Pressable').filter((row) => row.props.testID?.startsWith('wallet-position-')).length, 7);
      assert.match(text(wallet), /9,900,000원/); assert.match(text(wallet), /\$50.39/);
      assert.doesNotMatch(text(home), /자산 구성|지갑 요약|평균 매입가|현재가|987,654|80,000/);
      assert.doesNotMatch(text(wallet), /평균 매입가|현재가|987,654|80,000/);
      const nodes = elements(wallet);
      assert.ok(nodes.indexOf(find(wallet, 'home-summary-card')) < nodes.indexOf(find(wallet, 'wallet-exchange')));
      assert.ok(nodes.indexOf(find(wallet, 'wallet-exchange')) < nodes.indexOf(find(wallet, 'wallet-composition')));
      assert.ok(nodes.indexOf(find(wallet, 'wallet-composition')) < nodes.indexOf(find(wallet, 'wallet-orders')));
      find(wallet, 'wallet-ledger').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['WalletTransactions']);
      find(wallet, 'wallet-position-0').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['MainTabs', { screen: 'MarketTab', params: { screen: 'AssetDetail', params: { assetId: '0' } } }]);
    });

    it(`${mode} scopes every read and completes offset pagination beyond 100`, async (t) => {
      const h = createHomeHarness(mode); t.after(h.close); h.seed(h.account, { points: [] });
      h.renderWallet();
      assert.ok(h.queries.every((q) => q.queryKey.includes(h.account.id)));
      const query = h.queries.find((q) => q.queryKey.includes('holdings'));
      h.response = (_path, config) => {
        const offset = config.params.offset;
        const positions = Array.from({ length: Math.min(100, 207 - offset) }, (_, i) => holding(String(offset + i)));
        return { success: true, data: { tradingAccountId: h.account.id, state: 'available', positions,
          pagination: { offset, limit: 100, total: 207, returned: positions.length, nextOffset: offset < 200 ? offset + 100 : null } } };
      };
      const result = await query.queryFn();
      assert.equal(result.positions.length, 207);
      assert.deepEqual(h.requests.map((r) => r.params.offset), [0, 100, 200]);
      assert.ok(h.requests.every((r) => r.path === `/trading-accounts/${h.account.id}/positions`));
    });
  }
  it('switches immediately discard previous total, cash, holdings and return', (t) => {
    const h = createHomeHarness(); t.after(h.close); h.seed(h.account, { points: [] });
    assert.match(text(h.renderWallet().tree), /10,001,000/);
    for (const mode of ['season', 'general']) {
      h.account = { ...h.account, id: `${mode}-new`, mode };
      const { tree, branch } = h.renderWallet();
      assert.equal(branch.key, h.account.id);
      assert.doesNotMatch(text(tree), /10,001,000/);
      assert.equal(elements(tree, 'SectionSkeleton').length, 3);
      assert.ok(h.queries.every((q) => q.queryKey.includes(h.account.id)));
    }
  });
  it('an unavailable total preserves independently known cash and stale/unavailable holdings', (t) => {
    const h = createHomeHarness(); t.after(h.close); h.seed(h.account, { points: [] });
    const portfolioKey = QUERY_KEYS.tradingAccount.portfolio(h.account.id);
    h.client.setQueryData(portfolioKey, { ...h.client.getQueryData(portfolioKey), state: 'unavailable', summary: null });
    const stale = holding('stale');
    Object.assign(stale.valuation, { state: 'stale_cache' });
    const unavailable = holding('unavailable', { valuation: { state: 'unavailable', reason: 'ASSET_PRICE_UNAVAILABLE', message: 'internal' } });
    h.client.setQueryData(QUERY_KEYS.tradingAccount.holdings(h.account.id), { tradingAccountId: h.account.id, positions: [stale, unavailable] });
    h.client.setQueryData(QUERY_KEYS.tradingAccount.wallets(h.account.id), { tradingAccountId: h.account.id, wallets: [{ currencyCode: 'KRW', balanceAmount: '0' }] });
    const { tree } = h.renderWallet();
    assert.equal(find(tree, 'home-total-asset'), undefined);
    assert.match(text(find(tree, 'wallet-cash-KRW')), /0원/);
    assert.match(text(find(tree, 'wallet-cash-USD')), /-/);
    assert.equal(find(tree, 'wallet-position-unavailable-value').props.children, '-');
    assert.equal(find(tree, 'wallet-position-unavailable-return').props.children, '-');
    assert.equal(find(tree, 'wallet-position-unavailable-quantity').props.children, '0.123457주');
    assert.equal(find(tree, 'wallet-position-stale-quantity').props.children, '0.123457주');
    assert.match(text(find(tree, 'wallet-position-stale')), /1,120,000원.*\+4.82%.*이전 시세/);
    assert.doesNotMatch(text(tree), /internal/);
  });
  for (const status of ['suspended', 'closed']) {
    it(`${status} disables exchange while preserving readable holdings and history`, (t) => {
      const h = createHomeHarness(); t.after(h.close); h.account.status = status; h.seed(h.account, { points: [] });
      const { tree } = h.renderWallet();
      assert.equal(h.renderCta(find(tree, 'wallet-exchange')).props.disabled, true);
      assert.ok(find(tree, 'wallet-ledger')); assert.ok(find(tree, 'wallet-orders'));
    });
  }
  it('fails closed on integrity errors while transient failures stay local and retryable', (t) => {
    const h = createHomeHarness(); t.after(h.close); h.seed(h.account, { points: [] }); h.renderWallet();
    const query = h.client.getQueryCache().find({ queryKey: QUERY_KEYS.tradingAccount.holdings(h.account.id) });
    query.setState({ status: 'error', error: new HoldingsContractError() });
    const failed = h.renderWallet().tree;
    assert.equal(find(failed, 'home-summary-card'), undefined);
    assert.equal(find(failed, 'wallet-composition'), undefined);
    query.setState({ status: 'error', error: new Error('offline') });
    const transient = h.renderWallet().tree;
    assert.ok(find(transient, 'home-summary-card'));
    assert.ok(elements(transient, 'ErrorState').some((node) => node.props.title === '보유 종목을 불러오지 못했습니다.' && node.props.onRetry));
  });
});
