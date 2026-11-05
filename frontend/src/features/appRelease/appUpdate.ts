/**
 * 앱 업데이트 안내 (2026-11-05). The newest version the STORES publish comes
 * from the server's release manifest (GET /app-release, backend
 * docs/app-release-contract.md), which an operator fills only after seeing the
 * version live on Google Play / the App Store — never from a build, a
 * TestFlight upload or this source tree. This decides whether the installed
 * build should hear about it. Pure, so the rules run under `node --test`.
 *
 * A notice needs ALL of:
 * - a store build: a release (not __DEV__) EAS `production` build — preview
 *   APKs, development clients, Metro and web never qualify — and on iOS an
 *   App Store-signed one (not a simulator, development, ad-hoc or enterprise
 *   build). A TestFlight install is App Store-signed too and cannot be told
 *   apart on the device; it only hears of a version newer than its own.
 * - the manifest naming THIS app (its package / bundle id) with a well-formed
 *   version, and on iOS the App Store id the store link needs;
 * - that version strictly newer than the installed one.
 * Anything missing, malformed or unreadable shows nothing. Nothing here
 * blocks the app or forces an update.
 */
export type AppReleaseManifest = {
  android: { packageName: string; latestVersion: string; notes: string | null } | null;
  ios: { bundleId: string; appStoreId: string; latestVersion: string; notes: string | null } | null;
};

export type InstalledApp = {
  platform: string;
  applicationId: string | null;
  version: string | null;
  /** Not __DEV__, and the EAS build stamp's profile is `production`. */
  production: boolean;
  /** iOS: signed for the App Store (expo-application's APP_STORE release type). */
  appStoreSigned: boolean;
};

export type AppUpdateNotice = {
  /** One notice per platform and version per app run. */
  key: string;
  store: 'Google Play' | 'App Store';
  currentVersion: string;
  latestVersion: string;
  notes: string | null;
  /** The store app's own page for this app, then the same page on the web. */
  storeUrl: string;
  webUrl: string;
};

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;
const INSTALLED = /^\d{1,4}(\.\d{1,4}){0,3}$/u;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;
const BUNDLE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/u;
const STORE_ID = /^\d{6,12}$/u;
const MAX_NOTES = 300;

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const notesOf = (value: unknown) => {
  const notes = text(value);
  return notes && notes.length <= MAX_NOTES ? notes : null;
};

/** The server's manifest, checked again here: a platform with any bad field is none. */
export function parseAppReleaseManifest(value: unknown): AppReleaseManifest {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const android = data.android && typeof data.android === 'object' ? (data.android as Record<string, unknown>) : null;
  const ios = data.ios && typeof data.ios === 'object' ? (data.ios as Record<string, unknown>) : null;
  const androidPackage = text(android?.packageName);
  const androidVersion = text(android?.latestVersion);
  const iosBundle = text(ios?.bundleId);
  const iosStoreId = text(ios?.appStoreId);
  const iosVersion = text(ios?.latestVersion);
  return {
    android: androidPackage && PACKAGE.test(androidPackage) && androidVersion && VERSION.test(androidVersion)
      ? { packageName: androidPackage, latestVersion: androidVersion, notes: notesOf(android?.notes) }
      : null,
    ios: iosBundle && BUNDLE.test(iosBundle) && iosStoreId && STORE_ID.test(iosStoreId) && iosVersion && VERSION.test(iosVersion)
      ? { bundleId: iosBundle, appStoreId: iosStoreId, latestVersion: iosVersion, notes: notesOf(ios?.notes) }
      : null,
  };
}

/** Numeric, part by part (1.0.10 > 1.0.9; 1.0 = 1.0.0); null when either is malformed. */
export function compareVersions(left: string, right: string): number | null {
  if (!INSTALLED.test(left) || !INSTALLED.test(right)) return null;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** The notice this installed build should get, or null. */
export function decideAppUpdate(manifest: AppReleaseManifest, installed: InstalledApp): AppUpdateNotice | null {
  if (!installed.production || !installed.version || !installed.applicationId) return null;
  if (installed.platform === 'android') {
    const release = manifest.android;
    if (!release || release.packageName !== installed.applicationId) return null;
    if (compareVersions(release.latestVersion, installed.version) !== 1) return null;
    const id = encodeURIComponent(release.packageName);
    return {
      key: `android:${release.latestVersion}`,
      store: 'Google Play',
      currentVersion: installed.version,
      latestVersion: release.latestVersion,
      notes: release.notes,
      storeUrl: `market://details?id=${id}`,
      webUrl: `https://play.google.com/store/apps/details?id=${id}`,
    };
  }
  if (installed.platform === 'ios') {
    const release = manifest.ios;
    if (!installed.appStoreSigned || !release || release.bundleId !== installed.applicationId) return null;
    if (compareVersions(release.latestVersion, installed.version) !== 1) return null;
    return {
      key: `ios:${release.latestVersion}`,
      store: 'App Store',
      currentVersion: installed.version,
      latestVersion: release.latestVersion,
      notes: release.notes,
      storeUrl: `itms-apps://apps.apple.com/app/id${release.appStoreId}`,
      webUrl: `https://apps.apple.com/app/id${release.appStoreId}`,
    };
  }
  return null;
}
