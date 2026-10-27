import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const { setup, account, flush, act } = require('../../../test/homeDiscoveryHarness.cjs');
const { futuresFixture } = require('../../../test/futuresFixtures.cjs');

// One list across both domains. In these fixtures the futures Mark notional
// (202 USD × 1,350 = 272,700 KRW) is larger than the spot value (150,000 KRW).
const listRows = h => h.node('home-holdings').findAll(node => node.type === 'Pressable'
  && /^home-(position-item|futures)-/.test(node.props.testID ?? '')).map(node => node.props.testID);
const headers = h => h.node('home-holdings').findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'header')
  .map(node => node.props.children);
const fxReads = h => h.requests.filter(request => request.section === 'fx').length;

for (const mode of ['general', 'season', 'beginner']) for (const [spot, future] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
  it(`${mode}: Spot ${spot} / Futures ${future} form one list by amount and navigate to their domain`, async t => {
    const h = setup(mode, spot); t.after(h.close); await flush();
    h.futures = { [mode]: futuresFixture(mode, { position: !!future, marginMode: 'cross', direction: 'short' }).positions };
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.positions(mode) })); await flush();
    const spotId = `home-position-item-${mode}-a0`, futuresId = `home-futures-${mode}:position`;
    assert.deepEqual(headers(h), ['보유종목 및 포지션'], 'no separate 보유종목/포지션 headings');
    // Both empty: each area says so on its own line, once, with no repeated
    // explanation; otherwise the list itself shows what is held.
    const empties = h.renderer.root.findAllByType('InlineEmptyState').map(node => [node.props.title, node.props.message ?? null]);
    assert.deepEqual(empties, spot === 0 && future === 0
      ? [['보유 중인 종목이 없습니다.', null], ['포지션이 없습니다.', null]] : []);
    // Collapsed: the single largest row of both domains.
    assert.deepEqual(listRows(h), future ? [futuresId] : spot ? [spotId] : []);
    // The rate is read only when KRW spot values and USD notionals must be compared.
    assert.equal(fxReads(h) > 0, !!(spot && future));
    assert.equal(h.node('home-holdings-toggle') !== undefined, spot + future > 1);
    if (spot + future > 1) {
      await h.press('home-holdings-toggle');
      assert.deepEqual(listRows(h), [futuresId, spotId]);
    }
    if (spot) {
      assert.equal(h.positions[mode][0].quantity, '1');
      await h.press(spotId);
      assert.deepEqual(h.navigation.at(-1)[1].params, { screen: 'AssetDetail', params: { assetId: h.positions[mode][0].assetId, returnTab: 'HomeTab' }, initial: false });
    }
    if (future) {
      await h.press(futuresId);
      assert.deepEqual(h.navigation.at(-1), ['MainTabs', { screen: 'MarketTab', params: {
        screen: 'Futures', params: { accountId: mode, instrumentId: 'btc' }, initial: false,
      } }]);
    }
  });
}

it('collapsed picks the larger spot row over a smaller futures notional, expanded keeps one order', async t => {
  const h = setup('general', 3); t.after(h.close); await flush();
  // 0.5 USD × 1,350 = 675 KRW sits below every spot row (149,998..150,000 KRW).
  const book = futuresFixture('general', { position: true }).positions;
  book.positions[0] = { ...book.positions[0], markNotional: '0.5' };
  h.futures = { general: book };
  await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.positions('general') })); await flush();
  assert.deepEqual(listRows(h), ['home-position-item-general-a0']);
  await h.press('home-holdings-toggle');
  assert.deepEqual(listRows(h), ['home-position-item-general-a0', 'home-position-item-general-a1', 'home-position-item-general-a2', 'home-futures-general:position']);
  await h.press('home-holdings-toggle');
  assert.deepEqual(listRows(h), ['home-position-item-general-a0']);
});

it('a mixed list is not ordered until the rate arrives, and an unavailable rate never compares USD with KRW', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let failRate = false;
  const h = setup('general', 1, 'home', { beforeRead: async request => {
    if (request.section === 'fx') { await gate; if (failRate) throw new Error('rate offline'); }
  } }); t.after(h.close);
  h.futures = { general: futuresFixture('general', { position: true }).positions };
  await flush();
  assert.deepEqual(listRows(h), [], 'no partial order while the rate is pending');
  assert.equal(h.node('home-holdings').findAllByType('SectionSkeleton').length > 0, true);
  failRate = true;
  await act(async () => release()); await flush();
  // Futures follow the valued spot row and the list says why.
  assert.deepEqual(listRows(h), ['home-position-item-general-a0']);
  assert.equal(h.node('home-holdings-fx-notice') !== undefined, true);
  await h.press('home-holdings-toggle');
  assert.deepEqual(listRows(h), ['home-position-item-general-a0', 'home-futures-general:position']);
});

it('a pending futures read never presents the spot row as the whole list', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = setup('general', 1, 'home', { beforeRead: async request => {
    if (request.section === 'futures') await gate;
  } }); t.after(h.close);
  h.futures = { general: futuresFixture('general', { position: true }).positions };
  await flush();
  assert.deepEqual(listRows(h), []);
  await act(async () => release()); await flush();
  assert.deepEqual(listRows(h), ['home-futures-general:position']);
});

