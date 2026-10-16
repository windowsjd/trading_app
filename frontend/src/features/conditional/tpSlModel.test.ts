import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_TP_SL_LEG,
  getEntryPlanFailureText,
  getEntryPlanStateLabel,
  getFuturesTpSlStateLabel,
  getTpSlLegError,
  isTpSlAlreadyMet,
  quantityForPercent,
  sellableUsdEstimate,
  tpSlCountSummary,
  tpSlPercentRoom,
  tpSlQuantityRoom,
  tpSlWatchesRise,
  type TpSlLegContext,
} from './tpSlModel.ts';

const leg = (overrides: Partial<TpSlLegContext> = {}): TpSlLegContext => ({
  kind: 'stop_loss', draft: { ...EMPTY_TP_SL_LEG, enabled: true, triggerPrice: '90', percent: 50 },
  direction: 'long', mode: 'quantity', basis: '10', scale: 6, existing: [], ...overrides,
});

describe('a share becomes a quantity of the holding / position / fill', () => {
  it('cuts down to the unit and never exceeds the basis', () => {
    assert.equal(quantityForPercent('10', 20, 6), '2');
    assert.equal(quantityForPercent('1', 30, 8), '0.3');
    assert.equal(quantityForPercent('0.0000015', 50, 6), null, '0.00000075 is below one unit');
    assert.equal(quantityForPercent('0.000003', 50, 6), '0.000001', '0.0000015 floors to one unit');
    assert.equal(quantityForPercent('7.123456', 100, 6), '7.123456', '100% is the whole basis');
    assert.equal(quantityForPercent('7.1234567', 100, 6), '7.123456', 'cut to the order unit, never rounded up');
    assert.equal(quantityForPercent(null, 50, 6), null);
    assert.equal(quantityForPercent('10', 0, 6), null);
    assert.equal(quantityForPercent('10', 101, 6), null);
    assert.equal(quantityForPercent('10', 12.5, 6), null, 'whole percents only');
  });

  it('activation example: 0.4 filled of a 1-unit entry with 익절 30%·70% and 손절 100% → 0.12, 0.28 and 0.4', () => {
    assert.deepEqual([30, 70, 100].map((ratio) => quantityForPercent('0.4', ratio, 8)), ['0.12', '0.28', '0.4']);
  });
});

describe('per kind totals (stop-losses and take-profits are separate)', () => {
  const live = [
    { kind: 'stop_loss', triggerPrice: '700', quantity: '6' },
    { kind: 'take_profit', triggerPrice: '900', quantity: '10' },
  ];
  it('holdings and positions: live quantities of one kind stay within the basis', () => {
    assert.equal(tpSlQuantityRoom('10', live, 'stop_loss')?.toFixed(), '4');
    assert.equal(tpSlQuantityRoom('10', live, 'take_profit')?.toFixed(), '0');
    assert.equal(getTpSlLegError(leg({ existing: live, draft: { enabled: true, triggerPrice: '650', percent: 40 } })), null, '4 of 10 fits exactly');
    assert.match(getTpSlLegError(leg({ existing: live, draft: { enabled: true, triggerPrice: '650', percent: 50 } })) ?? '',
      /등록된 손절 설정과 합치면 보유 수량을 넘어요\. \(등록 6 · 추가 가능 4\)/);
    assert.match(getTpSlLegError(leg({ kind: 'take_profit', existing: live, draft: { enabled: true, triggerPrice: '950', percent: 25 } })) ?? '',
      /익절 설정이 이미 보유 수량 전체를 대상으로 해요/);
  });

  it('entries: percents of one kind add up to at most 100%', () => {
    const pending = [{ kind: 'take_profit', triggerPrice: '110', ratioPercent: 30 }];
    assert.equal(tpSlPercentRoom(pending, 'take_profit'), 70);
    assert.equal(tpSlPercentRoom(pending, 'stop_loss'), 100);
    const entry = (percent: number, triggerPrice = '120') => leg({ kind: 'take_profit', mode: 'ratio', basis: null, entryPrice: '100', existing: pending,
      draft: { enabled: true, triggerPrice, percent } });
    assert.equal(getTpSlLegError(entry(70)), null);
    assert.match(getTpSlLegError(entry(75)) ?? '', /익절 비율의 합은 100%를 넘을 수 없어요\. \(추가 가능 70%\)/);
  });

  it('one price per kind; the other kind may use the same price', () => {
    const live = [{ kind: 'stop_loss', triggerPrice: '700.0', quantity: '1' }];
    assert.match(getTpSlLegError(leg({ existing: live, draft: { enabled: true, triggerPrice: '700', percent: 10 } })) ?? '', /같은 손절가로 등록된 설정이 이미 있어요/);
    assert.equal(getTpSlLegError(leg({ kind: 'take_profit', existing: live, draft: { enabled: true, triggerPrice: '700', percent: 10 } })), null);
  });
});

