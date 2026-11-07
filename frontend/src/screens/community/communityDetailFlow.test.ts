import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { communityHarness, httpError, networkError, React, act } = require('../../../test/communityTestHarness.cjs');

/** 글 상세 of post `a` over the in-memory community server (with the feed's first page already read when `feed`). */
async function detail(setup?: (h: any) => void, { feed = false, harness = {} } = {}) {
  const h = communityHarness(harness);
  setup?.(h);
  if (feed) {
    const page = { items: h.server.posts.map(h.server.postView), nextOffset: null, total: h.server.posts.length };
    h.client.setQueryData(['community', 'feed', 'me', 'all', 'infinite'], { pages: [page], pageParams: [0] });
  }
  const Detail = h.screen('src/screens/community/PostDetailScreen.tsx').default;
  await h.mount(React.createElement(Detail, { route: { params: { postId: 'a' } } }));
  await h.flush(2);
  h.comments = () => h.server.sent('post', '/community/posts/a/comments');
  return h;
}
const feedPost = (h: any) => h.client.getQueryData(['community', 'feed', 'me', 'all', 'infinite']).pages[0].items.find((item: any) => item.id === 'a');

describe('글 상세: comments and replies', () => {
  it('a comment is sent trimmed, counted on the post everywhere, and shown; a reply goes to its top-level comment', async (t) => {
    const h = await detail((x) => {
      x.server.addPost({ id: 'a', userId: 'u2', body: '삼성전자 오늘 흐름' });
      x.server.addComment({ postId: 'a', userId: 'u3', body: '저도 궁금해요' });
    }, { feed: true });
    t.after(h.close);
    assert.match(h.text(), /댓글 1/);
    await h.type('community-comment-input', '   좋은 글이네요  \n');
    await h.press('community-comment-send');
    await h.flush(3);
    assert.deepEqual(h.comments().map((item: any) => [item.body, item.anonymous, item.parentCommentId ?? null]), [['좋은 글이네요', false, null]]);
    assert.equal(h.node('community-comment-input').props.value, '');
    assert.match(h.text(), /댓글 2/);
    assert.equal(feedPost(h).commentCount, 2, 'the feed shows the same count');
    assert.match(h.text(), /좋은 글이네요/);

    // 답글 on the first comment, then 답글 on that reply: both answer the top-level comment.
    const top = h.server.comments[0].id;
    await h.press(`community-comment-${top}-reply`);
    assert.match(h.text(h.node('community-reply-to')), /value-lab에게 답글 남기는 중/);
    await h.type('community-comment-input', '답글입니다');
    await h.press('community-comment-send');
    await h.flush(3);
    const reply = h.server.comments.find((item: any) => item.body === '답글입니다');
    await h.press(`community-comment-${reply.id}-reply`);
    await h.type('community-comment-input', '답글의 답글');
    await h.press('community-comment-send');
    await h.flush(3);
    assert.deepEqual(h.comments().slice(1).map((item: any) => item.parentCommentId), [top, top]);
  });

  it('spaces or line breaks alone cannot be sent', async (t) => {
    const h = await detail((x) => { x.server.addPost({ id: 'a', userId: 'u2' }); });
    t.after(h.close);
    for (const blank of ['   ', '\n\n', ' \t ', String.fromCharCode(0x3000)]) {
      await h.type('community-comment-input', blank);
      assert.equal(h.node('community-comment-send').props['aria-disabled'], true, JSON.stringify(blank));
      await h.press('community-comment-send');
    }
    assert.deepEqual(h.comments(), []);
  });

  it('a failed comment keeps the text and the request id; sending again files it once', async (t) => {
    const h = await detail((x) => { x.server.addPost({ id: 'a', userId: 'u2' }); });
    t.after(h.close);
    h.server.loseAnswer('post', '/community/posts/a/comments');
    await h.type('community-comment-input', '한 번만 올라가야 해요');
    await h.press('community-comment-send');
    await h.flush(2);
    assert.equal(h.node('community-comment-input').props.value, '한 번만 올라가야 해요');
    assert.equal(h.exists('community-detail-notice'), true);
    await h.press('community-comment-send');
    await h.flush(3);
    const keys = h.comments().map((item: any) => item.clientRequestId);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(h.server.comments.length, 1);
  });
});

