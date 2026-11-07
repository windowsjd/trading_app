import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { homeCommunityCard } from '../../features/community/homeCommunityCard.ts';
import { patchCommunityPost, refreshCommunityLists } from '../../features/community/communityCache.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const { communityHarness } = require('../../../test/communityTestHarness.cjs');

const post = (id: string, patch: Record<string, unknown> = {}) => ({
  id, category: 'free', body: `${id} 본문`, createdAt: '2026-11-07T03:00:00.000Z', author: { kind: 'anonymous', label: '익명' },
  asset: null, photos: [], likeCount: 4, commentCount: 18, likedByMe: false, mine: false, isHot: true, ...patch,
});
const page = (items: readonly unknown[]) => ({ items, nextOffset: null, total: items.length });

/**
 * The card alone, fed what the hook would give it: HOT posts, else the latest
 * posts (`latest`), else the invitation; `loading`/`error` for the HOT read.
 */
function setup(posts: readonly unknown[] | 'loading' | 'error', { season = false, reduced = false, latest = undefined as readonly unknown[] | 'error' | undefined, fontScale = 1 } = {}) {
  const h = interactionHarness('android');
  h.reduced = reduced;
  h.dimensions = { width: 360, height: 760, fontScale };
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
  const query = (value: readonly unknown[] | 'loading' | 'error' | undefined) => ({
    data: Array.isArray(value) ? page(value) : undefined, isError: value === 'error',
    dataUpdatedAt: Array.isArray(value) ? Date.now() : 0, errorUpdatedAt: value === 'error' ? Date.now() : 0, refetch: async () => ({}),
  });
  const hot = query(posts), next = query(latest);
  const data = {
    card: homeCommunityCard({ page: hot.data as never, failed: hot.isError }, { page: next.data as never, failed: next.isError }),
    hot, latest: next, latestActive: Array.isArray(posts) && !posts.length,
    refreshQuery: { isFetching: false, refetch: async () => {}, enabled: true },
  };
  const tree = () => React.createElement(Ticker, { hot: data, season });
  const renderer = h.render(tree());
  const find = (id: string) => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  const slide = () => renderer.root.findAll((node: any) => /^home-community-ticker-slide-/.test(node.props?.testID ?? ''))[0]?.props.testID;
  return {
    h, renderer, find, slide, navigations, appListeners,
    setFocused: (value: boolean) => { state.focused = value; act(() => renderer.update(tree())); },
    close: () => act(() => renderer.unmount()),
  };
}
const press = (h: ReturnType<typeof setup>, id: string) => act(() => h.renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === id)[0].props.onPress());
const route = (h: ReturnType<typeof setup>) => {
  const [name, params] = h.navigations.at(-1) as [string, any];
  return name === 'MainTabs' && params.screen === 'RankingTab'
    ? `리그:${params.params.screen}:${params.params.params.section}:${params.params.params.category}:${params.params.pop}`
    : `${params.screen}:${params.params.screen}:${params.params.params.category}:${params.params.pop}`;
};

