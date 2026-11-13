/**
 * 앱 업데이트 안내 (2026-11-05; stores asked directly since 2026-11-13,
 * backend docs/app-release-contract.md). Whether the installed build should
 * hear of a newer STORE version — never a build, a TestFlight upload or this
 * source tree. Pure, so the rules run under `node --test`.
 *
 * - Android: Google Play's own answer for this install (In-App Updates API,
 *   modules/play-app-update): "update available" respects staged rollouts and
 *   device targeting, and only an install from Play gets one. Play reports
 *   the new version's code, not its name, so the notice names no new version.
 * - iOS: the version the App Store publishes for this bundle id in the Korean
 *   storefront, which the server reads from Apple's lookup API (GET
 *   /app-release, cached there) — never a TestFlight or in-review build.
 *
 * A notice needs ALL of:
 * - a store build: a release (not __DEV__) EAS `production` build — preview
 *   APKs, development clients, Metro and web never qualify — and on iOS an
 *   App Store-signed one (not a simulator, development, ad-hoc or enterprise
 *   build). A TestFlight install is App Store-signed too and cannot be told
 *   apart on the device; it only hears of a version newer than its own.
 * - Android: Play says an update is available, with a version code above the
 *   installed one. iOS: the manifest names THIS bundle id with a well-formed
 *   version strictly newer than the installed one, and the App Store id the
 *   store link needs.
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
  /** Android versionCode / iOS build number, when it is a whole number. */
  buildNumber: number | null;
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
  /** The store's version name; null when the store does not tell it (Google Play). */
  latestVersion: string | null;
  notes: string | null;
  /** The store app's own page for this app, then the same page on the web. */
  storeUrl: string;
  webUrl: string;
};

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;
/** An App Store version: numeric dotted, 2 or 3 parts (the live one is "1.03" as of 2026-11-12). */
const STORE_VERSION = /^\d{1,4}(\.\d{1,4}){1,2}$/u;
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
    ios: iosBundle && BUNDLE.test(iosBundle) && iosStoreId && STORE_ID.test(iosStoreId) && iosVersion && STORE_VERSION.test(iosVersion)
      ? { bundleId: iosBundle, appStoreId: iosStoreId, latestVersion: iosVersion, notes: notesOf(ios?.notes) }
      : null,
  };
}

/**
 * Numeric, part by part (1.0.10 > 1.0.9; 1.04 > 1.03), and only between
 * versions written alike: a different number of parts is not comparable
 * (null). The App Store lists "1.03" while app.json says "1.0.3"
 * (2026-11-12); read loosely, "1.03" would be 1.3 > 1.0.3 and nag every
 * member forever, so a mismatch shows nothing instead. Null when either is
 * malformed.
 */
export function compareVersions(left: string, right: string): number | null {
  if (!INSTALLED.test(left) || !INSTALLED.test(right)) return null;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  if (a.length !== b.length) return null;
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index];
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** A manifest read older than this is read again when the app comes back to the front. */
export const RELEASE_RECHECK_MS = 30 * 60_000;
/** A failed read is tried again on the next return to the app, but not sooner than this. */
export const RELEASE_RETRY_MS = 5 * 60_000;

/**
 * Back in the foreground (2026-11-11): read the manifest again only when the
 * last read is old enough to have missed a release published meanwhile, or
 * failed a while ago — never on every switch back, never while a read runs.
 * (React Query's own focus refetch is not wired to AppState in this app.)
 */
export function shouldRecheckRelease(read: {
  now: number;
  /** When the last successful read landed (0 = never). */
  dataUpdatedAt: number;
  /** When the last failed read landed (0 = never). */
  errorUpdatedAt: number;
  /** The latest read failed. */
  failed: boolean;
  fetching: boolean;
}): boolean {
  if (read.fetching) return false;
  if (read.failed) return read.now - read.errorUpdatedAt >= RELEASE_RETRY_MS;
  return read.dataUpdatedAt === 0 || read.now - read.dataUpdatedAt >= RELEASE_RECHECK_MS;
}

/** Google Play's UpdateAvailability.UPDATE_AVAILABLE. */
export const PLAY_UPDATE_AVAILABLE = 2;

/**
 * Android: the notice for Play's answer, or null. Only "update available"
 * with a whole version code above the installed one counts (Play's other
 * answers — unknown, not available, an in-app update already running — and
 * anything malformed show nothing). No new version name is invented.
 */
export function decidePlayUpdate(info: unknown, installed: InstalledApp): AppUpdateNotice | null {
  if (installed.platform !== 'android' || !installed.production || !installed.version || !installed.applicationId) return null;
  const data = info && typeof info === 'object' ? (info as Record<string, unknown>) : {};
  if (data.updateAvailability !== PLAY_UPDATE_AVAILABLE) return null;
  const code = data.availableVersionCode;
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code <= 0) return null;
  if (installed.buildNumber !== null && code <= installed.buildNumber) return null;
  const id = encodeURIComponent(installed.applicationId);
  return {
    key: `android:play:${code}`,
    store: 'Google Play',
    currentVersion: installed.version,
    latestVersion: null,
    notes: null,
    storeUrl: `market://details?id=${id}`,
    webUrl: `https://play.google.com/store/apps/details?id=${id}`,
  };
}

/**
 * iOS: the notice for the server's App Store manifest, or null. (The
 * manifest's `android` entry is kept on the server for app builds from
 * before 2026-11-13 only; this build asks Google Play instead.)
 */
export function decideAppUpdate(manifest: AppReleaseManifest, installed: InstalledApp): AppUpdateNotice | null {
  if (!installed.production || !installed.version || !installed.applicationId) return null;
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
