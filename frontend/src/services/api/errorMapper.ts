import { ERROR_CODE, type ErrorCode } from '../../models/enums/errorCode.ts';
import type { AdminDiagnosticDto } from '../../models/dto/common.ts';

type ApiErrorLike = {
  response?: {
    status?: unknown;
    data?: {
      error?: {
        code?: unknown;
        message?: unknown;
        diagnostic?: unknown;
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
        return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.';
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

export function getApiErrorDiagnostic(
  error: unknown,
): AdminDiagnosticDto | null {
  const errorLike = isRecord(error) ? (error as ApiErrorLike) : undefined;
  return sanitizeAdminDiagnostic(errorLike?.response?.data?.error?.diagnostic);
}

/** Treat both HTTP errors and HTTP 200 partial diagnostics as untrusted input. */
export function sanitizeAdminDiagnostic(input: unknown): AdminDiagnosticDto | null {
  let diagnostic: unknown;
  try {
    diagnostic = boundDiagnostic(input);
  } catch {
    // Unreadable input must not turn an error panel into another screen failure.
    return null;
  }
  if (!isRecord(diagnostic)) return null;
  if (
    diagnostic.version !== 1 ||
    typeof diagnostic.code !== 'string' ||
    typeof diagnostic.httpStatus !== 'number' ||
    typeof diagnostic.timestamp !== 'string' ||
    typeof diagnostic.requestId !== 'string' ||
    typeof diagnostic.domain !== 'string' ||
    typeof diagnostic.operation !== 'string' ||
    typeof diagnostic.failureStage !== 'string' ||
    (diagnostic.nextInvestigation !== undefined && !isStringArray(diagnostic.nextInvestigation)) ||
    !isRecord(diagnostic.exception) ||
    typeof diagnostic.exception.type !== 'string' ||
    typeof diagnostic.exception.message !== 'string' ||
    (diagnostic.exception.cause !== undefined && typeof diagnostic.exception.cause !== 'string') ||
    !isStringArray(diagnostic.exception.applicationStack) ||
    !isStringArray(diagnostic.exception.stack) ||
    typeof diagnostic.exception.truncated !== 'boolean' ||
    !isRecord(diagnostic.diagnosticEvents) ||
    !Array.isArray(diagnostic.diagnosticEvents.events) ||
    !diagnostic.diagnosticEvents.events.every(isDiagnosticLogEvent) ||
    typeof diagnostic.diagnosticEvents.truncated !== 'boolean' ||
    !isRecord(diagnostic.serverLogs) ||
    !Array.isArray(diagnostic.serverLogs.entries) ||
    !diagnostic.serverLogs.entries.every(isServerLogEntry) ||
    typeof diagnostic.serverLogs.truncated !== 'boolean' ||
    typeof diagnostic.truncated !== 'boolean'
  ) {
    return null;
  }
  return diagnostic as unknown as AdminDiagnosticDto;
}

function boundDiagnostic(input: unknown): unknown {
  let remaining = 6000;
  let nodes = 300;
  let truncated = false;
  const sensitive = (key: string) => /password|authorization|cookie|credential|databaseurl|dburl|token|secret|apikey|appkey|privatekey|rawpayload|providerpayload|rawbody|responsebody|rawresponse|providerresponse|^(?:row|walletrow|dbrow)$|^(?:balance|reserved|amount|quantity|pnl)$|(?:balanceamount|reservedamount|transferamount|sourceamount|netamount|grossamount|feeamount|averagecost|realizedpnl|reservedquantity)/u.test(key.replace(/[^a-z0-9]/giu, '').toLowerCase());
  const text = (value: string): string => {
    // Free-text payload/credential assignments and URLs have ambiguous bounds.
    if (/(?:https?|wss?|postgres(?:ql)?|mysql|mongodb):\/\/|\b(?:Bearer|Basic)\s|(?:password|token|secret|api[_ -]?key|raw[_ -]?(?:payload|exception)|provider[_ -]?(?:payload|response))[\s\\"']*[:=]|(?:balance|reserved|amount|quantity|pnl)[a-z_]*[\s\\"']*[:= ][\s\\"']*[-+]?\d/iu.test(value)) return '[REDACTED]';
    const limit = Math.min(1000, Math.max(remaining, 0));
    remaining -= Math.min(value.length, limit);
    if (value.length > limit) { truncated = true; return value.slice(0, limit); }
    return value;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 7 || remaining <= 0) { truncated = true; return '[TRUNCATED]'; }
    if (typeof value === 'string') return text(value);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) {
      if (value.length > 30) truncated = true;
      return value.slice(0, 30).map(item => visit(item, depth + 1));
    }
    if (isRecord(value)) {
      const entries: Array<[string, unknown]> = [];
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (entries.length === 30 || nodes <= 0 || remaining <= 0) {
          truncated = true;
          break;
        }
        entries.push([text(key), sensitive(key) ? '[REDACTED]' : visit(value[key], depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return null;
  };
  if (!isRecord(input)) return null;
  // Only the existing DTO fields cross the panel boundary; discard extra rows/payloads.
  const fields = ['version', 'code', 'httpStatus', 'timestamp', 'requestId', 'domain', 'operation', 'failureStage', 'exception', 'diagnosticEvents', 'serverLogs', 'nextInvestigation', 'truncated', 'entities', 'evidence'];
  const result = visit(Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]])), 0);
  if (isRecord(result)) {
    result.truncated = input.truncated === true || truncated;
    if (Array.isArray(result.nextInvestigation)) result.nextInvestigation = result.nextInvestigation.filter(hint => typeof hint === 'string' && /^(?:backend|frontend)\/(?:src|scripts)\/[\w/.-]+\.(?:ts|tsx)$/u.test(hint));
  }
  return result;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDiagnosticLogEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.timestamp === 'string' &&
    typeof value.level === 'string' &&
    typeof value.event === 'string' &&
    typeof value.message === 'string'
  );
}

function isServerLogEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.timestamp === 'string' &&
    typeof value.level === 'string' &&
    typeof value.message === 'string' &&
    (value.context === undefined || typeof value.context === 'string') &&
    (value.details === undefined || Array.isArray(value.details))
  );
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
      return '회원가입을 완료하지 못했습니다. 입력 정보를 확인하고 다시 시도해주세요.';
    case ERROR_CODE.AUTH_CONFIGURATION_ERROR:
      return '로그인 또는 회원가입을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.';
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
      return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.';
    case ERROR_CODE.HTTP_ERROR:
      return '요청을 처리하지 못했습니다. 다시 시도해주세요.';
    case ERROR_CODE.SEASON_NOT_JOINED:
      return '시즌에 참가해야 이용할 수 있습니다.';
    case ERROR_CODE.SEASON_NOT_ACTIVE:
      return '현재 활성 시즌이 아닙니다.';
    case ERROR_CODE.SEASON_ALREADY_JOINED:
      return '이미 참가한 시즌입니다.';
    case ERROR_CODE.SEASON_NOT_FOUND:
      return '현재 시즌이 설정되지 않았습니다.';
    case ERROR_CODE.MARKET_CLOSED:
      return '정규장 외에는 시장가 주문을 할 수 없습니다. 지정가를 직접 선택해주세요.';
    case ERROR_CODE.MARKET_CALENDAR_UNAVAILABLE:
      return '시장 운영 정보를 확인할 수 없어 주문할 수 없습니다. 잠시 후 다시 시도해주세요.';
    case ERROR_CODE.LIMIT_ORDER_DISABLED:
      return '지정가 주문 기능이 아직 활성화되지 않았습니다.';
    case ERROR_CODE.LIMIT_BUY_ONLY:
      return '지정가 주문은 현재 매수만 지원합니다.';
    case ERROR_CODE.FRACTIONAL_LIMIT_ORDER_NOT_SUPPORTED:
      return '주식 소수점 수량은 시장가만 가능합니다. 지정가는 정수 수량을 입력해주세요.';
    case ERROR_CODE.INVALID_AMOUNT:
      return '매수 금액을 확인해주세요. 주문 가능한 최소 수량보다 작을 수 있습니다.';
    case ERROR_CODE.INVALID_ORDER_INPUT:
      return '암호화폐 매수는 매수 금액을, 다른 주문은 수량을 입력해주세요.';
    case ERROR_CODE.PRICE_UNAVAILABLE:
      return '서버에서 주문 가능한 시세를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.';
    case ERROR_CODE.INVALID_LIMIT_PRICE:
      return '지정가 가격을 확인해주세요. 0보다 큰 숫자여야 합니다.';
    case ERROR_CODE.INSUFFICIENT_AVAILABLE_BALANCE:
      return '사용 가능 현금이 부족합니다. 기존 예약 주문을 확인해주세요.';
    case ERROR_CODE.ORDER_RESERVATION_CONFLICT:
      return '예약 처리 중 충돌이 발생했습니다. 다시 시도해주세요.';
    case ERROR_CODE.ORDER_RESERVATION_INCONSISTENT:
      return '예약 상태를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.';
    case ERROR_CODE.ORDER_NOT_CANCELABLE:
      return '이미 체결되었거나 취소할 수 없는 주문입니다.';
    case ERROR_CODE.ORDER_CANCEL_CONFLICT:
      return '주문 상태가 변경되어 취소하지 못했습니다. 새로고침 후 다시 확인해주세요.';
    case ERROR_CODE.ORDER_CANCEL_NOT_SUPPORTED:
      return '시장가 주문은 취소할 수 없습니다.';
    case ERROR_CODE.ORDER_TYPE_NOT_SUPPORTED:
      return '지원하지 않는 주문 유형입니다.';
    case ERROR_CODE.PRICE_STALE:
      return '가격 갱신 대기 중입니다.';
    case 'ORDER_LIQUIDITY_UNAVAILABLE':
      return '현재 체결 가능한 시장 유동성이 없습니다. 새 견적으로 다시 시도해주세요.';
    case 'EXECUTION_EVIDENCE_UNAVAILABLE':
      return '체결에 필요한 시장 정보를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.';
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
    case ERROR_CODE.ORDER_NOT_FOUND:
      // Unknown id and another account's id are the same answer by design;
      // the copy therefore states neither.
      return '주문을 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 확인해주세요.';
    case ERROR_CODE.AD_REWARD_PROVIDER_UNAVAILABLE:
      // Temporary and retryable — deliberately worded unlike an integrity
      // failure, which asks the user to contact support.
      return '광고 제공자와 연결할 수 없습니다. 잠시 후 다시 시도해주세요.';
    case ERROR_CODE.RATE_CHANGED_REQUOTE_REQUIRED:
      return '가격 또는 환율이 변경되었습니다. 다시 견적을 받아주세요.';
    case ERROR_CODE.IDEMPOTENCY_REQUIRED:
      return '요청을 처리하지 못했습니다. 다시 시도해주세요.';
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
    case ERROR_CODE.TRADING_ACCOUNT_NOT_FOUND:
      return '선택한 투자 계정을 찾을 수 없습니다. 계정 목록을 새로 불러옵니다.';
    case ERROR_CODE.TRADING_ACCOUNT_NOT_ACTIVE:
      return '현재 계정 상태에서는 이 작업을 할 수 없습니다.';
    // 준비 중인 기능: 데이터 손상이 아니므로 문의를 안내하지 않는다.
    case ERROR_CODE.GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED:
      return '일반 투자 계정의 환전 기능은 아직 준비 중입니다.';
    // 구조적 무결성 오류: 빈 데이터로 위장하지 않고 재시도/문의를 안내한다.
    case ERROR_CODE.TRADING_ACCOUNT_INTEGRITY:
    case ERROR_CODE.TRADING_ACCOUNT_SCOPE_MISMATCH:
    case ERROR_CODE.TRADING_SCOPE_REPAIR_REQUIRED:
    case ERROR_CODE.TRADING_ACCOUNT_LINK_INTEGRITY:
    case ERROR_CODE.FINANCIAL_SCOPE_REPAIR_REQUIRED:
    case ERROR_CODE.FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH:
    case ERROR_CODE.GENERAL_ACCOUNT_INTEGRITY:
    case ERROR_CODE.GENERAL_PERFORMANCE_NOT_INITIALIZED:
    case ERROR_CODE.GENERAL_PERFORMANCE_INTEGRITY:
    case ERROR_CODE.GENERAL_PERFORMANCE_DISCONTINUITY:
    case ERROR_CODE.SEASON_RANKING_SCOPE_REPAIR_REQUIRED:
    case ERROR_CODE.SEASON_RANKING_SCOPE_MISMATCH:
    case ERROR_CODE.SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED:
    case ERROR_CODE.SEASON_RANKING_SOURCE_SCOPE_MISMATCH:
    case ERROR_CODE.FINAL_RESULTS_INTEGRITY:
    case ERROR_CODE.AD_REWARD_CLAIM_INTEGRITY:
      return '계정 데이터에 문제가 발견되어 안전하게 조회를 중단했습니다. 잠시 후 다시 시도하고, 계속되면 고객센터에 문의해주세요.';
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

  const statusMessage = getErrorMessageFromStatus(info.status);
  if (statusMessage) return statusMessage;

  if (isTimeoutError(info)) {
    return '응답이 늦어지고 있습니다. 잠시 후 다시 시도해주세요.';
  }

  if (isNetworkErrorWithoutResponse(info)) {
    return '연결하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해주세요.';
  }

  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.';
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

