import type { CommunityCategory } from '../generated/prisma/client';
import { communityError } from './community-errors';
import { isCommunityHot } from './community-hot.policy';
import { ANONYMOUS_LABEL, DELETED_MEMBER_LABEL } from './community.policy';

/**
 * Response shapes and the ONLY place author identity is decided
 * (docs/community-api-contract.md §3–§4). Builders are pure: callers pass
 * pre-fetched maps. An anonymous author's id, nickname, photo URL or tier is
 * never read from those maps for a member response — only an operator's
 * `adminAuthor` reads the id/nickname of an anonymous author.
 */

export type AuthorUser = {
  id: string;
  nickname: string;
  profileImageUrl: string | null;
};

export type PublicAuthorView = {
  kind: 'public';
  userId: string;
  nickname: string;
  profileImageUrl: string | null;
  tier: string | null;
};
export type AnonymousPostAuthorView = { kind: 'anonymous'; label: string };
export type AnonymousCommentAuthorView = {
  kind: 'anonymous';
  label: string;
  isPostAuthor: boolean;
};
export type DeletedMemberAuthorView = { kind: 'deleted_member'; label: string };
export type AdminAuthorView = { userId: string; nickname: string };

export type AssetView = {
  id: string;
  symbol: string;
  name: string;
  market: string;
  assetType: string;
};

export type PostView = {
  id: string;
  category: CommunityCategory;
  body: string;
  createdAt: string;
  author: PublicAuthorView | AnonymousPostAuthorView;
  asset: AssetView | null;
  photos: { url: string; width: number; height: number }[];
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  mine: boolean;
  isHot: boolean;
  reportCount?: number;
  adminAuthor?: AdminAuthorView;
};

export type CommentView = {
  id: string;
  postId: string;
  parentCommentId: string | null;
  deleted: boolean;
  body: string | null;
  createdAt: string;
  author:
    | PublicAuthorView
    | AnonymousCommentAuthorView
    | DeletedMemberAuthorView
    | null;
  likeCount: number;
  likedByMe: boolean;
  mine: boolean;
  reportCount?: number;
  adminAuthor?: AdminAuthorView;
};

export type Viewer = { userId: string; operator: boolean };

export type PostRow = {
  id: string;
  userId: string;
  category: CommunityCategory;
  body: string;
  anonymous: boolean;
  createdAt: Date;
  asset: AssetView | null;
};

export type PostContext = {
  viewer: Viewer;
  /** Only the post detail carries `adminAuthor` (contract §3.5). */
  includeAdminAuthor: boolean;
  now: Date;
  users: ReadonlyMap<string, AuthorUser>;
  tiers: ReadonlyMap<string, string | null>;
  photos: ReadonlyMap<
    string,
    { objectKey: string; width: number; height: number }[]
  >;
  likes: ReadonlyMap<string, { total: number; others: number }>;
  liked: ReadonlySet<string>;
  comments: ReadonlyMap<string, { total: number; others: number }>;
  reports: ReadonlyMap<string, number>;
  /** null when photo storage is not configured: photos are then omitted. */
  photoUrl: (objectKey: string) => string | null;
};

function publicAuthor(
  userId: string,
  context: Pick<PostContext, 'users' | 'tiers'>,
): PublicAuthorView {
  const user = context.users.get(userId);
  if (!user) throw communityError('COMMUNITY_INTEGRITY');
  return {
    kind: 'public',
    userId: user.id,
    nickname: user.nickname,
    profileImageUrl: user.profileImageUrl,
    tier: context.tiers.get(user.id) ?? null,
  };
}

function adminAuthor(
  userId: string,
  users: ReadonlyMap<string, AuthorUser>,
): AdminAuthorView | undefined {
  const user = users.get(userId);
  return user ? { userId: user.id, nickname: user.nickname } : undefined;
}

