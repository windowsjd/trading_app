import {
  buildCommentView,
  buildPostView,
  type CommentContext,
  type CommentRow,
  type PostContext,
  type PostRow,
} from './community-views';

const author = {
  id: 'user-anon-author-7f3a',
  nickname: 'secret-nickname-9b1c',
  profileImageUrl:
    'https://cdn.example/profile-images/user-anon-author-7f3a/p.jpg',
};
const commenter = {
  id: 'user-commenter-22aa',
  nickname: 'hidden-commenter-55dd',
  profileImageUrl:
    'https://cdn.example/profile-images/user-commenter-22aa/q.jpg',
};
const publicUser = {
  id: 'user-public-1',
  nickname: 'bluechip',
  profileImageUrl: null,
};
const users = new Map([
  [author.id, author],
  [commenter.id, commenter],
  [publicUser.id, publicUser],
]);
const tiers = new Map<string, string | null>([
  [author.id, 'master'],
  [commenter.id, 'diamond'],
  [publicUser.id, 'gold'],
]);
const now = new Date('2026-11-07T12:00:00.000Z');

function postContext(
  viewer: { userId: string; operator: boolean },
  admin = false,
): PostContext {
  return {
    viewer,
    includeAdminAuthor: admin,
    now,
    users,
    tiers,
    photos: new Map([
      [
        'post-1',
        [
          {
            objectKey:
              'community-images/0d1c7a7e-6c2b-4d55-9a53-0f1f8f6d2a10.jpg',
            width: 1280,
            height: 960,
          },
        ],
      ],
    ]),
    likes: new Map([['post-1', { total: 2, others: 2 }]]),
    liked: new Set<string>(),
    comments: new Map([['post-1', { total: 1, others: 1 }]]),
    reports: new Map([['post-1', 4]]),
    photoUrl: (key) => `https://cdn.example/${key}`,
  };
}

const anonymousPost: PostRow = {
  id: 'post-1',
  userId: author.id,
  category: 'free',
  body: '시즌 수익률이 마이너스예요',
  anonymous: true,
  createdAt: new Date('2026-11-07T11:00:00.000Z'),
  asset: null,
};

function commentRow(overrides: Partial<CommentRow>): CommentRow {
  return {
    id: 'comment-1',
    postId: 'post-1',
    userId: commenter.id,
    parentCommentId: null,
    body: '저도 그래요',
    anonymous: true,
    createdAt: new Date('2026-11-07T11:30:00.000Z'),
    deletedAt: null,
    hiddenBySanctionId: null,
    ...overrides,
  };
}

function commentContext(
  viewer: { userId: string; operator: boolean },
  aliases = new Map([[commenter.id, 3]]),
): CommentContext {
  return {
    viewer,
    post: { userId: author.id, anonymous: true },
    aliases,
    users,
    tiers,
    likes: new Map([['comment-1', 5]]),
    liked: new Set(['comment-1']),
    reports: new Map([['comment-1', 1]]),
  };
}

/** No identifying string of `who` anywhere in the serialized response. */
function leaks(value: unknown, who: typeof author): string[] {
  const json = JSON.stringify(value);
  return [who.id, who.nickname, who.profileImageUrl].filter((needle) =>
    json.includes(needle),
  );
}

