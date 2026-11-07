import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

const post = (id: string, patch: Record<string, unknown> = {}) => ({
  id, category: 'free', body: `${id} 본문`, createdAt: '2026-11-07T03:00:00.000Z', author: { kind: 'anonymous', label: '익명' },
  asset: null, photos: [], likeCount: 4, commentCount: 18, likedByMe: false, mine: false, isHot: true, ...patch,
});

function setup(posts: readonly unknown[] | 'loading' | 'error', { season = false, reduced = false } = {}) {
  const h = interactionHarness('android');
  h.reduced = reduced;
  const appListeners: Array<(state: string) => void> = [];
  h.native.AppState = { currentState: 'active', addEventListener: (_type: string, listener: (state: string) => void) => {
    appListeners.push(listener); return { remove: () => appListeners.splice(appListeners.indexOf(listener), 1) };
  } };
  const state = { focused: true };
  const navigations: unknown[] = [];
  const Ticker = h.load('src/screens/home/HomeCommunityTicker.tsx', {
    '@tanstack/react-query': { useQuery: () => ({}) },
    '@react-navigation/native': { useIsFocused: () => state.focused },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate: (...args: unknown[]) => navigations.push(args) }) },
    '../../features/me/api': { getMe() {} },
    '../../features/community/api': { COMMUNITY_HOT_PREVIEW_LIMIT: 3, getCommunityPosts() {} },
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    '../community/CommunityParts': { TierMark: () => null },
  }).default;
  const hot = {
    query: posts === 'loading' ? { isLoading: true } : posts === 'error' ? { isLoading: false, isError: true, refetch() {} }
      : { isLoading: false, data: { items: posts }, dataUpdatedAt: Date.now(), refetch() {} },
    refreshQuery: { isFetching: false, refetch: async () => {}, enabled: true },
  };
  const tree = () => React.createElement(Ticker, { hot, season });
  const renderer = h.render(tree());
  const find = (id: string) => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  const slide = () => renderer.root.findAll((node: any) => /^home-community-ticker-slide-/.test(node.props?.testID ?? ''))[0]?.props.testID;
  return {
    h, renderer, find, slide, navigations, appListeners,
    setFocused: (value: boolean) => { state.focused = value; act(() => renderer.update(tree())); },
    close: () => act(() => renderer.unmount()),
  };
}

describe('Home HOT community card', () => {
  it('is hidden with no HOT post or a failed read, and holds its height while first loading', t => {
    for (const posts of [[], 'error'] as const) {
      const h = setup(posts); t.after(h.close);
      assert.equal(h.renderer.toJSON() === null, true, String(posts));
    }
    const loading = setup('loading'); t.after(loading.close);
    const placeholder = loading.find('home-community-ticker-loading');
    assert.ok(placeholder);
    const slot = flatten(placeholder.props.children.props.style);
    assert.equal(slot.height, 68);
  });

  it('one button: the card style, the current post summary, no live region; one post has no dots', t => {
    const h = setup([post('a', { author: { kind: 'public', userId: 'u', nickname: 'bluechip', profileImageUrl: null, tier: 'gold' } })]); t.after(h.close);
    const card = h.find('home-community-ticker');
    const style = flatten(card.props.style);
    assert.equal([style.borderRadius, style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join('/'), '16/14/36/14/16');
    assert.equal(card.props.accessibilityRole, 'button');
    assert.match(card.props.accessibilityLabel, /bluechip, 댓글 18\. a 본문/);
    assert.equal(h.renderer.root.findAll((node: any) => node.props?.accessibilityLiveRegion !== undefined).length, 0);
    assert.equal(h.find('home-community-ticker-dots') === undefined, true);
  });

  it('advances every 4 s while shown, and stops for focus, background, a press and Reduce Motion', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup([post('a'), post('b'), post('c')]); t.after(h.close);
    assert.ok(h.find('home-community-ticker-dots'));
    assert.equal(h.slide(), 'home-community-ticker-slide-a');
    act(() => t.mock.timers.tick(3999));
    assert.equal(h.slide(), 'home-community-ticker-slide-a');
    act(() => t.mock.timers.tick(1));
    assert.equal(h.slide(), 'home-community-ticker-slide-b');
    const transition = h.h.animations.at(-1);
    assert.equal(`${transition.type}/${transition.options.duration}`, 'timing/450');
    // Another screen on top: no timer runs.
    h.setFocused(false);
    act(() => t.mock.timers.tick(12_000));
    assert.equal(h.slide(), 'home-community-ticker-slide-b');
    h.setFocused(true);
    // Pressed: held while the finger is down.
    const card = h.renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'home-community-ticker')[0];
    act(() => card.props.onPressIn({}));
    act(() => t.mock.timers.tick(8000));
    assert.equal(h.slide(), 'home-community-ticker-slide-b');
    act(() => card.props.onPressOut({}));
    // The app in the background: held.
    act(() => h.appListeners.forEach((listener) => listener('background')));
    act(() => t.mock.timers.tick(8000));
    assert.equal(h.slide(), 'home-community-ticker-slide-b');
    act(() => h.appListeners.forEach((listener) => listener('active')));
    act(() => t.mock.timers.tick(4000));
    assert.equal(h.slide(), 'home-community-ticker-slide-c');
    act(() => t.mock.timers.tick(4000));
    assert.equal(h.slide(), 'home-community-ticker-slide-a', 'wraps around');
  });

  it('Reduce Motion pins the first post without a timer or an animation; unmounting clears the timer', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup([post('a'), post('b')], { reduced: true });
    act(() => t.mock.timers.tick(20_000));
    assert.equal(h.slide(), 'home-community-ticker-slide-a');
    assert.equal(h.h.animations.length, 0);
    h.close();
    const live = setup([post('a'), post('b')]); live.close();
    // An unmounted card leaves no pending advance behind.
    act(() => t.mock.timers.tick(20_000));
  });

  for (const season of [false, true]) {
    it(`${season ? 'season' : 'beginner/general'}: tapping opens the community with HOT selected`, t => {
      const h = setup([post('a')], { season }); t.after(h.close);
      const card = h.renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'home-community-ticker')[0];
      act(() => card.props.onPress());
      const [route, params] = h.navigations[0] as [string, any];
      assert.equal(route, 'MainTabs');
      if (season) {
        assert.equal([params.screen, params.params.screen, params.params.params.section, params.params.params.category, params.params.pop].join('|'), 'RankingTab|Ranking|community|hot|true');
      } else {
        assert.equal([params.screen, params.params.screen, params.params.params.category, params.params.pop].join('|'), 'CommunityTab|Community|hot|true');
      }
      assert.equal(typeof params.params.params.at, 'number');
    });
  }
});
