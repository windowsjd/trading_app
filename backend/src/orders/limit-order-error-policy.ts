import { HttpStatus } from '@nestjs/common';

/**
 * Error codes introduced by the limit-buy foundation. Existing market-order
 * codes (ORDER_TYPE_NOT_SUPPORTED, ORDER_CANCEL_NOT_SUPPORTED,
 * INSUFFICIENT_BALANCE, QUOTE_*, ORDER_IDEMPOTENCY_CONFLICT, ...) keep their
 * meanings unchanged; everything here is additive. Clients must branch on
 * these codes, never on messages.
 */
export const limitOrderErrorCodes = {
  /** Feature flag off: new limit quote/create requests are rejected. */
  LIMIT_ORDER_DISABLED: 'LIMIT_ORDER_DISABLED',
  /** Phase 1 supports limit BUY only; limit sell has its own code. */
  LIMIT_BUY_ONLY: 'LIMIT_BUY_ONLY',
  /** limitPrice missing / non-positive / malformed / out of Decimal(24,8). */
  INVALID_LIMIT_PRICE: 'INVALID_LIMIT_PRICE',
  /** balance - reserved cannot cover the new reservation. */
  INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE',
  /** Atomic reservation lost a race and no clear cause remains. */
  ORDER_RESERVATION_CONFLICT: 'ORDER_RESERVATION_CONFLICT',
  /** Order/wallet reservation bookkeeping violates an invariant. */
  ORDER_RESERVATION_INCONSISTENT: 'ORDER_RESERVATION_INCONSISTENT',
  /** Cancel target is executed/rejected (terminal, nothing to release). */
  ORDER_NOT_CANCELABLE: 'ORDER_NOT_CANCELABLE',
  /** Concurrent state change defeated the cancel after validation. */
  ORDER_CANCEL_CONFLICT: 'ORDER_CANCEL_CONFLICT',
  /**
   * The durable quote does not carry a usable reservation basis (missing,
   * negative, out-of-range fee rate, or gross/fee/reserved that disagree
   * with the canonical rounding chain). Create refuses rather than falling
   * back to the live season fee rate.
   */
  QUOTE_RESERVATION_BASIS_INVALID: 'QUOTE_RESERVATION_BASIS_INVALID',
  LIMIT_ORDER_MATCHER_UNAVAILABLE: 'LIMIT_ORDER_MATCHER_UNAVAILABLE',
  LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE: 'LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE',
  LIMIT_ORDER_EVENT_INVALID: 'LIMIT_ORDER_EVENT_INVALID',
  LIMIT_ORDER_EVENT_GAP_DETECTED: 'LIMIT_ORDER_EVENT_GAP_DETECTED',
  LIMIT_ORDER_EXECUTION_CONFLICT: 'LIMIT_ORDER_EXECUTION_CONFLICT',
  LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT:
    'LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT',
  LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT:
    'LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT',
  LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED:
    'LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED',
} as const;

export type LimitOrderErrorCode =
  (typeof limitOrderErrorCodes)[keyof typeof limitOrderErrorCodes];

export const limitOrderErrorHttpStatus: Record<
  LimitOrderErrorCode,
  HttpStatus
> = {
  LIMIT_ORDER_DISABLED: HttpStatus.FORBIDDEN,
  LIMIT_BUY_ONLY: HttpStatus.BAD_REQUEST,
  INVALID_LIMIT_PRICE: HttpStatus.BAD_REQUEST,
  INSUFFICIENT_AVAILABLE_BALANCE: HttpStatus.CONFLICT,
  ORDER_RESERVATION_CONFLICT: HttpStatus.CONFLICT,
  ORDER_RESERVATION_INCONSISTENT: HttpStatus.INTERNAL_SERVER_ERROR,
  ORDER_NOT_CANCELABLE: HttpStatus.CONFLICT,
  ORDER_CANCEL_CONFLICT: HttpStatus.CONFLICT,
  QUOTE_RESERVATION_BASIS_INVALID: HttpStatus.CONFLICT,
  LIMIT_ORDER_MATCHER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  LIMIT_ORDER_EVENT_INVALID: HttpStatus.BAD_REQUEST,
  LIMIT_ORDER_EVENT_GAP_DETECTED: HttpStatus.SERVICE_UNAVAILABLE,
  LIMIT_ORDER_EXECUTION_CONFLICT: HttpStatus.CONFLICT,
  LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT:
    HttpStatus.INTERNAL_SERVER_ERROR,
  LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT: HttpStatus.INTERNAL_SERVER_ERROR,
  LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED: HttpStatus.BAD_REQUEST,
};