describe('community author display', () => {
  const member = { userId: 'user-reader', operator: false };
  const operator = { userId: 'user-operator', operator: true };

  it('never puts an anonymous post author into a member response', () => {
    const view = buildPostView(anonymousPost, postContext(member));
    expect(view.author.kind).toBe('anonymous');
    expect(leaks(view, author)).toEqual([]);
    expect('adminAuthor' in view).toBe(false);
    expect('reportCount' in view).toBe(false);
    // The photo URL carries neither the member nor the post id.
    expect(view.photos[0].url.includes(author.id)).toBe(false);
    expect(view.photos[0].url.includes('post-1')).toBe(false);
  });

  it('keeps the anonymous author hidden from the author too (mine only)', () => {
    const view = buildPostView(
      anonymousPost,
      postContext({ userId: author.id, operator: false }),
    );
    expect(view.mine).toBe(true);
    expect(view.author.kind).toBe('anonymous');
    expect(leaks(view, author)).toEqual([]);
  });

  it('gives operators adminAuthor on the detail only, and report counts', () => {
    const feed = buildPostView(anonymousPost, postContext(operator, false));
    expect('adminAuthor' in feed).toBe(false);
    expect(feed.reportCount).toBe(4);
    const detail = buildPostView(anonymousPost, postContext(operator, true));
    expect(detail.adminAuthor?.userId).toBe(author.id);
    expect(detail.adminAuthor?.nickname).toBe(author.nickname);
  });

  it('shows a public author with tier, and HOT when the score is met', () => {
    const view = buildPostView(
      { ...anonymousPost, anonymous: false, userId: publicUser.id },
      postContext(member),
    );
    expect(view.author.kind).toBe('public');
    if (view.author.kind !== 'public') return;
    expect(view.author.nickname).toBe('bluechip');
    expect(view.author.tier).toBe('gold');
    // 2 likes + 2 × 1 comment = 4 ≥ 3 within 24 h.
    expect(view.isHot).toBe(true);
  });

  it('numbers other anonymous commenters and never leaks them', () => {
    const view = buildCommentView(commentRow({}), commentContext(member));
    expect(view.author?.kind).toBe('anonymous');
    if (view.author?.kind !== 'anonymous') return;
    expect(view.author.label).toBe('익명3');
    expect(view.author.isPostAuthor).toBe(false);
    expect(leaks(view, commenter)).toEqual([]);
  });

  it('marks the anonymous post author as 글쓴이 without a number', () => {
    const view = buildCommentView(
      commentRow({ userId: author.id }),
      commentContext(member, new Map()),
    );
    if (view.author?.kind !== 'anonymous')
      throw new Error('anonymous expected');
    expect(view.author.label).toBe('익명');
    expect(view.author.isPostAuthor).toBe(true);
    expect(leaks(view, author)).toEqual([]);
  });

  it('gives a public post author commenting anonymously only a number', () => {
    const view = buildCommentView(commentRow({ userId: author.id }), {
      ...commentContext(member, new Map([[author.id, 1]])),
      post: { userId: author.id, anonymous: false },
    });
    if (view.author?.kind !== 'anonymous')
      throw new Error('anonymous expected');
    expect(view.author.label).toBe('익명1');
    expect(view.author.isPostAuthor).toBe(false);
  });

  it('shows comments of deleted accounts as 탈퇴계정', () => {
    const view = buildCommentView(
      commentRow({ userId: null, anonymous: false }),
      commentContext(operator),
    );
    expect(view.author?.kind).toBe('deleted_member');
    expect(view.author?.label).toBe('탈퇴계정');
    expect(view.mine).toBe(false);
    expect('adminAuthor' in view).toBe(false);
    expect(view.body).toBe('저도 그래요');
  });

  it('keeps a deleted or hidden comment as an empty placeholder', () => {
    for (const row of [
      commentRow({ deletedAt: now }),
      commentRow({ hiddenBySanctionId: 'sanction-1' }),
    ]) {
      const view = buildCommentView(row, commentContext(member));
      expect(view.deleted).toBe(true);
      expect(view.body === null).toBe(true);
      expect(view.author === null).toBe(true);
      expect(view.likeCount).toBe(0);
      expect(view.likedByMe).toBe(false);
      expect(leaks(view, commenter)).toEqual([]);
    }
    const forOperator = buildCommentView(
      commentRow({ deletedAt: now, anonymous: false }),
      commentContext(operator),
    );
    expect(forOperator.adminAuthor?.userId).toBe(commenter.id);
  });

  it('refuses to invent a number when the alias row is missing', () => {
    expect(() =>
      buildCommentView(commentRow({}), commentContext(member, new Map())),
    ).toThrow();
  });
});
