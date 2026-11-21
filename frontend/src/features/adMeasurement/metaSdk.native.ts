import { NativeModules, Platform } from 'react-native';
import type { Tracking } from './consent';
import type { MetaMeasurementSdk } from './controller';

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
 * Nothing here runs at app start: Android's manifest and iOS's Info.plist keep
 * initialization, automatic events and advertising-ID collection off, and the
 * patch in frontend/patches removes the library's iOS launch hook. `start`
 * runs only when the consent (and on iOS 앱 추적 허용) allows it.
 */
type FBSettingsModule = {
  setAutoLogAppEventsEnabled(enabled: boolean): void;
  // iOS declares a promise it never settles: never awaited.
  setAdvertiserIDCollectionEnabled(enabled: boolean): unknown;
  initializeSDK(): void;
  /** Android, frontend/patches: persisted com.facebook.sdk.AutoInitEnabled. */
  setAutoInitEnabled?(enabled: boolean): void;
  /** Android, frontend/patches: publishes the install (once) and starts the activity tracking. */
  activateApp?(): void;
};

function settings(): FBSettingsModule {
  const module = (NativeModules as { FBSettings?: FBSettingsModule }).FBSettings;
  if (!module) throw new Error('The Meta SDK is not in this build.');
  if (Platform.OS === 'android' && (typeof module.setAutoInitEnabled !== 'function' || typeof module.activateApp !== 'function'))
    throw new Error('The Meta SDK patch is not applied to this build.');
  return module;
}

type PermissionResponse = { status: string; canAskAgain?: boolean };

/** Runs the synchronous native calls as one promise (a missing module rejects it). */
const run = (calls: () => void) => new Promise<void>((resolve) => { calls(); resolve(); });

function toTracking(response: PermissionResponse): Tracking {
  const status = response.status === 'granted' || response.status === 'denied' ? response.status : 'undetermined';
  return { status, canAskAgain: response.canAskAgain !== false };
}

export const metaSdk: MetaMeasurementSdk = {
  available: () => (Platform.OS === 'android' || Platform.OS === 'ios') && !!(NativeModules as { FBSettings?: unknown }).FBSettings,

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

  start: () => run(() => {
    const sdk = settings();
    if (Platform.OS === 'android') {
      // In this order on the native-modules thread. Each setting persists in
      // the SDK, so the next launch starts fully initialized and tracking
      // before JavaScript runs (no event is ever sent half-initialized).
      sdk.setAdvertiserIDCollectionEnabled(true);
      sdk.setAutoInitEnabled?.(true);
      sdk.setAutoLogAppEventsEnabled(true);
      // The install now; this session's launch is logged on the next resume.
      sdk.activateApp?.();
      return;
    }
    // iOS: the settings first (kept for this session), then the first start,
    // which logs the current launch because the app is already active.
    sdk.setAutoLogAppEventsEnabled(true);
    sdk.setAdvertiserIDCollectionEnabled(true);
    sdk.initializeSDK();
  }),

  stop: () => run(() => {
    const sdk = settings();
    sdk.setAutoLogAppEventsEnabled(false);
    sdk.setAdvertiserIDCollectionEnabled(false);
    // Android: the next launch is not initialized at all. iOS never starts
    // the SDK without the consent, so nothing persists there.
    if (Platform.OS === 'android') sdk.setAutoInitEnabled?.(false);
  }),
};
