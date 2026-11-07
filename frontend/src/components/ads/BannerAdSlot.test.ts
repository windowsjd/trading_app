import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The banner slot (BannerAdSlot.native.tsx) over a fake SDK module: this
 * build's BANNER unit only, after consent, nothing drawn until an ad arrives,
 * a failed load leaves the screen as it was (one fresh try after the app
 * returns to the foreground), and unmounting removes its subscription.
 * Small values only in assertions.
 */
const BANNER = 'ca-app-pub-3940256099942544/9214589741';
const REWARDED = 'ca-app-pub-3940256099942544/5224354917';
const settle = async () => { await act(async () => { await new Promise((done) => setImmediate(done)); }); };

function setup({ platform = 'android', readiness = { canRequestAds: true, privacyOptionsRequired: false } as unknown, unit = BANNER as string | null } = {}) {
  const h = { listeners: [] as Array<(state: string) => void>, removed: 0, readinessReads: 0, banners: [] as any[], loads: 0, mounts: 0 };
  class BannerAd extends React.Component<any> {
    componentDidMount() { h.mounts += 1; h.banners.push(this); }
    load() { h.loads += 1; }
    render() { return React.createElement('NativeBanner', { unitId: this.props.unitId, size: this.props.size }); }
  }
  const ads = { BannerAd, BannerAdSize: { ANCHORED_ADAPTIVE_BANNER: 'ANCHORED_ADAPTIVE_BANNER' } };
  const appState = { currentState: 'active', addEventListener: (_type: string, listener: (state: string) => void) => {
    h.listeners.push(listener);
    return { remove: () => { h.removed += 1; h.listeners.splice(h.listeners.indexOf(listener), 1); } };
  } };
  const Slot = load(resolve('src/components/ads/BannerAdSlot.native.tsx'), {
    'react-native': { AppState: appState, Platform: { OS: platform } },
    '../../theme/native': { View: 'View' },
    '../../theme/tokens': { semantic: { border: 'border', surface: 'surface' } },
    '../../features/ads/adsRuntime': {
      getAdUnit: (kind: string) => (kind === 'banner' ? unit : REWARDED),
      ensureAdsReady: () => { h.readinessReads += 1; return Promise.resolve(readiness); },
      loadAdsModule: () => Promise.resolve(ads),
    },
  }).default;
  let renderer: any;
  const mount = async () => { await act(async () => { renderer = create(React.createElement(Slot, { testID: 'home-banner-ad' })); }); await settle(); };
  const banner = () => renderer.root.findAll((node: any) => node.type === BannerAd)[0];
  const slot = () => renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'home-banner-ad')[0];
  const foreground = async () => { await act(async () => { for (const listener of [...h.listeners]) { listener('background'); } }); await act(async () => { for (const listener of [...h.listeners]) { listener('active'); } }); await settle(); };
  return { h, mount, banner, slot, foreground, unmount: () => act(() => renderer.unmount()), json: () => renderer.toJSON() };
}

