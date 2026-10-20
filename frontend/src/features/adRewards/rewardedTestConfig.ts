export const GOOGLE_TEST_REWARDED_UNITS = {
  android: 'ca-app-pub-3940256099942544/5224354917',
  ios: 'ca-app-pub-3940256099942544/1712485313',
} as const;

/** Fail closed for web, Expo Go, unknown profiles and production. No UI toggle. */
export function rewardedTestUnit(platform: string, config: unknown, expoGo: boolean): string | null {
  if (expoGo || (platform !== 'android' && platform !== 'ios') || !config || typeof config !== 'object') return null;
  const value = config as { mode?: unknown; profile?: unknown; rewardedUnits?: { android?: unknown; ios?: unknown } };
  if (value.mode !== 'test' || (value.profile !== 'development' && value.profile !== 'preview')) return null;
  const official = GOOGLE_TEST_REWARDED_UNITS[platform];
  // A misconfigured EAS variable or OTA manifest can never substitute a real unit.
  return value.rewardedUnits?.[platform] === official ? official : null;
}
