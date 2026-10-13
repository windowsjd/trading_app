import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getAvailabilityLabel,
  getConditionalBuyGate,
  getConditionalSellGate,
  getLimitOnCloseGate,
  getLimitOnCloseSellGate,
  getOrderMethodOptions,
  getOrderTypeForMethod,
  isOrderMethodSelectable,
  type ServerGate,
} from './orderMethods.ts';

const open: ServerGate = { state: 'ready', enabled: true };
const closed: ServerGate = { state: 'ready', enabled: false, reason: '서버 꺼짐' };
const list = (assetType: string, side: 'buy' | 'sell', conditional: ServerGate = open, loc: ServerGate = open, protection: ServerGate = open) =>
  getOrderMethodOptions({ assetType, side, conditional, loc, protection });
const summary = (assetType: string, side: 'buy' | 'sell', conditional: ServerGate = open, loc: ServerGate = open, protection: ServerGate = open) =>
  list(assetType, side, conditional, loc, protection).map((option) => `${option.method}:${option.availability.state}`);

describe('주문방식 list per market and side', () => {
  it('KRX buy: market, limit, conditional and LOC, the last two following the server', () => {
    assert.deepEqual(summary('domestic_stock', 'buy'), ['market:available', 'limit:available', 'conditional:available', 'loc:available']);
    assert.deepEqual(summary('domestic_stock', 'buy', closed, closed), ['market:available', 'limit:available', 'conditional:unavailable', 'loc:unavailable']);
  });

  it('US buy lists the same four, but conditional and LOC stay 준비 중 even if a gate says open', () => {
    assert.deepEqual(summary('us_stock', 'buy'), ['market:available', 'limit:available', 'conditional:preparing', 'loc:preparing']);
  });

  it('crypto buy: market, limit and conditional; never LOC', () => {
    assert.deepEqual(summary('crypto', 'buy'), ['market:available', 'limit:available', 'conditional:available']);
  });

  it('KRX sell: market plus conditional, LOC and stop/take following their own server gates; no new limit', () => {
    assert.deepEqual(summary('domestic_stock', 'sell'), ['market:available', 'conditional:available', 'loc:available', 'protection:available']);
    assert.deepEqual(summary('domestic_stock', 'sell', closed, closed, closed),
      ['market:available', 'conditional:unavailable', 'loc:unavailable', 'protection:unavailable']);
    assert.deepEqual(summary('domestic_stock', 'sell', open, closed, open),
      ['market:available', 'conditional:available', 'loc:unavailable', 'protection:available']);
  });

  it('US sell lists the same, but new SELL automation stays 준비 중 even if a gate says open', () => {
    assert.deepEqual(summary('us_stock', 'sell'), ['market:available', 'conditional:preparing', 'loc:preparing', 'protection:preparing']);
  });

  it('crypto sell: market plus conditional and stop/take; no limit, no LOC', () => {
    assert.deepEqual(summary('crypto', 'sell'), ['market:available', 'conditional:available', 'protection:available']);
    assert.equal(list('crypto', 'sell').some((option) => option.method === 'limit' || option.method === 'loc'), false);
  });

  it('a sell gate still loading is 확인 중, never available', () => {
    const options = getOrderMethodOptions({ assetType: 'crypto', side: 'sell', conditional: { state: 'loading' }, loc: { state: 'loading' } });
    assert.deepEqual(options.map((option) => `${option.method}:${option.availability.state}`),
      ['market:available', 'conditional:checking', 'protection:checking']);
  });

  it('keeps the product copy for each method', () => {
    const krx = list('domestic_stock', 'buy');
    assert.deepEqual(krx.map((option) => option.label), ['시장가', '지정가', '조건주문', 'LOC 주문']);
    assert.equal(krx[0].description, '현재 거래 가능한 가격으로 매수를 시도합니다.');
    assert.equal(krx[1].description, '지정한 가격 이하에서 매수를 시도합니다.');
    assert.equal(krx[2].description, '감시가격에 도달하면 설정한 방식으로 주문합니다.');
    assert.equal(krx[3].description, '정규장 마감가격이 지정가격 이하이면 종가로 매수합니다.');
  });

  it('only available methods are selectable; loading and failures are never "available"', () => {
    const loading = list('domestic_stock', 'buy', { state: 'loading' }, { state: 'error' });
    assert.deepEqual(loading.map((option) => isOrderMethodSelectable(option)), [true, true, false, false]);
    assert.equal(getAvailabilityLabel(loading[2].availability), '확인 중');
    assert.equal(getAvailabilityLabel(loading[3].availability), '이용 불가');
    assert.equal(getAvailabilityLabel(list('us_stock', 'buy')[3].availability), '준비 중');
    assert.equal(getAvailabilityLabel(loading[0].availability), null);
  });

  it('LOC submits as an ordinary limit order; conditional/stop-take have no ordinary type', () => {
    assert.equal(getOrderTypeForMethod('market'), 'market');
    assert.equal(getOrderTypeForMethod('limit'), 'limit');
    assert.equal(getOrderTypeForMethod('loc'), 'limit');
    assert.equal(getOrderTypeForMethod('conditional'), null);
    assert.equal(getOrderTypeForMethod('protection'), null);
    assert.equal(getOrderTypeForMethod(null), null);
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
    assert.equal((getConditionalBuyGate(capabilities(), 'us_stock') as { enabled: boolean }).enabled, false);
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
  });

  it('LOC SELL: its own flag, KRX only; the BUY flag never opens it', () => {
    const caps = (sellEnabled: boolean | undefined, buyEnabled = true) => ({
      isLoading: false, isError: false,
      data: { limitOnClose: { enabled: buyEnabled, markets: ['KRX'], sides: ['buy'] },
        ...(sellEnabled === undefined ? {} : { limitOnCloseSell: { enabled: sellEnabled, markets: ['KRX'] } }) },
    });
    assert.equal((getLimitOnCloseSellGate(caps(undefined), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseSellGate(caps(false), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseSellGate(caps(true), 'crypto') as { enabled: boolean }).enabled, false);
    assert.deepEqual(getLimitOnCloseSellGate(caps(true, false), 'domestic_stock'), { state: 'ready', enabled: true });
    assert.deepEqual(getLimitOnCloseSellGate({ isLoading: true, isError: false }, 'domestic_stock'), { state: 'loading' });
  });

  it('LOC: open only when the server reports it for KRX BUY', () => {
    const loc = (enabled: boolean, markets = ['KRX'], sides = ['buy']) =>
      ({ isLoading: false, isError: false, data: { limitOnClose: { enabled, markets, sides } } });
    assert.deepEqual(getLimitOnCloseGate({ isLoading: true, isError: false }, 'domestic_stock'), { state: 'loading' });
    assert.deepEqual(getLimitOnCloseGate({ isLoading: false, isError: true }, 'domestic_stock'), { state: 'error' });
    assert.equal((getLimitOnCloseGate(loc(false), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseGate(loc(true), 'us_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseGate(loc(true, ['US']), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.equal((getLimitOnCloseGate(loc(true, ['KRX'], ['sell']), 'domestic_stock') as { enabled: boolean }).enabled, false);
    assert.deepEqual(getLimitOnCloseGate(loc(true), 'domestic_stock'), { state: 'ready', enabled: true });
  });
});