describe('the first problem of a leg, in the order the user fixes it', () => {
  it('price, then share, then the unit', () => {
    assert.equal(getTpSlLegError(leg({ draft: { enabled: true, triggerPrice: '', percent: 0 } })), '손절가를 입력해주세요.');
    assert.match(getTpSlLegError(leg({ draft: { enabled: true, triggerPrice: '1.123456789', percent: 10 } })) ?? '', /소수점 이하 최대 8자리/);
    assert.equal(getTpSlLegError(leg({ draft: { enabled: true, triggerPrice: '90', percent: 0 } })), '손절 비율을 선택해주세요.');
    assert.match(getTpSlLegError(leg({ basis: '0.000003', draft: { enabled: true, triggerPrice: '90', percent: 25 } })) ?? '', /최소 단위보다 적어요/);
    assert.match(getTpSlLegError(leg({ basis: null })) ?? '', /보유 수량을 확인한 뒤/);
  });

  it('a pending entry checks the protective side of its own price, strictly and in exact decimals', () => {
    const entry = (direction: 'long' | 'short', kind: 'stop_loss' | 'take_profit', triggerPrice: string, entryPrice = '100') =>
      getTpSlLegError(leg({ direction, kind, mode: 'ratio', basis: null, entryPrice, draft: { enabled: true, triggerPrice, percent: 50 } }));
    assert.equal(entry('long', 'stop_loss', '90'), null);
    assert.equal(entry('long', 'stop_loss', '100'), '손절가는 진입 가격보다 낮게 입력해주세요.', 'equal is refused');
    assert.equal(entry('long', 'take_profit', '90'), '익절가는 진입 가격보다 높게 입력해주세요.');
    assert.equal(entry('short', 'stop_loss', '110'), null);
    assert.equal(entry('short', 'stop_loss', '90'), '손절가는 진입 가격보다 높게 입력해주세요.');
    assert.equal(entry('short', 'take_profit', '90'), null);
    assert.equal(entry('long', 'stop_loss', '1234567890123456.12345679', '1234567890123456.12345678'), '손절가는 진입 가격보다 낮게 입력해주세요.');
    assert.equal(entry('long', 'stop_loss', '1234567890123456.12345677', '1234567890123456.12345678'), null);
  });
});

describe('sides by kind and direction (never chosen by hand)', () => {
  it('Spot and Long: take-profit on a rise, stop-loss on a fall; Short reversed', () => {
    assert.equal(tpSlWatchesRise('long', 'take_profit'), true);
    assert.equal(tpSlWatchesRise('long', 'stop_loss'), false);
    assert.equal(tpSlWatchesRise('short', 'take_profit'), false);
    assert.equal(tpSlWatchesRise('short', 'stop_loss'), true);
  });

  it('flags a price the last price already reached (the server refuses it)', () => {
    assert.equal(isTpSlAlreadyMet('long', 'take_profit', '110', '110'), true);
    assert.equal(isTpSlAlreadyMet('long', 'take_profit', '110', '109'), false);
    assert.equal(isTpSlAlreadyMet('long', 'stop_loss', '95', '94'), true);
    assert.equal(isTpSlAlreadyMet('short', 'take_profit', '110', '102'), true);
    assert.equal(isTpSlAlreadyMet('short', 'stop_loss', '110', '102'), false);
    assert.equal(isTpSlAlreadyMet('long', 'take_profit', '110', null), false);
  });
});

