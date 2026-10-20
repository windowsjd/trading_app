import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { GOOGLE_TEST_REWARDED_UNITS } from './rewardedTestConfig.ts';
const require = createRequire(import.meta.url);
const { interactionHarness } = require('../../../test/interactionTestHarness.cjs');

function nativeHarness() {
  const h = { imports: 0, init: 0, requests: [] as Array<{ unit: string; options: unknown }>, ads: [] as any[],
    consent: true, initError: false, required: false };
  const module = {
    default: () => ({ setRequestConfiguration: () => Promise.resolve(), initialize: () => {
      h.init++; return h.initError ? Promise.reject(new Error('init failed')) : Promise.resolve([]);
    } }),
    AdsConsent: {
      gatherConsent: () => Promise.resolve({ canRequestAds: h.consent, privacyOptionsRequirementStatus: h.required ? 'REQUIRED' : 'NOT_REQUIRED' }),
      showPrivacyOptionsForm: () => Promise.resolve(),
    },
    AdsConsentPrivacyOptionsRequirementStatus: { REQUIRED: 'REQUIRED' },
    TestIds: { REWARDED: GOOGLE_TEST_REWARDED_UNITS.android },
    AdEventType: { OPENED: 'opened', CLOSED: 'closed', ERROR: 'error' },
    RewardedAdEventType: { LOADED: 'loaded', EARNED_REWARD: 'earned' },
    RewardedAd: { createForAdRequest: (unit: string, options: unknown) => {
      h.requests.push({ unit, options });
      const ad = { listener: undefined as any, shows: 0, unsubscribes: 0, cleanups: 0, rejectShow: false,
        addAdEventsListener(listener: unknown) { this.listener = listener; return () => { this.unsubscribes++; }; },
        removeAllListeners() { this.cleanups++; }, load() {},
        show() { this.shows++; return this.rejectShow ? Promise.reject(new Error('failed to present')) : Promise.resolve(); },
        emit(type: string) { this.listener?.({ type }); },
      };
      h.ads.push(ad); return ad;
    } },
    __esModule: true,
  };
  const constants = { executionEnvironment: 'standalone', expoConfig: { extra: { adMob: {
    mode: 'test', profile: 'preview', rewardedUnits: GOOGLE_TEST_REWARDED_UNITS,
  } } } };
  const runtime = interactionHarness('android').load('src/features/adRewards/rewardedTestSdk.native.ts', {
    'expo-constants': { default: constants, ExecutionEnvironment: { StoreClient: 'storeClient' }, __esModule: true },
    'react-native-google-mobile-ads': module,
  });
  return { h, runtime, constants };
}

test('native adapter gates consent, initializes once and requests only NPA official test units', async () => {
  const { h, runtime } = nativeHarness();
  const sdk = await runtime.loadRewardedTestSdk();
  h.consent = false;
  await assert.rejects(sdk.prepare(), /consent/); assert.equal(h.init, 0);
  h.consent = true;
  await sdk.prepare(); await sdk.prepare(); assert.equal(h.init, 1);
  const ad = sdk.create(GOOGLE_TEST_REWARDED_UNITS.android);
  assert.deepEqual(h.requests, [{ unit: GOOGLE_TEST_REWARDED_UNITS.android, options: { requestNonPersonalizedAdsOnly: true } }]);
  assert.throws(() => sdk.create('ca-app-pub-7899930948413451/3165650506'), /official test unit/);
  ad.dispose();
});

test('a failed shared initialization can be retried by a later manual attempt', async () => {
  const { h, runtime } = nativeHarness(); const sdk = await runtime.loadRewardedTestSdk();
  h.initError = true; await assert.rejects(sdk.prepare(), /init failed/);
  h.initError = false; await sdk.prepare(); assert.equal(h.init, 2);
});

test('a disposed visible ad retains only terminal cleanup and prevents another screen from displaying over it', async () => {
  const { h, runtime } = nativeHarness(); const sdk = await runtime.loadRewardedTestSdk();
  const events: string[] = [];
  const first = sdk.create(GOOGLE_TEST_REWARDED_UNITS.android);
  first.listen((event: string) => events.push(event)); await first.show(); first.dispose();
  assert.equal(h.ads[0].unsubscribes, 0, 'terminal native cleanup must survive unmount while visible');
  const next = sdk.create(GOOGLE_TEST_REWARDED_UNITS.android);
  await assert.rejects(next.show(), /another ad/); assert.equal(h.ads[1].shows, 0);
  h.ads[0].emit('earned'); assert.deepEqual(events, [], 'old screen receives no reward event');
  h.ads[0].emit('closed'); assert.equal(h.ads[0].unsubscribes > 0, true);
  await next.show(); assert.equal(h.ads[1].shows, 1);
  h.ads[1].emit('closed'); next.dispose();
});

test('native display rejection releases the display lock and normal disposal unsubscribes', async () => {
  const { h, runtime } = nativeHarness(); const sdk = await runtime.loadRewardedTestSdk();
  const first = sdk.create(GOOGLE_TEST_REWARDED_UNITS.android); h.ads[0].rejectShow = true;
  await assert.rejects(first.show(), /failed to present/); first.dispose();
  assert.equal(h.ads[0].unsubscribes > 0, true);
  const next = sdk.create(GOOGLE_TEST_REWARDED_UNITS.android); await next.show(); h.ads[1].emit('closed'); next.dispose();
});

test('production and Expo Go fail before native SDK actions', async () => {
  const { runtime, constants, h } = nativeHarness();
  constants.expoConfig.extra.adMob.profile = 'production';
  assert.equal(runtime.getRewardedTestUnit(), null); await assert.rejects(runtime.loadRewardedTestSdk(), /disabled/);
  constants.expoConfig.extra.adMob.profile = 'preview'; constants.executionEnvironment = 'storeClient';
  assert.equal(runtime.getRewardedTestUnit(), null); await assert.rejects(runtime.loadRewardedTestSdk(), /disabled/);
  assert.equal(h.init, 0); assert.deepEqual(h.requests, []);
});
