import { HttpException, HttpStatus } from '@nestjs/common';
import { createApiError } from '../common/api-error';

/**
 * Error contract for the rewarded-ad endpoints (작업 6). Every code maps to
 * exactly one HTTP status so the same situation can never be reported two
 * different ways from two call sites.
 */
export const adRewardErrorCodes = {
  /** The named account is a season account; ad rewards are general-only. */
  AD_REWARD_GENERAL_ACCOUNT_ONLY: 'AD_REWARD_GENERAL_ACCOUNT_ONLY',
  /** General account is suspended or closed: reads allowed, grants not. */
  TRADING_ACCOUNT_NOT_ACTIVE: 'TRADING_ACCOUNT_NOT_ACTIVE',
  /** AD_REWARD_ENABLED is false — the default state. */
  AD_REWARD_DISABLED: 'AD_REWARD_DISABLED',
  /** No verifier adapter is registered for the configured provider. */
  AD_REWARD_PROVIDER_UNAVAILABLE: 'AD_REWARD_PROVIDER_UNAVAILABLE',
  /** The provider verifier rejected the proof. Nothing is written. */
  AD_REWARD_VERIFICATION_FAILED: 'AD_REWARD_VERIFICATION_FAILED',
  /**
   * The ad session is this command's, but the ad network's signed
   * confirmation (AdMob SSV) has not arrived yet (2026-11-07). Nothing is
   * written; retry the SAME command (key and proof) — never a new ad.
   */
  AD_REWARD_VERIFICATION_PENDING: 'AD_REWARD_VERIFICATION_PENDING',
  /** Too many ad sessions are still waiting for their confirmation. */
  AD_REWARD_SESSION_LIMIT: 'AD_REWARD_SESSION_LIMIT',
  /**
   * Google confirmed the ad, and the SERVER is still completing its command
   * after a temporary failure (2026-11-08, "Server recovery"): the member's
   * call only reads that, nothing is run or written for it — ask again later.
   * Also the answer to a new ad session while an earlier reset is pending.
   */
  AD_REWARD_REDEMPTION_PENDING: 'AD_REWARD_REDEMPTION_PENDING',
  /**
   * The server settled this ad's command as not applied — refused, its
   * outcome unknown, or its 24 h window over — and never runs it again
   * (2026-11-08). `details.reasonCode` names why when it is a known code.
   * Trying again is a NEW command (a new session and ad).
   */
  AD_REWARD_REDEMPTION_CLOSED: 'AD_REWARD_REDEMPTION_CLOSED',
  /** This provider event was already consumed by another user/account. */
  AD_REWARD_EVENT_ALREADY_USED: 'AD_REWARD_EVENT_ALREADY_USED',
  AD_REWARD_DAILY_COUNT_LIMIT: 'AD_REWARD_DAILY_COUNT_LIMIT',
  AD_REWARD_DAILY_AMOUNT_LIMIT: 'AD_REWARD_DAILY_AMOUNT_LIMIT',
  AD_REWARD_COOLDOWN_ACTIVE: 'AD_REWARD_COOLDOWN_ACTIVE',
  AD_REWARD_INVALID_REQUEST: 'AD_REWARD_INVALID_REQUEST',
  /**
   * Same (account, idempotencyKey) submitted with a DIFFERENT request. Never
   * silently re-verified or re-granted — the key already means something.
   */
  AD_REWARD_IDEMPOTENCY_CONFLICT: 'AD_REWARD_IDEMPOTENCY_CONFLICT',
  /**
   * A stored claim disagrees with its ledger row / wallet / boundary
   * snapshots. Replaying it as a success would report money that may not
   * exist, so it fails closed instead.
   */
  AD_REWARD_CLAIM_INTEGRITY: 'AD_REWARD_CLAIM_INTEGRITY',
  /**
   * A general-account reset was refused because something is still held or
   * pending (holdings, Futures positions, open or conditional orders,
   * reserved cash). Nothing is written and the ad completion is not consumed;
   * GET .../account-reset/eligibility lists what blocks it (2026-10-20).
   */
  GENERAL_ACCOUNT_RESET_BLOCKED: 'GENERAL_ACCOUNT_RESET_BLOCKED',
} as const;

export type AdRewardErrorCode =
  (typeof adRewardErrorCodes)[keyof typeof adRewardErrorCodes];

export const adRewardErrorHttpStatus: Record<AdRewardErrorCode, HttpStatus> = {
  AD_REWARD_GENERAL_ACCOUNT_ONLY: HttpStatus.CONFLICT,
  TRADING_ACCOUNT_NOT_ACTIVE: HttpStatus.CONFLICT,
  AD_REWARD_DISABLED: HttpStatus.SERVICE_UNAVAILABLE,
  AD_REWARD_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  AD_REWARD_VERIFICATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  AD_REWARD_VERIFICATION_PENDING: HttpStatus.CONFLICT,
  AD_REWARD_SESSION_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  AD_REWARD_REDEMPTION_PENDING: HttpStatus.CONFLICT,
  AD_REWARD_REDEMPTION_CLOSED: HttpStatus.CONFLICT,
  AD_REWARD_EVENT_ALREADY_USED: HttpStatus.CONFLICT,
  AD_REWARD_DAILY_COUNT_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  AD_REWARD_DAILY_AMOUNT_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  AD_REWARD_COOLDOWN_ACTIVE: HttpStatus.TOO_MANY_REQUESTS,
  AD_REWARD_INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  AD_REWARD_IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  AD_REWARD_CLAIM_INTEGRITY: HttpStatus.INTERNAL_SERVER_ERROR,
  GENERAL_ACCOUNT_RESET_BLOCKED: HttpStatus.CONFLICT,
};

/** The three codes a claim can be permanently REJECTED with. */
export const adRewardLimitErrorCodes = [
  adRewardErrorCodes.AD_REWARD_DAILY_COUNT_LIMIT,
  adRewardErrorCodes.AD_REWARD_DAILY_AMOUNT_LIMIT,
  adRewardErrorCodes.AD_REWARD_COOLDOWN_ACTIVE,
] as const;

export type AdRewardLimitErrorCode = (typeof adRewardLimitErrorCodes)[number];

export function isAdRewardLimitErrorCode(
  value: string | null | undefined,
): value is AdRewardLimitErrorCode {
  return adRewardLimitErrorCodes.includes(value as AdRewardLimitErrorCode);
}

export function throwAdRewardError(
  code: AdRewardErrorCode,
  message: string,
): never {
  throw new HttpException(
    {
      success: false,
      error: { code, message },
    },
    adRewardErrorHttpStatus[code],
  );
}

/**
 * The same code → status contract, with structured `details` the client
 * reads (fixed codes only, never exception text), through the reviewed-copy
 * factory: `message` must be in public-error-message.ts.
 */
export function throwAdRewardErrorWithDetails(
  code: AdRewardErrorCode,
  message: string,
  details: Record<string, string>,
): never {
  throw createApiError(code, message, adRewardErrorHttpStatus[code], details);
}
