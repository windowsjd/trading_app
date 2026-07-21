import { ERROR_CODE, type ErrorCode } from '../../models/enums/errorCode';

type ApiErrorLike = {
  response?: {
    status?: unknown;
    data?: {
      error?: {
        code?: unknown;
        message?: unknown;
      };
    };
  };
  request?: unknown;
  code?: unknown;
  message?: unknown;
  isAxiosError?: unknown;
};

export type ApiErrorInfo = {
  status: number | null;
  serverCode: string | null;
  serverMessage: string | null;
  clientCode: string | null;
  clientMessage: string | null;
  hasResponse: boolean;
  hasRequest: boolean;
  isAxiosError: boolean;
};

const KNOWN_ERROR_CODES = new Set<string>(Object.values(ERROR_CODE));
const SERVER_CODE_MAX_LENGTH = 80;
const SERVER_MESSAGE_MAX_LENGTH = 160;
const SENSITIVE_KEY_VALUE_PATTERN =
  /\b(?:accessToken|refreshToken|password|authorization|secret|DATABASE_URL|api[_\s-]*key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;{}]+)/gi;
const SENSITIVE_WORD_PATTERN =
  /\b(?:accessToken|refreshToken|password|authorization|secret|DATABASE_URL|api[_\s-]*key)\b/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const NETWORK_ERROR_CODES = new Set([
  'ERR_NETWORK',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
]);
const TIMEOUT_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toStringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function toStatusOrNull(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sanitizeDisplayText(value: string, maxLength: number) {
  const redacted = value
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(SENSITIVE_KEY_VALUE_PATTERN, '[REDACTED]')
    .replace(SENSITIVE_WORD_PATTERN, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();

  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getErrorMessageFromStatus(status?: number | null) {
  switch (status) {
    case 400:
      return '입력값을 다시 확인해주세요.';
    case 401:
      return '로그인이 필요합니다.';
    case 403:
      return '이 작업을 수행할 권한이 없습니다.';
    case 404:
      return '요청한 정보를 찾을 수 없습니다.';
    case 409:
      return '이미 처리된 요청이거나 현재 상태와 충돌합니다.';
    case 410:
      return '요청한 리소스는 더 이상 사용할 수 없습니다.';
    case 429:
      return '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.';
    default:
      if (status && status >= 500) {
        return '서버 내부 오류가 발생했습니다. 백엔드 로그를 확인해주세요.';
      }
      return null;
  }
}

function isTimeoutError(info: ApiErrorInfo) {
  if (info.hasResponse) return false;

  const code = info.clientCode?.toUpperCase() ?? '';
  const message = info.clientMessage?.toLowerCase() ?? '';

  return (
    TIMEOUT_ERROR_CODES.has(code) ||
    message.includes('timeout') ||
    message.includes('timed out')
  );
}

function isNetworkErrorWithoutResponse(info: ApiErrorInfo) {
  if (info.hasResponse) return false;

  const code = info.clientCode?.toUpperCase() ?? '';
  const message = info.clientMessage?.toLowerCase() ?? '';

  return (
    info.isAxiosError ||
    info.hasRequest ||
    NETWORK_ERROR_CODES.has(code) ||
    message.includes('network error') ||
    message.includes('network request failed') ||
    message.includes('failed to fetch')
  );
}

export function isKnownErrorCode(code?: string | null): code is ErrorCode {
  return typeof code === 'string' && KNOWN_ERROR_CODES.has(code);
}

export function getApiErrorInfo(error: unknown): ApiErrorInfo {
  const errorLike = isRecord(error) ? (error as ApiErrorLike) : undefined;
  const response = errorLike?.response;
  const serverError = response?.data?.error;

  return {
    status: toStatusOrNull(response?.status),
    serverCode: toStringOrNull(serverError?.code),
    serverMessage: toStringOrNull(serverError?.message),
    clientCode: toStringOrNull(errorLike?.code),
    clientMessage: toStringOrNull(errorLike?.message),
    hasResponse: !!response,
    hasRequest: !!errorLike?.request,
    isAxiosError: errorLike?.isAxiosError === true,
  };
}

export function getApiErrorCode(error: unknown) {
  return getApiErrorInfo(error).serverCode;
}

export function getApiErrorServerMessage(error: unknown) {
  return getApiErrorInfo(error).serverMessage;
}

export function getApiErrorStatus(error: unknown) {
  return getApiErrorInfo(error).status;
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

export function getErrorMessageFromCode(
  code?: string | null,
  options?: { fallbackToGeneric?: true },
): string;
export function getErrorMessageFromCode(
  code: string | null | undefined,
  options: { fallbackToGeneric: false },
): string | null;
export function getErrorMessageFromCode(
  code?: string | null,
  options?: { fallbackToGeneric?: boolean },
) {
  switch (code as ErrorCode | undefined) {
    case ERROR_CODE.INVALID_CREDENTIALS:
      return '이메일 또는 비밀번호를 확인해주세요.';
    case ERROR_CODE.EMAIL_ALREADY_EXISTS:
      return '이미 가입된 이메일입니다.';
    case ERROR_CODE.NICKNAME_ALREADY_EXISTS:
      return '이미 사용 중인 닉네임입니다.';
    case ERROR_CODE.INVALID_EMAIL:
      return '이메일 형식이 올바르지 않습니다.';
    case ERROR_CODE.INVALID_PASSWORD:
      return '비밀번호 형식이 올바르지 않습니다. 비밀번호는 8자 이상이어야 합니다.';
    case ERROR_CODE.INVALID_NICKNAME:
      return '닉네임 형식이 올바르지 않습니다.';
    case ERROR_CODE.INVALID_PROFILE_IMAGE_URL:
      return '프로필 이미지 주소 형식이 올바르지 않습니다.';
    case ERROR_CODE.INVALID_REFRESH_TOKEN:
      return '로그인 세션이 만료되었거나 유효하지 않습니다. 다시 로그인해주세요.';
    case ERROR_CODE.AUTH_SIGNUP_CONFLICT:
      return '회원가입 처리 중 중복 데이터 충돌이 발생했습니다.';
    case ERROR_CODE.AUTH_CONFIGURATION_ERROR:
      return '서버 인증 설정 오류입니다. 백엔드 환경변수 설정을 확인해야 합니다.';
    case ERROR_CODE.USER_NOT_ACTIVE:
      return '정지되었거나 삭제된 계정입니다. 고객센터에 문의해주세요.';
    case ERROR_CODE.UNAUTHORIZED:
      return '로그인이 필요합니다.';
    case ERROR_CODE.FORBIDDEN:
      return '이 작업을 수행할 권한이 없습니다.';
    case ERROR_CODE.NOT_FOUND:
      return '요청한 정보를 찾을 수 없습니다.';
    case ERROR_CODE.GONE:
      return '요청한 리소스는 더 이상 사용할 수 없습니다.';
    case ERROR_CODE.VALIDATION_ERROR:
      return '입력값을 다시 확인해주세요.';
    case ERROR_CODE.CONFLICT:
      return '이미 처리된 요청이거나 현재 상태와 충돌합니다.';
    case ERROR_CODE.RATE_LIMITED:
    case ERROR_CODE.TOO_MANY_REQUESTS:
      return '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.';
    case ERROR_CODE.INTERNAL_SERVER_ERROR:
      return '서버 내부 오류가 발생했습니다. 백엔드 로그를 확인해주세요.';
    case ERROR_CODE.HTTP_ERROR:
      return 'HTTP 요청 처리 중 오류가 발생했습니다.';
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
    case ERROR_CODE.MARKET_CALENDAR_UNAVAILABLE:
      return '시장 운영 정보를 확인할 수 없어 주문할 수 없습니다. 잠시 후 다시 시도해주세요.';
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
      return options?.fallbackToGeneric === false
        ? null
        : '잠시 후 다시 시도해주세요.';
  }
}

export function getApiErrorDisplayMessage(error: unknown) {
  const info = getApiErrorInfo(error);
  const codeMessage = getErrorMessageFromCode(info.serverCode, {
    fallbackToGeneric: false,
  });

  if (codeMessage) return codeMessage;

  if (info.serverCode) {
    const safeCode = sanitizeDisplayText(
      info.serverCode,
      SERVER_CODE_MAX_LENGTH,
    );
    const safeMessage = info.serverMessage
      ? sanitizeDisplayText(info.serverMessage, SERVER_MESSAGE_MAX_LENGTH)
      : null;

    return safeMessage
      ? `알 수 없는 서버 오류입니다. code=${safeCode}, message=${safeMessage}`
      : `알 수 없는 서버 오류입니다. code=${safeCode}`;
  }

  const statusMessage = getErrorMessageFromStatus(info.status);
  if (statusMessage) return statusMessage;

  if (isTimeoutError(info)) {
    return '서버 응답 시간이 초과되었습니다. 백엔드 상태와 네트워크를 확인해주세요.';
  }

  if (isNetworkErrorWithoutResponse(info)) {
    return '서버에 연결할 수 없습니다. 백엔드 실행 상태, API 주소, 네트워크를 확인해주세요.';
  }

  return '알 수 없는 오류가 발생했습니다. 콘솔 로그를 확인해주세요.';
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
    case ERROR_CODE.FX_RATE_UNAVAILABLE:
      return 'blocked_fx_rate_stale';
    case ERROR_CODE.SEASON_NOT_JOINED:
      return 'blocked_season_not_joined';
    case ERROR_CODE.SEASON_NOT_ACTIVE:
      return 'blocked_fx_season_inactive';
    default:
      return null;
  }
}
