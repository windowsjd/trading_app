import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ORDER_METHOD,
  getAvailabilityLabel,
  getFuturesConditionalGate,
  getFuturesOrderMethodOptions,
  getConditionalBuyGate,
  getConditionalSellGate,
  getLimitOnCloseGate,
  getLimitOnCloseSellGate,
  getOrderMethodOptions,
  getOrderTypeForMethod,
  isEntryTpSlMarketSupported,
  isOrderMethodSelectable,
  serverMarket,
  type ServerGate,
} from './orderMethods.ts';

const open: ServerGate = { state: 'ready', enabled: true };
const closed: ServerGate = { state: 'ready', enabled: false, reason: '서버 꺼짐' };
const list = (assetType: string, side: 'buy' | 'sell', conditional: ServerGate = open, loc: ServerGate = open) =>
  getOrderMethodOptions({ assetType, side, conditional, loc });
const summary = (assetType: string, side: 'buy' | 'sell', conditional: ServerGate = open, loc: ServerGate = open) =>
  list(assetType, side, conditional, loc).map((option) => `${option.method}:${option.availability.state}`);

describe('주문방식 list per market and side', () => {
  it('KRX buy: market, limit, conditional and LOC, the last two following the server', () => {
    assert.deepEqual(summary('domestic_stock', 'buy'), ['market:available', 'limit:available', 'conditional:available', 'loc:available']);
    assert.deepEqual(summary('domestic_stock', 'buy', closed, closed), ['market:available', 'limit:available', 'conditional:unavailable', 'loc:unavailable']);
  });

  it('US buy lists the same four, conditional and LOC following the server (2026-10-17)', () => {
    assert.deepEqual(summary('us_stock', 'buy'), ['market:available', 'limit:available', 'conditional:available', 'loc:available']);
    assert.deepEqual(summary('us_stock', 'buy', closed, closed), ['market:available', 'limit:available', 'conditional:unavailable', 'loc:unavailable']);
    assert.deepEqual(summary('us_stock', 'buy', { state: 'loading' }, { state: 'error' }), ['market:available', 'limit:available', 'conditional:checking', 'loc:unavailable']);
  });

  it('crypto buy: market, limit and conditional; never LOC', () => {
    assert.deepEqual(summary('crypto', 'buy'), ['market:available', 'limit:available', 'conditional:available']);
  });

  it('KRX sell: market plus conditional and LOC following their own server gates; no new limit', () => {
    assert.deepEqual(summary('domestic_stock', 'sell'), ['market:available', 'conditional:available', 'loc:available']);
    assert.deepEqual(summary('domestic_stock', 'sell', closed, closed), ['market:available', 'conditional:unavailable', 'loc:unavailable']);
    assert.deepEqual(summary('domestic_stock', 'sell', open, closed), ['market:available', 'conditional:available', 'loc:unavailable']);
  });

  it('US sell lists the same, each following its own server gate', () => {
    assert.deepEqual(summary('us_stock', 'sell'), ['market:available', 'conditional:available', 'loc:available']);
    assert.deepEqual(summary('us_stock', 'sell', open, closed), ['market:available', 'conditional:available', 'loc:unavailable']);
  });

  it('crypto sell: market plus conditional; no limit, no LOC', () => {
    assert.deepEqual(summary('crypto', 'sell'), ['market:available', 'conditional:available']);
    assert.equal(list('crypto', 'sell').some((option) => option.method === 'limit' || option.method === 'loc'), false);
  });

  it('손절가/익절가 is not a 주문방식 on any market or side (it lives on holdings, positions and pending entries)', () => {
    for (const assetType of ['domestic_stock', 'us_stock', 'crypto'])
      for (const side of ['buy', 'sell'] as const) {
        const options = list(assetType, side);
        assert.equal(options.some((option) => (option.method as string) === 'protection' || /손절|익절/.test(option.label)), false, `${assetType}/${side}`);
      }
  });

  it('a sell gate still loading is 확인 중, never available', () => {
    const options = getOrderMethodOptions({ assetType: 'crypto', side: 'sell', conditional: { state: 'loading' }, loc: { state: 'loading' } });
    assert.deepEqual(options.map((option) => `${option.method}:${option.availability.state}`), ['market:available', 'conditional:checking']);
  });

  it('lists names and availability only; how each method fills is the notice, not the sheet', () => {
    const krx = list('domestic_stock', 'buy');
    assert.deepEqual(krx.map((option) => option.label), ['시장가', '지정가', '조건주문', 'LOC 주문']);
    for (const option of [...krx, ...list('crypto', 'sell'), ...getFuturesOrderMethodOptions(false, open)])
      assert.deepEqual(Object.keys(option).sort(), ['availability', 'label', 'method'], option.method);
  });

  it('only available methods are selectable; loading and failures are never "available"', () => {
    const loading = list('domestic_stock', 'buy', { state: 'loading' }, { state: 'error' });
    assert.deepEqual(loading.map((option) => isOrderMethodSelectable(option)), [true, true, false, false]);
    assert.equal(getAvailabilityLabel(loading[2].availability), '확인 중');
    assert.equal(getAvailabilityLabel(loading[3].availability), '이용 불가');
    assert.equal(getAvailabilityLabel({ state: 'preparing' }), '준비 중');
    assert.equal(getAvailabilityLabel(loading[0].availability), null);
  });

  it('every form starts at 시장가, which every market and side offers as selectable', () => {
    assert.equal(DEFAULT_ORDER_METHOD, 'market');
    for (const assetType of ['domestic_stock', 'us_stock', 'crypto'])
      for (const side of ['buy', 'sell'] as const)
        for (const gate of [open, closed, { state: 'loading' } as ServerGate, { state: 'error' } as ServerGate]) {
          const market = list(assetType, side, gate, gate).find((option) => option.method === DEFAULT_ORDER_METHOD);
          assert.equal(market !== undefined && isOrderMethodSelectable(market), true, `${assetType}/${side}/${gate.state}`);
          assert.equal(market?.label, '시장가');
        }
  });

  it('LOC submits as an ordinary limit order; conditional has no ordinary type', () => {
    assert.equal(getOrderTypeForMethod('market'), 'market');
    assert.equal(getOrderTypeForMethod('limit'), 'limit');
    assert.equal(getOrderTypeForMethod('loc'), 'limit');
    assert.equal(getOrderTypeForMethod('conditional'), null);
    assert.equal(getOrderTypeForMethod(null), null);
  });
});

