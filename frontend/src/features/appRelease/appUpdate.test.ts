import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLAY_UPDATE_AVAILABLE, RELEASE_RECHECK_MS, RELEASE_RETRY_MS, compareVersions, decideAppUpdate, decidePlayUpdate, parseAppReleaseManifest,
  shouldRecheckRelease, type InstalledApp,
} from './appUpdate.ts';

const manifest = parseAppReleaseManifest({
  android: { packageName: 'com.nanghwa.tradingclass', latestVersion: '1.0.2', notes: '주문 화면이 더 빨라졌어요.' },
  ios: { bundleId: 'com.leagueoftrading', appStoreId: '1234567890', latestVersion: '1.0.2', notes: null },
});
const android: InstalledApp = { platform: 'android', applicationId: 'com.nanghwa.tradingclass', version: '1.0.1', buildNumber: 41, production: true, appStoreSigned: false };
const ios: InstalledApp = { platform: 'ios', applicationId: 'com.leagueoftrading', version: '1.0.1', buildNumber: 7, production: true, appStoreSigned: true };
/** Google Play's answer: UPDATE_AVAILABLE with the new version code. */
const playOffers = { updateAvailability: PLAY_UPDATE_AVAILABLE, availableVersionCode: 42 };

describe('앱 업데이트 안내 rules', () => {
  it('versions compare numerically, part by part; anything malformed compares as unknown', () => {
    assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
    assert.equal(compareVersions('1.0.1', '1.0.1'), 0);
    assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
    assert.equal(compareVersions('1.04', '1.03'), 1, 'two-part store versions compare among themselves');
    // Written differently: not comparable (the live App Store "1.03" against app.json's "1.0.3").
    assert.equal(compareVersions('1.03', '1.0.3'), null);
    assert.equal(compareVersions('1.0', '1.0.0'), null);
    for (const bad of ['', '1.0.1-beta', 'v1.0.1', '1..1', '1.0.0.0.1'])
      assert.equal(compareVersions(bad, '1.0.0'), null, bad);
  });

  it('a production Android build hears of an update when Google Play offers one, without a guessed version name', () => {
    assert.equal(PLAY_UPDATE_AVAILABLE, 2);
    assert.deepEqual(decidePlayUpdate(playOffers, android), {
      key: 'android:play:42', store: 'Google Play', currentVersion: '1.0.1', latestVersion: null, notes: null,
      storeUrl: 'market://details?id=com.nanghwa.tradingclass',
      webUrl: 'https://play.google.com/store/apps/details?id=com.nanghwa.tradingclass',
    });
    // An unreadable installed build number does not block Play's own answer.
    assert.equal(decidePlayUpdate(playOffers, { ...android, buildNumber: null })?.key, 'android:play:42');
    // The server's manifest (kept for older app builds) is not consulted on Android any more.
    assert.equal(decideAppUpdate(manifest, android), null);
  });

  it('no Android notice unless Play says available with a higher version code, on a production store build', () => {
    const cases: Array<[string, unknown, InstalledApp]> = [
      ['not available (already current, rollout not reaching this device)', { updateAvailability: 1, availableVersionCode: 0 }, android],
      ['unknown', { updateAvailability: 0, availableVersionCode: 42 }, android],
      ['an in-app update already running', { updateAvailability: 3, availableVersionCode: 42 }, android],
      ['no version code', { updateAvailability: 2 }, android],
      ['malformed version code', { updateAvailability: 2, availableVersionCode: 42.5 }, android],
      ['not newer than the installed build', { updateAvailability: 2, availableVersionCode: 41 }, android],
      ['nothing read', null, android],
      ['development / preview / Metro build', playOffers, { ...android, production: false }],
      ['iOS', playOffers, ios],
      ['web', playOffers, { ...android, platform: 'web' }],
      ['version unreadable', playOffers, { ...android, version: null }],
      ['app id unreadable', playOffers, { ...android, applicationId: null }],
    ];
    for (const [why, info, installed] of cases) assert.equal(decidePlayUpdate(info, installed), null, why);
  });

  it('an App Store-signed iOS build opens the App Store page of the listed id', () => {
    const notice = decideAppUpdate(manifest, ios);
    assert.equal(notice?.storeUrl, 'itms-apps://apps.apple.com/app/id1234567890');
    assert.equal(notice?.webUrl, 'https://apps.apple.com/app/id1234567890');
    assert.equal(notice?.store, 'App Store');
  });

  it('no notice for the same or an older store version, another app id, or a build that is not from the store', () => {
    const cases: Array<[string, InstalledApp]> = [
      ['already current', { ...ios, version: '1.0.2' }],
      ['newer than the store (TestFlight / in review)', { ...ios, version: '1.1.0' }],
      ['development / preview / Metro build', { ...ios, production: false }],
      ['iOS simulator, development, ad-hoc or enterprise signing', { ...ios, appStoreSigned: false }],
      ['iOS another bundle', { ...ios, applicationId: 'com.example.other' }],
      ['web', { ...ios, platform: 'web' }],
      ['version unreadable', { ...ios, version: null }],
      ['version malformed', { ...ios, version: '1.0.1 (12)' }],
      ['app id unreadable', { ...ios, applicationId: null }],
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
    assert.equal(decideAppUpdate(bad, ios), null);
    // The App Store's two-part version: a notice only against an install written the same way.
    const twoPart = parseAppReleaseManifest({ ios: { bundleId: 'com.leagueoftrading', appStoreId: '6824899937', latestVersion: '1.03' } });
    assert.equal(twoPart.ios?.latestVersion, '1.03');
    assert.equal(decideAppUpdate(twoPart, { ...ios, version: '1.0.3' }), null, 'never nag a 1.0.3 install about "1.03"');
    assert.equal(decideAppUpdate(twoPart, { ...ios, version: '1.03' }), null);
    assert.equal(decideAppUpdate(twoPart, { ...ios, version: '1.02' })?.latestVersion, '1.03');
    // iOS needs the App Store id: without it there is no link to offer.
    assert.equal(decideAppUpdate(parseAppReleaseManifest({ ios: { bundleId: 'com.leagueoftrading', latestVersion: '1.0.2' } }), ios), null);
    // Notes are optional and short; too long is dropped, the notice stays.
    const long = parseAppReleaseManifest({ ios: { bundleId: 'com.leagueoftrading', appStoreId: '1234567890', latestVersion: '1.0.2', notes: 'x'.repeat(301) } });
    assert.equal(decideAppUpdate(long, ios)?.notes, null);
    assert.equal(decideAppUpdate(long, ios)?.latestVersion, '1.0.2');
  });

  it('back in the foreground: read again only after 30 minutes, or 5 minutes after a failure; never during a read', () => {
    const now = 10_000_000;
    const read = (overrides: Partial<Parameters<typeof shouldRecheckRelease>[0]>) =>
      shouldRecheckRelease({ now, dataUpdatedAt: 0, errorUpdatedAt: 0, failed: false, fetching: false, ...overrides });
    assert.equal(RELEASE_RECHECK_MS, 30 * 60_000);
    assert.equal(RELEASE_RETRY_MS, 5 * 60_000);
    assert.equal(read({}), true, 'never read yet');
    assert.equal(read({ dataUpdatedAt: now - 60_000 }), false, 'read a minute ago: switching apps does not ask again');
    assert.equal(read({ dataUpdatedAt: now - RELEASE_RECHECK_MS + 1 }), false);
    assert.equal(read({ dataUpdatedAt: now - RELEASE_RECHECK_MS }), true, 'a release may have been published meanwhile');
    assert.equal(read({ failed: true, errorUpdatedAt: now - 60_000 }), false, 'a recent failure is not retried at once');
    assert.equal(read({ failed: true, errorUpdatedAt: now - RELEASE_RETRY_MS }), true);
    assert.equal(read({ failed: true, errorUpdatedAt: now - RELEASE_RETRY_MS, dataUpdatedAt: now - 1 }), true, 'a failed re-read is retried on its own clock');
    assert.equal(read({ fetching: true }), false);
  });
});
