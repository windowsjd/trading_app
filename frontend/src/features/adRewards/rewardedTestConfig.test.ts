import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GOOGLE_TEST_REWARDED_UNITS, rewardedTestUnit } from './rewardedTestConfig.ts';

const require = createRequire(import.meta.url);
const { adMobBuildConfig } = require('../../../config/admob.cjs');
const app = require('../../../app.json');
const eas = require('../../../eas.json');
const androidReal = 'ca-app-pub-7899930948413451/3165650506';
const iosReal = 'ca-app-pub-7899930948413451/8170740188';

test('development and preview force official platform test units even if the environment supplies real IDs', () => {
  for (const profile of ['development', 'preview']) {
    const config = adMobBuildConfig({ EAS_BUILD_PROFILE: profile, ADMOB_REWARDED_ANDROID_ID: androidReal, ADMOB_REWARDED_IOS_ID: iosReal });
    assert.deepEqual(config.rewardedUnits, GOOGLE_TEST_REWARDED_UNITS);
    for (const platform of ['android', 'ios'] as const) {
      assert.equal(rewardedTestUnit(platform, config, false), GOOGLE_TEST_REWARDED_UNITS[platform]);
      assert.equal(rewardedTestUnit(platform, config, true), null, 'Expo Go cannot load a native SDK');
    }
    assert.equal(rewardedTestUnit('web', config, false), null);
  }
});

test('production prepares the supplied real IDs but all ad execution remains disabled, including debug JS', () => {
  const config = adMobBuildConfig({ EAS_BUILD_PROFILE: 'production', ADMOB_REWARDED_ANDROID_ID: androidReal, ADMOB_REWARDED_IOS_ID: iosReal });
  assert.deepEqual(config, { mode: 'disabled', profile: 'production', rewardedUnits: { android: androidReal, ios: iosReal } });
  for (const platform of ['android', 'ios']) assert.equal(rewardedTestUnit(platform, config, false), null);
  for (const profile of [undefined, '', 'custom', 'Production']) {
    const unknown = adMobBuildConfig({ EAS_BUILD_PROFILE: profile });
    assert.equal(unknown.mode, 'disabled');
    assert.equal(rewardedTestUnit('android', unknown, false), null);
  }
});

test('runtime rejects mismatched platforms, real units and a test mode on a production profile', () => {
  assert.equal(adMobBuildConfig({ ADMOB_BUILD_PROFILE: 'preview', EAS_BUILD_PROFILE: 'production' }).mode, 'disabled');
  const localEas = adMobBuildConfig({ ADMOB_BUILD_PROFILE: 'preview', EAS_BUILD_PROFILE: {} });
  assert.equal(localEas.mode, 'test');
  assert.equal(localEas.profile, 'preview');
  for (const config of [null, {}, 'test', { mode: 'test', profile: 'production', rewardedUnits: GOOGLE_TEST_REWARDED_UNITS },
    { mode: 'test', profile: 'preview', rewardedUnits: { android: androidReal, ios: iosReal } }]) {
    assert.equal(rewardedTestUnit('android', config, false), null);
    assert.equal(rewardedTestUnit('ios', config, false), null);
  }
});

test('native app IDs, existing plugins, package and build profiles are preserved', () => {
  const plugin = app.plugins.find((p: unknown[]) => p[0] === 'react-native-google-mobile-ads')[1];
  assert.equal(plugin.androidAppId, 'ca-app-pub-7899930948413451~9002185139');
  assert.equal(plugin.iosAppId, 'ca-app-pub-7899930948413451~7288069200');
  assert.equal(plugin.delayAppMeasurementInit, true);
  assert.equal(plugin.userTrackingUsageDescription === undefined, true, 'test ads do not request ATT');
  assert.equal(app.android.package, 'com.leagueoftrading');
  assert.equal(app.ios.bundleIdentifier, 'com.leagueoftrading');
  for (const name of ['expo-image-picker', 'expo-notifications']) assert.equal(app.plugins.some((p: unknown[]) => p[0] === name), true);
  assert.equal(eas.build.preview.android.buildType, 'apk');
  assert.equal(eas.build.preview.environment, 'preview');
  assert.equal(eas.build.production.environment, 'production');
  assert.equal(eas.build.development.environment, 'development');
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  assert.match(manifest, /APPLICATION_ID" android:value="ca-app-pub-7899930948413451~9002185139"/);
  assert.match(manifest, /DELAY_APP_MEASUREMENT_INIT" android:value="true"/);
  assert.match(manifest, /com.google.android.gms.permission.AD_ID" tools:node="remove"/);
});
