/**
 * Which AdMob unit this build may request (2026-11-07). Pure: runs under
 * `node --test`.
 *
 * The build stamps `extra.adMob` (config/admob.cjs): development/preview →
 * Google's official sample units, production → Trading Class's own units,
 * anything else → nothing. The app re-checks the stamped unit against the
 * constants below, so a misconfigured environment or an OTA manifest can
 * never make a test build request a real unit (or a production build a
 * sample one), and a rewarded unit is never used as a banner or vice versa.
 * Web, Node and Expo Go (no native module) get no unit at all.
 */
export type AdUnitKind = 'rewarded' | 'banner';
export type AdPlatform = 'android' | 'ios';

export const GOOGLE_TEST_UNITS = {
  rewarded: { android: 'ca-app-pub-3940256099942544/5224354917', ios: 'ca-app-pub-3940256099942544/1712485313' },
  banner: { android: 'ca-app-pub-3940256099942544/9214589741', ios: 'ca-app-pub-3940256099942544/2435281174' },
} as const;

export const TRADING_CLASS_UNITS = {
  rewarded: { android: 'ca-app-pub-7899930948413451/3165650506', ios: 'ca-app-pub-7899930948413451/8170740188' },
  banner: { android: 'ca-app-pub-7899930948413451/9687728183', ios: 'ca-app-pub-7899930948413451/1842841847' },
} as const;

export function adMobUnit(kind: AdUnitKind, platform: string, config: unknown, expoGo: boolean): string | null {
  if (expoGo || (platform !== 'android' && platform !== 'ios') || !config || typeof config !== 'object') return null;
  const value = config as {
    mode?: unknown;
    profile?: unknown;
    rewardedUnits?: Partial<Record<AdPlatform, unknown>>;
    bannerUnits?: Partial<Record<AdPlatform, unknown>>;
  };
  const expected = value.mode === 'test' && (value.profile === 'development' || value.profile === 'preview')
    ? GOOGLE_TEST_UNITS
    : value.mode === 'production' && value.profile === 'production' ? TRADING_CLASS_UNITS : null;
  if (!expected) return null;
  const stamped = (kind === 'rewarded' ? value.rewardedUnits : value.bannerUnits)?.[platform];
  return stamped === expected[kind][platform] ? expected[kind][platform] : null;
}

/** True for the build's test mode (Google sample units only). */
export function isAdMobTestMode(config: unknown): boolean {
  return !!config && typeof config === 'object' && (config as { mode?: unknown }).mode === 'test';
}
