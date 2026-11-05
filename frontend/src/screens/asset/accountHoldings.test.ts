import { semantic } from '../../theme/tokens.ts';
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
/** Holding rows (not the 손절가/익절가 button or count inside a row). */
const ids = (h: any) =>
  h.renderer.root
    .findAll(
      (n: any) =>
        typeof n.type === 'string' && n.props.testID?.startsWith('holding-') && !/-tp-sl(-summary)?$/.test(n.props.testID),
    )
    .map((n: any) => n.props.testID);
const empty = (h: any) =>
  h.renderer.root
    .findAllByType('InlineEmptyState')
    .map((n: any) => n.props.title)
    .join(' ');

it('a holding card opens its 익절가/손절가 sheet (no inline editor); an existing spot OCO protection stays listed, cancelable and in history under 대기 목록 › TP/SL', async t => {
  const h=inlineTradingHarness(); h.holdings={general:[holding('bnb')]};
  const {conditionalFixture}=require('../../../test/conditionalFixtures.cjs');
  h.protections=conditionalFixture('general',{domain:'spot',active:true});
  await h.mount(); t.after(h.close); await h.flush();
  assert.equal(h.node('holding-bnb') !== undefined,true);
  assert.equal(h.node('holding-bnb-tp-sl').props.label,'익절가/손절가 설정','one button on the card');
  assert.equal(h.node('holding-protection-bnb') === undefined,true,'no old OCO button');
  assert.equal(h.node('protection-panel') === undefined,true,'no inline TP/SL editor');
  assert.doesNotMatch(text(h.node('account-holdings')),/TP\/SL 설정·관리|남은 보유 수량 전체를 보호/);
  await h.press('holdings-filter-pending');await h.flush();
  // A live whole-position OCO keeps its own section under the one pending list.
  assert.match(text(h.node('pending-protections')),/현물 · 포지션 보호 중/);
  const cancel=h.renderer.root.findAll((n:any)=>n.type==='CTAButton'&&n.props.label==='보호 조건 취소')[0];
  await act(async()=>cancel.props.onPress());
  assert.equal(h.protectionRequests.length,1);
  assert.deepEqual([h.protectionRequests[0].accountId,h.protectionRequests[0].groupId],['general','group']);
  // Ended protections stay reviewable, read only on request, in the one 종료 이력.
  h.protections=conditionalFixture('general',{domain:'spot',complete:true});await h.update();
  assert.equal(h.node('pending-history') === undefined,true);
  await h.press('pending-history-toggle');await h.flush();
  assert.match(text(h.node('pending-history')),/보호 완료/);
  assert.match(text(h.node('pending-history')),/기존 손절가\/익절가\(OCO\)/);
  assert.match(text(h.node('pending-history')),/조건 충족 .* · 실행됨/);
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
  assert.match(text(h.node('pending-item-futures_limit-entry')),/숏 진입 · 교차 37x/);
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
    // The new asset's form starts without a method or draft.
    assert.equal(h.freshForm(), true);
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
      positionValue: '12345.67', unrealizedPnl: pnl,
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
      ['samsung', semantic.secondary],
    ]) {
      const row = h.node(`holding-${id}`);
      const rate = h.node(`spot-card-${id}-return`);
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
/** The unified list's cards (a card root is the node that carries its own -registered line). */
const pendingIds = (h: any) => h.renderer.root.findAll((node: any) =>
  typeof node.type === 'string' && /^pending-item-/.test(node.props.testID ?? '')
  && node.findAll((inner: any) => inner.props?.testID === `${node.props.testID}-registered`).length > 0,
).map((node: any) => node.props.testID);

describe('pending limit orders in the real trading screen', () => {
  it('a pending US BUY limit offers 손절가/익절가 only while the server lists US, and keeps existing plans manageable', async t => {
    const usRow = pendingOrder('us-1', 'buy', { quantity: '3', limitPrice: '240', asset: { id: 'aapl', symbol: 'AAPL', name: 'Apple', market: 'NAS' } });
    const capabilities = (markets: string[]) => ({ spot: { enabled: true, canCreate: true, markets }, futures: { enabled: false, canCreate: false },
      canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 });
    const list = (markets: string[], plans: unknown[]) => ({ tradingAccountId: 'general', capabilities: capabilities(markets), entry: null, plans,
      pagination: { limit: 100, offset: 0, total: plans.length, returned: plans.length, nextOffset: null } });
    const plan = { id: 'plan-us', entryType: 'spot_limit_order', entryId: 'us-1', childOrderId: null, kind: 'take_profit', triggerPrice: '260', ratioPercent: 100,
      triggerCondition: 'at_or_above', status: 'pending', activatedQuantity: null, failureCode: null, terminalReason: null };
    const tpSlButtons = async (entryTpSlList: unknown) => {
      const h = inlineTradingHarness();
      h.orders = { general: [usRow] };
      h.entryTpSlList = entryTpSlList;
      await h.mount(); t.after(h.close); await h.press('holdings-filter-pending');
      for (let i = 0; i < 20 && pendingIds(h).length === 0; i += 1) await h.flush();
      for (let i = 0; i < 5; i += 1) await h.flush();
      const find = (pattern: RegExp) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && pattern.test(n.props.testID ?? ''));
      return {
        buttons: find(/^pending-item-.*-tp-sl$/).length,
        summary: [find(/^pending-item-.*-tp-sl-summary$/)[0]?.props.children].flat().join(''),
      };
    };
    // Tiingo prices: the server lists US.
    assert.deepEqual(await tpSlButtons(list(['KRX', 'CRYPTO_SPOT', 'US'], [])), { buttons: 1, summary: '' });
    // KIS prices: US is not offered.
    assert.deepEqual(await tpSlButtons(list(['KRX', 'CRYPTO_SPOT'], [])), { buttons: 0, summary: '' });
    // Plans registered before a rollback stay visible and manageable.
    assert.deepEqual(await tpSlButtons(list(['KRX', 'CRYPTO_SPOT'], [plan])), { buttons: 1, summary: '익절 1건' });
  });

  it('a pending Spot BUY limit offers 손절가/익절가 by share of its fill; LOC and SELL rows do not', async t => {
    const h = inlineTradingHarness();
    h.orders = { general: [
      pendingOrder('buy-1', 'buy', { quantity: '100', limitPrice: '700', asset: { id: 'bnb', symbol: 'BNBUSDT', name: 'BNB', market: 'BINANCE' } }),
      pendingOrder('loc-1', 'buy', { currencyCode: 'KRW', limitOnClose: { status: 'pending' }, asset: { id: 'samsung', symbol: '005930', name: '삼성전자', market: 'KRX' } }),
      pendingOrder('sell-1', 'sell', { asset: { id: 'eth', symbol: 'ETHUSDT', name: 'ETH', market: 'BINANCE' } }),
    ] };
    h.entryTpSlList = { tradingAccountId: 'general', capabilities: { spot: { enabled: true, canCreate: true }, futures: { enabled: false, canCreate: false },
      canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 }, entry: null,
      plans: [{ id: 'plan-1', entryType: 'spot_limit_order', entryId: 'buy-1', childOrderId: null, kind: 'stop_loss', triggerPrice: '600', ratioPercent: 100,
        triggerCondition: 'at_or_below', status: 'pending', activatedQuantity: null, failureCode: null, terminalReason: null }],
      pagination: { limit: 100, offset: 0, total: 1, returned: 1, nextOffset: null } };
    h.entryTpSlEntry = (entryType: string, entryId: string) => ({ entryType, entryId, domain: 'spot', state: 'open', supported: true, assetId: 'bnb',
      asset: { id: 'bnb', symbol: 'BNBUSDT', name: 'BNB', market: 'BINANCE', assetType: 'crypto' }, instrumentId: null, direction: 'long',
      executionType: 'limit', entryPrice: '700', triggerPrice: null, limitPrice: '700', expectedQuantity: '100', amount: null, currencyCode: 'USD',
      leverage: null, legacyProtection: false, childOrderId: null });
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending');
    // The plan's own card (a fixture read) shows before the real Spot read lands: wait for the order.
    for (let i = 0; i < 20 && !h.node('pending-item-spot_limit-buy-1'); i += 1) await h.flush();
    const button = h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /^pending-item-.*-tp-sl$/.test(n.props.testID ?? ''));
    assert.equal(button.length, 1, 'only the ordinary BUY limit');
    assert.equal(button[0].props.label, '손절가/익절가 설정');
    const summary = h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /^pending-item-.*-tp-sl-summary$/.test(n.props.testID ?? ''));
    assert.equal([summary[0]?.props.children].flat().join(''), '손절 1건');
    await act(async () => button[0].props.onPress()); await h.flush();
    assert.equal([h.node('tp-sl-entry-summary')?.props.children].flat().join(''), '지정가 매수 · 700 USD');
    assert.equal([h.node('tp-sl-entry-quantity')?.props.children].flat().join(''), '체결 예정 수량 100 BNB');
    assert.equal(h.node('tp-sl-plan-plan-1') !== undefined, true);
    await h.press('tp-sl-take-profit-toggle');
    await h.input('tp-sl-take-profit-trigger-price', '800');
    await h.press('tp-sl-take-profit-ratio-50');
    assert.equal([h.node('tp-sl-take-profit-quantity')?.props.children].flat().join(''), '체결 수량의 50% · 전량 체결 시 50 BNB');
    await h.press('tp-sl-submit'); await h.flush();
    const created = h.requests.filter((r: any) => r.url === '/trading-accounts/general/entry-tp-sl-plans');
    assert.equal(created.length, 1);
    assert.deepEqual({ ...created[0].body, idempotencyKey: undefined },
      { entryType: 'spot_limit_order', entryId: 'buy-1', takeProfit: { triggerPrice: '800', ratio: 50 }, idempotencyKey: undefined });
  });

  for (const [spot, futures] of [[0, 1], [1, 0], [0, 0]])
    it(`one list for Spot ${spot}/Futures ${futures}; a live OCO keeps its section and is never "nothing pending"`, async t => {
      const h = inlineTradingHarness();
      const { futuresFixture } = require('../../../test/futuresFixtures.cjs');
      const { conditionalFixture } = require('../../../test/conditionalFixtures.cjs');
      h.orders = { general: spot ? [pendingOrder('spot-only', 'buy')] : [] };
      h.pendingEntries = { general: futures ? [{ id: 'futures-only', instrument: futuresFixture('general').catalog.instruments[0], direction: 'long', marginMode: 'isolated', leverage: 10, limitPrice: '100', quantity: '1', reservedAmount: '10', createdAt: '2026-09-28T00:00:00.000Z' }] : [] };
      h.protections = conditionalFixture('general', { domain: 'futures', holding: true });
      await h.mount(); t.after(h.close); await h.press('holdings-filter-pending');
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && (pendingIds(h).length !== spot + futures || !h.node('pending-protections'))) await h.flush();
      assert.deepEqual(pendingIds(h), [...(futures ? ['pending-item-futures_limit-futures-only'] : []), ...(spot ? ['pending-item-spot_limit-spot-only'] : [])]);
      assert.match(text(h.node('pending-protections')), /진입 체결 대기/);
      assert.doesNotMatch(empty(h), /대기 중인 주문이 없습니다/);
      // No kind groups or filters remain.
      assert.equal(h.renderer.root.findAll((n: any) => /^pending-(kind|group)-/.test(n.props?.testID ?? '')).length, 0);
    });
  it('대기 목록 is one list without kind filters: every kind once, oldest registration first', async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: [pendingOrder('late', 'buy', { submittedAt: '2026-09-29T02:00:00.000Z', createdAt: '2026-09-29T02:00:00.000Z' }),
      pendingOrder('early', 'sell', { submittedAt: '2026-09-29T01:00:00.000Z', createdAt: '2026-09-29T01:00:00.000Z' })] };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-early', 'pending-item-spot_limit-late']);
    assert.equal(h.renderer.root.findAll((n: any) => /^pending-(kind|group)-/.test(n.props?.testID ?? '')).length, 0);
    assert.match(text(h.node('pending-count')), /대기 2건 · 먼저 등록한 순/);
  });

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
    assert.match(empty(h), /대기 중인 주문이 없습니다/);
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
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-buy', 'pending-item-spot_limit-sell']);
    const buy = h.node('pending-item-spot_limit-buy');
    const sell = h.node('pending-item-spot_limit-sell');
    assert.match(text(buy), /지정가.*매수.*매수 유형지정가/);
    assert.match(text(sell), /지정가.*매도.*매도 유형지정가/);
    assert.match(text(buy), /\(12,345,678,901,234,567,890\.12345678 BUY\)/);
    assert.match(text(sell), /주문 조건지정가 \$12,345,678,901,234,567,890\.12345678/);
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
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-buy']);
  });

  it('switches General to Season without ever showing the old account row', async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: [pendingOrder('a', 'buy')], season: [pendingOrder('b', 'sell')] };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-a']);
    h.orderGate = { season: deferred() };
    h.accountId = 'season';
    h.routeAccountId = 'season'; await h.update();
    assert.deepEqual(pendingIds(h), []);
    await h.press('holdings-filter-pending');
    assert.deepEqual(pendingIds(h), []);
    await act(async () => h.orderGate.season.resolve()); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-b']);
    assert.deepEqual(h.orderReads.map((read: any) => read.id), ['general', 'season']);
  });

  it('refreshes create, matcher execution and cancellation from the account-scoped key', async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: [pendingOrder('buy', 'buy')] };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-buy']);
    h.orders.general.push(pendingOrder('sell', 'sell'));
    await act(async () => invalidateAfterOrderCreate(h.client, 'general')); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-buy', 'pending-item-spot_limit-sell']);
    h.invalidations = [];
    h.orders.general[0].status = 'executed';
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.ordersAll('general') })); await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-sell']);
    assert.ok(h.invalidations.some((key: any[]) => key[1] === 'positions' && key[2] === 'general'));
    assert.ok(h.invalidations.every((key: any[]) => key[2] !== 'season'));
    h.orders.general[1].status = 'canceled';
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.ordersAll('general') })); await h.flush();
    assert.deepEqual(pendingIds(h), []);
    assert.match(empty(h), /대기 중인 주문이 없습니다/);
    // Polled while focused: every 4 s while something is pending, every 15 s while the list is empty.
    const orders = h.queries.filter((q: any) => q.queryKey[1] === 'orders' && typeof q.refetchInterval === 'function').at(-1);
    assert.equal(orders !== undefined, true);
    assert.deepEqual([orders.refetchInterval({ state: { data: { items: [{}] } } }), orders.refetchInterval({ state: { data: { items: [] } } })], [4000, 15000]);
  });

  it('reads every submitted page before displaying the list', async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: Array.from({ length: 205 }, (_, i) => pendingOrder(`o${i}`, i % 2 ? 'sell' : 'buy')) };
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.equal(pendingIds(h).length, 205);
    assert.deepEqual(h.orderReads.map((read: any) => read.offset), [0, 100, 200]);
    assert.match(text(h.node('pending-count')), /대기 205건/);
  });

  for (const integrity of [false, true]) it(`distinguishes ${integrity ? 'integrity' : 'network'} failure from empty`, async (t) => {
    const h = inlineTradingHarness();
    h.orders = { general: [] };
    h.orderError = integrity ? { response: { status: 409, data: { error: { code: 'TRADING_ACCOUNT_INTEGRITY' } } } } : new Error('offline');
    await h.mount(); t.after(h.close); await h.press('holdings-filter-pending'); await h.flush();
    assert.match(text(h.node('pending-source-error-spot')), integrity ? /현물 지정가 주문을 안전하게 표시할 수 없어요/ : /현물 지정가 주문을 불러오지 못했어요/);
    assert.doesNotMatch(empty(h), /대기 중인 주문이 없습니다/);
    h.orderError = null; await h.press('pending-source-retry-spot'); await h.flush();
    assert.match(empty(h), /대기 중인 주문이 없습니다/);
  });
});


