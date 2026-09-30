import assert from 'node:assert/strict';
import { semantic } from '../../theme/tokens.ts';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { invalidateAfterOrderCreate } from '../../features/tradingAccount/invalidation.ts';
const require = createRequire(import.meta.url);
const {
  inlineTradingHarness,
  deferred,
  act,
} = require('../../../test/inlineTradingHarness.cjs');
const text = (node: any): string =>
  typeof node === 'string' ? node : (node?.children ?? []).map(text).join('');
const holding = (
  id: string,
  quantity = '1',
  valuation: any = { state: 'unavailable' },
) => ({
  positionId: id,
  assetId: id,
  symbol: id === 'samsung' ? '005930' : `${id.toUpperCase()}USDT`,
  name: id === 'samsung' ? 'Samsung Electronics' : id,
  market: id === 'samsung' ? 'KRX' : 'BINANCE',
  assetType: id === 'samsung' ? 'domestic_stock' : 'crypto',
  currencyCode: id === 'samsung' ? 'KRW' : 'USD',
  quantity,
  averageCost: '720.3',
  realizedPnl: '0',
  realizedPnlKrw: '0',
  valuation,
});
const ids = (h: any) =>
  h.renderer.root
    .findAll(
      (n: any) =>
        typeof n.type === 'string' && n.props.testID?.startsWith('holding-'),
    )
    .map((n: any) => n.props.testID);
const empty = (h: any) =>
  h.renderer.root
    .findAllByType('InlineEmptyState')
    .map((n: any) => n.props.title)
    .join(' ');

