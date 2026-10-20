import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { GOOGLE_TEST_REWARDED_UNITS } from './rewardedTestConfig.ts';
const require = createRequire(import.meta.url);
const { interactionHarness } = require('../../../test/interactionTestHarness.cjs');

function nativeHarness(importError?: unknown) {
  const h = { imports: 0, init: 0, requests: [] as Array<{ unit: string; options: unknown }>, ads: [] as any[],
    consent: true, initError: false, required: false,
    consentError: undefined as unknown, configError: undefined as unknown, initFailure: undefined as unknown, privacyError: undefined as unknown };
  const module = {
    default: () => ({ setRequestConfiguration: () => { if (h.configError) throw h.configError; return Promise.resolve(); }, initialize: () => {
      h.init++; return h.initFailure ? Promise.reject(h.initFailure) : h.initError ? Promise.reject(new Error('init failed')) : Promise.resolve([]);
    } }),
    AdsConsent: {
      gatherConsent: () => h.consentError ? Promise.reject(h.consentError) : Promise.resolve({ canRequestAds: h.consent, privacyOptionsRequirementStatus: h.required ? 'REQUIRED' : 'NOT_REQUIRED' }),
      showPrivacyOptionsForm: () => h.privacyError ? Promise.reject(h.privacyError) : Promise.resolve(),
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
        emit(type: string, payload?: unknown) { this.listener?.({ type, payload }); },
      };
      h.ads.push(ad); return ad;
    } },
    __esModule: true,
  };
  if (importError) Object.defineProperty(module, '__esModule', { get() { throw importError; } });
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
  await assert.rejects(sdk.prepare(), (error: any) => {
    assert.equal(error.diagnostic.stage, 'ump-eligibility');
    assert.equal(error.diagnostic.code, 'DIAG_AD_REQUEST_NOT_ALLOWED');
    assert.equal(error.diagnostic.codeSource, 'internal'); return true;
  }); assert.equal(h.init, 0);
  h.consent = true;
  await sdk.prepare(); await sdk.prepare(); assert.equal(h.init, 1);
  const ad = sdk.create(GOOGLE_TEST_REWARDED_UNITS.android);
  assert.deepEqual(h.requests, [{ unit: GOOGLE_TEST_REWARDED_UNITS.android, options: { requestNonPersonalizedAdsOnly: true } }]);
  assert.throws(() => sdk.create('ca-app-pub-7899930948413451/3165650506'), /official test unit/);
  ad.dispose();
});

test('a failed shared initialization can be retried by a later manual attempt', async () => {
  const { h, runtime } = nativeHarness(); const sdk = await runtime.loadRewardedTestSdk();
  h.initError = true; await assert.rejects(sdk.prepare(), (error: any) => {
    assert.equal(error.diagnostic.stage, 'mobile-ads-initialization'); return true;
  });
  h.initError = false; await sdk.prepare(); assert.equal(h.init, 2);
});

test('module import, UMP, configuration, initialization and privacy exceptions carry exact stages and only safe fields', async () => {
  const error = { code: 'consent-update-failed', message: 'Publisher misconfiguration: token=super-secret user@example.com', stack: 'private-stack' };
  const imported = nativeHarness(error);
  await assert.rejects(imported.runtime.loadRewardedTestSdk(), (failure: any) => {
    assert.equal(failure.diagnostic.stage, 'native-module');
    assert.equal(failure.diagnostic.code, error.code);
    assert.doesNotMatch(JSON.stringify(failure), /super-secret|user@example|private-stack/); return true;
  });
  for (const [field, stage] of [['consentError', 'ump-consent'], ['configError', 'request-configuration'], ['initFailure', 'mobile-ads-initialization'], ['privacyError', 'privacy-options']] as const) {
    const { h, runtime } = nativeHarness(); const sdk = await runtime.loadRewardedTestSdk();
    h[field] = error;
    await assert.rejects(field === 'privacyError' ? sdk.showPrivacyOptions() : sdk.prepare(), (failure: any) => {
      assert.equal(failure.diagnostic.stage, stage); assert.equal(failure.diagnostic.code, error.code);
      assert.match(failure.diagnostic.detail, /Publisher misconfiguration/);
      assert.doesNotMatch(JSON.stringify(failure), /super-secret|user@example|private-stack/); return true;
    });
    assert.equal(h.requests.length, 0);
    h[field] = undefined;
    await sdk.prepare(); assert.equal(h.init, field === 'initFailure' ? 2 : 1);
  }
});

test('native ERROR payload is forwarded for load/show diagnostics, not reward data', async () => {
  const { h, runtime } = nativeHarness(); const sdk = await runtime.loadRewardedTestSdk();
  const ad = sdk.create(GOOGLE_TEST_REWARDED_UNITS.android);
  const events: any[] = [];
  ad.listen((event: string, error: unknown) => events.push({ event, error }));
  h.ads[0].emit('earned', { amount: 100 });
  h.ads[0].emit('error', { code: 'network-error', message: 'Network error' });
  assert.deepEqual(events, [{ event: 'earned', error: undefined }, { event: 'error', error: { code: 'network-error', message: 'Network error' } }]);
  ad.dispose();
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