describe('매도 가능 금액 (USD) of a Spot holding', () => {
  it('server sellable quantity × a valid price; KRW only with a usable USD/KRW; never a made-up $0', () => {
    assert.equal(sellableUsdEstimate({ available: '2', price: '763.79', priceCurrency: 'USD', usdKrw: null }), '1527.58');
    assert.equal(sellableUsdEstimate({ available: '10', price: '70000', priceCurrency: 'KRW', usdKrw: '1400' }), '500.00');
    assert.equal(sellableUsdEstimate({ available: '10', price: '70000', priceCurrency: 'KRW', usdKrw: null }), null);
    assert.equal(sellableUsdEstimate({ available: '10', price: null, priceCurrency: 'USD', usdKrw: null }), null);
    assert.equal(sellableUsdEstimate({ available: null, price: '1', priceCurrency: 'USD', usdKrw: null }), null);
    assert.equal(sellableUsdEstimate({ available: '0', price: '1', priceCurrency: 'USD', usdKrw: null }), '0.00', 'a real zero is shown as zero');
  });
});

describe('labels', () => {
  it('counts what is set, per kind', () => {
    assert.equal(tpSlCountSummary([{ kind: 'take_profit' }, { kind: 'take_profit' }, { kind: 'stop_loss' }]), '익절 2건 · 손절 1건');
    assert.equal(tpSlCountSummary([{ kind: 'stop_loss' }]), '손절 1건');
    assert.equal(tpSlCountSummary([]), null);
    assert.equal(tpSlCountSummary(null), null);
  });

  it('a plan activates, never "fills"; a failed activation stays visible with its reason', () => {
    assert.equal(getEntryPlanStateLabel({ status: 'pending', terminalReason: null }), '체결 후 활성화');
    assert.equal(getEntryPlanStateLabel({ status: 'activated', terminalReason: null }), '활성화됨');
    assert.equal(getEntryPlanStateLabel({ status: 'failed', terminalReason: 'activation_failed' }), '활성화 실패');
    assert.equal(getEntryPlanStateLabel({ status: 'canceled', terminalReason: 'entry_canceled' }), '진입 주문 종료로 취소');
    assert.equal(getEntryPlanStateLabel({ status: 'canceled', terminalReason: 'entry_failed' }), '진입 실패로 종료');
    assert.match(getEntryPlanFailureText({ status: 'failed', failureCode: 'ENTRY_TP_SL_TOTAL_EXCEEDS_HOLDING' }) ?? '', /보유 수량을 넘어 활성화하지 못했어요/);
    assert.match(getEntryPlanFailureText({ status: 'failed', failureCode: 'SOMETHING_NEW' }) ?? '', /활성화하지 못했어요/);
    assert.equal(getEntryPlanFailureText({ status: 'pending', failureCode: null }), null);
  });

  it('a Futures setting is 실행됨 only when its reduction executed', () => {
    assert.equal(getFuturesTpSlStateLabel({ state: 'watching', terminalReason: null }), '감시 중');
    assert.equal(getFuturesTpSlStateLabel({ state: 'triggered', terminalReason: null }), '조건 충족 · 실행 중');
    assert.equal(getFuturesTpSlStateLabel({ state: 'filled', terminalReason: null }), '실행됨');
    assert.equal(getFuturesTpSlStateLabel({ state: 'canceled', terminalReason: 'position_closed' }), '포지션 종료로 끝남');
    assert.equal(getFuturesTpSlStateLabel({ state: 'canceled', terminalReason: 'liquidated' }), '강제청산으로 끝남');
    assert.equal(getFuturesTpSlStateLabel({ state: 'failed', terminalReason: 'execution_window_expired' }), '실행 시간 초과');
  });
});
