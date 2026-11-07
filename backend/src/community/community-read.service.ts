import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ProfileImageStorageService } from '../auth/profile-image-storage.service';
import { buildPagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { communityError } from './community-errors';
import { COMMUNITY_HOT_POLICY } from './community-hot.policy';
import { isEntityId } from './community-text';
import { sequential } from './community-sequential';
import { CommunityTierReader } from './community-tier.reader';
import {
  type AuthorUser,
  buildCommentView,
  buildPostView,
  type CommentRow,
  type CommentView,
  isAnonymousPostAuthor,
  isVisibleComment,
  type PostRow,
  type PostView,
  type Viewer,
} from './community-views';
import {
  COMMUNITY_COMMENT_BODY_MAX,
  COMMUNITY_COMMENT_PAGE,
  COMMUNITY_FEED_PAGE,
  COMMUNITY_MAX_OFFSET,
  COMMUNITY_MAX_PHOTOS,
  COMMUNITY_MODERATION_REASONS,
  COMMUNITY_POST_BODY_MAX,
  COMMUNITY_RULES_VERSION,
} from './community.policy';

type Tx = Prisma.TransactionClient;

export type CommunityFeedQuery = {
  category?: string;
  limit?: string;
  offset?: string;
};
export type CommunityCommentsQuery = {
  sort?: string;
  limit?: string;
  offset?: string;
};

const FEED_CATEGORIES = ['all', 'free', 'theory', 'hot'] as const;
type FeedCategory = (typeof FEED_CATEGORIES)[number];
const COMMENT_SORTS = ['latest', 'likes'] as const;
type CommentSort = (typeof COMMENT_SORTS)[number];

export const VISIBLE = {
  deletedAt: null,
  hiddenBySanctionId: null,
} as const;

export const POST_SELECT = {
  id: true,
  userId: true,
  category: true,
  body: true,
  anonymous: true,
  createdAt: true,
  asset: {
    select: {
      id: true,
      symbol: true,
      name: true,
      market: true,
      assetType: true,
    },
  },
} satisfies Prisma.CommunityPostSelect;

export const COMMENT_SELECT = {
  id: true,
  postId: true,
  userId: true,
  parentCommentId: true,
  body: true,
  anonymous: true,
  createdAt: true,
  deletedAt: true,
  hiddenBySanctionId: true,
} satisfies Prisma.CommunityCommentSelect;

export function viewerOf(user: AuthenticatedUser | undefined): Viewer {
  if (!user?.userId) throw communityError('UNAUTHORIZED');
  return {
    userId: user.userId,
    operator: user.role === UserRole.operator || user.role === UserRole.admin,
  };
}

/** The transaction's own start instant (epoch text avoids the timestamp
 * adapter path); every window in one response uses it. */
export async function transactionNow(tx: Pick<Tx, '$queryRaw'>): Promise<Date> {
  const [row] = await tx.$queryRaw<{ epochMs: string }[]>`
    SELECT (extract(epoch FROM transaction_timestamp()) * 1000)::text AS "epochMs"`;
  return new Date(Number(row.epochMs));
}

function pageNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max))
    throw communityError('INVALID_PAGINATION');
  return parsed;
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * Member reads of the community (docs/community-api-contract.md §5): every
 * response's queries run in one RepeatableRead snapshot, pages are hydrated
 * with a constant number of batched queries (no N+1), and author identity
 * goes only through community-views.
 */