describe('Home community card: the four states', () => {
  it('a placeholder of the card height while HOT is first read; the card grows with the system font up to its cap', t => {
    const heights: string[] = [];
    for (const fontScale of [1, 1.3, 2]) {
      const loading = setup('loading', { fontScale }); t.after(loading.close);
      const placeholder = loading.find('home-community-ticker-loading');
      assert.ok(placeholder);
      const slot = flatten(placeholder.props.children.props.style).height;
      // The nearest sized box above a node: the slide's clipping slot, the invitation's box.
      const sized = (node: any) => { let n = node.parent; while (n && !(typeof n.type === 'string' && flatten(n.props.style).height)) n = n.parent; return flatten(n.props.style); };
      const hot = setup([post('a')], { fontScale }); t.after(hot.close);
      const box = sized(hot.renderer.root.findAll((node: any) => node.props?.testID === 'home-community-ticker-slide-a')[0]);
      const empty = setup([], { latest: [], fontScale }); t.after(empty.close);
      const message = empty.renderer.root.findAll((node: any) => node.type === 'Text' && node.props.numberOfLines === 2)[0];
      const invitation = sized(message).height;
      heights.push(`${fontScale}:${slot}/${box.height}/${invitation}/${box.overflow}`);
    }
    assert.deepEqual(heights, ['1:68/68/68/hidden', '1.3:85/85/85/hidden', '2:85/85/85/hidden']);
  });

  it('HOT: one button with the card style and the post summary; one post has no dots', t => {
    const h = setup([post('a', { author: { kind: 'public', userId: 'u', nickname: 'bluechip', profileImageUrl: null, tier: 'gold' } })]); t.after(h.close);
    const card = h.find('home-community-ticker');
    const style = flatten(card.props.style);
    assert.equal([style.borderRadius, style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join('/'), '16/14/36/14/16');
    assert.equal(card.props.accessibilityRole, 'button');
    assert.match(card.props.accessibilityLabel, /^커뮤니티 HOT 글, bluechip, 댓글 18\. a 본문/);
    assert.equal(card.props.accessibilityHint, '이 글의 본문과 댓글을 엽니다.');
    assert.equal(h.renderer.root.findAll((node: any) => node.props?.accessibilityLiveRegion !== undefined).length, 0);
    assert.equal(h.find('home-community-ticker-dots') === undefined, true);
  });

  it('no HOT post: the latest posts in the same card, never called HOT, rotating like HOT', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const items = ['n1', 'n2', 'n3'].map((id) => post(id, { isHot: false }));
    const h = setup([], { latest: items }); t.after(h.close);
    const card = h.find('home-community-ticker');
    assert.equal(flatten(card.props.style).paddingRight, 36, 'the same card box');
    assert.match(card.props.accessibilityLabel, /^커뮤니티 최신 글, 익명, 댓글 18\. n1 본문/);
    assert.equal(/HOT/.test(card.props.accessibilityLabel + card.props.accessibilityHint), false);
    assert.equal(card.props.accessibilityHint, '이 글의 본문과 댓글을 엽니다.');
    assert.ok(h.find('home-community-ticker-dots'));
    assert.equal(h.slide(), 'home-community-ticker-slide-n1');
    act(() => t.mock.timers.tick(4000));
    assert.equal(h.slide(), 'home-community-ticker-slide-n2');
  });

  it('no post at all: the first-post invitation, a button into the community', t => {
    const h = setup([], { latest: [] }); t.after(h.close);
    const card = h.find('home-community-empty');
    assert.equal(card.props.accessibilityRole, 'button');
    assert.equal(card.props.accessibilityLabel, '커뮤니티에서 첫 이야기를 시작해 보세요.');
    assert.match(JSON.stringify(h.renderer.toJSON()), /커뮤니티에서 첫 이야기를 시작해 보세요\./);
    assert.equal(flatten(card.props.style).borderRadius, 16);
  });

  it('a failed read: only the way in, never "no posts"', t => {
    for (const [posts, latest] of [['error', undefined], [[], 'error']] as const) {
      const h = setup(posts, { latest }); t.after(h.close);
      assert.equal(h.find('home-community-empty') === undefined, true, String(posts));
      const card = h.find('home-community-unavailable');
      assert.equal(card.props.accessibilityLabel, '커뮤니티에서 투자 이야기를 확인해 보세요.');
      assert.equal(/첫 이야기|없/.test(JSON.stringify(h.renderer.toJSON())), false);
    }
  });
});

/** The post detail a tap opened: `<tab>:PostDetail:<postId>:<returnTab>:<initial>`. */
const detail = (h: ReturnType<typeof setup>) => {
  const [name, params] = h.navigations.at(-1) as [string, any];
  assert.equal(name, 'MainTabs');
  return `${params.screen}:${params.params.screen}:${params.params.params.postId}:${params.params.params.returnTab}:${params.params.initial}`;
};
const card = (h: ReturnType<typeof setup>) =>
  h.renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'home-community-ticker')[0];