describe('설정 변경 / 설정 취소 on the one pending list', () => {
  const values = (h: any, id: string) => [h.node(id)?.props.value].flat().join('');
  // The sheet's frame takes touches only while it is open (a closing sheet animates out).
  const sheetOpen = (h: any) => h.node('pending-edit-sheet')?.props.pointerEvents === 'auto';
  const open = async (h: any, rows: unknown[]) => {
    h.orders = { general: rows };
    await h.mount(); await h.press('holdings-filter-pending');
    for (let i = 0; i < 20 && pendingIds(h).length === 0; i += 1) await h.flush();
  };
  const bnb = () => pendingOrder('buy-1', 'buy', { quantity: '100', limitPrice: '700', revision: 2,
    asset: { id: 'bnb', symbol: 'BNBUSDT', name: 'BNB', market: 'BINANCE' } });

  it('prefills the current terms, reviews before → after, and sends ONE modify with the row revision', async (t) => {
    const h = inlineTradingHarness();
    t.after(h.close);
    await open(h, [bnb()]);
    await h.press('pending-item-spot_limit-buy-1-edit');
    assert.equal(sheetOpen(h), true);
    assert.equal(values(h, 'pending-edit-limit-price'), '700');
    assert.equal(values(h, 'pending-edit-amount'), '70000');
    // A plain limit stays limit: no execution choice is offered.
    assert.equal(h.node('pending-edit-execution') === undefined, true);
    assert.match(text(h.node('pending-edit-execution-fixed')), /지정가 · 이 지정가의 실행 유형은 바꿀 수 없어요/);
    // Nothing changed: no request.
    await h.press('pending-edit-review');
    assert.match(text(h.node('pending-edit-message')), /변경된 내용이 없어요/);
    await h.input('pending-edit-limit-price', '650');
    await h.press('pending-edit-review');
    assert.match(text(h.node('pending-edit-changes')), /지정가.*700.*→.*650/);
    assert.equal(h.requests.some((r: any) => r.url.endsWith('/modify')), false, 'reviewing sends nothing');
    h.orders.general[0] = { ...h.orders.general[0], limitPrice: '650', quantity: '107.692307', revision: 3 };
    await h.press('pending-edit-save'); await h.flush();
    const sent = h.requests.filter((r: any) => r.url.endsWith('/modify'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, '/trading-accounts/general/orders/buy-1/modify');
    assert.deepEqual({ ...sent[0].body, idempotencyKey: typeof sent[0].body.idempotencyKey },
      { limitPrice: '650', amount: '70000', expectedRevision: 2, idempotencyKey: 'string' });
    // Never a cancel plus a new order.
    assert.equal(h.requests.some((r: any) => r.url.endsWith('/cancel') || r.url.endsWith('/orders')), false);
    for (let i = 0; i < 10 && !h.node('pending-notice'); i += 1) await h.flush();
    assert.match(text(h.node('pending-notice')), /BNB 지정가 설정을 변경했어요/);
    assert.equal(sheetOpen(h), false);
    assert.match(text(h.node('pending-item-spot_limit-buy-1-condition')), /지정가 \$650/);
  });

  it('an unconfirmed result retries with the SAME key; a refused one keeps the order and offers only 닫기 when it moved on', async (t) => {
    const h = inlineTradingHarness();
    t.after(h.close);
    await open(h, [bnb()]);
    await h.press('pending-item-spot_limit-buy-1-edit');
    await h.input('pending-edit-amount', '35000');
    await h.press('pending-edit-review');
    h.modifyFailures = [
      Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} }),
      { response: { status: 409, data: { error: { code: 'PENDING_ORDER_CHANGED', message: 'changed' } } } },
    ];
    await h.press('pending-edit-save'); await h.flush();
    assert.match(text(h.node('pending-edit-error')), /변경 결과를 확인하지 못했어요/);
    assert.equal(h.node('pending-edit-save')?.props.label, '같은 요청으로 다시 확인');
    // The draft cannot be edited into another request while the first is unconfirmed.
    assert.equal(h.node('pending-edit-back')?.props.state, 'disabled');
    await h.press('pending-edit-save'); await h.flush();
    const sent = h.requests.filter((r: any) => r.url.endsWith('/modify'));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.idempotencyKey, sent[0].body.idempotencyKey);
    assert.deepEqual(sent[1].body, sent[0].body);
    // The order changed elsewhere: no save, the list shows the server's state.
    assert.equal(h.node('pending-edit-save') === undefined, true);
    assert.equal(h.node('pending-edit-close') !== undefined, true);
    assert.match(text(h.node('pending-edit-error')), /다른 곳에서 바뀌었|최신 상태|변경되었/);
    await h.press('pending-edit-close'); await h.flush();
    assert.equal(sheetOpen(h), false);
    assert.match(text(h.node('pending-item-spot_limit-buy-1-condition')), /지정가 \$700/);
  });

  it('LOC shows why it cannot change; 설정 취소 asks first, 유지 keeps it, 취소하기 sends one cancel', async (t) => {
    const h = inlineTradingHarness();
    t.after(h.close);
    await open(h, [
      pendingOrder('loc-1', 'buy', { currencyCode: 'KRW', quantity: '3', limitPrice: '70000', limitOnClose: { status: 'pending' },
        asset: { id: 'samsung', symbol: '005930', name: '삼성전자', market: 'KRX' }, submittedAt: '2026-09-29T00:00:00.000Z' }),
      pendingOrder('sell-1', 'sell', { quantity: '2', limitPrice: '900', submittedAt: '2026-09-29T01:00:00.000Z',
        asset: { id: 'eth', symbol: 'ETHUSDT', name: 'ETH', market: 'BINANCE' } }),
    ]);
    assert.equal(h.node('pending-item-spot_limit-loc-1-edit')?.props.disabled, true);
    assert.match(text(h.node('pending-item-spot_limit-loc-1-edit-reason')), /LOC.*변경할 수 없어요/);
    assert.equal(h.node('pending-item-spot_limit-sell-1-edit')?.props.disabled, false);
    await h.press('pending-item-spot_limit-sell-1-cancel');
    assert.match(text(h.node('pending-item-spot_limit-sell-1-confirm')), /지정가 매도 주문을 취소할까요/);
    await h.press('pending-item-spot_limit-sell-1-keep');
    assert.equal(h.node('pending-item-spot_limit-sell-1-confirm') === undefined, true);
    assert.equal(h.requests.some((r: any) => r.url.endsWith('/cancel')), false);
    await h.press('pending-item-spot_limit-sell-1-cancel');
    h.orders.general = h.orders.general.filter((row: any) => row.id !== 'sell-1');
    await h.press('pending-item-spot_limit-sell-1-confirm-cancel'); await h.flush();
    assert.deepEqual(h.requests.filter((r: any) => r.url.endsWith('/cancel')).map((r: any) => r.url),
      ['/trading-accounts/general/orders/sell-1/cancel']);
    for (let i = 0; i < 10 && pendingIds(h).length !== 1; i += 1) await h.flush();
    assert.deepEqual(pendingIds(h), ['pending-item-spot_limit-loc-1']);
    assert.match(text(h.node('pending-notice')), /ETH 지정가 설정을 취소했어요/);
  });
});