describe('futures 주문방식', () => {
  const ready: ServerGate = { state: 'ready', enabled: true };
  const futures = (hasPosition: boolean, gate: ServerGate = ready) =>
    getFuturesOrderMethodOptions(hasPosition, gate).map((option) => `${option.method}:${option.availability.state}`);

  it('lists exactly 시장가, 지정가 and 조건주문 — never LOC or the spot SELL settings', () => {
    for (const hasPosition of [false, true]) {
      const options = getFuturesOrderMethodOptions(hasPosition, ready);
      assert.deepEqual(options.map((option) => option.label), ['시장가', '지정가', '조건주문']);
      assert.deepEqual(options.map((option) => option.method), ['market', 'limit', 'conditional']);
    }
  });

  it('flat: market, limit and 조건주문 open a new position without a position held', () => {
    assert.deepEqual(futures(false), ['market:available', 'limit:available', 'conditional:available']);
  });

  it('flat 조건주문 follows the server capability: checking, error, disabled', () => {
    assert.deepEqual(futures(false, { state: 'loading' }), ['market:available', 'limit:available', 'conditional:checking']);
    assert.deepEqual(futures(false, { state: 'error' }), ['market:available', 'limit:available', 'conditional:unavailable']);
    const off = getFuturesOrderMethodOptions(false, { state: 'ready', enabled: false, reason: '운영 중지' })[2].availability;
    assert.equal(off.state === 'unavailable' && off.reason === '운영 중지', true);
  });

  it('open position: market adjusts it; limit and 조건주문 are entry-only and point 손절가/익절가 to the position card', () => {
    assert.deepEqual(futures(true), ['market:available', 'limit:unavailable', 'conditional:unavailable']);
    const limit = getFuturesOrderMethodOptions(true, ready)[1].availability;
    assert.equal(limit.state === 'unavailable' && /새 포지션 진입에만/.test(limit.reason), true);
    const conditional = getFuturesOrderMethodOptions(true, ready)[2].availability;
    assert.equal(conditional.state === 'unavailable' && /새 포지션 진입에만/.test(conditional.reason), true);
    assert.equal(conditional.state === 'unavailable' && /포지션 카드의 손절가\/익절가 설정/.test(conditional.reason), true);
  });

  it('the default method is available whether or not a position is open', () => {
    for (const hasPosition of [false, true]) {
      const market = getFuturesOrderMethodOptions(hasPosition, { state: 'loading' }).find((option) => option.method === DEFAULT_ORDER_METHOD);
      assert.equal(market !== undefined && isOrderMethodSelectable(market), true);
    }
  });

  it('maps the futures conditional capability to a gate', () => {
    const query = (enabled: boolean, canCreate: boolean) => ({ isLoading: false, isError: false, data: { capabilities: { enabled, canCreate } } });
    assert.deepEqual(getFuturesConditionalGate({ isLoading: true, isError: false }), { state: 'loading' });
    assert.deepEqual(getFuturesConditionalGate({ isLoading: false, isError: true }), { state: 'error' });
    assert.deepEqual(getFuturesConditionalGate(query(true, true)), { state: 'ready', enabled: true });
    const disabled = getFuturesConditionalGate(query(false, true));
    assert.equal(disabled.state === 'ready' && !disabled.enabled && /운영 상태/.test(disabled.reason ?? ''), true);
    const blocked = getFuturesConditionalGate(query(true, false));
    assert.equal(blocked.state === 'ready' && !blocked.enabled && /거래 상태/.test(blocked.reason ?? ''), true);
  });
});

