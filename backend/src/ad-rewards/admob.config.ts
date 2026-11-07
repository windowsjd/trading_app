import type { AdRewardConfig } from './ad-reward.config';
import { AdRewardConfigError } from './ad-reward.config';

/**
 * AdMob rewarded ads (2026-11-07). The provider key the app and
 * AD_REWARD_PROVIDER name, and the rewarded ad units whose signed SSV
 * callbacks may redeem a session — per platform, because a session names the
 * platform its ad is shown on and only that platform's unit may confirm it.
 *
 * Ad unit ids are public identifiers, not secrets. Banner units are never
 * listed here: a banner pays nothing.
 */
export const ADMOB_PROVIDER = 'admob';

export const ADMOB_PLATFORMS = ['android', 'ios'] as const;
export type AdMobPlatform = (typeof ADMOB_PLATFORMS)[number];

/** How long a session may wait for its callback (an ad is ~30 s; SSV takes seconds). */
export const ADMOB_SESSION_TTL_MS = 30 * 60_000;

/**
 * A callback records only up to `expiresAt`; the app's command is told the
 * session ENDED (final) only this long after it. A callback that passed its
 * expiry check just before the deadline has long committed by then, so the
 * app is never told "ended" for a session the server then confirms.
 */
export const ADMOB_SESSION_EXPIRY_GRACE_MS = 2 * 60_000;

export type AdMobConfig = {
  rewardedAdUnits: Record<AdMobPlatform, string | null>;
};

const AD_UNIT = /^ca-app-pub-\d{10,20}\/\d{6,20}$/u;

export function readAdMobConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdMobConfig {
  return {
    rewardedAdUnits: {
      android: optionalAdUnit(
        env.ADMOB_REWARDED_AD_UNIT_ID_ANDROID,
        'ADMOB_REWARDED_AD_UNIT_ID_ANDROID',
      ),
      ios: optionalAdUnit(
        env.ADMOB_REWARDED_AD_UNIT_ID_IOS,
        'ADMOB_REWARDED_AD_UNIT_ID_IOS',
      ),
    },
  };
}

/**
 * Boot rule: rewarded ads switched on with AD_REWARD_PROVIDER=admob need at
 * least one platform's rewarded unit (a missing unit would accept no
 * callback, so every watched ad would wait forever).
 */
export function assertAdMobConfigured(
  adReward: AdRewardConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const admob = readAdMobConfig(env);
  if (!adReward.enabled || adReward.provider !== ADMOB_PROVIDER) return;
  if (!admob.rewardedAdUnits.android && !admob.rewardedAdUnits.ios) {
    throw new AdRewardConfigError(
      'AD_REWARD_PROVIDER=admob requires ADMOB_REWARDED_AD_UNIT_ID_ANDROID and/or ADMOB_REWARDED_AD_UNIT_ID_IOS.',
    );
  }
}

/**
 * Whether an SSV callback's `ad_unit` is this configured unit. Google's
 * examples send only the numeric part after the slash; the full id is
 * accepted too.
 */
export function adMobAdUnitMatches(callbackUnit: string, configured: string) {
  return (
    callbackUnit === configured || callbackUnit === configured.split('/')[1]
  );
}

export function isAdMobPlatform(value: unknown): value is AdMobPlatform {
  return (ADMOB_PLATFORMS as readonly unknown[]).includes(value);
}

function optionalAdUnit(raw: string | undefined, name: string): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (!AD_UNIT.test(trimmed)) {
    throw new AdRewardConfigError(
      `${name} must be an AdMob ad unit id (ca-app-pub-<publisher>/<unit>). Received: ${JSON.stringify(raw)}.`,
    );
  }
  return trimmed;
}
