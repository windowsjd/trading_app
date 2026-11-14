import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GOOGLE_TEST_UNITS, TRADING_CLASS_UNITS, adMobUnit, isAdMobTestMode } from './adMobUnits.ts';

const require = createRequire(import.meta.url);
const { adMobBuildConfig, TEST_UNITS, PRODUCTION_UNITS } = require('../../../config/admob.cjs');
const app = require('../../../app.json');
const eas = require('../../../eas.json');
const dependencies = require('../../../package.json').dependencies;
const sdkPackage = require('react-native-google-mobile-ads/package.json');

/** The confirmed units (2026-11-07): rewarded and banner, per platform, never mixed. */
const CONFIRMED = {
  rewarded: { android: 'ca-app-pub-7899930948413451/3165650506', ios: 'ca-app-pub-7899930948413451/8170740188' },
  banner: { android: 'ca-app-pub-7899930948413451/9687728183', ios: 'ca-app-pub-7899930948413451/1842841847' },
};

test('the confirmed production units, Google sample units, and their build-config copies agree', () => {
  assert.deepEqual(TRADING_CLASS_UNITS, CONFIRMED);
  assert.deepEqual(PRODUCTION_UNITS, CONFIRMED);
  assert.deepEqual(GOOGLE_TEST_UNITS, TEST_UNITS);
  assert.deepEqual(GOOGLE_TEST_UNITS.rewarded, { android: 'ca-app-pub-3940256099942544/5224354917', ios: 'ca-app-pub-3940256099942544/1712485313' });
  assert.deepEqual(GOOGLE_TEST_UNITS.banner, { android: 'ca-app-pub-3940256099942544/9214589741', ios: 'ca-app-pub-3940256099942544/2435281174' });
  // Eight distinct ids: no unit is shared by two kinds or two platforms.
  const all = [GOOGLE_TEST_UNITS, TRADING_CLASS_UNITS].flatMap((set) => [set.rewarded, set.banner]).flatMap((units) => [units.android, units.ios]);
  assert.equal(new Set(all).size, 8);
});

test('development and preview request only Google sample units, whatever the environment supplies', () => {
  for (const profile of ['development', 'preview']) {
    const config = adMobBuildConfig({ EAS_BUILD_PROFILE: profile, ADMOB_REWARDED_ANDROID_ID: CONFIRMED.rewarded.android });
    assert.equal(config.mode, 'test');
    assert.equal(isAdMobTestMode(config), true);
    for (const kind of ['rewarded', 'banner'] as const) for (const platform of ['android', 'ios'] as const) {
      assert.equal(adMobUnit(kind, platform, config, false), GOOGLE_TEST_UNITS[kind][platform], `${profile}/${kind}/${platform}`);
      assert.equal(adMobUnit(kind, platform, config, true), null, 'Expo Go cannot load a native SDK');
    }
    assert.equal(adMobUnit('banner', 'web', config, false), null);
  }
});

test('production requests only Trading Class units, each of its own kind and platform', () => {
  const config = adMobBuildConfig({ EAS_BUILD_PROFILE: 'production' });
  assert.deepEqual(config, { mode: 'production', profile: 'production', rewardedUnits: CONFIRMED.rewarded, bannerUnits: CONFIRMED.banner });
  assert.equal(isAdMobTestMode(config), false);
  for (const kind of ['rewarded', 'banner'] as const) for (const platform of ['android', 'ios'] as const)
    assert.equal(adMobUnit(kind, platform, config, false), CONFIRMED[kind][platform]);
});

