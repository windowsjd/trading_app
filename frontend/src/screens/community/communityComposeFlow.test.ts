import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { communityHarness, httpError, networkError, React, act } = require('../../../test/communityTestHarness.cjs');

/** 글쓰기 over the in-memory community server; `withFeed` also mounts the feed on the same cache (the screen below it). */
async function composer(setup?: (h: any) => void, { withFeed = false, params = undefined as unknown, harness = {} } = {}) {
  const h = communityHarness(harness);
  setup?.(h);
  const Compose = h.screen('src/screens/community/PostComposeScreen.tsx').default;
  const Feed = withFeed ? h.screen('src/screens/community/CommunityFeedView.tsx').default : null;
  await h.mount(React.createElement(React.Fragment, null,
    Feed ? React.createElement(Feed, {}) : null,
    React.createElement(Compose, { route: { params } })));
  h.submit = () => h.options.headerRight();
  /** Presses 등록 even when it is disabled: the screen itself must refuse. */
  h.send = async () => { await act(async () => h.submit().props.onPress()); await h.flush(3); };
  h.posts = () => h.server.sent('post', '/community/posts');
  return h;
}
const SPACE_ONLY = [' ', '   ', '\n\n', ' \t \n ', String.fromCharCode(0x3000, 0x3000), String.fromCharCode(0xa0), '\r\n  '];

describe('글쓰기: what can be posted', () => {
  it('등록 stays off for empty text and for spaces, tabs or line breaks alone (the server trims the same way)', async (t) => {
    const h = await composer();
    t.after(h.close);
    assert.equal(h.submit().props.disabled, true, 'empty');
    for (const blank of SPACE_ONLY) {
      await h.type('community-compose-body', blank);
      assert.equal(h.submit().props.disabled, true, JSON.stringify(blank));
      assert.equal(h.submit().props['aria-disabled'], true);
      await h.send();
      assert.equal(h.text(h.node('community-compose-counter')), '0 / 500');
    }
    assert.deepEqual(h.posts(), [], 'nothing is sent for blank text');
    await h.type('community-compose-body', '  \n 안녕하세요 \n ');
    assert.equal(h.submit().props.disabled, false);
    assert.equal(h.text(h.node('community-compose-counter')), '5 / 500');
  });

  it('500 characters are allowed and 501 are not (code points, after trimming)', async (t) => {
    const h = await composer();
    t.after(h.close);
    await h.type('community-compose-body', `  ${'가'.repeat(500)}  `);
    assert.equal(h.submit().props.disabled, false);
    await h.type('community-compose-body', '😀'.repeat(501));
    assert.equal(h.submit().props.disabled, true);
    assert.equal(h.text(h.node('community-compose-counter')), '501 / 500');
    await h.send();
    assert.deepEqual(h.posts(), []);
  });

  it('a link is refused before anything is sent', async (t) => {
    const h = await composer();
    t.after(h.close);
    await h.type('community-compose-body', '여기 보세요 open.kakao.com/o/abc');
    await h.send();
    assert.deepEqual(h.posts(), []);
    assert.match(h.text(h.node('community-compose-error')), /링크나 오픈채팅/);
  });
});