describe('Home community card: where a tap goes', () => {
  for (const season of [false, true]) {
    const tab = season ? 'RankingTab' : 'CommunityTab';
    const where = season ? '리그:Ranking:community' : 'CommunityTab:Community';
    it(`${season ? 'season' : 'beginner/general'}: a HOT or latest post opens that post's detail; invitation and unavailable → 전체`, t => {
      const hot = setup([post('a')], { season }); t.after(hot.close);
      press(hot, 'home-community-ticker');
      // Pushed onto the community stack's list (initial: false); back returns to Home.
      assert.equal(detail(hot), `${tab}:PostDetail:a:HomeTab:false`);
      const latest = setup([], { season, latest: [post('n', { isHot: false })] }); t.after(latest.close);
      press(latest, 'home-community-ticker');
      assert.equal(detail(latest), `${tab}:PostDetail:n:HomeTab:false`);
      for (const [id, options] of [['home-community-empty', { latest: [] }], ['home-community-unavailable', { latest: 'error' }]] as const) {
        const h = setup([], { season, ...options }); t.after(h.close);
        press(h, id);
        assert.equal(route(h), `${where}:all:true`, id);
        const [, params] = h.navigations[0] as [string, any];
        assert.equal(typeof params.params.params.at, 'number');
      }
    });
  }

  it('after a rotation the tap opens the post now shown, and a screen reader opens the one it announced', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup([post('a'), post('b'), post('c')]); t.after(h.close);
    act(() => t.mock.timers.tick(4000));
    act(() => h.h.animations.at(-1).finish());
    assert.equal(h.slide(), 'home-community-ticker-slide-b');
    act(() => card(h).props.onPressIn({}));
    act(() => card(h).props.onPressOut({}));
    act(() => card(h).props.onPress());
    assert.equal(detail(h), 'CommunityTab:PostDetail:b:HomeTab:false');
    // No press-in (an accessibility activation): the announced post.
    assert.match(card(h).props.accessibilityLabel, /b 본문/);
    act(() => card(h).props.onPress());
    assert.equal(detail(h), 'CommunityTab:PostDetail:b:HomeTab:false');
  });

  it('a touch that became a scroll leaves no target: a later screen-reader activation opens the post it announces', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup([post('a'), post('b'), post('c')]); t.after(h.close);
    act(() => card(h).props.onPressIn({}));
    act(() => card(h).props.onPressOut({}));
    // No onPress (the finger scrolled); rotation goes on.
    act(() => t.mock.timers.tick(4000));
    act(() => h.h.animations.at(-1).finish());
    assert.equal(h.slide(), 'home-community-ticker-slide-b');
    assert.match(card(h).props.accessibilityLabel, /b 본문/);
    act(() => card(h).props.onPress());
    assert.equal(detail(h), 'CommunityTab:PostDetail:b:HomeTab:false');
  });

  for (const [elapsed, expected] of [[100, 'a'], [300, 'b']] as const) {
    it(`a tap ${elapsed} ms into a transition settles on the more visible post (${expected}) and opens exactly it`, t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let now = 1_000;
      t.mock.method(performance, 'now', () => now);
      const h = setup([post('a'), post('b'), post('c')]); t.after(h.close);
      act(() => t.mock.timers.tick(4000));
      const bodies = () => h.renderer.root.findAll((node: any) => node.type === 'Text' && node.props.numberOfLines === 2)
        .map((node: any) => node.props.children).sort();
      // a → b has started: both are drawn while it runs.
      assert.equal(h.slide(), 'home-community-ticker-slide-b');
      assert.deepEqual(bodies(), ['a 본문', 'b 본문'], 'the outgoing post is still on screen');
      now += elapsed;
      act(() => card(h).props.onPressIn({}));
      // Settled: one post on screen, the one that will open.
      assert.equal(h.slide(), `home-community-ticker-slide-${expected}`);
      assert.deepEqual(bodies(), [`${expected} 본문`]);
      // Held while pressed: no rotation changes what the release opens.
      act(() => t.mock.timers.tick(8000));
      assert.equal(h.slide(), `home-community-ticker-slide-${expected}`);
      act(() => card(h).props.onPressOut({}));
      act(() => card(h).props.onPress());
      assert.equal(detail(h), `CommunityTab:PostDetail:${expected}:HomeTab:false`);
    });
  }
});

