import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { createHomeHarness, elements } from '../../../test/homeTestHarness.cjs';
import { holding } from '../../../test/positionFixture.ts';
import { HoldingsContractError } from '../../features/tradingAccount/holdings.ts';
import { primaryGradient, semantic } from '../../theme/tokens.ts';

const text = (tree) => elements(tree, 'Text').flatMap((node) => node.props.children).join(' ');
const find = (tree, testID) => elements(tree).find((node) => node.props.testID === testID);

describe('selected account Wallet and shared Home holdings', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} lazily loads daily equity and resets its selected range on account switch`, async (t) => {
      const h = createHomeHarness(mode); t.after(h.close);
      h.seed(h.account, { points: [] });
      const equityOptions = () => h.queries.find(q => q.queryKey.includes('equity'));
      let tree = h.renderWallet().tree;
      assert.equal(find(tree, 'home-trend-toggle').props.accessibilityState.expanded, false);
      assert.equal(find(tree, 'home-trend-chart') === undefined, true);
      assert.equal(equityOptions().enabled, false);
      assert.deepEqual(equityOptions().queryKey, QUERY_KEYS.tradingAccount.portfolioEquity(h.account.id, '30d', 'daily'));
      find(tree, 'home-trend-toggle').props.onPress();
      for (const range of ['7d', '30d', '90d', '180d', '360d']) {
        tree = h.renderWallet().tree;
        find(tree, `home-trend-range-${range}`).props.onPress();
        tree = h.renderWallet().tree;
        const options = equityOptions();
        assert.equal(options.enabled, true);
        assert.deepEqual(options.queryKey, QUERY_KEYS.tradingAccount.portfolioEquity(h.account.id, range, 'daily'));
        h.response = { success: true, data: {
          tradingAccountId: h.account.id, mode, state: 'empty', range, granularity: 'daily', points: [],
          returnRateMethod: mode === 'general' ? 'time_weighted' : 'initial_capital',
        } };
        await options.queryFn();
        assert.equal(h.requests.at(-1).path, `/trading-accounts/${h.account.id}/portfolio/equity`);
        assert.deepEqual(h.requests.at(-1).params, { range, granularity: 'daily' });
      }
      h.account = { ...h.account, id: `${mode}-next` };
      h.seed(h.account, { points: [] });
      tree = h.renderWallet().tree;
      assert.equal(find(tree, 'home-trend-toggle').props.accessibilityState.expanded, false);
      assert.equal(equityOptions().enabled, false);
      assert.deepEqual(equityOptions().queryKey, QUERY_KEYS.tradingAccount.portfolioEquity(h.account.id, '30d', 'daily'));
    });
  }
  for (const mode of ['general', 'season']) {
    it(`${mode} shares the Hero and name/value/return rows and preserves preview vs full holdings`, (t) => {
      const h = createHomeHarness(mode); t.after(h.close);
      h.seed(h.account, { points: [] });
      const positions = Array.from({ length: 7 }, (_, i) => holding(String(i), { quantity: '10.000000' }));
      Object.assign(positions[1], { name: 'Apple', assetType: 'us_stock', symbol: 'AAPL', quantity: '0.125000' });
      Object.assign(positions[2], { name: 'Bitcoin', assetType: 'crypto', market: 'BINANCE', symbol: 'BTCUSDT', quantity: '0.00080500' });
      h.client.setQueryData(QUERY_KEYS.tradingAccount.wallets(h.account.id), {
        tradingAccountId: h.account.id, wallets: [
          { id: 'futures', walletScope: 'crypto_futures', currencyCode: 'USD', balanceAmount: '700' },
          { id: 'spot', walletScope: 'crypto_spot', currencyCode: 'USD', balanceAmount: '500' },
          { id: 'krw', walletScope: 'securities', currencyCode: 'KRW', balanceAmount: '9900000' },
          { id: 'usd', walletScope: 'securities', currencyCode: 'USD', balanceAmount: '50.39' },
        ],
      });
      h.client.setQueryData(QUERY_KEYS.tradingAccount.positions(h.account.id, { limit: 1 }), { tradingAccountId: h.account.id, positions: positions.slice(0, 1), pagination: { total: 7 } });
      h.client.setQueryData(QUERY_KEYS.tradingAccount.holdings(h.account.id), { tradingAccountId: h.account.id, positions });
      const collapsed = h.render().tree;
      assert.equal(elements(collapsed, 'Pressable').filter(row => row.props.testID?.startsWith('home-position-item-')).length, 1);
      find(collapsed, 'home-holdings-toggle').props.onPress();
      const home = h.render().tree, wallet = h.renderWallet().tree;
      assert.equal(text(find(home, 'home-summary-card')), text(find(wallet, 'home-summary-card')));
      assert.equal(text(find(home, 'home-position-item-0')), text(find(wallet, 'wallet-position-0')));
      for (const [index, quantity] of ['10 주', '0.125 주', '0.000805 BTC'].entries()) {
        assert.equal(find(home, `home-position-item-${index}-quantity`) !== undefined, true);
        assert.equal(find(wallet, `wallet-position-${index}-quantity`) !== undefined, true);
        assert.ok(text(find(home, `home-position-item-${index}`)).includes(quantity));
        assert.ok(text(find(wallet, `wallet-position-${index}`)).includes(quantity));
        for (const part of ['name', 'value', 'return']) {
          assert.equal(find(home, `home-position-item-${index}-${part}`).props.children, find(wallet, `wallet-position-${index}-${part}`).props.children);
        }
      }
      assert.equal(elements(home, 'Pressable').filter((row) => row.props.testID?.startsWith('home-position-item-')).length, 7);
      assert.equal(elements(wallet, 'Pressable').filter((row) => row.props.testID?.startsWith('wallet-position-')).length, 7);
      assert.match(text(wallet), /9,900,000원/); assert.match(text(wallet), /\$50.39/);
      assert.doesNotMatch(text(find(wallet, 'wallet-cash-USD')), /\$500|\$700|\$1,250/);
      assert.match(text(find(wallet, 'wallet-cash-crypto_spot-USD')), /\$500/);
      assert.match(text(find(wallet, 'wallet-cash-crypto_futures-USD')), /\$700/);
      assert.match(text(wallet), /암호화폐 · 현물/);
      assert.match(text(wallet), /암호화폐 · 선물/);
      assert.doesNotMatch(text(wallet), /crypto_spot|crypto_futures|securities/);
      assert.doesNotMatch(text(home), /자산 구성|지갑 요약|평균 매입가|현재가|987,654|80,000/);
      assert.doesNotMatch(text(wallet), /평균 매입가|현재가|987,654|80,000/);
      const nodes = elements(wallet);
      assert.equal(elements(wallet, 'AccountSwitcher').length, 0);
      assert.equal(find(wallet, 'trading-account-switcher-trigger') === undefined, true);
      const group = find(wallet, 'wallet-quick-actions');
      assert.ok(nodes.indexOf(find(wallet, 'home-summary-card')) < nodes.indexOf(group));
      assert.ok(nodes.indexOf(group) < nodes.indexOf(find(wallet, 'wallet-composition')));
      assert.ok(nodes.indexOf(find(wallet, 'wallet-exchange')) < nodes.indexOf(find(wallet, 'wallet-ledger')));
      assert.ok(nodes.indexOf(find(wallet, 'wallet-ledger')) < nodes.indexOf(find(wallet, 'wallet-orders')));
      for (const [testID, label] of [
        ['wallet-transfer', '이체하기'], ['wallet-exchange', '환전하기'], ['wallet-ledger', '원장 보기'], ['wallet-orders', '주문 내역'],
      ]) {
        const item = find(group, `${testID}-item`);
        const button = find(item, testID), caption = find(item, `${testID}-label`);
        const surface = find(button, `${testID}-surface`);
        const content = find(button, `${testID}-guide-target`);
        assert.equal(item.props.children === button, true);
        assert.equal(button.props.children === content, true);
        assert.equal(content.props.children.length === 2 && content.props.children[0] === surface && content.props.children[1] === caption, true, 'one measured group contains the icon surface, gap and label');
        assert.equal(elements(item, 'Pressable').length, 1, 'one accessible action per item');
        const visual = Object.assign({}, ...surface.props.style.filter(Boolean));
        assert.equal(visual.backgroundColor, primaryGradient.colors[0]);
        assert.deepEqual([visual.width, visual.height, visual.borderRadius], [52, 52, 12]);
        const background = elements(surface).find(node => typeof node.type === 'function');
        assert.equal(background.type.name, 'PrimaryButtonBackground');
        assert.deepEqual(background.props.shape, { borderRadius: 12 });
        assert.equal(button.props.primary, undefined, 'gradient is confined to the inner surface');
        assert.equal(button.props.style.backgroundColor, undefined);
        assert.equal(caption.props.style[0].color, semantic.secondary);
        assert.equal(elements(button, 'Svg').length, 1);
        assert.equal(elements(button, 'Svg')[0].props.stroke, primaryGradient.foreground);
        assert.equal(elements(surface, 'Text').length, 0, 'compact icon surface remains text-free');
        assert.equal(caption.props.children, label);
        assert.equal(button.props.accessibilityLabel, label);
        assert.equal(caption.props.accessible, false);
        assert.equal(surface.props.accessible, false);
      }
      assert.ok(nodes.indexOf(find(wallet, 'wallet-orders-label')) < nodes.indexOf(find(wallet, 'wallet-composition')));
      find(wallet, 'wallet-transfer').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['WalletTransfer']);
      find(wallet, 'wallet-exchange').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['WalletFx']);
      find(wallet, 'wallet-ledger').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['WalletTransactions']);
      find(wallet, 'wallet-orders').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['TradeHistory', { accountId: h.account.id }]);
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
      h.seed(h.account, { points: [] });
      find(h.renderWallet().tree, 'wallet-orders').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['TradeHistory', { accountId: h.account.id }]);
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
    assert.equal(find(tree, 'home-total-asset') === undefined, true);
    assert.match(text(find(tree, 'wallet-cash-KRW')), /0원/);
    assert.match(text(find(tree, 'wallet-cash-USD')), /-/);
    assert.equal(find(tree, 'wallet-position-unavailable-value').props.children, '-');
    assert.equal(find(tree, 'wallet-position-unavailable-return').props.children, '-');
    assert.equal(find(tree, 'wallet-position-unavailable-quantity') !== undefined, true);
    assert.equal(find(tree, 'wallet-position-stale-quantity') !== undefined, true);
    assert.match(text(find(tree, 'wallet-position-stale')), /1,120,000원.*\+4.82%.*이전 시세/);
    assert.doesNotMatch(text(tree), /internal/);
  });
  for (const status of ['suspended', 'closed']) {
    it(`${status} disables exchange while preserving readable holdings and history`, (t) => {
      const h = createHomeHarness(); t.after(h.close); h.account.status = status; h.seed(h.account, { points: [] });
      const { tree } = h.renderWallet();
      assert.equal(find(tree, 'wallet-exchange').props.disabled, true);
      assert.equal(find(tree, 'wallet-exchange').props.accessibilityState.disabled, true);
      assert.equal(find(tree, 'wallet-ledger').props.disabled, false);
      assert.equal(find(tree, 'wallet-orders').props.disabled, false);
      find(tree, 'wallet-ledger').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['WalletTransactions']);
      find(tree, 'wallet-orders').props.onPress();
      assert.deepEqual(h.navigation.at(-1), ['TradeHistory', { accountId: h.account.id }]);
    });
  }
  it('fails closed on integrity errors while transient failures stay local and retryable', (t) => {
    const h = createHomeHarness(); t.after(h.close); h.seed(h.account, { points: [] });
    h.client.setQueryData(QUERY_KEYS.tradingAccount.holdings(h.account.id), { tradingAccountId: h.account.id, positions: [holding('0')] });
    h.renderWallet();
    const query = h.client.getQueryCache().find({ queryKey: QUERY_KEYS.tradingAccount.holdings(h.account.id) });
    query.setState({ status: 'error', error: new HoldingsContractError() });
    const failed = h.renderWallet().tree;
    assert.equal(find(failed, 'home-summary-card') === undefined, true);
    assert.equal(find(failed, 'wallet-composition') === undefined, true);
    assert.equal(find(failed, 'wallet-exchange-item') === undefined, true);
    assert.ok(find(failed, 'wallet-ledger'));
    assert.ok(find(failed, 'wallet-orders'));
    query.setState({ status: 'error', error: new Error('offline') });
    const transient = h.renderWallet().tree;
    assert.ok(find(transient, 'home-summary-card'));
    assert.ok(find(transient, 'wallet-composition'));
    assert.equal(elements(transient, 'ErrorState').length, 1, 'ordinary refresh failure is explicit while preserving previous holdings');
    assert.ok(find(transient, 'wallet-position-0'));
  });
});