describe('글쓰기: posting', () => {
  it('posts the trimmed text once, goes back, and the feed below shows it', async (t) => {
    const h = await composer((x) => { x.server.addPost({ id: 'old', body: '예전 글', ageMinutes: 30 }); }, { withFeed: true });
    t.after(h.close);
    assert.equal(h.exists('community-post-old'), true);
    await h.press('community-compose-category-theory');
    await h.type('community-compose-body', '  RSI 다이버전스 질문이요  ');
    await h.send();
    const [sent] = h.posts();
    assert.equal(sent.body, 'RSI 다이버전스 질문이요');
    assert.equal(`${sent.category}/${sent.anonymous}/${sent.photoCount}`, 'theory/false/0');
    assert.match(sent.clientRequestId, /^community_post_/);
    assert.deepEqual(h.navigations, [['goBack']]);
    await h.flush(3);
    const ids = h.renderer.root.findAll((node: any) => typeof node.type === 'string' && /^community-post-[^-]+$/.test(node.props.testID ?? ''))
      .map((node: any) => node.props.testID);
    assert.deepEqual(ids, ['community-post-p1', 'community-post-old'], 'the new post leads the refreshed feed');
  });

  it('an unknown result keeps the text and the request id: sending again never posts twice', async (t) => {
    const h = await composer();
    t.after(h.close);
    h.server.loseAnswer('post', '/community/posts');
    await h.type('community-compose-body', '처음 올리는 글');
    await h.send();
    assert.match(h.text(h.node('community-compose-error')), /등록 결과를 확인하지 못했어요/);
    assert.equal(h.node('community-compose-body').props.value, '처음 올리는 글');
    assert.deepEqual(h.navigations, []);
    await h.send();
    const keys = h.posts().map((item: any) => item.clientRequestId);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], 'the same request id');
    assert.equal(h.server.posts.length, 1, 'one post on the server');
    assert.deepEqual(h.navigations, [['goBack']]);
  });

  it('a server error (5xx) keeps the request id; a refusal (4xx) starts a new one', async (t) => {
    const h = await composer();
    t.after(h.close);
    h.server.fail('post', '/community/posts', httpError(503, 'SERVICE_UNAVAILABLE'));
    h.server.fail('post', '/community/posts', httpError(409, 'COMMUNITY_DUPLICATE_CONTENT'));
    await h.type('community-compose-body', '재시도 확인');
    await h.send();
    await h.send();
    assert.match(h.text(h.node('community-compose-error')), /같은 내용을 방금 올렸어요/);
    await h.send();
    const keys = h.posts().map((item: any) => item.clientRequestId);
    assert.equal(keys.length, 3);
    assert.equal(keys[0], keys[1], '5xx: same id');
    assert.notEqual(keys[2], keys[1], '4xx: a new id');
    assert.equal(h.server.posts.length, 1);
  });

  it('익명: the preview hides the name and the tier, and the post is anonymous', async (t) => {
    const h = await composer();
    t.after(h.close);
    const preview = () => h.node('community-compose-preview');
    assert.match(h.text(preview()), /demiant/);
    assert.equal(preview().findAll((node: any) => node.props?.testID === 'community-tier-emblem-whale').length > 0, true, 'master shows the Whale emblem');
    assert.match(h.text(preview()), /Whale/);
    await h.press('community-compose-anonymous');
    assert.match(h.text(preview()), /익명/);
    assert.equal(/demiant|Whale/.test(h.text(preview())), false);
    assert.equal(preview().findAll((node: any) => /^community-tier/.test(node.props?.testID ?? '')).length, 0);
    await h.type('community-compose-body', '익명으로 묻습니다');
    await h.send();
    assert.equal(h.posts()[0].anonymous, true);
    assert.equal(h.server.postView(h.server.posts[0]).author.kind, 'anonymous');
  });

  it('photos: picked ones are attached, a removed one is not sent; anonymous with a photo warns', async (t) => {
    const h = await composer();
    t.after(h.close);
    h.picked.push(...['a', 'b'].map((name) => ({ uri: `file:///${name}.jpg`, name: `${name}.jpg`, type: 'image/jpeg', width: 1280, height: 960 })));
    await h.press('community-compose-photos');
    assert.equal(h.exists('community-compose-photo-0') && h.exists('community-compose-photo-1'), true);
    await h.press('community-compose-photo-0-remove');
    assert.equal(h.exists('community-compose-photo-1'), false);
    await h.press('community-compose-anonymous');
    assert.equal(h.exists('community-compose-anonymous-photo'), true);
    await h.type('community-compose-body', '차트 캡처');
    await h.send();
    assert.equal(h.posts()[0].photoCount, 1);
    assert.equal(h.server.posts[0].photos.length, 1);
  });
});

describe('글쓰기: who is writing', () => {
  it('a failed member read offers 다시 시도 instead of an endless loader, and 등록 waits for the member', async (t) => {
    const h = await composer((x) => { x.server.meFailures.push(networkError()); }, { harness: { seedMe: false } });
    t.after(h.close);
    assert.equal(h.exists('community-compose-author-retry'), true);
    await h.type('community-compose-body', '본문은 있어요');
    assert.equal(h.submit().props.disabled, true);
    await h.send();
    assert.deepEqual(h.posts(), []);
    await h.press('community-compose-author-retry');
    await h.flush(3);
    assert.equal(h.exists('community-compose-author-retry'), false);
    assert.match(h.text(h.node('community-compose-preview')), /demiant/);
    assert.equal(h.submit().props.disabled, false);
  });

  it('a restricted member cannot type or post', async (t) => {
    const h = await composer((x) => { x.server.sanction = { reason: 'ABUSE', until: null }; });
    t.after(h.close);
    assert.match(h.text(h.node('community-compose-restricted')), /커뮤니티 이용이 제한되었어요 \(영구\)/);
    assert.equal(h.node('community-compose-body').props.editable, false);
    assert.equal(h.submit().props.disabled, true);
  });
});