describe('Home community card: layout', () => {
  it('a post sits centered vertically in its slide, lines starting at the left; the invitation too', t => {
    const h = setup([post('a')]); t.after(h.close);
    const slide = h.renderer.root.findAll((node: any) => node.props?.testID === 'home-community-ticker-slide-a')[0];
    const box = slide.findAll((node: any) => typeof node.type === 'string' && flatten(node.props.style).height === 68)[0];
    const style = flatten(box.props.style);
    assert.equal(style.justifyContent, 'center');
    assert.equal(style.alignItems === undefined || style.alignItems === 'stretch', true, 'the horizontal start is unchanged');
    const empty = setup([], { latest: [] }); t.after(empty.close);
    const message = empty.renderer.root.findAll((node: any) => node.type === 'Text' && node.props.numberOfLines === 2)[0];
    let n = message.parent; while (n && !(typeof n.type === 'string' && flatten(n.props.style).height)) n = n.parent;
    assert.equal(flatten(n.props.style).justifyContent, 'center');
  });
});

describe('Home community card: rotation', () => {
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
    // The 450 ms transition ends (the mocked animation finishes only when told).
    act(() => transition.finish());
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
    for (const latest of [undefined, [post('n1', { isHot: false }), post('n2', { isHot: false })]]) {
      const h = setup(latest ? [] : [post('a'), post('b')], { reduced: true, latest });
      act(() => t.mock.timers.tick(20_000));
      assert.equal(h.slide(), latest ? 'home-community-ticker-slide-n1' : 'home-community-ticker-slide-a');
      assert.equal(h.h.animations.length, 0);
      h.close();
    }
    const live = setup([post('a'), post('b')]); live.close();
    // An unmounted card leaves no pending advance behind.
    act(() => t.mock.timers.tick(20_000));
  });
});

/** The hook and the card on a real query cache over the in-memory community server. */
async function home(setup?: (h: any) => void, { season = false } = {}) {
  const h = communityHarness();
  setup?.(h);
  const module = h.screen('src/screens/home/HomeCommunityTicker.tsx');
  function Home() {
    const data = module.useHomeCommunityHot(true);
    h.data = data;
    return React.createElement(module.default, { hot: data, season });
  }
  h.tree = () => React.createElement(Home);
  await h.mount(h.tree());
  await h.flush(3);
  h.reads = () => h.server.requests.filter((request: any) => request.path.startsWith('/community/posts?')).map((request: any) => request.path);
  h.reshow = async () => {
    h.focused = false;
    await act(async () => h.renderer.update(React.createElement(require('@tanstack/react-query').QueryClientProvider, { client: h.client }, h.tree())));
    h.focused = true;
    await act(async () => h.renderer.update(React.createElement(require('@tanstack/react-query').QueryClientProvider, { client: h.client }, h.tree())));
    await h.flush(3);
  };
  return h;
}
const HOT_LIKES = ['u3', 'me', 'x9'];
const HOT_READ = '/community/posts?category=hot&limit=3&offset=0';
const LATEST_READ = '/community/posts?category=all&limit=3&offset=0';