describe('holdings in Order with real React Query and order invalidation', () => {
  it('all/current filters, missing asset and zero positions; changing asset resets filter/input/KRW', async (t) => {
    const h = inlineTradingHarness();
    h.assetId = 'btc';
    h.holdings = {
      general: [
        holding('btc'),
        holding('eth'),
        holding('samsung'),
        holding('closed', '0'),
      ],
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.deepEqual(ids(h), ['holding-btc', 'holding-eth', 'holding-samsung']);
    assert.equal(text(h.node('holdings-count')), '보유 종목 3');
    await h.press('holdings-filter-current');
    assert.deepEqual(ids(h), ['holding-btc']);
    await h.input(TEST_IDS.order.quantityInput, '0.125');
    await h.press('asset-krw-toggle');
    h.assets.xrp = {
      ...h.assets.bnb,
      id: 'xrp',
      symbol: 'XRPUSDT',
      name: 'XRP',
    };
    h.assetId = 'xrp';
    await h.update();
    await h.flush();
    assert.equal(
      h.node('holdings-filter-all').props.accessibilityState.selected,
      true,
    );
    assert.equal(h.node(TEST_IDS.order.quantityInput).props.value, '');
    assert.equal(
      h.node('asset-krw-toggle').props.accessibilityState.selected,
      false,
    );
    await h.press('holdings-filter-current');
    assert.deepEqual(ids(h), []);
    assert.match(empty(h), /현재 종목을 보유하고 있지 않습니다/);
  });
  it('renders every page without publishing a partial count or nesting a vertical list', async (t) => {
    const h = inlineTradingHarness();
    h.holdings = {
      general: Array.from({ length: 205 }, (_, i) => holding(`asset${i}`)),
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(ids(h).length, 205);
    assert.equal(text(h.node('holdings-count')), '보유 종목 205');
    assert.deepEqual(
      h.holdingsReads.map((read: any) => read.offset),
      [0, 100, 200],
    );
    assert.equal(
      h.node('account-holdings').findAllByType('ScrollView').length,
      0,
    );
    assert.equal(
      h.node('account-holdings').findAllByType('FlatList').length,
      0,
    );
    assert.equal(h.node('asset-market-status'), undefined);
    assert.doesNotMatch(text(h.node('account-holdings')), /내 포지션/);
  });
  it('never renders general holdings under season, including a late general response and cached return', async (t) => {
    const h = inlineTradingHarness();
    h.holdings = {
      general: [holding('btc'), holding('eth'), holding('samsung')],
      season: [holding('bnb')],
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(ids(h).length, 3);
    h.holdingsGate = { general: deferred(), season: deferred() };
    let pending: Promise<unknown>;
    await act(async () => {
      pending = invalidateAfterOrderCreate(h.client, 'general');
    });
    h.accountId = 'season';
    h.routeAccountId = 'season';
    await h.update();
    assert.deepEqual(ids(h), []);
    assert.equal(h.renderer.root.findAllByType('SectionSkeleton').length, 1);
    await act(async () => h.holdingsGate.general.resolve());
    await pending!;
    await h.flush();
    assert.deepEqual(ids(h), []);
    await act(async () => h.holdingsGate.season.resolve());
    await h.flush();
    assert.deepEqual(ids(h), ['holding-bnb']);
    h.accountId = 'general';
    h.routeAccountId = 'general';
    await h.update();
    await h.flush();
    assert.deepEqual(ids(h), ['holding-btc', 'holding-eth', 'holding-samsung']);
  });
  for (const accountId of ['general', 'season'])
    for (const filter of ['all', 'current']) {
      it(`${accountId}/${filter}: first buy, add buy, partial sell and full sell update through real create invalidation`, async (t) => {
        const h = inlineTradingHarness();
        h.assetId = 'btc';
        h.accountId = accountId;
        h.holdings = { [accountId]: [] };
        await h.mount();
        t.after(h.close);
        await h.flush();
        await h.press(`holdings-filter-${filter}`);
        assert.deepEqual(ids(h), []);
        for (const [side, quantity, after] of [
          ['buy', '1', '1'],
          ['buy', '1', '2'],
          ['sell', '1', '1'],
          ['sell', '1', '0'],
        ]) {
          h.positions[accountId] = side === 'sell' ? '2' : '0';
          h.onCreate = () => {
            h.holdings[accountId] = [holding('btc', after)];
          };
          await h.update();
          await h.press(
            side === 'buy'
              ? TEST_IDS.assetDetail.buyButton
              : TEST_IDS.assetDetail.sellButton,
          );
          await h.input(TEST_IDS.order.quantityInput, quantity);
          await h.press(TEST_IDS.order.executeSubmit);
          await h.flush();
          assert.equal(h.success().visible, true);
          assert.deepEqual(ids(h), after === '0' ? [] : ['holding-btc']);
          const cached = h.client.getQueryData(
            QUERY_KEYS.tradingAccount.holdings(accountId),
          );
          assert.equal(cached.positions[0]?.quantity ?? '0', after);
          await act(async () => h.success().onGoAssetDetail());
        }
        assert.match(
          empty(h),
          filter === 'all'
            ? /보유 중인 종목이 없습니다/
            : /현재 종목을 보유하고 있지 않습니다/,
        );
        assert.ok(h.holdingsReads.length >= 5);
        assert.ok(
          h.invalidations.every(
            (key: any[]) =>
              key[2] !== (accountId === 'general' ? 'season' : 'general'),
          ),
        );
      });
    }
  for (const status of ['suspended', 'closed']) {
    it(`${status} accounts remain readable independently from order capability`, async (t) => {
      const h = inlineTradingHarness();
      h.accounts[0].status = status;
      h.holdings = { general: [holding('btc')] };
      await h.mount();
      t.after(h.close);
      await h.flush();
      assert.deepEqual(ids(h), ['holding-btc']);
    });
  }
  for (const integrity of [false, true]) {
    it(`distinguishes ${integrity ? 'integrity' : 'network'} failure from empty, retries`, async (t) => {
      const h = inlineTradingHarness();
      h.holdings = { general: [] };
      h.holdingsError = integrity
        ? {
            response: {
              status: 409,
              data: { error: { code: 'TRADING_ACCOUNT_INTEGRITY' } },
            },
          }
        : new Error('offline');
      await h.mount();
      t.after(h.close);
      await h.flush();
      assert.match(
        empty(h),
        integrity
          ? /보유 내역을 안전하게 표시할 수 없습니다/
          : /보유 종목을 불러오지 못했습니다/,
      );
      assert.doesNotMatch(empty(h), /보유 중인 종목이 없습니다/);
      assert.equal(text(h.node('holdings-count')), '보유 종목');
      h.holdingsError = null;
      await h.press('holdings-retry');
      await h.flush();
      assert.match(empty(h), /보유 중인 종목이 없습니다/);
    });
  }
  it('uses canonical valuation including unavailable/stale, signs, zero and high returns; KRW toggle leaves holdings intact', async (t) => {
    const h = inlineTradingHarness();
    const value = (pnl: string, rate: string) => ({
      state: 'available',
      currentPrice: '763.79',
      priceCurrency: 'USD',
      positionValueKrw: '1234567890123',
      unrealizedPnlKrw: pnl,
      returnRate: rate,
    });
    h.holdings = {
      general: [
        holding('btc', '1.12345678', value('100000', '123.45')),
        holding('eth', '2', value('-999999999', '-99.5')),
        holding('samsung', '3', value('0', '0')),
        holding('bnb'),
        holding('stale', '4', { ...value('1', '1'), state: 'stale_cache' }),
      ],
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    const before = text(h.node('account-holdings'));
    assert.match(before, /123\.45%/);
    assert.match(before, /-99\.5%/);
    assert.match(before, /1\.12345678/);
    assert.match(before, /시세 조회 불가/);
    assert.match(before, /이전 시세/);
    assert.equal(ids(h).length, 5);
    for (const [id, color] of [
      ['btc', semantic.rise],
      ['eth', semantic.fall],
      ['samsung', null],
    ]) {
      const row = h.node(`holding-${id}`);
      const rate = row.findAllByType('Text').at(-1);
      assert.equal(rate.props.style[1]?.color ?? null, color);
    }
    await h.press('asset-krw-toggle');
    assert.equal(text(h.node('account-holdings')), before);
  });
  for (const assetType of ['domestic_stock', 'us_stock'])
    for (const [status, label] of [
      ['open', '장중'],
      ['closed', '장마감'],
      ['unknown', '상태 확인 불가'],
    ]) {
      it(`${assetType} ${status} badge is beside the pair, never raw`, async (t) => {
        const h = inlineTradingHarness();
        h.assetId = 'samsung';
        h.assets.samsung.assetType = assetType;
        h.assets.samsung.marketStatus = status;
        await h.mount();
        t.after(h.close);
        assert.ok(
          h
            .node('asset-pair-header')
            .findAll((n: any) => n.props.testID === 'asset-market-status')
            .length,
        );
        assert.equal(text(h.node('asset-market-status')), label);
      });
    }
});


const pendingOrder = (id: string, side: 'buy' | 'sell', overrides: Record<string, unknown> = {}) => ({
  id,
  orderId: id,
  asset: { id: `asset-${id}`, symbol: `${id.toUpperCase()}USDT`, name: `긴 종목 이름 ${id}` },
  side,
  orderType: 'limit',
  status: 'submitted',
  quantity: '12345678901234567890.12345678',
  limitPrice: '12345678901234567890.12345678',
  currencyCode: 'USD',
  submittedAt: '2026-09-29T00:00:00.000Z',
  ...overrides,
});
const pendingIds = (h: any) => h.renderer.root.findAll((node: any) =>
  typeof node.type === 'string' && /^pending-order-/.test(node.props.testID ?? ''),
).map((node: any) => node.props.testID);

describe('pending limit orders in the real trading screen', () => {
  it('keeps holdings filters and shows a distinct empty pending state', async (t) => {
    const h = inlineTradingHarness();
    h.holdings = { general: [holding('btc')] };
    h.orders = { general: [] };
    await h.mount(); t.after(h.close); await h.flush();
    assert.deepEqual(ids(h), ['holding-btc']);
    await h.press('holdings-filter-current');
    assert.deepEqual(ids(h), []);
    await h.press('holdings-filter-pending'); await h.flush();
    assert.equal(h.node('holdings-filter-pending').props.accessibilityState.selected, true);
    assert.deepEqual(pendingIds(h), []);
    assert.match(empty(h), /대기 중인 지정가 주문이 없습니다/);
    assert.deepEqual(h.orderReads.map((read: any) => [read.id, read.status, read.offset]), [['general', 'submitted', 0]]);
    await h.press('holdings-filter-all');
    assert.deepEqual(ids(h), ['holding-btc']);
  });

  it('shows BUY and SELL, excludes other lifecycle rows, and wraps long values at 320px / 2× font', async (t) => {
    const h = inlineTradingHarness();
    h.dimensions.fontScale = 2;
    h.orders = { general: [
      pendingOrder('buy', 'buy'), pendingOrder('sell', 'sell'),
      pendingOrder('market', 'buy', { orderType: 'market' }),
      pendingOrder('done', 'buy', { status: 'executed' }),
      pendingOrder('cancel', 'sell', { status: 'canceled' }),
      pendingOrder('reject', 'buy', { status: 'rejected' }),
    ] };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-order-buy', 'pending-order-sell']);
    const buy = h.node('pending-order-buy');
    const sell = h.node('pending-order-sell');
    assert.match(text(buy), /지정가 매수 · 미체결/);
    assert.match(text(sell), /지정가 매도 · 미체결/);
    assert.match(text(buy), /주문 수량12,345,678,901,234,567,890.12345678/);
    assert.match(text(sell), /지정가12,345,678,901,234,567,890.12345678/);
    assert.ok(buy.findAllByType('Text').every((node: any) => node.props.numberOfLines === undefined));
    assert.equal(buy.findAllByType('View').find((node: any) => node.props.style?.flexWrap === 'wrap') !== undefined, true);
    assert.equal(h.dimensions.width, 320);
  });

  it('keeps all three filters accessible at 430px', async (t) => {
    const h = inlineTradingHarness();
    h.dimensions.width = 430;
    h.orders = { general: [pendingOrder('buy', 'buy')] };
    await h.mount(); t.after(h.close); await h.flush();
    for (const value of ['all', 'current', 'pending']) {
      await h.press(`holdings-filter-${value}`);
      assert.equal(h.node(`holdings-filter-${value}`).props.accessibilityState.selected, true);
    }
    await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-order-buy']);
  });

  it('switches General to Season without ever showing the old account row', async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: [pendingOrder('a', 'buy')], season: [pendingOrder('b', 'sell')] };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-order-a']);
    h.orderGate = { season: deferred() };
    h.accountId = 'season';
    h.routeAccountId = 'season'; await h.update();
    assert.deepEqual(pendingIds(h), []);
    await h.press('holdings-filter-pending');
    assert.deepEqual(pendingIds(h), []);
    await act(async () => h.orderGate.season.resolve()); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-order-b']);
    assert.deepEqual(h.orderReads.map((read: any) => read.id), ['general', 'season']);
  });

  it('refreshes create, matcher execution and cancellation from the account-scoped key', async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: [pendingOrder('buy', 'buy')] };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-order-buy']);
    h.orders.general.push(pendingOrder('sell', 'sell'));
    await act(async () => invalidateAfterOrderCreate(h.client, 'general')); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-order-buy', 'pending-order-sell']);
    h.invalidations = [];
    h.orders.general[0].status = 'executed';
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.ordersAll('general') })); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-order-sell']);
    assert.ok(h.invalidations.some((key: any[]) => key[1] === 'positions' && key[2] === 'general'));
    assert.ok(h.invalidations.every((key: any[]) => key[2] !== 'season'));
    h.orders.general[1].status = 'canceled';
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.ordersAll('general') })); await h.flush();
    assert.deepEqual(pendingIds(h), []);
    assert.match(empty(h), /대기 중인 지정가 주문이 없습니다/);
    assert.ok(h.queries.some((q: any) => q.queryKey[1] === 'orders' && q.refetchInterval === 4000));
  });

  it('reads every submitted page before displaying the list', async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: Array.from({ length: 205 }, (_, i) => pendingOrder(`o${i}`, i % 2 ? 'sell' : 'buy')) };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.equal(pendingIds(h).length, 205);
    assert.deepEqual(h.orderReads.map((read: any) => read.offset), [0, 100, 200]);
    assert.match(text(h.node('pending-orders-list')), /대기 주문 205건/);
  });

  for (const integrity of [false, true]) it(`distinguishes ${integrity ? 'integrity' : 'network'} failure from empty`, async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: [] };
    h.orderError = integrity ? { response: { status: 409, data: { error: { code: 'TRADING_ACCOUNT_INTEGRITY' } } } } : new Error('offline');
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.match(empty(h), integrity ? /대기 주문을 안전하게 표시할 수 없습니다/ : /대기 주문을 불러오지 못했습니다/);
    assert.doesNotMatch(empty(h), /대기 중인 지정가 주문이 없습니다/);
    h.orderError = null; await h.press('pending-orders-retry'); await h.flush();
    assert.match(empty(h), /대기 중인 지정가 주문이 없습니다/);
  });
});


describe('order panel side colors in the trading screen', () => {
  it('keeps BUY green and SELL red on selected tabs and final CTA', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close); await h.flush();
    const color = (node: any) => (Array.isArray(node.props.style)
      ? Object.assign({}, ...node.props.style.filter(Boolean))
      : node.props.style).backgroundColor;
    assert.equal(color(h.node(TEST_IDS.assetDetail.buyButton)), '#16a34a');
    assert.equal(color(h.node(TEST_IDS.order.executeSubmit)), '#16a34a');
    await h.press(TEST_IDS.assetDetail.sellButton); await h.flush();
    assert.equal(color(h.node(TEST_IDS.assetDetail.sellButton)), '#dc2626');
    assert.equal(color(h.node(TEST_IDS.order.executeSubmit)), '#dc2626');
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'disabled');
  });
});
