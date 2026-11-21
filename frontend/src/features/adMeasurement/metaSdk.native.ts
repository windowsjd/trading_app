import { NativeModules, Platform } from 'react-native';
import type { Tracking } from './consent';
import type { MetaMeasurementSdk, StartResult } from './controller';

/**
 * The only module that talks to the Meta SDK and to iOS App Tracking
 * Transparency (2026-11-21, docs/meta-ad-measurement.md).
 *
 * It uses react-native-fbsdk-next's `FBSettings` native module and nothing
 * else: the library's JavaScript is never imported, so its event, login,
 * share and Graph modules are never created and app code has no way to log a
 * custom event. Measurement is the SDK's own automatic install/launch events
 * only.
 *
 * Nothing of the SDK runs at app start: Android's manifest removes its
 * start-up provider and iOS's launch hook is unlinked (frontend/patches), so
 * the SDK starts only from `start`, which runs once the consent (and on iOS
 * 앱 추적 허용) read in this session allows it. Both calls resolve only after
 * the native side has acted.
 */
type AndroidSettings = {
  /** frontend/patches: resolves 'started' | 'nextLaunch' | 'withdrawn'. */
  startMeasurement(consent: string): Promise<unknown>;
  /** frontend/patches: resolves whether the stop is also saved for the next launches. */
  stopMeasurement(consent: string): Promise<unknown>;
};

type IosSettings = {
  setAutoLogAppEventsEnabled(enabled: boolean): void;
  // Declares a promise it never settles: never awaited.
  setAdvertiserIDCollectionEnabled(enabled: boolean): unknown;
  initializeSDK(): void;
  /** Read-only, on the same main queue as the calls above, so it resolves after they ran. */
  getAdvertiserTrackingEnabled(): Promise<unknown>;
};

type FBSettingsModule = Partial<AndroidSettings & IosSettings>;

const nativeModule = () => (NativeModules as { FBSettings?: FBSettingsModule }).FBSettings;

const isAndroidSettings = (module: FBSettingsModule): module is AndroidSettings =>
  typeof module.startMeasurement === 'function' && typeof module.stopMeasurement === 'function';

const isIosSettings = (module: FBSettingsModule): module is IosSettings =>
  typeof module.setAutoLogAppEventsEnabled === 'function' && typeof module.setAdvertiserIDCollectionEnabled === 'function'
  && typeof module.initializeSDK === 'function' && typeof module.getAdvertiserTrackingEnabled === 'function';

function android(): AndroidSettings {
  const module = nativeModule();
  if (!module) throw new Error('The Meta SDK is not in this build.');
  if (!isAndroidSettings(module)) throw new Error('The Meta SDK patch is not applied to this build.');
  return module;
}

function ios(): IosSettings {
  const module = nativeModule();
  if (!module || !isIosSettings(module)) throw new Error('The Meta SDK is not in this build.');
  return module;
}

/** A native call that never answers must not hold the consent controls: it counts as failed. */
const NATIVE_TIMEOUT_MS = 10_000;

function answered<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The Meta SDK did not answer in time.')), NATIVE_TIMEOUT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const START_RESULTS: readonly unknown[] = ['started', 'nextLaunch', 'withdrawn'] satisfies StartResult[];

type PermissionResponse = { status: string; canAskAgain?: boolean };

function toTracking(response: PermissionResponse): Tracking {
  const status = response.status === 'granted' || response.status === 'denied' ? response.status : 'undetermined';
  return { status, canAskAgain: response.canAskAgain !== false };
}

export const metaSdk: MetaMeasurementSdk = {
  available: () => {
    const module = nativeModule();
    if (!module) return false;
    if (Platform.OS === 'android') return isAndroidSettings(module);
    return Platform.OS === 'ios' && isIosSettings(module);
  },

  keepsWithdrawals: Platform.OS === 'android',

  async getTracking() {
    if (Platform.OS !== 'ios') return null;
    const att = await import('expo-tracking-transparency');
    return toTracking(await att.getTrackingPermissionsAsync());
  },

  async requestTracking() {
    if (Platform.OS !== 'ios') return null;
    const att = await import('expo-tracking-transparency');
    return toTracking(await att.requestTrackingPermissionsAsync());
  },

  async start(consent) {
    if (Platform.OS === 'android') {
      // Initializes the SDK in this process, then logs this launch and the install (once).
      const result = await answered(android().startMeasurement(consent));
      if (START_RESULTS.includes(result)) return result as StartResult;
      throw new Error('The Meta SDK answered the start unexpectedly.');
    }
    // iOS: the settings (kept for this session), then the first start, which
    // logs the current launch because the app is already active.
    const sdk = ios();
    sdk.setAutoLogAppEventsEnabled(true);
    sdk.setAdvertiserIDCollectionEnabled(true);
    sdk.initializeSDK();
    await answered(sdk.getAdvertiserTrackingEnabled());
    return 'started';
  },

  async stop(consent) {
    if (Platform.OS === 'android') return (await answered(android().stopMeasurement(consent))) === true;
    const sdk = ios();
    sdk.setAutoLogAppEventsEnabled(false);
    sdk.setAdvertiserIDCollectionEnabled(false);
    await answered(sdk.getAdvertiserTrackingEnabled());
    // Nothing to keep for the next launches: iOS starts the SDK only from start().
    return true;
  },
};
