import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * 광고 성과 측정's native settings (2026-11-21) that no unit test can execute
 * but that decide what the Meta SDK does before JavaScript runs. Android ships
 * from the committed android/ project (EAS skips prebuild there), iOS from
 * app.json through prebuild; both must keep the SDK off until the in-app
 * consent, and the patch in frontend/patches must be applied to the
 * installed library (npm's postinstall runs patch-package).
 */
const read = (path: string) => readFileSync(resolve(path), 'utf8');
type Plugin = string | [string, Record<string, unknown>];
const appJson = JSON.parse(read('app.json')) as {
  scheme: string;
  plugins: Plugin[];
  android: { package: string; blockedPermissions: string[] };
  ios: { bundleIdentifier: string };
};
const plugin = (name: string) => {
  const entry = appJson.plugins.find((item) => (Array.isArray(item) ? item[0] : item) === name);
  return Array.isArray(entry) ? entry[1] : entry ? {} : undefined;
};
const facebook = plugin('react-native-fbsdk-next') as Record<string, unknown> | undefined;
const ADSERVICES = ['ACCESS_ADSERVICES_AD_ID', 'ACCESS_ADSERVICES_ATTRIBUTION', 'ACCESS_ADSERVICES_TOPICS', 'ACCESS_ADSERVICES_CUSTOM_AUDIENCE'];

describe('Android native settings', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const strings = read('android/app/src/main/res/values/strings.xml');
  const metaData = (name: string) => new RegExp(`<meta-data android:name="${name.replace(/\./g, '\\.')}" android:value="([^"]*)"/>`).exec(manifest)?.[1];
  const string = (name: string) => new RegExp(`<string name="${name}"[^>]*>([^<]*)</string>`).exec(strings)?.[1];

  it('keeps the advertising ID permission and removes every AdServices permission', () => {
    assert.equal(manifest.includes('<uses-permission android:name="com.google.android.gms.permission.AD_ID"/>'), true);
    assert.equal(manifest.includes('com.google.android.gms.permission.AD_ID" tools:node="remove"'), false);
    for (const permission of ADSERVICES)
      assert.equal(manifest.includes(`<uses-permission android:name="android.permission.${permission}" tools:node="remove"/>`), true, permission);
  });

  it('starts the Meta SDK with initialization, automatic events and advertiser-ID collection off', () => {
    assert.equal(metaData('com.facebook.sdk.ApplicationId'), '@string/facebook_app_id');
    assert.equal(metaData('com.facebook.sdk.ClientToken'), '@string/facebook_client_token');
    for (const name of ['AutoInitEnabled', 'AutoLogAppEventsEnabled', 'AdvertiserIDCollectionEnabled'])
      assert.equal(metaData(`com.facebook.sdk.${name}`), 'false', name);
  });

  it('removes the SDK start-up provider, so no SDK code runs before the consent is checked', () => {
    // It would initialize the SDK in every process, send events queued in an
    // earlier run and follow a server-sent auto-logging value over the flags above.
    assert.equal(manifest.includes(
      '<provider android:name="com.facebook.internal.FacebookInitProvider" android:authorities="${applicationId}.FacebookInitProvider" tools:node="remove"/>',
    ), true);
    assert.equal((manifest.match(/FacebookInitProvider/g) ?? []).length, 2);
  });

  it('keeps the SDK field the patch reads by name if release minification is turned on', () => {
    const rules = read('android/app/proguard-rules.pro');
    assert.equal(/-keepclassmembers class com\.facebook\.appevents\.internal\.ActivityLifecycleTracker \{\s*private static int activityReferences;\s*\}/.test(rules), true);
  });

  it('uses the same Meta app as iOS, and only its public client identifiers', () => {
    assert.equal(string('facebook_app_id'), facebook?.appID);
    assert.equal(string('facebook_client_token'), facebook?.clientToken);
    // The App Secret never belongs in an app.
    assert.equal(/<string name="[^"]*secret/i.test(strings), false);
  });

  it('keeps the app link scheme and pins the Meta SDK version', () => {
    assert.equal(manifest.includes(`<data android:scheme="${appJson.scheme}"/>`), true);
    assert.equal(read('android/app/build.gradle').includes(`applicationId "${appJson.android.package}"`), true);
    assert.equal(/^\s*facebookSdkVersion = '18\.3\.0'$/m.test(read('android/build.gradle')), true);
  });
});

describe('iOS settings (app.json → prebuild)', () => {
  it('writes the SDK switches off and the Meta app identifiers', () => {
    assert.equal(facebook?.appID, '1450675133819583');
    assert.equal(facebook?.scheme, `fb${String(facebook?.appID)}`);
    for (const flag of ['isAutoInitEnabled', 'autoLogAppEventsEnabled', 'advertiserIDCollectionEnabled'])
      assert.equal(facebook?.[flag], false, flag);
    // The library's own ATT text is not used; expo-tracking-transparency writes it.
    assert.equal(facebook?.iosUserTrackingPermission === undefined, true);
  });

  it('explains 앱 추적 허용 once, through expo-tracking-transparency', () => {
    const text = plugin('expo-tracking-transparency')?.userTrackingPermission;
    assert.equal(typeof text === 'string' && text.includes('광고 식별자') && text.includes('허용하지 않아도'), true);
    assert.equal(plugin('react-native-google-mobile-ads')?.userTrackingUsageDescription === undefined, true);
  });

  it('keeps the app identifiers and the existing scheme', () => {
    assert.equal(appJson.ios.bundleIdentifier, 'com.leagueoftrading');
    assert.equal(appJson.android.package, 'com.nanghwa.tradingclass');
    assert.equal(appJson.scheme, 'leagueoftrading');
    assert.equal(appJson.android.blockedPermissions.includes('com.google.android.gms.permission.AD_ID'), false);
    for (const permission of ADSERVICES) assert.equal(appJson.android.blockedPermissions.includes(`android.permission.${permission}`), true, permission);
  });
});

