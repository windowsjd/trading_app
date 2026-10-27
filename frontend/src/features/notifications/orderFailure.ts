import { getConditionalBuyEndReason } from '../conditional/conditionalBuyDisplay.ts';
import { getConditionalSellEndReason } from '../conditional/conditionalSellDisplay.ts';
import { getEntryPlanFailureText } from '../conditional/tpSlModel.ts';
import { getFuturesConditionalEndReason, getFuturesFailureText } from '../futures/conditionalEntryDisplay.ts';
import { getLimitOnCloseStatusLabel } from '../record/openOrder.ts';
import { getAssetNameDisplay } from '../../utils/format.ts';

/**
 * 주문 실패·만료 — what an `order_failure` push tap shows (pure; node --test).
 *
 * The push names one failure row (backend docs/push-notifications-contract.md
 * §2.3); the screen reads that row from the server and words its STORED
 * state. Only `final: true` (LOC unfilled/expired, otherwise `failed`) reads
 * as a failure: a watching, triggered or retrying row is never called one.
 */
export const ORDER_FAILURE_KINDS = [
  'loc',
  'conditional_buy',
  'conditional_sell',
  'futures_conditional_entry',
  'futures_tp_sl',
  'entry_tp_sl_plan',
] as const;
export type OrderFailureKind = (typeof ORDER_FAILURE_KINDS)[number];

export const isOrderFailureKind = (value: unknown): value is OrderFailureKind =>
  ORDER_FAILURE_KINDS.includes(value as OrderFailureKind);

export type OrderFailureDto = {
  kind: OrderFailureKind;
  id: string;
  tradingAccountId: string;
  market: 'spot' | 'futures';
  status: string;
  final: boolean;
  instrument: { name: string | null; symbol: string };
  side: 'buy' | 'sell' | null;
  direction: 'long' | 'short' | null;
  protection: 'condition' | 'stop_loss' | 'take_profit' | null;
  reasonCode: string | null;
  failureCode: string | null;
  endedAt: string | null;
  createdAt: string;
};

const text = (value: unknown) => typeof value === 'string';
const nullableText = (value: unknown) => value === null || typeof value === 'string';

/** The server's answer, checked field by field; anything else is null. */
export function parseOrderFailure(value: unknown): OrderFailureDto | null {
  const row = value as Partial<OrderFailureDto> | null;
  if (!row || typeof row !== 'object') return null;
  const ok =
    isOrderFailureKind(row.kind) && text(row.id) && !!row.id && text(row.tradingAccountId) &&
    (row.market === 'spot' || row.market === 'futures') && text(row.status) && typeof row.final === 'boolean' &&
    !!row.instrument && text(row.instrument.symbol) && nullableText(row.instrument.name) &&
    (row.side === null || row.side === 'buy' || row.side === 'sell') &&
    (row.direction === null || row.direction === 'long' || row.direction === 'short') &&
    (row.protection === null || row.protection === 'condition' || row.protection === 'stop_loss' || row.protection === 'take_profit') &&
    nullableText(row.reasonCode) && nullableText(row.failureCode) && nullableText(row.endedAt) && text(row.createdAt);
  return ok ? (row as OrderFailureDto) : null;
}

const SIDE = { buy: '매수', sell: '매도' } as const;
const DIRECTION = { long: '롱', short: '숏' } as const;
const TP_SL = { stop_loss: '손절', take_profit: '익절' } as const;

const LOC_REASON: Record<string, string> = {
  loc_close_not_reached: '확정 종가가 지정가 조건에 맞지 않아 체결되지 않았어요.',
  loc_close_evidence_unavailable: '확정 종가를 기한 안에 확인하지 못해 주문이 만료되었어요.',
  loc_session_invalid: '주문한 정규장 세션이 유효하지 않아 주문이 만료되었어요.',
  loc_fill_not_permitted: '판정 기한이 지나 체결할 수 없어 주문이 만료되었어요.',
};

export type OrderFailureView = {
  title: string;
  /** The stored outcome in a few words. */
  status: string;
  /** Why, from the server's codes; never a raw code. */
  reason: string;
  /** What happened to the reservation or protection afterwards. */
  consequence: string | null;
  /** Where else the row is listed. */
  where: string;
  /** LOC orders are also rows of 거래 내역 > 현물. */
  tradeHistory: boolean;
};

const ENDED_LIST = '주문 화면의 대기 목록에 있는 종료 이력에서도 확인할 수 있어요.';

