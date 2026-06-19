import { ERROR_CODE, type ErrorCode } from '../../models/enums/errorCode';

export type BlockedReason =
  | 'blocked_market_closed'
  | 'blocked_price_stale'
  | 'blocked_insufficient_balance'
  | 'blocked_insufficient_quantity'
  | 'blocked_season_not_joined'
  | 'blocked_season_not_active'
  | 'blocked_settlement_in_progress'
  | 'blocked_fx_rate_stale'
  | 'blocked_fx_insufficient_balance'
  | 'blocked_fx_season_inactive';

export const BLOCKED_REASON_MESSAGE: Record<BlockedReason, string> = {
  blocked_market_closed: '장 마감으로 거래할 수 없습니다.',
  blocked_price_stale: '최신 가격을 확인할 수 없어 주문할 수 없습니다.',
  blocked_insufficient_balance: '잔액이 부족합니다.',
  blocked_insufficient_quantity: '보유 수량이 부족합니다.',
  blocked_season_not_joined: '시즌에 참가해야 거래할 수 있습니다.',
  blocked_season_not_active: '현재 거래 가능한 시즌이 아닙니다.',
  blocked_settlement_in_progress: '정산 중에는 거래할 수 없습니다.',
  blocked_fx_rate_stale: '환율 정보를 확인할 수 없어 환전할 수 없습니다.',
  blocked_fx_insufficient_balance: '환전할 잔액이 부족합니다.',
  blocked_fx_season_inactive: '현재 환전 가능한 시즌이 아닙니다.',
};

export function getErrorMessageFromCode(code?: string | null) {
  switch (code as ErrorCode | undefined) {
    case ERROR_CODE.INVALID_CREDENTIALS:
      return '이메일 또는 비밀번호를 확인해주세요.';
    case ERROR_CODE.EMAIL_ALREADY_EXISTS:
      return '이미 가입된 이메일입니다.';
    case ERROR_CODE.SEASON_NOT_JOINED:
      return '시즌에 참가해야 이용할 수 있습니다.';
    case ERROR_CODE.SEASON_NOT_ACTIVE:
      return '현재 활성 시즌이 아닙니다.';
    case ERROR_CODE.MARKET_CLOSED:
      return '장 마감으로 주문할 수 없습니다.';
    case ERROR_CODE.PRICE_STALE:
      return '가격 갱신 대기 중입니다.';
    case ERROR_CODE.INSUFFICIENT_BALANCE:
      return '잔액이 부족합니다.';
    case ERROR_CODE.INSUFFICIENT_QUANTITY:
      return '보유 수량이 부족합니다.';
    case ERROR_CODE.FX_RATE_STALE:
      return '환율 갱신 대기 중입니다.';
    default:
      return '잠시 후 다시 시도해주세요.';
  }
}

export function mapOrderErrorCodeToBlockedReason(
  code?: string | null,
): BlockedReason | null {
  switch (code as ErrorCode | undefined) {
    case ERROR_CODE.MARKET_CLOSED:
      return 'blocked_market_closed';
    case ERROR_CODE.PRICE_STALE:
      return 'blocked_price_stale';
    case ERROR_CODE.INSUFFICIENT_BALANCE:
      return 'blocked_insufficient_balance';
    case ERROR_CODE.INSUFFICIENT_QUANTITY:
      return 'blocked_insufficient_quantity';
    case ERROR_CODE.SEASON_NOT_JOINED:
      return 'blocked_season_not_joined';
    case ERROR_CODE.SEASON_NOT_ACTIVE:
      return 'blocked_season_not_active';
    default:
      return null;
  }
}

export function mapFxErrorCodeToBlockedReason(
  code?: string | null,
): BlockedReason | null {
  switch (code as ErrorCode | undefined) {
    case ERROR_CODE.INSUFFICIENT_BALANCE:
      return 'blocked_fx_insufficient_balance';
    case ERROR_CODE.FX_RATE_STALE:
      return 'blocked_fx_rate_stale';
    case ERROR_CODE.SEASON_NOT_ACTIVE:
      return 'blocked_fx_season_inactive';
    default:
      return null;
  }
}