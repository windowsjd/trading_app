import { AppReleaseController } from './app-release.controller';
import { readLegacyAndroidRelease } from './app-release.policy';
import {
  APP_STORE_BUNDLE_ID,
  APP_STORE_CACHE_MS,
  APP_STORE_RETRY_MS,
  AppStoreLookupService,
  parseAppStoreLookup,
} from './app-store-lookup.service';

const android = {
  APP_RELEASE_ANDROID_PACKAGE: 'com.nanghwa.tradingclass',
  APP_RELEASE_ANDROID_LATEST_VERSION: '1.0.2',
};
/** Apple's lookup answer shape (trimmed): one result per bundle id. */
const lookup = (fields: Record<string, unknown> = {}) => ({
  resultCount: 1,
  results: [
    {
      kind: 'software',
      bundleId: APP_STORE_BUNDLE_ID,
      trackId: 6740123456,
      version: '1.0.3',
      ...fields,
    },
  ],
});

function lookupService(answers: Array<unknown>) {
  let clock = 1_000_000;
  const calls: string[] = [];
  const service = new AppStoreLookupService(
    (url) => {
      calls.push(url);
      const next = answers.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (next === 'http-500')
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(next) });
    },
    () => clock,
  );
  return {
    service,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('app release manifest', () => {
  it('Android (builds from before 2026-11-13 only): the operator-recorded Play version, every field well formed', () => {
    expect(readLegacyAndroidRelease({})).toBeNull();
    expect(
      readLegacyAndroidRelease({
        ...android,
        APP_RELEASE_NOTES: ' 주문 설정 변경 ',
      }),
    ).toEqual({
      packageName: 'com.nanghwa.tradingclass',
      latestVersion: '1.0.2',
      notes: '주문 설정 변경',
    });
    for (const patch of [
      { APP_RELEASE_ANDROID_LATEST_VERSION: '1.0' },
      { APP_RELEASE_ANDROID_LATEST_VERSION: 'v1.0.2' },
      { APP_RELEASE_ANDROID_PACKAGE: 'Com.Example' },
      { APP_RELEASE_ANDROID_PACKAGE: '' },
    ])
      expect(readLegacyAndroidRelease({ ...android, ...patch })).toBeNull();
    expect(
      readLegacyAndroidRelease({
        ...android,
        APP_RELEASE_NOTES: 'x'.repeat(301),
      })?.notes,
    ).toBeNull();
  });

  it('iOS: only the App Store’s public version and id of exactly this bundle', () => {
    expect(parseAppStoreLookup(lookup())).toEqual({
      bundleId: 'com.leagueoftrading',
      appStoreId: '6740123456',
      latestVersion: '1.0.3',
      notes: null,
    });
    // The live listing is written "1.03" (2026-11-12): passed through as is; the app compares only like with like.
    expect(
      parseAppStoreLookup(lookup({ version: '1.03' }))?.latestVersion,
    ).toBe('1.03');
    // Not on the store (yet), another app, or anything malformed: nothing.
    for (const body of [
      { resultCount: 0, results: [] },
      lookup({ bundleId: 'com.leagueoftrading.dev' }),
      lookup({ version: '1.0.3 beta' }),
      lookup({ version: 103 }),
      lookup({ trackId: '6740123456' }),
      lookup({ trackId: 12 }),
      lookup({ trackId: 6740123456.5 }),
      { results: 'none' },
      null,
      'html',
    ])
      expect(parseAppStoreLookup(body)).toBeNull();
  });

  it('asks Apple’s lookup for this bundle in the Korean store, once per cache period', async () => {
    const h = lookupService([lookup(), lookup({ version: '1.0.4' })]);
    expect((await h.service.current())?.latestVersion).toBe('1.0.3');
    expect(h.calls).toEqual([
      'https://itunes.apple.com/lookup?bundleId=com.leagueoftrading&country=kr',
    ]);
    h.advance(APP_STORE_CACHE_MS - 1);
    expect((await h.service.current())?.latestVersion).toBe('1.0.3');
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    expect((await h.service.current())?.latestVersion).toBe('1.0.4');
    expect(h.calls).toHaveLength(2);
  });

  it('concurrent requests share one read; a failure is null and retried only after the retry period', async () => {
    const h = lookupService([new Error('ETIMEDOUT'), 'http-500', lookup()]);
    const [first, second] = await Promise.all([
      h.service.current(),
      h.service.current(),
    ]);
    expect([first, second]).toEqual([null, null]);
    expect(h.calls).toHaveLength(1);
    h.advance(APP_STORE_RETRY_MS - 1);
    expect(await h.service.current()).toBeNull();
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    expect(await h.service.current()).toBeNull(); // HTTP 500
    expect(h.calls).toHaveLength(2);
    h.advance(APP_STORE_RETRY_MS);
    expect((await h.service.current())?.appStoreId).toBe('6740123456');
  });

  it('serves both entries from one public read-only route', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, android);
    try {
      const h = lookupService([lookup()]);
      await expect(new AppReleaseController(h.service).get()).resolves.toEqual({
        success: true,
        data: {
          android: {
            packageName: 'com.nanghwa.tradingclass',
            latestVersion: '1.0.2',
            notes: null,
          },
          ios: {
            bundleId: 'com.leagueoftrading',
            appStoreId: '6740123456',
            latestVersion: '1.0.3',
            notes: null,
          },
        },
      });
      // Operator iOS variables are retired: Apple's answer wins.
      process.env.APP_RELEASE_IOS_LATEST_VERSION = '9.9.9';
      expect(
        (await new AppReleaseController(h.service).get()).data.ios
          ?.latestVersion,
      ).toBe('1.0.3');
    } finally {
      process.env = previous;
    }
  });
});