describe('react-native-fbsdk-next patch', () => {
  const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; scripts: Record<string, string> };
  const version = pkg.dependencies['react-native-fbsdk-next'];
  const installed = 'node_modules/react-native-fbsdk-next';

  it('pins the exact version the patch was made for and applies it on install', () => {
    assert.equal(version, '13.4.3');
    assert.equal(pkg.scripts.postinstall, 'patch-package');
    assert.equal(statSync(resolve(`patches/react-native-fbsdk-next+${version}.patch`)).isFile(), true);
    assert.equal((JSON.parse(read(`${installed}/package.json`)) as { version: string }).version, version);
  });

  it('is applied: no iOS launch hook, and the Android start and stop answer only once done', () => {
    // Without the hook the iOS SDK starts only from Settings.initializeSDK() after consent.
    const expoModule = JSON.parse(read(`${installed}/expo-module.config.json`)) as { platforms: string[]; ios?: unknown };
    assert.deepEqual(expoModule.platforms, []);
    assert.equal(expoModule.ios === undefined, true);
    const androidsdk = `${installed}/android/src/main/java/com/facebook/reactnative/androidsdk`;
    const settings = read(`${androidsdk}/FBSettingsModule.java`);
    for (const method of ['startMeasurement', 'stopMeasurement'])
      assert.equal(settings.includes(`@ReactMethod\n    public void ${method}(final String consent, final Promise promise) {\n        UiThreadUtil.runOnUiThread(() -> {`), true, method);
    // Initialized only here, fully before its first request; the launch the tracking missed is replayed.
    assert.equal(settings.includes('FacebookSdk.setAutoInitEnabled(true);\n        if (!FacebookSdk.isInitialized()) FacebookSdk.sdkInitialize(application);'), true);
    assert.equal(settings.includes('if (!wasTracking && activity instanceof LifecycleOwner) replayLifecycle(activity);'), true);
    // A stop sends nothing more from this process and keeps the consent it ended.
    assert.equal(settings.includes('AppEventsLogger.setFlushBehavior(AppEventsLogger.FlushBehavior.EXPLICIT_ONLY);'), true);
    assert.equal(settings.includes('return state.edit().putString(STOPPED_CONSENT, consent).commit();'), true);
    // The earlier fire-and-forget calls that kept the SDK on across launches are gone.
    assert.equal(/public void (setAutoInitEnabled|activateApp)\(/.test(settings), false);
    assert.equal(read(`${androidsdk}/FBSDKPackage.java`).includes('new FBSettingsModule(reactContext),'), true);
  });

  it('the patch file itself carries the Android calls, so a fresh install gets them', () => {
    const patch = read(`patches/react-native-fbsdk-next+${version}.patch`);
    for (const line of ['+    public void startMeasurement(final String consent, final Promise promise) {', '+    public void stopMeasurement(final String consent, final Promise promise) {', '+                new FBSettingsModule(reactContext),', '+  "platforms": []'])
      assert.equal(patch.includes(line), true, line);
    // Only the library's sources: never its build output.
    assert.deepEqual(patch.match(/^diff --git a\/node_modules\/react-native-fbsdk-next\/(\S+)/gm)?.map((line) => line.split('react-native-fbsdk-next/')[1]), [
      'android/src/main/java/com/facebook/reactnative/androidsdk/FBSDKPackage.java',
      'android/src/main/java/com/facebook/reactnative/androidsdk/FBSettingsModule.java',
      'expo-module.config.json',
    ]);
  });
});

describe('data boundary in the app code', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(relative(resolve('.'), path));
    }
  };
  walk(resolve('src'));
  const using = (pattern: RegExp) => files.filter((file) => pattern.test(read(file))).sort();

  it('never imports the Meta library JavaScript (no event, login, share or Graph module)', () => {
    assert.deepEqual(using(/(?:from |import |import\(|require\()['"]react-native-fbsdk-next/), []);
    assert.deepEqual(using(/AppEventsLogger|logEvent\(|setUserData|setUserID/), []);
  });

  it('reaches the Meta SDK and 앱 추적 허용 from one adapter only', () => {
    assert.deepEqual(using(/\bFBSettings\b/), ['src/features/adMeasurement/metaSdk.native.ts']);
    assert.deepEqual(using(/(?:from |import |import\(|require\()['"]expo-tracking-transparency['"]/), ['src/features/adMeasurement/metaSdk.native.ts']);
  });

  it('starts and stops Android only through the calls that confirm it', () => {
    const adapter = read('src/features/adMeasurement/metaSdk.native.ts');
    assert.equal(adapter.includes('android().startMeasurement(consent)'), true);
    assert.equal(adapter.includes('android().stopMeasurement(consent)'), true);
    assert.equal(/setAutoInitEnabled|activateApp/.test(adapter), false);
  });
});