describe('banner ad slot', () => {
  it('the BANNER unit as an anchored adaptive, non-personalized banner, drawn only once an ad has loaded', async () => {
    const s = setup();
    await s.mount();
    const banner = s.banner();
    assert.equal(banner.props.unitId, BANNER, 'never the rewarded unit');
    assert.equal(banner.props.size, 'ANCHORED_ADAPTIVE_BANNER');
    assert.deepEqual(banner.props.requestOptions, { requestNonPersonalizedAdsOnly: true });
    // Loading: the slot takes no space and draws no line.
    assert.deepEqual([s.slot().props.style.height, s.slot().props.style.borderTopWidth], [0, undefined]);
    await act(async () => banner.props.onAdLoaded({ width: 360, height: 56 }));
    assert.deepEqual([s.slot().props.style.height, s.slot().props.style.borderTopWidth], [undefined, 1]);
    assert.equal(s.h.mounts, 1, 'one banner per slot');
    s.unmount();
    assert.equal(s.h.removed, 1, 'its foreground subscription goes with it');
  });

  it('no unit for this build, or consent that forbids requests: nothing, and the screen is unaffected', async () => {
    const none = setup({ unit: null });
    await none.mount();
    assert.equal(none.json() === null, true);
    assert.equal(none.h.readinessReads, 0, 'not even the consent is asked');
    const consent = setup({ readiness: { canRequestAds: false, privacyOptionsRequired: true } });
    await consent.mount();
    assert.equal(consent.json() === null, true);
  });

  it('a failed load leaves nothing behind and gets ONE fresh try only after the app comes back to the foreground', async () => {
    const s = setup();
    await s.mount();
    await act(async () => s.banner().props.onAdFailedToLoad(new Error('no fill')));
    assert.equal(s.json() === null, true);
    assert.equal(s.h.mounts, 1, 'no retry by itself');
    await s.foreground();
    assert.equal(s.banner() !== undefined, true);
    assert.equal(s.h.mounts, 2, 'a new banner after the foreground transition');
    assert.equal(s.h.loads, 0);
  });

  it('iOS reloads a shown banner when the app returns to the foreground; Android leaves it to the SDK', async () => {
    const ios = setup({ platform: 'ios' });
    await ios.mount();
    await act(async () => ios.banner().props.onAdLoaded({ width: 390, height: 60 }));
    await ios.foreground();
    assert.deepEqual([ios.h.loads, ios.h.mounts], [1, 1]);
    const android = setup({ platform: 'android' });
    await android.mount();
    await act(async () => android.banner().props.onAdLoaded({ width: 360, height: 56 }));
    await android.foreground();
    assert.deepEqual([android.h.loads, android.h.mounts], [0, 1]);
  });

  it('a return through "inactive" counts; an "inactive" that never left the foreground does not', async () => {
    const ios = setup({ platform: 'ios' });
    await ios.mount();
    await act(async () => ios.banner().props.onAdLoaded({ width: 390, height: 60 }));
    const emit = async (...states: string[]) => {
      for (const state of states) await act(async () => { for (const listener of [...ios.h.listeners]) listener(state); });
    };
    await emit('inactive', 'active');
    assert.equal(ios.h.loads, 0, 'Notification Center / a call banner is not a return');
    await emit('inactive', 'background', 'inactive', 'active');
    assert.equal(ios.h.loads, 1);
    await emit('active');
    assert.equal(ios.h.loads, 1, 'once per return');
  });
});

describe('banner placement', () => {
  it('Home: its last band after the body (right above the tab bar), the same for every mode', () => {
    const home = readFileSync(resolve('src/screens/home/HomeScreen.tsx'), 'utf8');
    assert.match(home, /<\/View>\s*\{\/\*[^]*?\*\/\}\s*<BannerAdSlot testID="home-banner-ad" \/>\s*\{rewardSheet\}\s*<\/SafeAreaView>/);
    // One slot, outside the general/season branches.
    assert.equal(home.match(/<BannerAdSlot /g)?.length, 1);
  });

  it('community feed (커뮤니티 tab and 리그 › 커뮤니티): under the list area, 글쓰기 inside it — above the banner, never over it', () => {
    const feed = readFileSync(resolve('src/screens/community/CommunityFeedView.tsx'), 'utf8');
    const area = feed.indexOf('<View style={{ flex: 1 }}>');
    const list = feed.indexOf('<FlatList', area);
    const compose = feed.indexOf('testID="community-compose"', area);
    const close = feed.indexOf('</View>', compose);
    const banner = feed.indexOf('<BannerAdSlot testID={`${testID}-banner-ad`} />');
    assert.equal(area > 0 && list > area && compose > list && close > compose && banner > close, true);
    assert.match(feed.slice(compose, close), /position: 'absolute', right: 16, bottom: 24/);
    // Both community screens render this one view.
    assert.match(readFileSync(resolve('src/screens/community/CommunityScreen.tsx'), 'utf8'), /<CommunityFeedView request=\{route\.params\} \/>/);
    assert.match(readFileSync(resolve('src/screens/ranking/LeagueScreen.tsx'), 'utf8'), /<CommunityFeedView request=\{params\} testID="league-community" \/>/);
  });

  it('web and Node hosts render no banner at all', () => {
    const web = readFileSync(resolve('src/components/ads/BannerAdSlot.tsx'), 'utf8');
    assert.match(web, /return null;/);
    assert.equal(/google-mobile-ads|adsRuntime/.test(web), false);
  });
});
