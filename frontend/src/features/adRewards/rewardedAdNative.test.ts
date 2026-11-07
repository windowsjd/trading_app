import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');

/**
 * The AdMob rewarded provider (rewardedAd.native.ts) over a fake SDK module:
 * the session's SSV options on a fresh ad, shown as soon as it loads, and
 * every listener removed when the attempt ends. Its `earned` is not evidence;
 * the server decides on Google's callback.
 */
const SAMPLE_REWARDED = 'ca-app-pub-3940256099942544/5224354917';
const SSV = { userId: 'ssv-user-1', customData: 'session-1' };
const tick = () => new Promise((done) => setImmediate(done));

function setup({ readiness = { canRequestAds: true, privacyOptionsRequired: false } as unknown, unit = SAMPLE_REWARDED as string | null, platform = 'android' } = {}) {
  const h = { created: [] as Array<{ unitId: string; options: any }>, ads: [] as any[], readinessReads: 0 };
  const fakeAd = () => ({
    listener: null as null | ((event: { type: string }) => void),
    loads: 0, shows: 0, unsubscribed: false, removed: false, showFailure: null as Error | null,
    addAdEventsListener(listener: (event: { type: string }) => void) { this.listener = listener; return () => { this.unsubscribed = true; }; },
    removeAllListeners() { this.removed = true; },
    load() { this.loads += 1; },
    show() { this.shows += 1; return this.showFailure ? Promise.reject(this.showFailure) : Promise.resolve(); },
    emit(type: string) { this.listener?.({ type }); },
  });
  const ads = {
    RewardedAd: { createForAdRequest(unitId: string, options: unknown) { const ad = fakeAd(); h.created.push({ unitId, options }); h.ads.push(ad); return ad; } },
    RewardedAdEventType: { LOADED: 'rewarded_loaded', EARNED_REWARD: 'rewarded_earned_reward' },
    AdEventType: { OPENED: 'opened', CLOSED: 'closed', ERROR: 'error' },
  };
  const module = load(resolve('src/features/adRewards/rewardedAd.native.ts'), {
    'react-native': { Platform: { OS: platform } },
    '../ads/adsRuntime': {
      getAdUnit: (kind: string) => (kind === 'rewarded' ? unit : 'ca-app-pub-3940256099942544/9214589741'),
      ensureAdsReady: () => { h.readinessReads += 1; return readiness instanceof Error ? Promise.reject(readiness) : Promise.resolve(readiness); },
      loadAdsModule: () => Promise.resolve(ads),
    },
  });
  return { h, provider: module.getRewardedAdProvider() };
}

describe('AdMob rewarded provider', () => {
  it('none without this build\'s rewarded unit or on another platform', () => {
    assert.equal(setup({ unit: null }).provider === null, true);
    assert.equal(setup({ platform: 'web' }).provider === null, true);
    const { provider } = setup();
    assert.deepEqual([provider.key, provider.platform], ['admob', 'android']);
  });

  it('a fresh ad with the session\'s SSV options (non-personalized), shown on load; earned only after the reward and the close', async () => {
    const { h, provider } = setup();
    const phases: string[] = [];
    const outcome = provider.show({ ssv: SSV, onPhase: (phase: string) => phases.push(phase) });
    await tick();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].unitId, SAMPLE_REWARDED);
    assert.deepEqual(h.created[0].options, { requestNonPersonalizedAdsOnly: true, serverSideVerificationOptions: SSV });
    const ad = h.ads[0];
    assert.equal(ad.loads, 1);
    assert.equal(ad.shows, 0, 'not shown before it loaded');
    ad.emit('rewarded_loaded');
    assert.equal(ad.shows, 1);
    ad.emit('opened');
    ad.emit('rewarded_earned_reward');
    ad.emit('closed');
    assert.deepEqual(await outcome, { status: 'earned' });
    assert.deepEqual(phases, ['loading', 'showing', 'earned']);
    assert.deepEqual([ad.unsubscribed, ad.removed], [true, true], 'every listener removed');
  });

  it('closed before the reward is dismissed; an error before or after opening is a load or show failure, after the reward the server decides', async () => {
    for (const [events, expected] of [
      [['rewarded_loaded', 'opened', 'closed'], { status: 'dismissed' }],
      [['error'], { status: 'unavailable', reason: 'load' }],
      [['rewarded_loaded', 'opened', 'error'], { status: 'unavailable', reason: 'show' }],
      // An error after the reward: the server is asked (Google may have called it).
      [['rewarded_loaded', 'opened', 'rewarded_earned_reward', 'error'], { status: 'earned' }],
    ] as const) {
      const { h, provider } = setup();
      const outcome = provider.show({ ssv: SSV });
      await tick();
      for (const event of events) h.ads[0].emit(event);
      assert.deepEqual(await outcome, expected, events.join('>'));
      assert.equal(h.ads[0].removed, true);
    }
    // show() itself rejecting is a show failure too.
    const { h, provider } = setup();
    const outcome = provider.show({ ssv: SSV });
    await tick();
    h.ads[0].showFailure = new Error('not ready');
    h.ads[0].emit('rewarded_loaded');
    assert.deepEqual(await outcome, { status: 'unavailable', reason: 'show' });
  });

  it('consent that forbids ad requests, or an SDK that cannot start, shows nothing', async () => {
    const consent = setup({ readiness: { canRequestAds: false, privacyOptionsRequired: true } });
    assert.deepEqual(await consent.provider.show({ ssv: SSV }), { status: 'unavailable', reason: 'consent' });
    assert.equal(consent.h.created.length, 0);
    const broken = setup({ readiness: new Error('UMP failed') });
    assert.deepEqual(await broken.provider.show({ ssv: SSV }), { status: 'unavailable', reason: 'load' });
    assert.equal(broken.h.created.length, 0);
  });

  it('one rewarded ad at a time: a second show while one is up is busy and creates nothing', async () => {
    const { h, provider } = setup();
    const first = provider.show({ ssv: SSV });
    assert.deepEqual(await provider.show({ ssv: SSV }), { status: 'unavailable', reason: 'busy' });
    await tick();
    assert.equal(h.created.length, 1);
    h.ads[0].emit('rewarded_loaded');
    h.ads[0].emit('closed');
    assert.deepEqual(await first, { status: 'dismissed' });
    // Released: the next attempt gets its own fresh ad.
    const next = provider.show({ ssv: SSV });
    await tick();
    assert.equal(h.created.length, 2);
    h.ads[1].emit('error');
    await next;
  });

  it('no ad within 45 s is a load failure (and its listeners go too)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { h, provider } = setup();
    const outcome = provider.show({ ssv: SSV });
    await tick(); await tick();
    t.mock.timers.tick(45_000);
    assert.deepEqual(await outcome, { status: 'unavailable', reason: 'load' });
    assert.equal(h.ads[0].removed, true);
  });
});
