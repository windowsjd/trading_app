import { ERROR_CODE, type ErrorCode } from '../../models/enums/errorCode';

type ApiErrorLike = {
  response?: {
    data?: {
      error?: {
        code?: unknown;
      };
    };
  };
};

export function getApiErrorCode(error: unknown) {
  const code = (error as ApiErrorLike | undefined)?.response?.data?.error?.code;
  return typeof code === 'string' ? code : null;
}

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
    case ERROR_CODE.USER_NOT_ACTIVE:
      return '정지되었거나 삭제된 계정입니다. 고객센터에 문의해주세요.';
    case ERROR_CODE.UNAUTHORIZED:
      return '로그인이 필요합니다.';
    case ERROR_CODE.FORBIDDEN:
      return '이 작업을 수행할 권한이 없습니다.';
    case ERROR_CODE.NOT_FOUND:
      return '요청한 정보를 찾을 수 없습니다.';
    case ERROR_CODE.VALIDATION_ERROR:
      return '입력값을 다시 확인해주세요.';
    case ERROR_CODE.CONFLICT:
      return '이미 처리된 요청이거나 현재 상태와 충돌합니다.';
    case ERROR_CODE.RATE_LIMITED:
      return '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.';
    case ERROR_CODE.SEASON_NOT_JOINED:
      return '시즌에 참가해야 이용할 수 있습니다.';
    case ERROR_CODE.SEASON_NOT_ACTIVE:
      return '현재 활성 시즌이 아닙니다.';
    case ERROR_CODE.SEASON_ALREADY_JOINED:
      return '이미 참가한 시즌입니다.';
    case ERROR_CODE.SEASON_NOT_FOUND:
      return '현재 시즌이 설정되지 않았습니다.';
    case ERROR_CODE.MARKET_CLOSED:
      return '장 마감으로 주문할 수 없습니다.';
    case ERROR_CODE.PRICE_STALE:
      return '가격 갱신 대기 중입니다.';
    case ERROR_CODE.ASSET_PRICE_UNAVAILABLE:
      return '자산 가격을 확인할 수 없습니다.';
    case ERROR_CODE.INSUFFICIENT_BALANCE:
      return '잔액이 부족합니다.';
    case ERROR_CODE.INSUFFICIENT_QUANTITY:
      return '보유 수량이 부족합니다.';
    case ERROR_CODE.FX_RATE_STALE:
      return '환율 갱신 대기 중입니다.';
    case ERROR_CODE.FX_RATE_UNAVAILABLE:
      return '환율 정보를 확인할 수 없습니다.';
    case ERROR_CODE.QUOTE_REQUIRED:
      return '최신 견적을 먼저 확인해주세요.';
    case ERROR_CODE.QUOTE_NOT_FOUND:
      return '견적 정보를 찾을 수 없습니다.';
    case ERROR_CODE.QUOTE_NOT_ACTIVE:
      return '사용할 수 없는 견적입니다. 다시 견적을 받아주세요.';
    case ERROR_CODE.QUOTE_EXPIRED:
      return '견적 유효 시간이 지났습니다. 다시 견적을 받아주세요.';
    case ERROR_CODE.QUOTE_MISMATCH:
      return '견적과 요청 내용이 일치하지 않습니다. 다시 견적을 받아주세요.';
    case ERROR_CODE.RATE_CHANGED_REQUOTE_REQUIRED:
      return '가격 또는 환율이 변경되었습니다. 다시 견적을 받아주세요.';
    case ERROR_CODE.IDEMPOTENCY_REQUIRED:
      return '요청 식별자가 필요합니다. 다시 시도해주세요.';
    case ERROR_CODE.IDEMPOTENCY_CONFLICT:
    case ERROR_CODE.ORDER_IDEMPOTENCY_CONFLICT:
      return '이미 다른 내용으로 처리 중인 요청입니다. 새로고침 후 다시 시도해주세요.';
    case ERROR_CODE.ASSET_NOT_TRADABLE:
      return '현재 거래할 수 없는 자산입니다.';
    case ERROR_CODE.INVALID_PRICE:
      return '주문 가격을 다시 확인해주세요.';
    case ERROR_CODE.ORDER_REJECTED:
      return '주문이 거절되었습니다.';
    case ERROR_CODE.EXCHANGE_REJECTED:
      return '환전 요청이 거절되었습니다.';
    case ERROR_CODE.RANKING_SNAPSHOT_CHANGED:
      return '랭킹 정보가 갱신되었습니다. 다시 불러와주세요.';
    default:
      return '잠시 후 다시 시도해주세요.';
  }
}

export function isRequoteRequiredError(code?: string | null) {
  return (
    code === ERROR_CODE.RATE_CHANGED_REQUOTE_REQUIRED ||
    code === ERROR_CODE.QUOTE_EXPIRED ||
    code === ERROR_CODE.QUOTE_NOT_ACTIVE ||
    code === ERROR_CODE.QUOTE_MISMATCH
  );
}

export function isQuoteExpiredError(code?: string | null) {
  return code === ERROR_CODE.QUOTE_EXPIRED;
}

export function isIdempotencyConflictError(code?: string | null) {
  return (
    code === ERROR_CODE.IDEMPOTENCY_CONFLICT ||
    code === ERROR_CODE.ORDER_IDEMPOTENCY_CONFLICT
  );
}

export function isAuthUserInactiveError(code?: string | null) {
  return code === ERROR_CODE.USER_NOT_ACTIVE;
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