@Injectable()
export class CommunityReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiers: CommunityTierReader,
    private readonly storage: ProfileImageStorageService,
  ) {}

  private read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async bootstrap(user: AuthenticatedUser | undefined) {
    const viewer = viewerOf(user);
    return this.read(async (tx) => {
      const now = await transactionNow(tx);
      const [me, consent, sanction] = await sequential([
        () =>
          tx.user.findUnique({
            where: { id: viewer.userId },
            select: { id: true, nickname: true, profileImageUrl: true },
          }),
        () =>
          tx.communityRuleConsent.findUnique({
            where: { userId: viewer.userId },
            select: { rulesVersion: true },
          }),
        () => activeSanctionOf(tx, viewer.userId, now),
      ] as const);
      if (!me) throw communityError('UNAUTHORIZED');
      const tiers = await this.tiers.read(tx, [me.id]);
      return {
        success: true as const,
        data: {
          rulesVersion: COMMUNITY_RULES_VERSION,
          rulesAccepted: consent?.rulesVersion === COMMUNITY_RULES_VERSION,
          reasons: COMMUNITY_MODERATION_REASONS.map((reason) => ({
            code: reason.code,
            label: reason.label,
            description: reason.description,
            noteRequired: reason.noteRequired,
          })),
          maxPhotos: COMMUNITY_MAX_PHOTOS,
          postBodyMaxLength: COMMUNITY_POST_BODY_MAX,
          commentBodyMaxLength: COMMUNITY_COMMENT_BODY_MAX,
          me: {
            userId: me.id,
            nickname: me.nickname,
            profileImageUrl: me.profileImageUrl,
            tier: tiers.get(me.id) ?? null,
          },
          activeSanction: sanction
            ? {
                reason: sanction.reason,
                until: sanction.endsAt?.toISOString() ?? null,
              }
            : null,
        },
      };
    });
  }

  async feed(
    user: AuthenticatedUser | undefined,
    query: CommunityFeedQuery = {},
  ) {
    const viewer = viewerOf(user);
    const category = (query.category || 'all') as FeedCategory;
    if (!FEED_CATEGORIES.includes(category))
      throw communityError('INVALID_COMMUNITY_CATEGORY');
    const limit = pageNumber(
      query.limit,
      COMMUNITY_FEED_PAGE.defaultLimit,
      1,
      COMMUNITY_FEED_PAGE.maxLimit,
    );
    const offset = pageNumber(query.offset, 0, 0, COMMUNITY_MAX_OFFSET);
    return this.read(async (tx) => {
      const now = await transactionNow(tx);
      let rows: PostRow[];
      let total: number;
      if (category === 'hot') {
        const hot = await hotPostIds(tx);
        total = hot.length;
        const ids = hot.slice(offset, offset + limit);
        const found = await tx.communityPost.findMany({
          where: { id: { in: ids } },
          select: POST_SELECT,
        });
        const byId = new Map(found.map((row) => [row.id, row]));
        rows = ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        });
      } else {
        const where: Prisma.CommunityPostWhereInput = {
          ...VISIBLE,
          ...(category === 'all' ? {} : { category }),
        };
        [rows, total] = await sequential([
          () =>
            tx.communityPost.findMany({
              where,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: offset,
              take: limit,
              select: POST_SELECT,
            }),
          () => tx.communityPost.count({ where }),
        ] as const);
      }
      const posts = await this.postViews(tx, rows, viewer, {
        includeAdminAuthor: false,
        now,
      });
      return {
        success: true as const,
        data: {
          posts,
          pagination: buildPagination({
            limit,
            offset,
            total,
            returned: posts.length,
          }),
        },
      };
    });
  }

  async post(user: AuthenticatedUser | undefined, postId: string) {
    const viewer = viewerOf(user);
    return this.read(async (tx) => ({
      success: true as const,
      data: { post: await this.renderPost(tx, viewer, postId) },
    }));
  }

  /** One visible post as the detail screen sees it (404 otherwise). */
  async renderPost(tx: Tx, viewer: Viewer, postId: string): Promise<PostView> {
    const row = isEntityId(postId)
      ? await tx.communityPost.findFirst({
          where: { id: postId, ...VISIBLE },
          select: POST_SELECT,
        })
      : null;
    if (!row) throw communityError('COMMUNITY_POST_NOT_FOUND');
    const now = await transactionNow(tx);
    const [view] = await this.postViews(tx, [row], viewer, {
      includeAdminAuthor: true,
      now,
    });
    return view;
  }

  async comments(
    user: AuthenticatedUser | undefined,
    postId: string,
    query: CommunityCommentsQuery = {},
  ) {
    const viewer = viewerOf(user);
    const sort = (query.sort || 'latest') as CommentSort;
    if (!COMMENT_SORTS.includes(sort))
      throw communityError('INVALID_COMMUNITY_SORT');
    const limit = pageNumber(
      query.limit,
      COMMUNITY_COMMENT_PAGE.defaultLimit,
      1,
      COMMUNITY_COMMENT_PAGE.maxLimit,
    );
    const offset = pageNumber(query.offset, 0, 0, COMMUNITY_MAX_OFFSET);
    return this.read(async (tx) => {
      const post = isEntityId(postId)
        ? await tx.communityPost.findFirst({
            where: { id: postId, ...VISIBLE },
            select: { id: true, userId: true, anonymous: true },
          })
        : null;
      if (!post) throw communityError('COMMUNITY_POST_NOT_FOUND');
      const [total, ordered] = await sequential([
        () => tx.communityComment.count({ where: { postId: post.id } }),
        () => orderedCommentIds(tx, post.id, sort, limit, offset),
      ] as const);
      const found = await tx.communityComment.findMany({
        where: { id: { in: ordered } },
        select: COMMENT_SELECT,
      });
      const byId = new Map(found.map((row) => [row.id, row]));
      const rows = ordered.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
      const comments = await this.commentViews(tx, rows, post, viewer);
      return {
        success: true as const,
        data: {
          comments,
          pagination: buildPagination({
            limit,
            offset,
            total,
            returned: comments.length,
          }),
        },
      };
    });
  }

  /** One comment of a visible post, as the comment list would show it. */
  async renderComment(tx: Tx, viewer: Viewer, commentId: string) {
    const row = await tx.communityComment.findUnique({
      where: { id: commentId },
      select: {
        ...COMMENT_SELECT,
        post: { select: { userId: true, anonymous: true } },
      },
    });
    if (!row) throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
    const { post, ...comment } = row;
    const [view] = await this.commentViews(tx, [comment], post, viewer);
    return view;
  }

  private photoUrl = (objectKey: string): string | null =>
    this.storage.isConfigured() ? this.storage.publicUrl(objectKey) : null;

  private async postViews(
    tx: Tx,
    rows: PostRow[],
    viewer: Viewer,
    options: { includeAdminAuthor: boolean; now: Date },
  ): Promise<PostView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const publicAuthorIds = unique(
      rows.filter((row) => !row.anonymous).map((row) => row.userId),
    );
    const adminIds =
      viewer.operator && options.includeAdminAuthor
        ? rows.filter((row) => row.anonymous).map((row) => row.userId)
        : [];
    const [likes, liked, comments, photos, reports, users, tiers] =
      await sequential([
        () => tx.$queryRaw<{ postId: string; total: number; others: number }[]>`
          SELECT l.post_id AS "postId", count(*)::int AS total,
                 count(*) FILTER (WHERE l.user_id <> p.user_id)::int AS others
          FROM community_post_likes l
          JOIN community_posts p ON p.id = l.post_id
          WHERE l.post_id = ANY(${ids}::text[])
          GROUP BY l.post_id`,
        () =>
          tx.communityPostLike.findMany({
            where: { userId: viewer.userId, postId: { in: ids } },
            select: { postId: true },
          }),
        () => tx.$queryRaw<{ postId: string; total: number; others: number }[]>`
          SELECT c.post_id AS "postId", count(*)::int AS total,
                 count(*) FILTER (WHERE c.user_id IS DISTINCT FROM p.user_id)::int AS others
          FROM community_comments c
          JOIN community_posts p ON p.id = c.post_id
          WHERE c.post_id = ANY(${ids}::text[])
            AND c.deleted_at IS NULL AND c.hidden_by_sanction_id IS NULL
          GROUP BY c.post_id`,
        () =>
          tx.communityPostPhoto.findMany({
            where: { postId: { in: ids } },
            orderBy: [{ postId: 'asc' }, { position: 'asc' }],
            select: {
              postId: true,
              objectKey: true,
              width: true,
              height: true,
            },
          }),
        () =>
          viewer.operator
            ? tx.communityReport.groupBy({
                by: ['postId'],
                where: { postId: { in: ids } },
                _count: { _all: true },
              })
            : Promise.resolve([]),
        () =>
          tx.user.findMany({
            where: { id: { in: unique([...publicAuthorIds, ...adminIds]) } },
            select: { id: true, nickname: true, profileImageUrl: true },
          }),
        () => this.tiers.read(tx, publicAuthorIds),
      ] as const);
    const photoMap = new Map<
      string,
      { objectKey: string; width: number; height: number }[]
    >();
    for (const photo of photos) {
      const list = photoMap.get(photo.postId) ?? [];
      list.push(photo);
      photoMap.set(photo.postId, list);
    }
    const context = {
      viewer,
      includeAdminAuthor: options.includeAdminAuthor,
      now: options.now,
      users: new Map<string, AuthorUser>(users.map((u) => [u.id, u])),
      tiers,
      photos: photoMap,
      likes: new Map(likes.map((row) => [row.postId, row])),
      liked: new Set(liked.map((row) => row.postId)),
      comments: new Map(comments.map((row) => [row.postId, row])),
      reports: new Map(
        (reports as { postId: string | null; _count: { _all: number } }[])
          .filter((row) => row.postId)
          .map((row) => [row.postId as string, row._count._all]),
      ),
      photoUrl: this.photoUrl,
    };
    return rows.map((row) => buildPostView(row, context));
  }

  private async commentViews(
    tx: Tx,
    rows: CommentRow[],
    post: { id?: string; userId: string; anonymous: boolean },
    viewer: Viewer,
  ): Promise<CommentView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const visible = rows.filter(isVisibleComment);
    const visibleIds = visible.map((row) => row.id);
    const aliasUserIds = unique(
      visible
        .filter(
          (row) =>
            row.anonymous &&
            row.userId !== null &&
            !isAnonymousPostAuthor(post, row.userId),
        )
        .map((row) => row.userId as string),
    );
    const publicAuthorIds = unique(
      visible
        .filter((row) => !row.anonymous && row.userId !== null)
        .map((row) => row.userId as string),
    );
    const adminIds = viewer.operator
      ? rows
          .filter(
            (row) =>
              row.userId !== null && (row.anonymous || !isVisibleComment(row)),
          )
          .map((row) => row.userId as string)
      : [];
    const postId = rows[0].postId;
    const [likes, liked, aliases, reports, users, tiers] = await sequential([
      () =>
        tx.communityCommentLike.groupBy({
          by: ['commentId'],
          where: { commentId: { in: visibleIds } },
          _count: { _all: true },
        }),
      () =>
        tx.communityCommentLike.findMany({
          where: { userId: viewer.userId, commentId: { in: visibleIds } },
          select: { commentId: true },
        }),
      () =>
        tx.communityPostAlias.findMany({
          where: { postId, userId: { in: aliasUserIds } },
          select: { userId: true, aliasNo: true },
        }),
      () =>
        viewer.operator
          ? tx.communityReport.groupBy({
              by: ['commentId'],
              where: { commentId: { in: ids } },
              _count: { _all: true },
            })
          : Promise.resolve([]),
      () =>
        tx.user.findMany({
          where: { id: { in: unique([...publicAuthorIds, ...adminIds]) } },
          select: { id: true, nickname: true, profileImageUrl: true },
        }),
      () => this.tiers.read(tx, publicAuthorIds),
    ] as const);
    const context = {
      viewer,
      post: { userId: post.userId, anonymous: post.anonymous },
      aliases: new Map(aliases.map((row) => [row.userId, row.aliasNo])),
      users: new Map<string, AuthorUser>(users.map((u) => [u.id, u])),
      tiers,
      likes: new Map(likes.map((row) => [row.commentId, row._count._all])),
      liked: new Set(liked.map((row) => row.commentId)),
      reports: new Map(
        (reports as { commentId: string | null; _count: { _all: number } }[])
          .filter((row) => row.commentId)
          .map((row) => [row.commentId as string, row._count._all]),
      ),
    };
    return rows.map((row) => buildCommentView(row, context));
  }
}