/** Facts from the failed request only. Endpoints are call-site templates, never URLs from errors. */
export function requestFailureFacts(error: unknown, context: {
  endpoint: string;
  operation: string;
  contractFailure?: boolean;
  contractInvestigation?:
    | 'frontend/src/features/order/validateOrderQuote.ts'
    | 'frontend/src/features/order/mapper.ts'
    | 'frontend/src/features/wallet/walletTransfer.ts';
  outcome?: 'unknown' | 'not_submitted';
}): import('../ws/runtimeDiagnostics').RuntimeFacts {
  const info = getApiErrorInfo(error);
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers;
  const requestId = headers?.['x-request-id'];
  const timeout = !info.hasResponse && TIMEOUT_ERROR_CODES.has(info.clientCode ?? '');
  const network = !info.hasResponse && NETWORK_ERROR_CODES.has(info.clientCode ?? '');
  return {
    endpoint: context.endpoint,
    operation: context.operation,
    hasResponse: info.hasResponse || !!context.contractFailure,
    httpStatus: info.status !== null && Number.isInteger(info.status) && info.status >= 100 && info.status <= 599 ? info.status : 'not_observed',
    serverCode: isKnownErrorCode(info.serverCode) ? info.serverCode : info.serverCode ? 'unrecognized' : 'not_observed',
    clientCode: timeout || network || ['ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_CANCELED'].includes(info.clientCode ?? '') ? info.clientCode : 'not_observed',
    timeout, network,
    responseContract: context.contractFailure ? 'rejected' : 'not_observed',
    clientFailureStage: context.contractFailure ? 'response_validation' : info.hasResponse ? 'http_response' : 'request_transport',
    outcome: context.outcome ?? 'not_observed',
    requestId: typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId) ? requestId : 'not_observed',
    clientInvestigation: context.contractFailure
      ? context.contractInvestigation ?? 'frontend/src/features/tradingAccount/api.ts'
      : 'frontend/src/services/api/client.ts',
  };
}
