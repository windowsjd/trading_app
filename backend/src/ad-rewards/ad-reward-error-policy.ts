import { HttpException, HttpStatus } from '@nestjs/common';

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
  /** This provider event was already consumed by another user/account. */
  AD_REWARD_EVENT_ALREADY_USED: 'AD_REWARD_EVENT_ALREADY_USED',
  AD_REWARD_DAILY_COUNT_LIMIT: 'AD_REWARD_DAILY_COUNT_LIMIT',
  AD_REWARD_DAILY_AMOUNT_LIMIT: 'AD_REWARD_DAILY_AMOUNT_LIMIT',
  AD_REWARD_COOLDOWN_ACTIVE: 'AD_REWARD_COOLDOWN_ACTIVE',
  AD_REWARD_INVALID_REQUEST: 'AD_REWARD_INVALID_REQUEST',
} as const;

export type AdRewardErrorCode =
  (typeof adRewardErrorCodes)[keyof typeof adRewardErrorCodes];

export const adRewardErrorHttpStatus: Record<AdRewardErrorCode, HttpStatus> = {
  AD_REWARD_GENERAL_ACCOUNT_ONLY: HttpStatus.CONFLICT,
  TRADING_ACCOUNT_NOT_ACTIVE: HttpStatus.CONFLICT,
  AD_REWARD_DISABLED: HttpStatus.SERVICE_UNAVAILABLE,
  AD_REWARD_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  AD_REWARD_VERIFICATION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  AD_REWARD_EVENT_ALREADY_USED: HttpStatus.CONFLICT,
  AD_REWARD_DAILY_COUNT_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  AD_REWARD_DAILY_AMOUNT_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  AD_REWARD_COOLDOWN_ACTIVE: HttpStatus.TOO_MANY_REQUESTS,
  AD_REWARD_INVALID_REQUEST: HttpStatus.BAD_REQUEST,
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