/** Words for a FINAL failure row. Callers show `notFinalView` otherwise. */
export function describeOrderFailure(row: OrderFailureDto): OrderFailureView {
  const spotName = getAssetNameDisplay({ name: row.instrument.name, symbol: row.instrument.symbol }).primary;
  const symbol = row.instrument.symbol;
  const reasons = { state: 'failed' as const, failureCode: row.failureCode, terminalReason: row.reasonCode, order: null };
  switch (row.kind) {
    case 'loc': {
      const side = SIDE[row.side ?? 'buy'];
      const unfilled = row.status === 'unfilled';
      return {
        title: `${spotName} LOC ${side} ${unfilled ? '미체결' : '만료'}`,
        status: getLimitOnCloseStatusLabel({ status: row.status }),
        reason: (row.reasonCode && LOC_REASON[row.reasonCode]) ||
          (unfilled ? LOC_REASON.loc_close_not_reached : '체결 조건을 기한 안에 확인하지 못해 주문이 만료되었어요.'),
        consequence: '체결되지 않았고, 주문에 묶였던 예약은 해제되었어요.',
        where: '거래 내역 > 현물에서도 이 주문을 볼 수 있어요.',
        tradeHistory: true,
      };
    }
    case 'conditional_buy':
      return {
        title: `${spotName} 조건주문 실패`,
        status: '실행 실패',
        reason: getConditionalBuyEndReason(reasons) ?? '조건 충족 후 주문을 만들지 못했어요.',
        consequence: '매수 주문은 체결되지 않았어요.',
        where: ENDED_LIST,
        tradeHistory: false,
      };
    case 'conditional_sell': {
      const label = row.protection === 'stop_loss' || row.protection === 'take_profit' ? TP_SL[row.protection] : '조건주문';
      return {
        title: `${spotName} ${label} 실행 실패`,
        status: '실행 실패',
        reason: getConditionalSellEndReason(reasons) ?? '조건 충족 후 주문을 만들지 못했어요.',
        consequence: '매도 주문은 체결되지 않았고, 보유 수량은 그대로예요.',
        where: ENDED_LIST,
        tradeHistory: false,
      };
    }
    case 'futures_conditional_entry':
      return {
        title: `${symbol} ${row.direction ? `${DIRECTION[row.direction]} ` : ''}조건 진입 실패`,
        status: '발동 후 주문 실패',
        reason: getFuturesConditionalEndReason(reasons) ?? '주문을 실행하지 못했어요.',
        consequence: '포지션은 열리지 않았어요.',
        where: '선물 화면의 대기 주문 > 조건주문 최근 종료에서도 확인할 수 있어요.',
        tradeHistory: false,
      };
    case 'futures_tp_sl': {
      const label = row.protection === 'take_profit' ? TP_SL.take_profit : TP_SL.stop_loss;
      return {
        title: `${symbol} ${label} 실행 실패`,
        status: row.reasonCode === 'execution_window_expired' ? '실행 시간 초과' : '실행 실패',
        reason: getFuturesFailureText(row.failureCode) ??
          (row.reasonCode === 'execution_window_expired'
            ? '조건 충족 후 30초 안에 포지션을 종료하지 못했어요.'
            : '조건은 충족됐지만 포지션을 종료하지 못했어요.'),
        consequence: `포지션은 그대로 열려 있고, 이 ${label} 설정은 종료되었어요.`,
        where: '선물 화면의 대기 주문 > 손절가/익절가 종료 이력에서도 확인할 수 있어요.',
        tradeHistory: false,
      };
    }
    case 'entry_tp_sl_plan': {
      const label = row.protection === 'take_profit' ? TP_SL.take_profit : TP_SL.stop_loss;
      const futures = row.market === 'futures';
      return {
        title: `${futures ? symbol : spotName} ${label}가 설정 실패`,
        status: '활성화 실패',
        reason: getEntryPlanFailureText({ status: 'failed', failureCode: row.failureCode }) ??
          '체결 후 설정을 활성화하지 못했어요.',
        consequence: `${futures ? '진입은' : '매수는'} 체결되었지만 이 ${label}가는 등록되지 않았어요. ${futures ? '포지션' : '보유종목'}에서 다시 설정해 주세요.`,
        where: `${futures ? '선물 화면의 대기 주문' : '주문 화면의 대기 목록'} > 손절가/익절가 종료 이력에서도 확인할 수 있어요.`,
        tradeHistory: false,
      };
    }
  }
}