describe('Home community card over the community API', () => {
  it('HOT posts: only the HOT list is read', async (t) => {
    const h = await home((x) => { x.server.addPost({ id: 'h1', likes: HOT_LIKES }); x.server.addPost({ id: 'plain', ageMinutes: 1 }); });
    t.after(h.close);
    assert.deepEqual(h.reads(), [HOT_READ]);
    assert.match(h.node('home-community-ticker').props.accessibilityLabel, /^커뮤니티 HOT 글/);
  });

  it('no HOT post: then the three newest visible posts of 전체, newest first, as plain posts', async (t) => {
    const h = await home((x) => {
      for (const [id, age] of [['n4', 40], ['n1', 1], ['n3', 30], ['n2', 20]] as const) x.server.addPost({ id, ageMinutes: age, likes: ['u3'] });
      x.server.posts.push({ ...x.server.posts[0], id: 'gone', createdAt: x.server.now, deleted: true });
    });
    t.after(h.close);
    assert.deepEqual(h.reads(), [HOT_READ, LATEST_READ]);
    assert.equal(h.data.card.kind, 'latest');
    assert.deepEqual(h.data.card.posts.map((item: any) => item.id), ['n1', 'n2', 'n3'], 'deleted posts never reach Home');
    assert.equal(h.data.card.posts.some((item: any) => item.isHot), false);
    assert.match(h.node('home-community-ticker').props.accessibilityLabel, /^커뮤니티 최신 글, bluechip/);
  });

  it('no post at all: the invitation; a failed HOT read: the way in, and the latest posts are not read for it', async (t) => {
    const empty = await home();
    t.after(empty.close);
    assert.equal(empty.exists('home-community-empty'), true);
    const failed = await home((x) => { x.server.addPost({ id: 'n1' }); x.server.fail('get', '/community/posts?category=hot', new Error('offline')); });
    t.after(failed.close);
    assert.equal(failed.exists('home-community-unavailable'), true);
    assert.deepEqual(failed.reads(), [HOT_READ]);
  });

  it('a failed member read: the way in, with no community read at all', async (t) => {
    const h = communityHarness({ seedMe: false });
    h.server.meFailures.push(new Error('offline'));
    const module = h.screen('src/screens/home/HomeCommunityTicker.tsx');
    function Home() { return React.createElement(module.default, { hot: module.useHomeCommunityHot(true), season: false }); }
    await h.mount(React.createElement(Home));
    await h.flush(3);
    t.after(h.close);
    assert.equal(h.exists('home-community-unavailable'), true);
    assert.equal(h.server.requests.some((request: any) => request.path.startsWith('/community')), false);
  });

  it('back on Home within a minute nothing is read; after a minute the lists in use are read again and HOT takes over', async (t) => {
    let clock = Date.parse('2026-11-07T12:00:00.000Z');
    t.mock.method(Date, 'now', () => clock);
    const h = await home((x) => { x.server.addPost({ id: 'p1', likes: ['u3'] }); });
    t.after(h.close);
    assert.equal(h.data.card.kind, 'latest');
    assert.equal(h.reads().length, 2);
    clock += 30_000;
    await h.reshow();
    assert.equal(h.reads().length, 2, 'fresh: no request');
    // Others' likes and a comment make it HOT (score 1 + 1 + 2 = 4).
    h.server.posts[0].likes.add('me');
    h.server.addComment({ postId: 'p1', userId: 'u3' });
    clock += 31_000;
    await h.reshow();
    assert.deepEqual(h.reads().slice(2), [HOT_READ, LATEST_READ]);
    assert.equal(h.data.card.kind, 'hot');
    assert.match(h.node('home-community-ticker').props.accessibilityLabel, /^커뮤니티 HOT 글/);
    // HOT in use: the latest posts are no longer read.
    clock += 61_000;
    await h.reshow();
    assert.deepEqual(h.reads().slice(4), [HOT_READ]);
  });

  it('pull to refresh: HOT again, then the latest posts only while HOT is empty', async (t) => {
    const h = await home((x) => { x.server.addPost({ id: 'p1' }); });
    t.after(h.close);
    await act(async () => { await h.data.refreshQuery.refetch({ cancelRefetch: false }); });
    await h.flush(2);
    assert.deepEqual(h.reads().slice(2), [HOT_READ, LATEST_READ]);
    h.server.posts[0].likes = new Set(HOT_LIKES);
    await act(async () => { await h.data.refreshQuery.refetch({ cancelRefetch: false }); });
    await h.flush(2);
    assert.deepEqual(h.reads().slice(4), [HOT_READ]);
    assert.equal(h.data.card.kind, 'hot');
  });

  it('a like shows on the card at once; a new post refreshes it', async (t) => {
    const h = await home((x) => { x.server.addPost({ id: 'p1' }); });
    t.after(h.close);
    await act(async () => patchCommunityPost(h.client, 'me', 'p1', (item: any) => ({ ...item, commentCount: item.commentCount + 1 })));
    await h.flush(1);
    assert.match(h.node('home-community-ticker').props.accessibilityLabel, /댓글 1\./);
    h.server.addPost({ id: 'fresh', ageMinutes: 0, body: '방금 쓴 글' });
    await act(async () => refreshCommunityLists(h.client, 'me'));
    await h.flush(3);
    assert.deepEqual(h.data.card.posts.map((item: any) => item.id), ['fresh', 'p1']);
  });
});
