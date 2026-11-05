/**
 * 앱 업데이트 안내 (docs/app-release-contract.md): the latest app version the
 * STORES actually publish, per platform, as an operator records it after
 * seeing the version live on Google Play / the App Store — never a build,
 * a TestFlight upload or a version in source. A platform is listed only when
 * every field it needs is present and well formed; anything else lists
 * nothing, and the app then shows no update notice.
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
const BUNDLE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const STORE_ID = /^\d{6,12}$/;
const MAX_NOTES = 300;

function text(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  return value ? value : null;
}

export function readAppReleaseManifest(
  env: NodeJS.ProcessEnv = process.env,
): AppReleaseManifest {
  const notesText = text(env, 'APP_RELEASE_NOTES');
  const notes = notesText && notesText.length <= MAX_NOTES ? notesText : null;
  const androidPackage = text(env, 'APP_RELEASE_ANDROID_PACKAGE');
  const androidVersion = text(env, 'APP_RELEASE_ANDROID_LATEST_VERSION');
  const iosBundle = text(env, 'APP_RELEASE_IOS_BUNDLE_ID');
  const iosStoreId = text(env, 'APP_RELEASE_IOS_APP_STORE_ID');
  const iosVersion = text(env, 'APP_RELEASE_IOS_LATEST_VERSION');
  return {
    android:
      androidPackage &&
      PACKAGE.test(androidPackage) &&
      androidVersion &&
      VERSION.test(androidVersion)
        ? { packageName: androidPackage, latestVersion: androidVersion, notes }
        : null,
    ios:
      iosBundle &&
      BUNDLE.test(iosBundle) &&
      iosStoreId &&
      STORE_ID.test(iosStoreId) &&
      iosVersion &&
      VERSION.test(iosVersion)
        ? {
            bundleId: iosBundle,
            appStoreId: iosStoreId,
            latestVersion: iosVersion,
            notes,
          }
        : null,
  };
}