describe('글 상세: anonymity', () => {
  it('on my anonymous post 익명 is locked on, my comment is 글쓴이, and no name or tier shows', async (t) => {
    const h = await detail((x) => { x.server.addPost({ id: 'a', userId: 'me', anonymous: true }); });
    t.after(h.close);
    const toggle = h.node('community-comment-anonymous');
    assert.equal(`${toggle.props['aria-checked']}/${toggle.props.accessibilityState.disabled}`, 'true/true');
    await h.type('community-comment-input', '작성자 댓글');
    await h.press('community-comment-send');
    await h.flush(3);
    assert.equal(h.comments()[0].anonymous, true);
    const row = h.node(`community-comment-${h.server.comments[0].id}`);
    assert.match(h.text(row), /익명/);
    assert.match(h.text(row), /글쓴이/);
    assert.equal(/demiant|Whale/.test(h.text()), false);
    assert.equal(h.renderer.root.findAll((node: any) => /^community-tier/.test(node.props?.testID ?? '')).length, 0);
  });

  it('a public commenter shows their tier emblem; an anonymous commenter shows none', async (t) => {
    const h = await detail((x) => {
      x.server.addPost({ id: 'a', userId: 'u3' });
      x.server.addComment({ postId: 'a', userId: 'u2', body: '공개 댓글', ageMinutes: 2 });
      x.server.addComment({ postId: 'a', userId: 'me', body: '익명 댓글', anonymous: true, ageMinutes: 1 });
    });
    t.after(h.close);
    const [open, hidden] = h.server.comments;
    const emblems = (id: string) => h.node(`community-comment-${id}`).findAll((node: any) => typeof node.type === 'string' && /^community-tier-emblem-[a-z]+$/.test(node.props.testID ?? ''))
      .map((node: any) => node.props.testID);
    assert.deepEqual(emblems(open.id), ['community-tier-emblem-gold']);
    assert.deepEqual(emblems(hidden.id), []);
    assert.match(h.text(h.node(`community-comment-${hidden.id}`)), /익명1/);
  });
});

describe('글 상세: likes', () => {
  it('liking here shows on the feed at once; a refused like is put back; the heart is always drawn', async (t) => {
    const h = await detail((x) => { x.server.addPost({ id: 'a', userId: 'u2', likes: ['u3'] }); }, { feed: true });
    t.after(h.close);
    const heart = () => {
      const svg = h.node('community-detail-like').findAll((node: any) => node.type === 'Svg')[0];
      return { stroke: svg?.props.stroke, fill: svg?.findAll((node: any) => node.type === 'Path')[0]?.props.fill };
    };
    await h.press('community-detail-like');
    await h.flush(2);
    assert.equal(`${feedPost(h).likedByMe}/${feedPost(h).likeCount}`, 'true/2');
    assert.match(String(heart().stroke), /^#[0-9a-f]{6}$/i);
    assert.equal(heart().fill, heart().stroke);
    h.server.fail('delete', '/community/posts/a/like', httpError(500, 'INTERNAL_SERVER_ERROR'));
    await h.press('community-detail-like');
    await h.flush(2);
    assert.equal(`${feedPost(h).likedByMe}/${feedPost(h).likeCount}`, 'true/2', 'the failed undo is put back everywhere');
    assert.equal(heart().fill, heart().stroke);
    assert.equal(h.exists('community-detail-notice'), true);
  });
});

describe('글 상세: the member', () => {
  it('a failed member read is an error with 다시 시도; the retry opens the post', async (t) => {
    const h = await detail((x) => {
      x.server.addPost({ id: 'a', userId: 'u2', body: '다시 열리는 글' });
      x.server.meFailures.push(networkError());
    }, { harness: { seedMe: false } });
    t.after(h.close);
    assert.equal(h.exists('community-viewer-error'), true);
    const error = h.renderer.root.findAll((node: any) => node.type === 'ErrorState')[0];
    await act(async () => error.props.onRetry());
    await h.flush(4);
    assert.match(h.text(h.node('community-detail-body')), /다시 열리는 글/);
  });
});
