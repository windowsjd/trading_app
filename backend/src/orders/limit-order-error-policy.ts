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
  /**
   * Manual/market execute paths refuse limit orders. Automatic fills happen
   * ONLY through the scheduler-driven matcher (paths A/B), never through the
   * market-order execute path.
   */
  LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED:
    'LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED',
  /**
   * A concurrent state change (cancel / cleanup / another fill) defeated a fill
   * after its guards passed. Internal to the matcher; the order stays whatever
   * the winner made it.
   */
  LIMIT_ORDER_EXECUTION_CONFLICT: 'LIMIT_ORDER_EXECUTION_CONFLICT',
  /**
   * Automatic matching is turned off (SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED
   * false). Registration still works; nothing fills automatically.
   */
  LIMIT_ORDER_MATCHING_DISABLED: 'LIMIT_ORDER_MATCHING_DISABLED',
  /** Path-B candle evidence is malformed or inconsistent (operational). */
  LIMIT_ORDER_EVIDENCE_INVALID: 'LIMIT_ORDER_EVIDENCE_INVALID',
  /** No closed 5m candle is a valid path-B trigger for the order (operational). */
  LIMIT_ORDER_CANDLE_NOT_ELIGIBLE: 'LIMIT_ORDER_CANDLE_NOT_ELIGIBLE',
  /**
   * The participant's trading-account link is missing (deploy-boundary
   * state). New financial rows are never written without it; run
   * trading-accounts:repair-links first.
   */
  TRADING_ACCOUNT_LINK_INTEGRITY: 'TRADING_ACCOUNT_LINK_INTEGRITY',
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
  LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED: HttpStatus.BAD_REQUEST,
  LIMIT_ORDER_EXECUTION_CONFLICT: HttpStatus.CONFLICT,
  LIMIT_ORDER_MATCHING_DISABLED: HttpStatus.FORBIDDEN,
  LIMIT_ORDER_EVIDENCE_INVALID: HttpStatus.INTERNAL_SERVER_ERROR,
  LIMIT_ORDER_CANDLE_NOT_ELIGIBLE: HttpStatus.CONFLICT,
  TRADING_ACCOUNT_LINK_INTEGRITY: HttpStatus.INTERNAL_SERVER_ERROR,
};
