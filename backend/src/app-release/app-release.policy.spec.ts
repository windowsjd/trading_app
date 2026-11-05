import { readAppReleaseManifest } from './app-release.policy';

const android = {
  APP_RELEASE_ANDROID_PACKAGE: 'com.nanghwa.tradingclass',
  APP_RELEASE_ANDROID_LATEST_VERSION: '1.0.2',
};
const ios = {
  APP_RELEASE_IOS_BUNDLE_ID: 'com.leagueoftrading',
  APP_RELEASE_IOS_APP_STORE_ID: '1234567890',
  APP_RELEASE_IOS_LATEST_VERSION: '1.0.2',
};

describe('app release manifest', () => {
  it('lists nothing until an operator records a store release', () => {
    expect(readAppReleaseManifest({})).toEqual({ android: null, ios: null });
  });

  it('lists a platform only when every field it needs is present and well formed', () => {
    expect(
      readAppReleaseManifest({
        ...android,
        ...ios,
        APP_RELEASE_NOTES: ' 주문 설정 변경 ',
      }),
    ).toEqual({
      android: {
        packageName: 'com.nanghwa.tradingclass',
        latestVersion: '1.0.2',
        notes: '주문 설정 변경',
      },
      ios: {
        bundleId: 'com.leagueoftrading',
        appStoreId: '1234567890',
        latestVersion: '1.0.2',
        notes: '주문 설정 변경',
      },
    });
    for (const patch of [
      { APP_RELEASE_ANDROID_LATEST_VERSION: '1.0' },
      { APP_RELEASE_ANDROID_LATEST_VERSION: 'v1.0.2' },
      { APP_RELEASE_ANDROID_PACKAGE: 'Com.Example' },
      { APP_RELEASE_ANDROID_PACKAGE: '' },
    ])
      expect(
        readAppReleaseManifest({ ...android, ...patch }).android,
      ).toBeNull();
    for (const patch of [
      { APP_RELEASE_IOS_APP_STORE_ID: 'id1234567890' },
      { APP_RELEASE_IOS_APP_STORE_ID: '' },
      { APP_RELEASE_IOS_LATEST_VERSION: '1.0.2-beta' },
      { APP_RELEASE_IOS_BUNDLE_ID: 'nodots' },
    ])
      expect(readAppReleaseManifest({ ...ios, ...patch }).ios).toBeNull();
  });

  it('drops release notes longer than the notice shows', () => {
    expect(
      readAppReleaseManifest({ ...android, APP_RELEASE_NOTES: 'x'.repeat(301) })
        .android?.notes,
    ).toBeNull();
  });
});