describe('익절가/손절가 설정 변경: 수량 비율 (현물, 2026-11-05)', () => {
  const value = (h: any, id: string) => [h.node(id)?.props.value].flat().join('');
  const label = (h: any, id: string) => [h.node(id)?.props.children].flat().join('');
  const sheetOpen = (h: any) => h.node('pending-edit-sheet')?.props.pointerEvents === 'auto';
  const modifies = (h: any) => h.requests.filter((r: any) => r.url.endsWith('/modify'));
  const samsung = { assetId: 'samsung', asset: { id: 'samsung', symbol: '005930', name: '삼성전자', market: 'KRX', assetType: 'domestic_stock' }, currencyCode: 'KRW' };
  const setting = (kind: 'stop_loss' | 'take_profit', patch: Record<string, unknown> = {}) => ({
    id: `cs-${kind}`, ...samsung, side: 'sell', kind, positionId: 'generalsamsung',
    triggerCondition: kind === 'stop_loss' ? 'at_or_below' : 'at_or_above', triggerPrice: kind === 'stop_loss' ? '199000.00000000' : '220000.00000000',
    executionType: 'market', limitPrice: null, quantity: '3.16412600', status: 'watching', state: 'watching', position: null,
    executionAvailableQuantity: null, quantityLimited: false, trigger: null, order: null, attemptCount: 0, lastAttemptAt: null,
    failureCode: null, terminalReason: null, createdAt: '2026-11-05T01:00:00.000Z', endedAt: null, updatedAt: '2026-11-05T01:00:00.000Z',
    revision: 4, ...patch,
  });
  const sells = (rows: unknown[]) => ({ tradingAccountId: 'general',
    capabilities: { enabled: true, condition: { enabled: true, canCreate: true, canUseLimit: false },
      protection: { enabled: true, canCreate: true, canUseLimit: false }, canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 30 },
    conditionalOrders: rows, pagination: { limit: 100, offset: 0, total: rows.length, returned: rows.length, nextOffset: null } });
  const open = async (h: any, rows: unknown[], positions: unknown[]) => {
    h.sellList = sells(rows);
    h.holdings = { general: positions };
    h.orders = { general: [] };
    await h.mount(); await h.press('holdings-filter-pending');
    for (let i = 0; i < 20 && pendingIds(h).length === 0; i += 1) await h.flush();
  };
  const edit = async (h: any, key = 'spot_stop_loss-cs-stop_loss') => {
    await h.press(`pending-item-${key}-edit`);
    for (let i = 0; i < 20 && h.node('pending-edit-quantity-basis') === undefined; i += 1) await h.flush();
  };

  it('the card reads 익절가/손절가 · 매도 · 손절가 · 매도 기준가 with no 최대; 설정 변경 opens on the registered quantity and its share, sending nothing', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    await open(h, [setting('stop_loss')], [holding('samsung', '6.328252')]);
    const id = 'pending-item-spot_stop_loss-cs-stop_loss';
    assert.equal(text(h.node(`${id}-type`)), '익절가/손절가');
    assert.match(text(h.node(id)), /매도 · 손절가/);
    assert.match(text(h.node(`${id}-amount`)), /예상 금액≈ 629,661원 \(3\.164126주\)/);
    assert.match(text(h.node(`${id}-condition`)), /매도 기준가 199,000원 이하/);
    assert.doesNotMatch(text(h.node(id)), /최대|감시가격|보유수량의/);
    await edit(h);
    assert.equal(sheetOpen(h), true);
    assert.equal(value(h, 'pending-edit-quantity'), '3.164126');
    assert.equal(label(h, 'pending-edit-quantity-ratio-percent'), '50%');
    assert.equal(label(h, 'pending-edit-quantity-basis'), '현재 보유 6.328252주 기준');
    assert.equal(['25', '50', '75', '100'].some((p) => h.node(`pending-edit-quantity-ratio-${p}`).props.accessibilityState.selected), false, 'no pick is claimed on open');
    assert.match(label(h, 'pending-edit-direction-fixed'), /이하 도달 시 실행 · 손절가는 방향이 정해져 있어요/);
    assert.match(label(h, 'pending-edit-execution-fixed'), /시장가 · 이 손절가의 실행 유형은 바꿀 수 없어요/);
    assert.equal(h.node('pending-edit-trigger-price').props.accessibilityLabel, '매도 기준가');
    assert.match(label(h, 'pending-edit-trigger-hint'), /자동 매도 여부를 판단하는 가격이에요\. 실제 체결가격은 다를 수 있어요/);
    assert.doesNotMatch(text(h.node('pending-edit-sheet')), /감시가격/);
    assert.equal(modifies(h).length, 0);
  });

  it('25/50/75/100% and the slider write a share of the TOTAL holding, rounded down to 6 decimals; typing moves the thumb and is never rewritten', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    await open(h, [setting('stop_loss')], [holding('samsung', '6.328252')]);
    await edit(h);
    await h.press('pending-edit-quantity-ratio-25');
    assert.equal(value(h, 'pending-edit-quantity'), '1.582063');
    assert.equal(h.node('pending-edit-quantity-ratio-25').props.accessibilityState.selected, true);
    await h.press('pending-edit-quantity-ratio-75');
    assert.equal(value(h, 'pending-edit-quantity'), '4.746189');
    await h.press('pending-edit-quantity-ratio-100');
    assert.equal(value(h, 'pending-edit-quantity'), '6.328252');
    await h.slide('pending-edit-quantity-ratio-slider', 30);
    assert.deepEqual([value(h, 'pending-edit-quantity'), label(h, 'pending-edit-quantity-ratio-percent')], ['1.898475', '30%']);
    await h.input('pending-edit-quantity', '2.5');
    assert.deepEqual([value(h, 'pending-edit-quantity'), label(h, 'pending-edit-quantity-ratio-percent')], ['2.5', '40%']);
    assert.equal(['25', '50', '75', '100'].some((p) => h.node(`pending-edit-quantity-ratio-${p}`).props.accessibilityState.selected), false);
    await h.slide('pending-edit-quantity-ratio-slider', 0);
    assert.equal(value(h, 'pending-edit-quantity'), '');
    await h.press('pending-edit-review');
    assert.match(label(h, 'pending-edit-message'), /수량은 0보다 큰 숫자로, 소수점 6자리까지/);
    await h.input('pending-edit-quantity', '2.5');
    await h.press('pending-edit-review');
    assert.match(text(h.node('pending-edit-changes')), /수량3\.164126 주 → 2\.5 주/);
    await h.press('pending-edit-save'); await h.flush();
    assert.deepEqual(modifies(h).map((r: any) => r.url), ['/trading-accounts/general/conditional-sell-orders/cs-stop_loss/modify']);
    assert.deepEqual({ ...modifies(h)[0].body, idempotencyKey: typeof modifies(h)[0].body.idempotencyKey },
      { triggerPrice: '199000', executionType: 'market', quantity: '2.5', expectedRevision: 4, idempotencyKey: 'string' });
    assert.equal(h.requests.some((r: any) => r.url.endsWith('/cancel') || r.url.endsWith('/conditional-sell-orders')), false, 'never a cancel plus a new setting');
    for (let i = 0; i < 10 && !h.node('pending-notice'); i += 1) await h.flush();
    assert.match(text(h.node('pending-notice')), /삼성전자 손절가 설정을 변경했어요/);
  });

  it('changing only the 매도 기준가 keeps the fractional registered quantity (no whole-share rule at market)', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    await open(h, [setting('take_profit')], [holding('samsung', '6.328252')]);
    await edit(h, 'spot_take_profit-cs-take_profit');
    assert.match(label(h, 'pending-edit-direction-fixed'), /이상 도달 시 실행 · 익절가는 방향이 정해져 있어요/);
    await h.input('pending-edit-trigger-price', '225000');
    await h.press('pending-edit-review');
    assert.equal(h.node('pending-edit-message') === undefined, true);
    assert.match(text(h.node('pending-edit-changes')), /매도 기준가220,000원 → 225,000원/);
    assert.doesNotMatch(text(h.node('pending-edit-changes')), /수량/);
    await h.press('pending-edit-save'); await h.flush();
    assert.deepEqual([modifies(h).length, modifies(h)[0].body.triggerPrice, modifies(h)[0].body.quantity, modifies(h)[0].body.executionType],
      [1, '225000', '3.164126', 'market']);
  });

  it('without a holding read the share is off and computes nothing; typing still works, and the read turns it on', async (t) => {
    const loading = inlineTradingHarness(); t.after(loading.close);
    loading.holdingsGate = { general: deferred() };
    await open(loading, [setting('stop_loss')], [holding('samsung', '6.328252')]);
    await loading.press('pending-item-spot_stop_loss-cs-stop_loss-edit');
    assert.equal(label(loading, 'pending-edit-quantity-ratio-reason'), '보유 수량을 확인하는 중이에요.');
    assert.equal(loading.node('pending-edit-quantity-ratio-slider').props.disabled, true);
    await loading.press('pending-edit-quantity-ratio-50');
    assert.deepEqual([value(loading, 'pending-edit-quantity'), label(loading, 'pending-edit-quantity-ratio-percent')], ['3.164126', '0%']);
    await act(async () => loading.holdingsGate.general.resolve()); await loading.flush();
    assert.equal(loading.node('pending-edit-quantity-ratio-reason') === undefined, true);
    assert.equal(label(loading, 'pending-edit-quantity-ratio-percent'), '50%');
    assert.equal(value(loading, 'pending-edit-quantity'), '3.164126', 'the read changes the thumb, never the quantity');

    const failed = inlineTradingHarness(); t.after(failed.close);
    failed.holdingsError = new Error('offline');
    await open(failed, [setting('stop_loss')], [holding('samsung', '6.328252')]);
    await failed.press('pending-item-spot_stop_loss-cs-stop_loss-edit');
    // Opening retries the failed read (확인하는 중) before it reports the failure.
    for (let i = 0; i < 10 && !/확인하지 못해/u.test(label(failed, 'pending-edit-quantity-ratio-reason')); i += 1) await failed.flush();
    assert.equal(label(failed, 'pending-edit-quantity-ratio-reason'), '보유 수량을 확인하지 못해 비율로 정할 수 없어요. 수량은 직접 입력할 수 있어요.');
    await failed.press('pending-edit-quantity-ratio-100');
    assert.equal(value(failed, 'pending-edit-quantity'), '3.164126');
    await failed.input('pending-edit-quantity', '1');
    await failed.press('pending-edit-review');
    assert.match(text(failed.node('pending-edit-changes')), /수량3\.164126 주 → 1 주/);
  });

  it('a setting above today\'s holding opens as registered (never shrunk); the server rules decide a change', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    await open(h, [setting('stop_loss')], [holding('samsung', '2')]);
    await edit(h);
    assert.deepEqual([value(h, 'pending-edit-quantity'), label(h, 'pending-edit-quantity-ratio-percent')], ['3.164126', '100%']);
    assert.match(label(h, 'pending-edit-quantity-over'), /설정 수량이 현재 보유 수량보다 많아요/);
    await h.input('pending-edit-trigger-price', '198000');
    await h.press('pending-edit-review');
    h.modifyFailures = [{ response: { status: 409, data: { error: { code: 'CONDITIONAL_SELL_QUANTITY_EXCEEDS_HOLDING', message: 'raw' } } } }];
    await h.press('pending-edit-save'); await h.flush();
    assert.match(text(h.node('pending-edit-error')), /설정 수량은 현재 보유 수량을 넘을 수 없습니다/);
    assert.equal(h.node('pending-edit-save')?.props.label, '저장하기', 'a definite refusal is not an unconfirmed result');
    await h.press('pending-edit-back');
    await h.press('pending-edit-quantity-ratio-100');
    assert.equal(value(h, 'pending-edit-quantity'), '2');
    assert.equal(h.node('pending-edit-quantity-over') === undefined, true);
    // Other live settings of the same kind still count on the server.
    await h.press('pending-edit-review');
    h.modifyFailures = [{ response: { status: 409, data: { error: { code: 'CONDITIONAL_SELL_TOTAL_EXCEEDS_HOLDING', message: 'raw' } } } }];
    await h.press('pending-edit-save'); await h.flush();
    assert.match(text(h.node('pending-edit-error')), /같은 종류\(익절 또는 손절\) 설정과 합친 수량이 현재 보유 수량을 넘어 등록하거나 변경할 수 없습니다/);
    assert.equal(modifies(h).length, 2);
    assert.notEqual(modifies(h)[1].body.idempotencyKey, modifies(h)[0].body.idempotencyKey, 'another change, another key');
  });

  it('a crypto pick below the smallest unit writes and sends nothing, and says why', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    const bnb = { assetId: 'bnb', asset: { id: 'bnb', symbol: 'BNBUSDT', name: 'BNB', market: 'BINANCE', assetType: 'crypto' },
      currencyCode: 'USD', triggerPrice: '700.00000000', quantity: '0.00000200' };
    await open(h, [setting('stop_loss', bnb)], [holding('bnb', '0.000003')]);
    await edit(h);
    assert.equal(label(h, 'pending-edit-quantity-basis'), '현재 보유 0.000003 BNB 기준');
    await h.press('pending-edit-quantity-ratio-25');
    assert.equal(value(h, 'pending-edit-quantity'), '0.000002');
    assert.match(label(h, 'pending-edit-quantity-ratio-notice'), /최소 단위보다 적어요/);
    await h.press('pending-edit-quantity-ratio-100');
    assert.equal(value(h, 'pending-edit-quantity'), '0.000003');
    assert.equal(h.node('pending-edit-quantity-ratio-notice') === undefined, true);
    assert.equal(modifies(h).length, 0);
  });

  it('a SELL condition and a Futures stop-loss keep their sheets: no holding share; Futures keep 감시가격', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    h.futuresTpSl = { general: { open: [{ id: 'ft-1', tradingAccountId: 'general', instrumentId: 'i', positionId: 'pos', direction: 'long',
      instrument: { underlying: { symbol: 'BTCUSDT', name: 'BTC', displayPriceDecimals: 2 } }, kind: 'stop_loss', triggerCondition: 'at_or_below',
      triggerPrice: '60000.00000000', quantity: '0.01000000', status: 'watching', state: 'watching', position: null, execution: null,
      quantityLimited: false, trigger: null, entryPlanId: null, attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null,
      createdAt: '2026-11-05T00:00:00.000Z', endedAt: null, updatedAt: '2026-11-05T00:00:00.000Z', revision: 1 }] } };
    await open(h, [setting('stop_loss', { id: 'c-1', kind: 'condition', triggerCondition: 'at_or_above', quantity: '2.50000000' })],
      [holding('samsung', '6.328252')]);
    for (let i = 0; i < 20 && !h.node('pending-item-futures_stop_loss-ft-1'); i += 1) await h.flush();
    assert.equal(text(h.node('pending-item-conditional_sell-c-1-type')), '조건주문');
    assert.match(text(h.node('pending-item-conditional_sell-c-1-condition')), /매도 기준가 199,000원 이상/);
    await h.press('pending-item-conditional_sell-c-1-edit');
    assert.equal(h.node('pending-edit-quantity-ratio') === undefined, true, 'conditions keep their sheet');
    assert.equal(h.node('pending-edit-direction') !== undefined, true);
    assert.equal(value(h, 'pending-edit-quantity'), '2.5');
    await h.press('pending-edit-sheet-close');
    assert.equal(text(h.node('pending-item-futures_stop_loss-ft-1-type')), '선물 손절가');
    assert.match(text(h.node('pending-item-futures_stop_loss-ft-1-amount')), /최대 0\.01 BTC/);
    await h.press('pending-item-futures_stop_loss-ft-1-edit');
    assert.equal(h.node('pending-edit-quantity-ratio') === undefined, true);
    assert.equal(h.node('pending-edit-trigger-hint') === undefined, true);
    assert.equal(h.node('pending-edit-trigger-price').props.accessibilityLabel, '감시가격');
    assert.match(label(h, 'pending-edit-direction-fixed'), /이하 도달 시 실행 · 손절가는 방향이 정해져 있어요/);
    assert.match(label(h, 'pending-edit-execution-fixed'), /시장가 · 이 선물 손절가의 실행 유형은 바꿀 수 없어요/);
  });

  it('a double save is one change (one key); a setting that fired or ended meanwhile is refused, offering only 닫기', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    await open(h, [setting('stop_loss')], [holding('samsung', '6.328252')]);
    await edit(h);
    await h.press('pending-edit-quantity-ratio-25');
    await h.press('pending-edit-review');
    h.modifyGate = deferred();
    const save = h.node('pending-edit-save').props.onPress;
    await act(async () => { save(); save(); });
    await act(async () => h.modifyGate.resolve()); await h.flush();
    assert.equal(new Set(modifies(h).map((r: any) => r.body.idempotencyKey)).size, 1, 'the server applies it once');
    h.modifyGate = null;

    const moved = inlineTradingHarness(); t.after(moved.close);
    await open(moved, [setting('stop_loss')], [holding('samsung', '6.328252')]);
    await edit(moved);
    await moved.press('pending-edit-quantity-ratio-25');
    await moved.press('pending-edit-review');
    moved.modifyFailures = [{ response: { status: 409, data: { error: { code: 'PENDING_ORDER_NOT_MODIFIABLE', message: 'raw' } } } }];
    await moved.press('pending-edit-save'); await moved.flush();
    assert.match(text(moved.node('pending-edit-error')), /이미 체결·발동·취소되어 변경할 수 없어요/);
    assert.equal(moved.node('pending-edit-save') === undefined, true, 'no retry of a refused change');
    await moved.press('pending-edit-close'); await moved.flush();
    assert.equal(sheetOpen(moved), false);
    assert.equal(modifies(moved).length, 1);
    assert.equal(moved.requests.some((r: any) => r.url.endsWith('/cancel') || r.url.endsWith('/conditional-sell-orders')), false);
  });

  it('switching the account closes the sheet before anything is sent', async (t) => {
    const h = inlineTradingHarness(); t.after(h.close);
    await open(h, [setting('stop_loss')], [holding('samsung', '6.328252')]);
    await edit(h);
    await h.press('pending-edit-quantity-ratio-50');
    h.accountId = 'season'; h.routeAccountId = 'season';
    await h.update(); await h.flush();
    assert.equal(sheetOpen(h), false);
    assert.equal(modifies(h).length, 0);
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

describe('order screen holdings switch the order in place', () => {
  it('a holding of another asset opens its order on the same account with fresh inputs', async (t) => {
    const h = inlineTradingHarness();
    h.holdings = { general: [holding('bnb', '2'), holding('btc', '3')] };
    await h.mount(); t.after(h.close); await h.flush();
    await h.input(TEST_IDS.order.quantityInput, '5');
    await h.press('holdings-filter-all');
    // The current asset's own row is not a navigation target.
    assert.equal(h.node('spot-card-bnb').props.onPress, undefined);
    const other = h.node('spot-card-btc');
    assert.equal(typeof other.props.onPress, 'function');
    assert.equal(other.props.accessibilityRole, 'button');
    assert.match(other.props.accessibilityHint, /주문 화면으로 전환/);
    assert.equal(h.navigation.some((entry: any) => entry[0] === 'setParams'), false);
    await act(async () => other.props.onPress());
    assert.deepEqual(h.navigation.at(-1), ['setParams', { assetId: 'btc', side: 'buy' }]);
    await h.update(); await h.flush();
    assert.equal(h.routeAccountId, h.accountId, 'the account is never changed');
    assert.equal(h.freshForm(), true, 'the previous asset method and input do not carry over');
  });
});
