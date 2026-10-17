import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeOrderFailure, parseOrderFailure, type OrderFailureDto } from './orderFailure.ts';

const row = (patch: Partial<OrderFailureDto> = {}): OrderFailureDto => ({
  kind: 'conditional_buy',
  id: 'row-1',
  tradingAccountId: 'acct-a',
  market: 'spot',
  status: 'failed',
  final: true,
  instrument: { name: '삼성전자', symbol: '005930' },
  side: 'buy',
  direction: null,
  protection: null,
  reasonCode: 'execution_failed',
  failureCode: null,
  endedAt: '2026-10-17T06:30:00.000Z',
  createdAt: '2026-10-17T06:00:00.000Z',
  ...patch,
});

// Raw server vocabulary must never reach the screen.
const RAW = /[A-Z]{3,}_[A-Z_]+|[a-z]+_[a-z_]+/;

describe('order failure payload', () => {
  it('accepts the server shape and rejects anything else', () => {
    assert.deepEqual(parseOrderFailure(row()), row());
    for (const bad of [
      null,
      'x',
      { ...row(), kind: 'refund' },
      { ...row(), final: 'yes' },
      { ...row(), market: 'margin' },
      { ...row(), instrument: null },
      { ...row(), side: 'hold' },
      { ...row(), protection: 'oco' },
      { ...row(), endedAt: 5 },
      { ...row(), id: '' },
    ])
      assert.equal(parseOrderFailure(bad), null);
  });
});

describe('order failure copy', () => {
  it('words every kind from its stored codes, never a raw code', () => {
    const cases: Array<[Partial<OrderFailureDto>, RegExp, RegExp]> = [
      [{ kind: 'loc', status: 'unfilled', reasonCode: 'loc_close_not_reached' }, /LOC 매수 미체결/, /지정가 조건에 맞지 않아/],
      [{ kind: 'loc', status: 'expired', side: 'sell', reasonCode: 'loc_fill_not_permitted' }, /LOC 매도 만료/, /판정 기한이 지나/],
      [{ kind: 'loc', status: 'expired', reasonCode: 'loc_close_evidence_unavailable' }, /만료/, /확정 종가를 기한 안에/],
      [{ kind: 'conditional_buy', failureCode: 'INSUFFICIENT_AVAILABLE_BALANCE' }, /조건주문 실패/, /사용 가능 현금이 부족/],
      [{ kind: 'conditional_sell', side: 'sell', protection: 'stop_loss', reasonCode: 'quantity_unavailable' }, /손절 실행 실패/, /매도할 수 있는 수량이 없었어요/],
      [{ kind: 'conditional_sell', side: 'sell', protection: 'condition', failureCode: 'MARKET_CLOSED' }, /조건주문 실행 실패/, /정규장이 아니었어요/],
      [
        { kind: 'futures_conditional_entry', market: 'futures', instrument: { name: null, symbol: 'BTCUSDT' }, direction: 'short', side: null, failureCode: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL' },
        /BTCUSDT 숏 조건 진입 실패/, /담보가 부족/,
      ],
      [
        { kind: 'futures_tp_sl', market: 'futures', instrument: { name: null, symbol: 'ETHUSDT' }, protection: 'take_profit', side: null, failureCode: 'FUTURES_MARK_STALE' },
        /ETHUSDT 익절 실행 실패/, /Mark 시세/,
      ],
      [
        { kind: 'futures_tp_sl', market: 'futures', instrument: { name: null, symbol: 'ETHUSDT' }, protection: 'stop_loss', side: null, reasonCode: 'execution_window_expired', failureCode: 'SOMETHING_NEW' },
        /손절 실행 실패/, /30초 안에/,
      ],
      [
        { kind: 'entry_tp_sl_plan', market: 'futures', instrument: { name: null, symbol: 'BTC' }, protection: 'stop_loss', side: null, reasonCode: 'activation_failed', failureCode: 'ENTRY_TP_SL_DUPLICATE_PRICE' },
        /BTC 손절가 설정 실패/, /같은 가격의 설정/,
      ],
      [
        { kind: 'entry_tp_sl_plan', protection: 'take_profit', reasonCode: 'activation_failed', failureCode: 'UNKNOWN_CODE' },
        /삼성전자 익절가 설정 실패/, /활성화하지 못했어요/,
      ],
    ];
    for (const [patch, title, reason] of cases) {
      const view = describeOrderFailure(row(patch));
      assert.match(view.title, title);
      assert.match(view.reason, reason);
      for (const text of [view.title, view.status, view.reason, view.consequence ?? '', view.where])
        assert.equal(RAW.test(text), false, `raw code in "${text}"`);
    }
  });

  it('says what happened afterwards and where the row is also listed', () => {
    const loc = describeOrderFailure(row({ kind: 'loc', status: 'unfilled', reasonCode: 'loc_close_not_reached' }));
    assert.equal(loc.tradeHistory, true);
    assert.match(loc.consequence ?? '', /예약은 해제/);
    const tpSl = describeOrderFailure(row({ kind: 'futures_tp_sl', market: 'futures', protection: 'stop_loss', instrument: { name: null, symbol: 'BTCUSDT' } }));
    assert.equal(tpSl.tradeHistory, false, 'a failed setting is not a trade');
    assert.match(tpSl.consequence ?? '', /포지션은 그대로/);
    assert.match(tpSl.where, /선물 화면/);
    const plan = describeOrderFailure(row({ kind: 'entry_tp_sl_plan', protection: 'stop_loss' }));
    assert.match(plan.consequence ?? '', /^매수는 체결되었지만 이 손절가는 등록되지 않았어요/);
    const futuresPlan = describeOrderFailure(row({ kind: 'entry_tp_sl_plan', market: 'futures', protection: 'take_profit' }));
    assert.match(futuresPlan.consequence ?? '', /^진입은 체결되었지만 이 익절가는/);
  });
});
