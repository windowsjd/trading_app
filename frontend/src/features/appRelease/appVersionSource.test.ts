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