/** The member's active restriction at `now`, if any. */
export function activeSanctionOf(
  tx: Pick<Tx, 'communitySanction'>,
  userId: string,
  now: Date,
) {
  return tx.communitySanction.findFirst({
    where: {
      userId,
      revokedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** HOT ids in order (contract §7): one query over the visible posts of the
 * window; weights and thresholds come from COMMUNITY_HOT_POLICY. */
async function hotPostIds(tx: Tx): Promise<string[]> {
  const policy = COMMUNITY_HOT_POLICY;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM community_posts p
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM community_post_likes l
      WHERE l.post_id = p.id AND l.user_id <> p.user_id) likes
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM community_comments c
      WHERE c.post_id = p.id
        AND c.deleted_at IS NULL AND c.hidden_by_sanction_id IS NULL
        AND c.user_id IS DISTINCT FROM p.user_id) comments
    WHERE p.deleted_at IS NULL AND p.hidden_by_sanction_id IS NULL
      AND p.created_at > timezone('UTC', transaction_timestamp())
        - make_interval(hours => ${policy.windowHours}::int)
      AND likes.n * ${policy.likeWeight}::int
        + comments.n * ${policy.commentWeight}::int >= ${policy.minScore}::int
    ORDER BY likes.n * ${policy.likeWeight}::int
        + comments.n * ${policy.commentWeight}::int DESC,
      p.created_at DESC, p.id DESC
    LIMIT ${policy.maxPosts}::int`;
  return rows.map((row) => row.id);
}

/** Flat thread page (contract §5.3): top-level comments by `sort`, each
 * followed by its replies oldest first. Two fixed statements: no dynamic SQL. */
async function orderedCommentIds(
  tx: Tx,
  postId: string,
  sort: CommentSort,
  limit: number,
  offset: number,
): Promise<string[]> {
  const rows =
    sort === 'likes'
      ? await tx.$queryRaw<{ id: string }[]>`
          WITH roots AS (
            SELECT r.id, r.created_at,
              CASE WHEN r.deleted_at IS NULL AND r.hidden_by_sanction_id IS NULL
                THEN (SELECT count(*) FROM community_comment_likes l WHERE l.comment_id = r.id)
                ELSE 0 END AS likes
            FROM community_comments r
            WHERE r.post_id = ${postId} AND r.parent_comment_id IS NULL)
          SELECT c.id FROM community_comments c
          JOIN roots ON roots.id = COALESCE(c.parent_comment_id, c.id)
          WHERE c.post_id = ${postId}
          ORDER BY roots.likes DESC, roots.created_at DESC, roots.id DESC,
            (c.parent_comment_id IS NOT NULL), c.created_at, c.id
          LIMIT ${limit}::int OFFSET ${offset}::int`
      : await tx.$queryRaw<{ id: string }[]>`
          WITH roots AS (
            SELECT r.id, r.created_at FROM community_comments r
            WHERE r.post_id = ${postId} AND r.parent_comment_id IS NULL)
          SELECT c.id FROM community_comments c
          JOIN roots ON roots.id = COALESCE(c.parent_comment_id, c.id)
          WHERE c.post_id = ${postId}
          ORDER BY roots.created_at DESC, roots.id DESC,
            (c.parent_comment_id IS NOT NULL), c.created_at, c.id
          LIMIT ${limit}::int OFFSET ${offset}::int`;
  return rows.map((row) => row.id);
}