export function buildPostView(row: PostRow, context: PostContext): PostView {
  const likes = context.likes.get(row.id) ?? { total: 0, others: 0 };
  const comments = context.comments.get(row.id) ?? { total: 0, others: 0 };
  const photos = (context.photos.get(row.id) ?? []).flatMap((photo) => {
    const url = context.photoUrl(photo.objectKey);
    return url ? [{ url, width: photo.width, height: photo.height }] : [];
  });
  const view: PostView = {
    id: row.id,
    category: row.category,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    author: row.anonymous
      ? { kind: 'anonymous', label: ANONYMOUS_LABEL }
      : publicAuthor(row.userId, context),
    asset: row.asset,
    photos,
    likeCount: likes.total,
    commentCount: comments.total,
    likedByMe: context.liked.has(row.id),
    mine: row.userId === context.viewer.userId,
    isHot: isCommunityHot({
      createdAt: row.createdAt,
      now: context.now,
      likesByOthers: likes.others,
      commentsByOthers: comments.others,
    }),
  };
  if (context.viewer.operator) {
    view.reportCount = context.reports.get(row.id) ?? 0;
    if (row.anonymous && context.includeAdminAuthor) {
      const admin = adminAuthor(row.userId, context.users);
      if (admin) view.adminAuthor = admin;
    }
  }
  return view;
}

export type CommentRow = {
  id: string;
  postId: string;
  userId: string | null;
  parentCommentId: string | null;
  body: string | null;
  anonymous: boolean;
  createdAt: Date;
  deletedAt: Date | null;
  hiddenBySanctionId: string | null;
};

export type CommentContext = {
  viewer: Viewer;
  post: { userId: string; anonymous: boolean };
  /** userId → alias number on this post. */
  aliases: ReadonlyMap<string, number>;
  users: ReadonlyMap<string, AuthorUser>;
  tiers: ReadonlyMap<string, string | null>;
  likes: ReadonlyMap<string, number>;
  liked: ReadonlySet<string>;
  reports: ReadonlyMap<string, number>;
};

export function isVisibleComment(
  row: Pick<CommentRow, 'deletedAt' | 'hiddenBySanctionId'>,
): boolean {
  return row.deletedAt === null && row.hiddenBySanctionId === null;
}

/** The anonymous post's author always comments anonymously as "익명" with
 * the 글쓴이 mark; everyone else anonymous gets their per-post number. */
export function isAnonymousPostAuthor(
  post: { userId: string; anonymous: boolean },
  commentUserId: string | null,
): boolean {
  return (
    post.anonymous && commentUserId !== null && commentUserId === post.userId
  );
}

export function buildCommentView(
  row: CommentRow,
  context: CommentContext,
): CommentView {
  const visible = isVisibleComment(row);
  let author: CommentView['author'] = null;
  if (visible) {
    if (row.userId === null) {
      author = { kind: 'deleted_member', label: DELETED_MEMBER_LABEL };
    } else if (row.anonymous) {
      if (isAnonymousPostAuthor(context.post, row.userId)) {
        author = {
          kind: 'anonymous',
          label: ANONYMOUS_LABEL,
          isPostAuthor: true,
        };
      } else {
        const aliasNo = context.aliases.get(row.userId);
        if (aliasNo === undefined) throw communityError('COMMUNITY_INTEGRITY');
        author = {
          kind: 'anonymous',
          label: `${ANONYMOUS_LABEL}${aliasNo}`,
          isPostAuthor: false,
        };
      }
    } else {
      author = publicAuthor(row.userId, context);
    }
  }
  const view: CommentView = {
    id: row.id,
    postId: row.postId,
    parentCommentId: row.parentCommentId,
    deleted: !visible,
    body: visible ? row.body : null,
    createdAt: row.createdAt.toISOString(),
    author,
    likeCount: visible ? (context.likes.get(row.id) ?? 0) : 0,
    likedByMe: visible && context.liked.has(row.id),
    mine: row.userId !== null && row.userId === context.viewer.userId,
  };
  if (context.viewer.operator) {
    view.reportCount = context.reports.get(row.id) ?? 0;
    if (row.userId !== null && (row.anonymous || !visible)) {
      const admin = adminAuthor(row.userId, context.users);
      if (admin) view.adminAuthor = admin;
    }
  }
  return view;
}