describe('server gates', () => {
  const capabilities = (overrides: Partial<{ enabled: boolean; canCreate: boolean; markets: string[] }> = {}) => ({
    isLoading: false,
    isError: false,
    data: { capabilities: { enabled: true, canCreate: true, markets: ['KRX', 'CRYPTO_SPOT'], ...overrides } },
  });

  it('Conditional BUY: loading, error, flag off, unsupported market and account gate', () => {
    assert.deepEqual(getConditionalBuyGate({ isLoading: true, isError: false }, 'crypto'), { state: 'loading' });
    assert.deepEqual(getConditionalBuyGate({ isLoading: false, isError: true }, 'crypto'), { state: 'error' });
    assert.equal((getConditionalBuyGate(capabilities({ enabled: false }), 'crypto') as { enabled: boolean }).enabled, false);
    assert.equal((getConditionalBuyGate(capabilities({ markets: ['KRX'] }), 'crypto') as { enabled: boolean }).enabled, false);
    // US only when the server lists it (US_STOCK_PRICE_PROVIDER=tiingo).
    assert.equal((getConditionalBuyGate(capabilities(), 'us_stock') as { enabled: boolean }).enabled, false);
    assert.deepEqual(getConditionalBuyGate(capabilities({ markets: ['KRX', 'CRYPTO_SPOT', 'US'] }), 'us_stock'), { state: 'ready', enabled: true });
    assert.equal((getConditionalBuyGate(capabilities({ markets: ['US'] }), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getConditionalBuyGate(capabilities({ canCreate: false }), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.deepEqual(getConditionalBuyGate(capabilities(), 'domestic_stock'), { state: 'ready', enabled: true });
    assert.deepEqual(getConditionalBuyGate(capabilities(), 'crypto'), { state: 'ready', enabled: true });
  });

  it('SELL condition and stop/take gates read their own family', () => {
    const sell = (condition: Partial<{ enabled: boolean; canCreate: boolean }>, protection: Partial<{ enabled: boolean; canCreate: boolean }>, markets = ['KRX', 'CRYPTO_SPOT']) => ({
      isLoading: false, isError: false,
      data: { capabilities: { enabled: true, markets, condition: { enabled: true, canCreate: true, ...condition }, protection: { enabled: true, canCreate: true, ...protection } } },
    });
    assert.deepEqual(getConditionalSellGate({ isLoading: true, isError: false }, 'crypto', 'condition'), { state: 'loading' });
    assert.deepEqual(getConditionalSellGate({ isLoading: false, isError: true }, 'crypto', 'protection'), { state: 'error' });
    const onlyCondition = sell({}, { enabled: false });
    assert.deepEqual(getConditionalSellGate(onlyCondition, 'domestic_stock', 'condition'), { state: 'ready', enabled: true });
    assert.equal((getConditionalSellGate(onlyCondition, 'domestic_stock', 'protection') as { enabled: boolean }).enabled, false);
    assert.equal((getConditionalSellGate(sell({ canCreate: false }, {}), 'crypto', 'condition') as { enabled: boolean }).enabled, false);
    assert.equal((getConditionalSellGate(sell({}, {}, ['KRX']), 'crypto', 'protection') as { enabled: boolean }).enabled, false);
    assert.equal((getConditionalSellGate(sell({}, {}), 'us_stock', 'condition') as { enabled: boolean }).enabled, false);
    const withUs = sell({}, {}, ['KRX', 'CRYPTO_SPOT', 'US']);
    assert.deepEqual(getConditionalSellGate(withUs, 'us_stock', 'condition'), { state: 'ready', enabled: true });
    assert.deepEqual(getConditionalSellGate(withUs, 'us_stock', 'protection'), { state: 'ready', enabled: true });
  });

  it('LOC SELL: its own flag, per listed market (KRX, US); the BUY flag never opens it', () => {
    const caps = (sellEnabled: boolean | undefined, buyEnabled = true, markets = ['KRX']) => ({
      isLoading: false, isError: false,
      data: { limitOnClose: { enabled: buyEnabled, markets, sides: ['buy'] },
        ...(sellEnabled === undefined ? {} : { limitOnCloseSell: { enabled: sellEnabled, markets } }) },
    });
    assert.equal((getLimitOnCloseSellGate(caps(undefined), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseSellGate(caps(false), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseSellGate(caps(true), 'crypto') as { enabled: boolean }).enabled, false);
    assert.deepEqual(getLimitOnCloseSellGate(caps(true, false), 'domestic_stock'), { state: 'ready', enabled: true });
    assert.deepEqual(getLimitOnCloseSellGate({ isLoading: true, isError: false }, 'domestic_stock'), { state: 'loading' });
    // US only when the server lists US for SELL; KRX never stands in for it.
    assert.equal((getLimitOnCloseSellGate(caps(true), 'us_stock') as { enabled: boolean }).enabled, false);
    assert.deepEqual(getLimitOnCloseSellGate(caps(true, false, ['US']), 'us_stock'), { state: 'ready', enabled: true });
    assert.equal((getLimitOnCloseSellGate(caps(true, true, ['US']), 'domestic_stock') as { enabled: boolean }).enabled, false);
  });

  it('LOC BUY: open only when the server lists the asset\'s market (KRX, US) for BUY', () => {
    const loc = (enabled: boolean, markets = ['KRX'], sides = ['buy']) =>
      ({ isLoading: false, isError: false, data: { limitOnClose: { enabled, markets, sides } } });
    assert.deepEqual(getLimitOnCloseGate({ isLoading: true, isError: false }, 'domestic_stock'), { state: 'loading' });
    assert.deepEqual(getLimitOnCloseGate({ isLoading: false, isError: true }, 'domestic_stock'), { state: 'error' });
    assert.equal((getLimitOnCloseGate(loc(false), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseGate(loc(true), 'us_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseGate(loc(true, ['US']), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseGate(loc(true, ['KRX'], ['sell']), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.deepEqual(getLimitOnCloseGate(loc(true), 'domestic_stock'), { state: 'ready', enabled: true });
    assert.deepEqual(getLimitOnCloseGate(loc(true, ['US']), 'us_stock'), { state: 'ready', enabled: true });
    assert.deepEqual(getLimitOnCloseGate(loc(true, ['KRX', 'US']), 'us_stock'), { state: 'ready', enabled: true });
    assert.equal((getLimitOnCloseGate(loc(true, ['US']), 'crypto') as { enabled: boolean }).enabled, false);
  });
});

describe('server market tokens', () => {
  it('maps asset types to the capability market tokens', () => {
    assert.deepEqual(['domestic_stock', 'us_stock', 'crypto', 'futures', null].map((type) => serverMarket(type)), ['KRX', 'US', 'CRYPTO_SPOT', null, null]);
  });

  it('entry 손절가/익절가: the server list decides; an older server keeps KRX + Spot crypto', () => {
    assert.equal(isEntryTpSlMarketSupported({ markets: ['KRX', 'CRYPTO_SPOT', 'US'] }, 'us_stock'), true);
    assert.equal(isEntryTpSlMarketSupported({ markets: ['KRX', 'CRYPTO_SPOT'] }, 'us_stock'), false);
    assert.equal(isEntryTpSlMarketSupported({}, 'us_stock'), false);
    assert.equal(isEntryTpSlMarketSupported(null, 'domestic_stock'), true);
    assert.equal(isEntryTpSlMarketSupported({}, 'crypto'), true);
    assert.equal(isEntryTpSlMarketSupported({ markets: ['US'] }, 'domestic_stock'), false);
    assert.equal(isEntryTpSlMarketSupported({ markets: ['KRX', 'CRYPTO_SPOT', 'US'] }, null), false);
  });
});
