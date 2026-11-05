import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, decideAppUpdate, parseAppReleaseManifest, type InstalledApp } from './appUpdate.ts';

const manifest = parseAppReleaseManifest({
  android: { packageName: 'com.nanghwa.tradingclass', latestVersion: '1.0.2', notes: '주문 화면이 더 빨라졌어요.' },
  ios: { bundleId: 'com.leagueoftrading', appStoreId: '1234567890', latestVersion: '1.0.2', notes: null },
});
const android: InstalledApp = { platform: 'android', applicationId: 'com.nanghwa.tradingclass', version: '1.0.1', production: true, appStoreSigned: false };
const ios: InstalledApp = { platform: 'ios', applicationId: 'com.leagueoftrading', version: '1.0.1', production: true, appStoreSigned: true };

describe('앱 업데이트 안내 rules', () => {
  it('versions compare numerically, part by part; anything malformed compares as unknown', () => {
    assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
    assert.equal(compareVersions('1.0.1', '1.0.1'), 0);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
    for (const bad of ['', '1.0.1-beta', 'v1.0.1', '1..1', '1.0.0.0.1'])
      assert.equal(compareVersions(bad, '1.0.0'), null, bad);
  });

  it('a production Android build hears of a newer Google Play version, with the store app first and the web page next', () => {
    assert.deepEqual(decideAppUpdate(manifest, android), {
      key: 'android:1.0.2', store: 'Google Play', currentVersion: '1.0.1', latestVersion: '1.0.2', notes: '주문 화면이 더 빨라졌어요.',
      storeUrl: 'market://details?id=com.nanghwa.tradingclass',
      webUrl: 'https://play.google.com/store/apps/details?id=com.nanghwa.tradingclass',
    });
  });

  it('an App Store-signed iOS build opens the App Store page of the listed id', () => {
    const notice = decideAppUpdate(manifest, ios);
    assert.equal(notice?.storeUrl, 'itms-apps://apps.apple.com/app/id1234567890');
    assert.equal(notice?.webUrl, 'https://apps.apple.com/app/id1234567890');
    assert.equal(notice?.store, 'App Store');
  });

  it('no notice for the same or an older store version, another app id, or a build that is not from the store', () => {
    const cases: Array<[string, InstalledApp]> = [
      ['already current', { ...android, version: '1.0.2' }],
      ['newer than the store (internal track)', { ...android, version: '1.1.0' }],
      ['another package (a differently identified build)', { ...android, applicationId: 'com.nanghwa.tradingclass.dev' }],
      ['development / preview / Metro build', { ...android, production: false }],
      ['iOS simulator, development, ad-hoc or enterprise signing', { ...ios, appStoreSigned: false }],
      ['iOS another bundle', { ...ios, applicationId: 'com.example.other' }],
      ['web', { ...android, platform: 'web' }],
      ['version unreadable', { ...android, version: null }],
      ['version malformed', { ...android, version: '1.0.1 (12)' }],
      ['app id unreadable', { ...android, applicationId: null }],
    ];
    for (const [why, installed] of cases) assert.equal(decideAppUpdate(manifest, installed), null, why);
  });

  it('a platform the manifest does not list, or lists with any bad field, shows nothing', () => {
    assert.deepEqual(parseAppReleaseManifest(null), { android: null, ios: null });
    assert.deepEqual(parseAppReleaseManifest({ android: null, ios: null }), { android: null, ios: null });
    const bad = parseAppReleaseManifest({
      android: { packageName: 'com.nanghwa.tradingclass', latestVersion: 'latest' },
      ios: { bundleId: 'com.leagueoftrading', appStoreId: 'id12', latestVersion: '1.0.2' },
    });
    assert.deepEqual(bad, { android: null, ios: null });
    assert.equal(decideAppUpdate(bad, android), null);
    // iOS needs the App Store id: without it there is no link to offer.
    assert.equal(decideAppUpdate(parseAppReleaseManifest({ ios: { bundleId: 'com.leagueoftrading', latestVersion: '1.0.2' } }), ios), null);
    // Notes are optional and short; too long is dropped, the notice stays.
    const long = parseAppReleaseManifest({ android: { packageName: 'com.nanghwa.tradingclass', latestVersion: '1.0.2', notes: 'x'.repeat(301) } });
    assert.equal(decideAppUpdate(long, android)?.notes, null);
  });
});
