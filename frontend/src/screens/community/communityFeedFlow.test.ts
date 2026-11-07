import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { communityHarness, httpError, networkError, React, act } = require('../../../test/communityTestHarness.cjs');

/** The feed (커뮤니티 tab / 리그 › 커뮤니티) over the in-memory community server. */
async function feed(setup?: (h: any) => void, options: Record<string, unknown> = {}) {
  const h = communityHarness(options);
  setup?.(h);
  const Feed = h.screen('src/screens/community/CommunityFeedView.tsx').default;
  await h.mount(React.createElement(Feed, {}));
  return h;
}
const likeButton = (h: any, id: string) => h.node(`community-post-${id}-like`);
/** The drawn heart of a like button: its SVG stroke and its path's fill. */
function heart(h: any, id: string) {
  const svg = likeButton(h, id).findAll((node: any) => node.type === 'Svg')[0];
  const path = svg?.findAll((node: any) => node.type === 'Path')[0];
  return { drawn: !!svg && !!path, stroke: svg?.props.stroke, fill: path?.props.fill };
}
const likes = (h: any) => h.server.requests.filter((request: any) => request.path.endsWith('/like')).map((request: any) => `${request.method} ${request.path}`);

describe('community feed: the member', () => {
  it('a failed member read is an error with 다시 시도, never an endless loader; the retry brings the feed', async (t) => {
    const h = await feed((x) => {
      x.server.addPost({ id: 'a', body: '첫 글' });
      x.server.meFailures.push(networkError());
    }, { seedMe: false });
    t.after(h.close);
    assert.equal(h.exists('community-viewer-error'), true);
    const error = h.renderer.root.findAll((node: any) => node.type === 'ErrorState')[0];
    assert.equal(error.props.title, '커뮤니티 정보를 불러오지 못했어요.');
    assert.equal(h.renderer.root.findAll((node: any) => node.type === 'WhaleLoader').length, 0, 'no loader under the error');
    // Nothing community-specific was read for an unknown member, and nothing says logged out or restricted.
    assert.equal(h.server.requests.some((request: any) => request.path.startsWith('/community')), false);
    assert.equal(/로그인|제한/.test(h.text()), false);
    await act(async () => error.props.onRetry());
    await h.flush(3);
    assert.equal(h.exists('community-viewer-error'), false);
    assert.equal(h.exists('community-post-a'), true);
  });

  it('while the member is being read the feed waits on a loader (no request keyed by nobody)', async (t) => {
    const h = communityHarness({ seedMe: false });
    const gate = new Promise(() => {});
    h.mocks['../../features/me/api'] = { getMe: () => gate };
    const Feed = h.screen('src/screens/community/CommunityFeedView.tsx').default;
    await h.mount(React.createElement(Feed, {}));
    t.after(h.close);
    assert.equal(h.renderer.root.findAll((node: any) => node.type === 'WhaleLoader').length, 1);
    assert.equal(h.exists('community-viewer-error'), false);
    assert.equal(h.server.requests.length, 0);
  });
});

describe('community feed: the write gate', () => {
  it('글쓰기 before the rules: the rules sheet, then 동의하고 계속 records the consent and opens the composer', async (t) => {
    const h = await feed((x) => { x.server.rulesAccepted = false; });
    t.after(h.close);
    await h.press('community-compose');
    assert.equal(h.exists('community-rules-sheet'), true);
    assert.deepEqual(h.navigations, [], 'nothing opens before the consent');
    assert.equal(h.exists('community-rule-AD_SPAM'), true);
    await h.press('community-rules-accept');
    assert.deepEqual(h.server.sent('post', '/community/rules/consent'), [{ rulesVersion: 'v1' }]);
    assert.deepEqual(h.navigations, [['PostCompose', undefined]]);
    assert.equal(h.exists('community-rules-sheet'), false);
    // Accepted: the next 글쓰기 opens at once.
    await h.press('community-compose');
    assert.deepEqual(h.navigations.at(-1), ['PostCompose', undefined]);
    assert.equal(h.server.sent('post', '/community/rules/consent').length, 1);
  });

  it('a restricted member sees the restriction and never reaches the composer', async (t) => {
    const h = await feed((x) => { x.server.sanction = { reason: 'ABUSE', until: '2026-12-07T03:00:00.000Z' }; });
    t.after(h.close);
    assert.match(h.text(), /커뮤니티 이용이 제한되었어요 \(2026\.12\.07까지\)/);
    assert.equal(h.node('community-compose').props['aria-disabled'], true);
    await h.press('community-compose');
    assert.deepEqual(h.navigations, []);
  });
});

