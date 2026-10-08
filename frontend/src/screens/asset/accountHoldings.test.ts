import { financial } from '../../theme/financialColors.ts';
import assert from 'node:assert/strict';
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
        typeof n.type === 'string' && n.props.testID?.startsWith('holding-') && !n.props.testID.startsWith('holding-protection-'),
    )
    .map((n: any) => n.props.testID);
const empty = (h: any) =>
  h.renderer.root
    .findAllByType('InlineEmptyState')
    .map((n: any) => n.props.title)
    .join(' ');

it('holding TP/SL creates with the card account, asset and Position; active protection opens management', async t => {
  const h=inlineTradingHarness(); h.holdings={general:[holding('bnb')]};
  const {conditionalFixture}=require('../../../test/conditionalFixtures.cjs');
  h.protections=conditionalFixture('general',{domain:'spot'});
  await h.mount(); t.after(h.close); await h.flush();
  await h.press('holding-protection-bnb');
  assert.equal(h.node('protection-panel') !== undefined,true);
  await h.press('protection-stop_loss-toggle');
  const input=h.renderer.root.findAll((n:any)=>n.type==='TextInput' && n.props.accessibilityLabel==='손절 (Stop Loss) 조건 가격')[0];
  await act(async()=>input.props.onChangeText('500'));
  const submit=h.renderer.root.findAll((n:any)=>n.type==='CTAButton' && n.props.label==='보호 조건 등록')[0];
  await act(async()=>submit.props.onPress());
  assert.equal(h.protectionRequests.length,1);
  assert.deepEqual({...h.protectionRequests[0].body,idempotencyKey:'key'}, {domain:'spot',assetId:'bnb',positionId:'bnb',legs:[{kind:'stop_loss',triggerPrice:'500',childOrderType:'market'}],idempotencyKey:'key'});
  assert.equal(h.protectionRequests[0].accountId,'general');
  h.protections=conditionalFixture('general',{domain:'spot',active:true});
  await h.update();
  assert.equal(h.node('protection-stop_loss-toggle') === undefined,true);
  const cancel=h.renderer.root.findAll((n:any)=>n.type==='CTAButton' && n.props.label==='보호 조건 취소')[0];
  assert.equal(!!cancel,true); await act(async()=>cancel.props.onPress());
  assert.equal(h.protectionRequests[1].groupId,'group');
});

it('pending separates Spot/Futures entries from active or holding Protection and honors cancellation capability', async t => {
  const h=inlineTradingHarness();
  const {conditionalFixture}=require('../../../test/conditionalFixtures.cjs');
  const {futuresFixture}=require('../../../test/futuresFixtures.cjs');
  h.pendingEntries={general:[{id:'entry',instrument:futuresFixture('general').catalog.instruments[0],direction:'short',marginMode:'cross',leverage:37,limitPrice:'100',quantity:'1',reservedAmount:'3'}]};
  h.protections=conditionalFixture('general',{domain:'futures',holding:true});
  h.protections.groups.push({...h.protections.groups[0],id:'finished',status:'completed',asset:{name:'SHOULD NOT DISPLAY'}});
  await h.mount();t.after(h.close);await h.flush();
  await h.press('holdings-filter-pending');await h.flush();
  assert.equal(h.node('pending-futures') !== undefined,true);
  assert.match(JSON.stringify(h.node('pending-futures').children.map(text)),/Short.*Cross.*37/);
  await h.press('pending-kind-protection');await h.flush();
  assert.equal(h.node('pending-futures') === undefined,true);
  assert.match(text(h.node('pending-protections')),/진입 체결 대기/);
  assert.doesNotMatch(text(h.node('pending-protections')),/SHOULD NOT DISPLAY/);
  const cancel=h.renderer.root.findAll((n:any)=>n.type==='CTAButton'&&n.props.label==='보호 조건 취소')[0].props.onPress;
  h.protections.capabilities={...h.protections.capabilities,enabled:false,canCancel:false};await h.update();
  assert.match(text(h.node('pending-protections')),/조건 감시가 중지/);
  await act(async()=>cancel()); assert.equal(h.protectionRequests?.length??0,0);
  h.accountId='season';await h.update();
  assert.equal(h.node('pending-protections') === undefined,true);
  await act(async()=>cancel());assert.equal(h.protectionRequests?.length??0,0);
});

it('pending keeps Futures protection visible but paused when only Futures mode is disabled; cancellation remains available', async t => {
  const h = inlineTradingHarness();
  const { conditionalFixture } = require('../../../test/conditionalFixtures.cjs');
  h.protections = conditionalFixture('general', { domain: 'futures', active: true, mode: 'DISABLED' });
  await h.mount(); t.after(h.close); await h.flush();
  await h.press('holdings-filter-pending'); await h.flush();
  await h.press('pending-kind-protection'); await h.flush();
  const content = text(h.node('pending-protections'));
  assert.match(content, /보호 감시 중지/);
  assert.equal(content.match(/조건 감시 중지/g)?.length, 2);
  assert.doesNotMatch(content, /포지션 보호 중|조건 충족 · 체결 대기/);
  const cancel = h.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === '보호 조건 취소')[0];
  assert.equal(cancel.props.state, 'enabled');
  await act(async () => cancel.props.onPress());
  assert.equal(h.protectionRequests[0].groupId, 'group');
  assert.equal(h.protectionRequests[0].accountId, 'general');
});

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
    assert.equal(h.node('holdings-filter-current').props.accessibilityState.selected, true);
    assert.deepEqual(ids(h), ['holding-btc']);
    await h.press('holdings-filter-all');
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
      h.node('holdings-filter-current').props.accessibilityState.selected,
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
    await h.press('holdings-filter-all');
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
    assert.equal(h.node('asset-market-status') === undefined, true);
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
    await h.press('holdings-filter-all');
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
    await h.press('holdings-filter-all');
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
      h.assetId = 'btc';
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
      assert.match(empty(h), /현재 종목을 보유하고 있지 않습니다/);
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
    await h.press('holdings-filter-all');
    const before = text(h.node('account-holdings'));
    assert.match(before, /123\.45%/);
    assert.match(before, /-99\.5%/);
    assert.match(before, /1\.12345678/);
    assert.match(before, /시세 조회 불가/);
    assert.match(before, /이전 시세/);
    assert.equal(ids(h).length, 5);
    for (const [id, color] of [
      ['btc', financial.rise],
      ['eth', financial.fall],
      ['samsung', null],
    ]) {
      const row = h.node(`holding-${id}`);
      const rate = row.findAllByType('Text').find((n:any) => typeof n.props.children === 'string' && n.props.children.endsWith('%'));
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
    assert.deepEqual(ids(h), []);
    await h.press('holdings-filter-all');
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
      pendingOrder('conditional-child', 'sell', { conditionalChildId: 'child' }),
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
    assert.equal(color(h.node(TEST_IDS.assetDetail.buyButton)), financial.buyAction);
    assert.equal(color(h.node(TEST_IDS.order.executeSubmit)), financial.buyAction);
    await h.press(TEST_IDS.assetDetail.sellButton); await h.flush();
    assert.equal(color(h.node(TEST_IDS.assetDetail.sellButton)), financial.sellAction);
    assert.equal(color(h.node(TEST_IDS.order.executeSubmit)), financial.sellAction);
    assert.equal(h.node(TEST_IDS.order.executeSubmit).props.state, 'disabled');
  });
});