test('an unknown build, a profile mismatch or a tampered manifest requests no ad at all', () => {
  for (const profile of [undefined, '', 'custom', 'Production']) {
    const unknown = adMobBuildConfig({ EAS_BUILD_PROFILE: profile });
    assert.equal(unknown.mode, 'disabled');
    assert.equal(adMobUnit('rewarded', 'android', unknown, false), null);
    assert.equal(adMobUnit('banner', 'ios', unknown, false), null);
  }
  // A plain local run (no EAS profile) is disabled too: automated runs never request ads.
  assert.equal(adMobBuildConfig({}).mode, 'disabled');
  assert.equal(adMobBuildConfig({ ADMOB_BUILD_PROFILE: 'preview', EAS_BUILD_PROFILE: 'production' }).mode, 'disabled');
  assert.equal(adMobBuildConfig({ ADMOB_BUILD_PROFILE: 'production', EAS_BUILD_PROFILE: 'preview' }).mode, 'disabled');
  const localEas = adMobBuildConfig({ ADMOB_BUILD_PROFILE: 'preview', EAS_BUILD_PROFILE: {} });
  assert.deepEqual([localEas.mode, localEas.profile], ['test', 'preview']);
  for (const config of [
    null, {}, 'test',
    // a test mode on a production profile, a production mode on a preview one
    { mode: 'test', profile: 'production', rewardedUnits: GOOGLE_TEST_UNITS.rewarded, bannerUnits: GOOGLE_TEST_UNITS.banner },
    { mode: 'production', profile: 'preview', rewardedUnits: CONFIRMED.rewarded, bannerUnits: CONFIRMED.banner },
    // real units in a test build, sample units in production, and kinds swapped
    { mode: 'test', profile: 'preview', rewardedUnits: CONFIRMED.rewarded, bannerUnits: CONFIRMED.banner },
    { mode: 'production', profile: 'production', rewardedUnits: GOOGLE_TEST_UNITS.rewarded, bannerUnits: GOOGLE_TEST_UNITS.banner },
    { mode: 'production', profile: 'production', rewardedUnits: CONFIRMED.banner, bannerUnits: CONFIRMED.rewarded },
    // platforms swapped
    { mode: 'production', profile: 'production', rewardedUnits: { android: CONFIRMED.rewarded.ios, ios: CONFIRMED.rewarded.android },
      bannerUnits: { android: CONFIRMED.banner.ios, ios: CONFIRMED.banner.android } },
  ]) {
    for (const kind of ['rewarded', 'banner'] as const) for (const platform of ['android', 'ios'] as const)
      assert.equal(adMobUnit(kind, platform, config, false), null, JSON.stringify(config));
  }
});

test('native SDK stays on the exact Kotlin 2.1 compatible version verified by the build', () => {
  // 16.5.0 selects Google Ads 25.4, whose Kotlin 2.3 metadata failed our EAS
  // :react-native-google-mobile-ads:compileReleaseKotlin step. No caret here.
  assert.equal(dependencies['react-native-google-mobile-ads'], '16.3.4');
  assert.equal(sdkPackage.version, '16.3.4');
  assert.equal(sdkPackage.sdkVersions.android.googleMobileAds, '25.0.0');
});

test('native app IDs, existing plugins, package and build profiles are preserved', () => {
  const plugin = app.plugins.find((p: unknown[]) => p[0] === 'react-native-google-mobile-ads')[1];
  assert.equal(plugin.androidAppId, 'ca-app-pub-7899930948413451~9002185139');
  assert.equal(plugin.iosAppId, 'ca-app-pub-7899930948413451~7288069200');
  assert.equal(plugin.delayAppMeasurementInit, true);
  assert.equal(plugin.userTrackingUsageDescription === undefined, true, 'no ATT prompt: ads are requested non-personalized');
  assert.equal(app.android.package, 'com.nanghwa.tradingclass');
  assert.equal(app.ios.bundleIdentifier, 'com.leagueoftrading');
  for (const name of ['expo-image-picker', 'expo-notifications']) assert.equal(app.plugins.some((p: unknown[]) => p[0] === name), true);
  assert.equal(eas.build.preview.android.buildType, 'apk');
  for (const profile of ['development', 'preview', 'production']) {
    assert.equal(eas.build[profile].environment, profile);
    assert.equal(eas.build[profile].env.ADMOB_BUILD_PROFILE, profile);
  }
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  assert.match(manifest, /APPLICATION_ID" android:value="ca-app-pub-7899930948413451~9002185139"/);
  assert.match(manifest, /DELAY_APP_MEASUREMENT_INIT" android:value="true"/);
  for (const permission of ['com.google.android.gms.permission.AD_ID', 'android.permission.ACCESS_ADSERVICES_AD_ID',
    'android.permission.ACCESS_ADSERVICES_ATTRIBUTION', 'android.permission.ACCESS_ADSERVICES_TOPICS']) {
    assert.equal(app.android.blockedPermissions.includes(permission), true);
    assert.equal(manifest.includes(`android:name="${permission}" tools:node="remove"`), true);
  }
});

test('committed Android native sources use the Expo application identifier', () => {
  const packageName = app.android.package;
  const gradle = readFileSync('android/app/build.gradle', 'utf8');
  assert.equal(gradle.includes(`namespace "${packageName}"`), true);
  assert.equal(gradle.includes(`applicationId "${packageName}"`), true);
  const sourceDir = `android/app/src/main/java/${packageName.replaceAll('.', '/')}`;
  for (const name of ['MainApplication', 'MainActivity']) {
    const source = readFileSync(`${sourceDir}/${name}.kt`, 'utf8');
    assert.equal(source.startsWith(`package ${packageName}\n`), true);
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
    assert.equal(manifest.includes(`android:name=".${name}"`), true);
  }
});