describe('community feed: likes', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: the heart stays drawn before, during and after a like and its undo; counts follow the server`, async (t) => {
      const h = await feed((x) => { x.server.addPost({ id: 'a', userId: 'u2', likes: ['u3'] }); }, { mode });
      t.after(h.close);
      const before = heart(h, 'a');
      assert.equal(before.drawn, true);
      assert.match(String(before.stroke), /^#[0-9a-f]{6}$/i);
      assert.equal(before.fill, 'none');
      assert.equal(likeButton(h, 'a').props['aria-selected'], false);

      const gate = h.server.hold('put', '/community/posts/a/like');
      await h.press('community-post-a-like');
      // Shown at once (one more, filled) while the server answers; a second tap is ignored.
      const pending = heart(h, 'a');
      assert.equal(pending.drawn, true);
      assert.match(String(pending.stroke), /^#[0-9a-f]{6}$/i, 'the liked heart has a real color (it used to be undefined)');
      assert.equal(pending.fill, pending.stroke);
      assert.match(h.text(likeButton(h, 'a')), /^2$/);
      await h.press('community-post-a-like');
      gate.release();
      await h.flush(3);
      assert.deepEqual(likes(h), ['put /community/posts/a/like']);
      const liked = heart(h, 'a');
      assert.equal(liked.fill, liked.stroke);
      assert.equal(likeButton(h, 'a').props['aria-selected'], true);
      assert.match(h.text(likeButton(h, 'a')), /^2$/);

      await h.press('community-post-a-like');
      await h.flush(2);
      assert.deepEqual(likes(h), ['put /community/posts/a/like', 'delete /community/posts/a/like']);
      const undone = heart(h, 'a');
      assert.equal(undone.drawn, true);
      assert.equal(undone.fill, 'none');
      assert.equal(undone.stroke, before.stroke);
      assert.match(h.text(likeButton(h, 'a')), /^1$/);
      assert.equal(likeButton(h, 'a').props['aria-selected'], false);
    });
  }

  it('a refused like goes back to what it was, says why, and leaves other posts alone', async (t) => {
    const h = await feed((x) => {
      x.server.addPost({ id: 'a', userId: 'u2', likes: ['u3'], ageMinutes: 2 });
      x.server.addPost({ id: 'b', userId: 'u3', likes: ['u2'], ageMinutes: 3 });
      x.server.fail('put', '/community/posts/a/like', httpError(500, 'INTERNAL_SERVER_ERROR'));
    });
    t.after(h.close);
    await h.press('community-post-a-like');
    await h.flush(2);
    assert.match(h.text(likeButton(h, 'a')), /^1$/);
    assert.equal(heart(h, 'a').fill, 'none');
    assert.equal(heart(h, 'a').drawn, true);
    assert.equal(h.exists('community-feed-notice'), true);
    assert.match(h.text(likeButton(h, 'b')), /^1$/);
    // Tried again: it counts.
    await h.press('community-post-a-like');
    await h.flush(2);
    assert.match(h.text(likeButton(h, 'a')), /^2$/);
    assert.equal(heart(h, 'a').fill, heart(h, 'a').stroke);
  });

  it('a like before the rules waits for the consent; my own post has no like action', async (t) => {
    const h = await feed((x) => {
      x.server.rulesAccepted = false;
      x.server.addPost({ id: 'a', userId: 'u2', ageMinutes: 2 });
      x.server.addPost({ id: 'mine', userId: 'me', ageMinutes: 3 });
    });
    t.after(h.close);
    await h.press('community-post-a-like');
    assert.equal(h.exists('community-rules-sheet'), true);
    assert.deepEqual(likes(h), []);
    await h.press('community-rules-accept');
    await h.flush(2);
    assert.deepEqual(likes(h), ['put /community/posts/a/like']);
    assert.equal(likeButton(h, 'mine').props.onPress, undefined);
    assert.equal(heart(h, 'mine').drawn, true);
  });

  it('a like changes every list of the member at once (feed pages, Home previews, the post detail)', async (t) => {
    const h = await feed((x) => { x.server.addPost({ id: 'a', userId: 'u2', likes: ['u3'] }); });
    t.after(h.close);
    const page = { items: [h.server.postView(h.server.posts[0])], nextOffset: null, total: 1 };
    h.client.setQueryData(['community', 'hot-preview', 'me'], page);
    h.client.setQueryData(['community', 'latest-preview', 'me'], page);
    h.client.setQueryData(['community', 'post', 'me', 'a'], page.items[0]);
    await h.press('community-post-a-like');
    await h.flush(2);
    for (const key of [['community', 'hot-preview', 'me'], ['community', 'latest-preview', 'me']]) {
      const item = h.client.getQueryData(key).items[0];
      assert.equal(`${item.likedByMe}/${item.likeCount}`, 'true/2', key.join('/'));
    }
    const detail = h.client.getQueryData(['community', 'post', 'me', 'a']);
    assert.equal(`${detail.likedByMe}/${detail.likeCount}`, 'true/2');
  });
});

describe('community feed: authors', () => {
  it('a public author shows the ranking emblem of their tier; an anonymous one shows none; a long nickname gives way first', async (t) => {
    const h = await feed((x) => {
      x.server.users.u2.nickname = '아주아주긴닉네임'.repeat(4);
      x.server.addPost({ id: 'pub', userId: 'u2', ageMinutes: 1 });
      x.server.addPost({ id: 'anon', userId: 'me', anonymous: true, ageMinutes: 2 });
      x.server.addPost({ id: 'none', userId: 'u3', ageMinutes: 3 });
    });
    t.after(h.close);
    const card = (id: string) => h.node(`community-post-${id}`);
    const tiers = (id: string) => card(id).findAll((node: any) => typeof node.type === 'string' && /^community-tier-emblem-[a-z]+$/.test(node.props.testID ?? ''))
      .map((node: any) => node.props.testID);
    assert.deepEqual(tiers('pub'), ['community-tier-emblem-gold']);
    assert.match(h.text(card('pub')), /Gold/);
    assert.deepEqual(tiers('anon'), []);
    assert.equal(/Whale|demiant/.test(h.text(card('anon'))), false, 'an anonymous post shows no identity');
    assert.deepEqual(tiers('none'), [], 'no tier, no emblem (never a made-up one)');
    const name = card('pub').findAll((node: any) => node.type === 'Text' && node.props.numberOfLines === 1)[0];
    assert.equal(h.style(name).flexShrink, 1);
    assert.equal(h.style(h.node('community-tier-gold')).flexShrink, 0, 'the emblem and tier name never shrink');
  });
});