for (const section of ['positions', 'futures']) it(`a failed ${section} read never makes both domains look empty`, async t => {
  const h = setup('general', 1, 'home', { beforeRead: async request => {
    if (request.section === section) throw new Error('offline');
  } }); t.after(h.close); await flush();
  if (section === 'positions') {
    h.futures = { general: futuresFixture('general', { position: true }).positions };
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.positions('general') })); await flush();
    assert.equal(h.node('home-futures-general:position') !== undefined, true);
  } else assert.equal(h.rows().length, 1);
  assert.equal(h.renderer.root.findAllByType('ErrorState').length > 0, true);
  assert.equal(h.renderer.root.findAllByType('InlineEmptyState').some(n => ['보유 중인 종목이 없습니다.', '포지션이 없습니다.'].includes(n.props.title)), false);
});

it('a late Futures response cannot paint an outgoing account after General→Season→Beginner', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = setup('general', 1, 'home', { beforeRead: async request => {
    if (request.section === 'futures' && request.account === 'general') await gate;
  } }); t.after(h.close); await flush();
  h.futures = { general: futuresFixture('general', { position: true }).positions };
  await h.switch(account('season'));
  await h.switch(account('beginner'));
  await act(async () => release()); await flush();
  assert.equal(h.node('home-futures-general:position') === undefined, true);
  assert.equal(h.rows()[0]?.props.testID?.includes('general') ?? false, false);
  assert.equal(h.client.getQueryData(QUERY_KEYS.tradingAccount.futures.positions('beginner')).positions.length, 0);
});

it('opening a Futures position for the same BTC leaves the Spot count, quantity, canonical value and PnL intact', async t => {
  const h = setup('general', 1); t.after(h.close); await flush();
  h.positions.general[0] = { ...h.positions.general[0], assetId: 'asset-btc', name: 'Bitcoin', symbol: 'BTCUSDT', market: 'BINANCE',
    assetType: 'crypto', quantity: '0.00000001', valuation: { state: 'available', priceCurrency: 'USD', positionValue: '145.28',
      unrealizedPnl: '0.36', returnRate: '0.25' } };
  const original = JSON.stringify(h.positions.general);
  h.futures = { general: futuresFixture('general', { position: true, direction: 'long' }).positions };
  await act(async () => h.client.refetchQueries({ predicate: q => q.queryKey.includes('general') })); await flush();
  // This spot fixture carries no KRW value, so it follows the valued futures row.
  await h.press('home-holdings-toggle');
  assert.equal(h.rows().length, 1);
  assert.equal(h.node('home-position-item-asset-btc-quantity').props.children, '보유수량 0.00000001 BTC');
  assert.equal(h.node('home-position-item-asset-btc-value').props.children, '$145.28');
  assert.equal(h.node('home-position-item-asset-btc-return').props.children, '+$0.36 (+0.25%)');
  assert.equal(h.node('home-futures-general:position') !== undefined, true);
  assert.equal(JSON.stringify(h.positions.general), original);
});

it('a US holding leads with its Korean name and keeps `(English) · SYMBOL` under it (2026-10-18)', async t => {
  const h = setup('general', 1); t.after(h.close); await flush();
  const id = 'home-position-item-general-a0';
  const own = (node: any): string => node === undefined ? '' : [node.props.children].flat().join('');
  // The fixture listing (market TEST) has no Korean name: one name line only.
  assert.equal(h.node(`${id}-english-name`) === undefined, true);
  Object.assign(h.positions.general[0], { name: 'Apple Inc.', symbol: 'AAPL', market: 'NAS' });
  await act(async () => h.client.refetchQueries()); await flush();
  assert.equal(own(h.node(`${id}-name`)), '애플');
  assert.equal(own(h.node(`${id}-english-name`)), '(Apple Inc.) · AAPL');
  assert.match(own(h.node(`${id}-quantity`)), /^보유수량 1/);
});

// The Portfolio screen's own read (its allocation card needs one).
const portfolio = { tradingAccountId: 'general', mode: 'general', status: 'active', state: 'available', summary: null,
  finalResult: null, sectionErrors: [],
  allocation: { state: 'available', cashKrwValue: '10000000', domesticStockValueKrw: '0', usStockValueKrw: '0', cryptoValueKrw: '0' } };
for (const screen of ['wallet', 'portfolio']) for (const [spot, future] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
  it(`${screen}: Spot ${spot} / Futures ${future} — each empty area says only its own sentence`, async t => {
    const h = setup('general', spot, screen, { portfolios: { general: portfolio } }); t.after(h.close); await flush();
    h.futures = { general: futuresFixture('general', { position: !!future }).positions };
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.positions('general') })); await flush();
    const empties = h.renderer.root.findAllByType('InlineEmptyState').map(node => [node.props.title, node.props.message ?? null]);
    const expected = [
      ...(spot ? [] : [['보유 중인 종목이 없습니다.', null]]),
      ...(future ? [] : [['포지션이 없습니다.', null]]),
    ];
    assert.deepEqual(empties.filter(([title]) => /보유|포지션/.test(String(title))), expected);
    assert.equal(empties.some(([title, message]) => [title, message].includes('데이터가 없습니다.')), false);
  });
}
