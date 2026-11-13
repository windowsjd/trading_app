import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { compareVersions } from './appUpdate.ts';

/**
 * The installed version the update notice compares (expo-application's native
 * value) comes from the native projects: Android from android/app/build.gradle
 * (this project keeps its own android/ directory, so EAS never copies
 * app.json's "version" into it), iOS from app.json through prebuild. Until
 * 2026-11-11 Android stayed "1.0" while app.json moved to 1.0.2, so an Android
 * build could never report a newer version: a store version above 1.0 would
 * have kept asking every Android user to update, even on the newest build.
 */
describe('app version source', () => {
  const appJson = JSON.parse(readFileSync(resolve('app.json'), 'utf8')) as { version?: string; expo?: { version?: string } };
  const appVersion = appJson.expo?.version ?? appJson.version;
  const gradle = readFileSync(resolve('android/app/build.gradle'), 'utf8');
  const versionName = /^\s*versionName\s+"([^"]+)"/m.exec(gradle)?.[1];

  it('Android versionName equals app.json version, in the x.y.z form the release manifest uses', () => {
    assert.equal(typeof appVersion, 'string');
    assert.match(appVersion!, /^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
    assert.equal(versionName, appVersion, 'bump android/app/build.gradle versionName together with app.json version');
    assert.equal(compareVersions(versionName!, appVersion!), 0);
  });

  it('a single versionName, set in defaultConfig (no flavour or build type overrides it)', () => {
    assert.equal((gradle.match(/^\s*versionName\s/gm) ?? []).length, 1);
    assert.equal(/versionNameSuffix/.test(gradle), false);
  });
});

/**
 * 2026-11-13: the stores are asked directly — Android through the local
 * native module (modules/play-app-update, compiled only in a native build),
 * iOS through the server's App Store lookup for one bundle id. These pin the
 * names that must agree but that no unit test can execute.
 */
describe('store sources', () => {
  const read = (path: string) => readFileSync(resolve(path), 'utf8');
  const appJson = JSON.parse(read('app.json')) as { ios?: { bundleIdentifier?: string } };

  it('the server looks up exactly the iOS bundle id this app ships with', () => {
    const lookup = read('../backend/src/app-release/app-store-lookup.service.ts');
    assert.equal(/export const APP_STORE_BUNDLE_ID = '([^']+)';/.exec(lookup)?.[1], appJson.ios?.bundleIdentifier);
    assert.equal(/export const APP_STORE_COUNTRY = 'kr';/.test(lookup), true);
  });

  it('the Play module is autolinked for Android only, under the class and name the app asks for', () => {
    const config = JSON.parse(read('modules/play-app-update/expo-module.config.json')) as { platforms: string[]; android: { modules: string[] } };
    assert.deepEqual(config.platforms, ['android']);
    const kotlin = read('modules/play-app-update/android/src/main/java/expo/modules/playappupdate/PlayAppUpdateModule.kt');
    const pkg = /^package ([\w.]+)$/m.exec(kotlin)?.[1];
    const cls = /^class (\w+) : Module\(\)/m.exec(kotlin)?.[1];
    assert.deepEqual(config.android.modules, [`${pkg}.${cls}`]);
    const name = /Name\("(\w+)"\)/.exec(kotlin)?.[1];
    const js = read('src/features/appRelease/playUpdate.ts');
    assert.equal(/requireOptionalNativeModule<\w+>\('(\w+)'\)/.exec(js)?.[1], name);
    assert.equal(/AsyncFunction\("(\w+)"\)/.exec(kotlin)?.[1], 'getUpdateInfoAsync');
    assert.equal(js.includes('getUpdateInfoAsync()'), true);
    assert.match(read('modules/play-app-update/android/build.gradle'), /implementation 'com\.google\.android\.play:app-update:\d+\.\d+\.\d+'/);
    // The module only reads; it never starts Play's update flow.
    assert.equal(/startUpdateFlow|completeUpdate/.test(kotlin), false);
  });
});
