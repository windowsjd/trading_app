/**
 * 앱 업데이트 안내 (docs/app-release-contract.md): the latest app version the
 * STORES actually publish, per platform — never a build, a TestFlight upload
 * or a version in source.
 *
 * Since 2026-11-13 the stores are asked directly: iOS from Apple's lookup API
 * (app-store-lookup.service.ts), and Android app builds ask Google Play on
 * the device. `android` below is kept ONLY for Android builds from before
 * that change, which still read this manifest: an operator may record the
 * live Play version for them (env, as before) until those builds are gone
 * (see the contract's removal plan). The `APP_RELEASE_IOS_*` variables are
 * no longer read.
 */
export type AppReleaseManifest = {
  android: {
    packageName: string;
    latestVersion: string;
    notes: string | null;
  } | null;
  ios: {
    bundleId: string;
    appStoreId: string;
    latestVersion: string;
    notes: string | null;
  } | null;
};

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_NOTES = 300;

function text(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  return value ? value : null;
}

/** The env-recorded Play version for pre-2026-11-13 Android builds, or null. */
export function readLegacyAndroidRelease(
  env: NodeJS.ProcessEnv = process.env,
): AppReleaseManifest['android'] {
  const notesText = text(env, 'APP_RELEASE_NOTES');
  const notes = notesText && notesText.length <= MAX_NOTES ? notesText : null;
  const androidPackage = text(env, 'APP_RELEASE_ANDROID_PACKAGE');
  const androidVersion = text(env, 'APP_RELEASE_ANDROID_LATEST_VERSION');
  return androidPackage &&
    PACKAGE.test(androidPackage) &&
    androidVersion &&
    VERSION.test(androidVersion)
    ? { packageName: androidPackage, latestVersion: androidVersion, notes }
    : null;
}
