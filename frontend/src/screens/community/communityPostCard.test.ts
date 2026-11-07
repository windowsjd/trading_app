import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

const PUBLIC = { kind: 'public', userId: 'author-1', nickname: 'bluechip', profileImageUrl: null, tier: 'gold' };
const post = (patch: Record<string, unknown> = {}) => ({
  id: 'p1', category: 'free', body: '마감 후에 지정가가 걸려있는데 내일 시초가가 어떻게 나올지 궁금하네요.',
  createdAt: new Date(Date.now() - 8 * 60_000).toISOString(), author: PUBLIC, asset: null,
  photos: [{ url: 'https://cdn.example.com/community-images/a.jpg', width: 1280, height: 960 }, { url: 'https://cdn.example.com/community-images/b.jpg', width: 960, height: 1280 }],
  likeCount: 12, commentCount: 7, likedByMe: false, mine: false, isHot: true, ...patch,
});

function render(item: Record<string, unknown>, canModerate = false) {
  const h = interactionHarness('android');
  const calls: string[] = [];
  const Card = h.load('src/screens/community/CommunityPostCard.tsx', {
    '../../theme/appearance': { useAppearance: () => ({ mode: 'light', colors: { hot: '#EA580C', secondary: '#536170', onScrim: '#fff' } }) },
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    './CommunityParts': {
      CommunityAvatar: ({ display }: any) => React.createElement('Avatar', { kind: display.kind }),
      TierMark: ({ name }: any) => (name ? React.createElement('Text', null, name) : null),
      AssetTagChip: () => React.createElement('AssetTag'),
      CountButton: ({ testID, onPress, count, active, disabled }: any) => React.createElement('Count', { testID, onPress, count, active, disabled }),
      PhotoCountChip: ({ text }: any) => React.createElement('PhotoCount', { text }),
    },
  }).default;
  const renderer = h.render(React.createElement(Card, {
    post: item, now: Date.now(), canModerate, likeBusy: false,
    onOpen: () => calls.push('open'), onOpenAuthor: (id: string) => calls.push(`author:${id}`), onToggleLike: () => calls.push('like'),
  }));
  const pressable = (id: string) => renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === id)[0];
  const text = () => renderer.root.findAllByType('Text').map((node: any) => node.props.children).flat().join(' ');
  return { renderer, calls, pressable, text, close: () => act(() => renderer.unmount()) };
}

describe('community feed card', () => {
  it('a public author is a 44dp button to 유저 시즌 요약; the rest opens the post', t => {
    const h = render(post()); t.after(h.close);
    const author = h.pressable('community-post-p1-author');
    assert.equal(flatten(author.props.style).minHeight, 44);
    act(() => author.props.onPress());
    act(() => h.pressable('community-post-p1-open').props.onPress());
    assert.equal(h.calls.join(','), 'author:author-1,open');
    assert.match(h.text(), /bluechip/);
    assert.match(h.text(), /Gold/);
    assert.match(h.text(), /8분 전/);
    // Only the first photo, with the count chip.
    assert.equal(h.renderer.root.findAllByType('Image').length, 1);
    assert.equal(h.renderer.root.findByType('PhotoCount').props.text, '2');
    const body = h.renderer.root.findAllByType('Text').find((node: any) => node.props.numberOfLines === 3);
    assert.equal(flatten(body.props.style).fontSize, 14);
  });

  it('an anonymous author opens nothing and shows no identity', t => {
    const h = render(post({ author: { kind: 'anonymous', label: '익명' } })); t.after(h.close);
    assert.equal(h.pressable('community-post-p1-author') === undefined, true);
    assert.equal(h.renderer.root.findByType('Avatar').props.kind, 'anonymous');
    assert.match(h.text(), /익명/);
    assert.equal(/bluechip|Gold/.test(h.text()), false);
  });

  it('my own post cannot be liked; operators see the report count', t => {
    const mine = render(post({ mine: true, reportCount: 2 })); t.after(mine.close);
    const like = mine.renderer.root.findAllByType('Count').find((node: any) => node.props.testID === 'community-post-p1-like');
    assert.equal(like.props.onPress === undefined, true);
    assert.equal(/신고/.test(mine.text()), false, 'members never see reports');
    const operator = render(post({ reportCount: 2 }), true); t.after(operator.close);
    assert.match(operator.text(), /신고\s+2/);
    const other = operator.renderer.root.findAllByType('Count').find((node: any) => node.props.testID === 'community-post-p1-like');
    act(() => other.props.onPress());
    assert.equal(operator.calls.join(','), 'like');
  });
});
