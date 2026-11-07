import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ProfileImageStorageService } from '../auth/profile-image-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { communityError } from './community-errors';
import { CommunityPhotoCleanupService } from './community-photo-cleanup.service';
import {
  type CommunityPhoto,
  type CommunityUploadedFile,
  validateCommunityPhotos,
} from './community-photo.validation';
import {
  activeSanctionOf,
  CommunityReadService,
  transactionNow,
  viewerOf,
} from './community-read.service';
import {
  containsBlockedLink,
  isClientRequestId,
  isEntityId,
  parseCommunityText,
  parseOptionalNote,
} from './community-text';
import { isAnonymousPostAuthor, type Viewer } from './community-views';
import {
  COMMUNITY_COMMENT_BODY_MAX,
  COMMUNITY_DUPLICATE_WINDOW_MS,
  COMMUNITY_NOTE_MAX,
  COMMUNITY_PHOTO_CACHE_CONTROL,
  COMMUNITY_PHOTO_KEY_PREFIX,
  COMMUNITY_POST_BODY_MAX,
  COMMUNITY_RATE_LIMITS,
  COMMUNITY_RULES_VERSION,
  isCommunityReason,
} from './community.policy';

type Tx = Prisma.TransactionClient;

type PostInput = {
  clientRequestId: string;
  category: 'free' | 'theory';
  body: string;
  anonymous: boolean;
  assetId: string | null;
};
type CommentInput = {
  clientRequestId: string;
  body: string;
  anonymous: boolean;
  parentCommentId: string | null;
};

const PAYLOAD_MAX_LENGTH = 16 * 1024;
const NOT_AUTHOR_DELETED = {
  OR: [{ deletionKind: null }, { deletionKind: 'operator' as const }],
};

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parsePostPayload(payload: unknown): PostInput {
  if (typeof payload !== 'string' || payload.length > PAYLOAD_MAX_LENGTH)
    throw communityError('INVALID_COMMUNITY_POST');
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw communityError('INVALID_COMMUNITY_POST');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw communityError('INVALID_COMMUNITY_POST');
  const input = raw as Record<string, unknown>;
  const body = parseCommunityText(input.body, COMMUNITY_POST_BODY_MAX);
  const assetId = input.assetId ?? null;
  if (
    !isClientRequestId(input.clientRequestId) ||
    (input.category !== 'free' && input.category !== 'theory') ||
    body === null ||
    typeof input.anonymous !== 'boolean' ||
    (assetId !== null && !isEntityId(assetId))
  )
    throw communityError('INVALID_COMMUNITY_POST');
  if (containsBlockedLink(body))
    throw communityError('COMMUNITY_LINK_NOT_ALLOWED');
  return {
    clientRequestId: input.clientRequestId,
    category: input.category,
    body,
    anonymous: input.anonymous,
    assetId: assetId,
  };
}

export function parseCommentBody(value: unknown): CommentInput {
  const input = record(value);
  const body = parseCommunityText(input.body, COMMUNITY_COMMENT_BODY_MAX);
  const parentCommentId = input.parentCommentId ?? null;
  if (
    !isClientRequestId(input.clientRequestId) ||
    body === null ||
    typeof input.anonymous !== 'boolean' ||
    (parentCommentId !== null && !isEntityId(parentCommentId))
  )
    throw communityError('INVALID_COMMUNITY_COMMENT');
  if (containsBlockedLink(body))
    throw communityError('COMMUNITY_LINK_NOT_ALLOWED');
  return {
    clientRequestId: input.clientRequestId,
    body,
    anonymous: input.anonymous,
    parentCommentId: parentCommentId,
  };
}

/** Consent and restriction at `now` (contract §6.4–§6.5). */
export async function assertCommunityWriteAllowed(
  tx: Pick<Tx, 'communityRuleConsent' | 'communitySanction'>,
  userId: string,
  now: Date,
): Promise<void> {
  const consent = await tx.communityRuleConsent.findUnique({
    where: { userId },
    select: { rulesVersion: true },
  });
  const sanction = await activeSanctionOf(tx, userId, now);
  if (consent?.rulesVersion !== COMMUNITY_RULES_VERSION)
    throw communityError('COMMUNITY_RULES_NOT_ACCEPTED');
  if (sanction)
    throw communityError('COMMUNITY_RESTRICTED', {
      reason: sanction.reason,
      until: sanction.endsAt?.toISOString() ?? null,
    });
}

/**
 * Member writes of the community (docs/community-api-contract.md §5–§6,
 * §10–§11). Every creating write locks the writer's users row FOR SHARE and
 * re-reads consent and restriction under it, so it serializes with a sanction
 * (which hides content under the same row's FOR NO KEY UPDATE) and with an
 * account deletion. Lock order: users → post → comment.
 */
@Injectable()
export class CommunityWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly read: CommunityReadService,
    private readonly cleanups: CommunityPhotoCleanupService,
    private readonly storage: ProfileImageStorageService,
  ) {}

  private render<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  /** The writer's row FOR SHARE, then consent/restriction under it. */
  private async lockWriter(tx: Tx, userId: string): Promise<Date> {
    const [user] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId} FOR SHARE`;
    if (!user) throw communityError('UNAUTHORIZED');
    const now = await transactionNow(tx);
    await assertCommunityWriteAllowed(tx, userId, now);
    return now;
  }

  async createPost(
    user: AuthenticatedUser | undefined,
    body: unknown,
    files: CommunityUploadedFile[] | undefined,
  ) {
    const viewer = viewerOf(user);
    const input = parsePostPayload(record(body).payload);
    const photos = validateCommunityPhotos(files);
    const replay = await this.postReplay(viewer, input, photos);
    if (replay) return replay;

    // Fail fast before any storage write; repeated under the lock below.
    await this.prisma.$transaction(async (tx) => {
      const now = await transactionNow(tx);
      await assertCommunityWriteAllowed(tx, viewer.userId, now);
      if (input.assetId) {
        const asset = await tx.asset.findFirst({
          where: { id: input.assetId, isActive: true },
          select: { id: true },
        });
        if (!asset) throw communityError('INVALID_COMMUNITY_POST');
      }
      const limit = COMMUNITY_RATE_LIMITS.post;
      const recent = await tx.communityPost.count({
        where: {
          userId: viewer.userId,
          createdAt: { gte: new Date(now.getTime() - limit.windowMs) },
        },
      });
      if (recent >= limit.count) throw communityError('COMMUNITY_RATE_LIMITED');
      const duplicate = await tx.communityPost.findFirst({
        where: {
          userId: viewer.userId,
          body: input.body,
          createdAt: {
            gte: new Date(now.getTime() - COMMUNITY_DUPLICATE_WINDOW_MS),
          },
          ...NOT_AUTHOR_DELETED,
        },
        select: { id: true },
      });
      if (duplicate) throw communityError('COMMUNITY_DUPLICATE_CONTENT');
    });

    const keys = photos.map(
      () => `${COMMUNITY_PHOTO_KEY_PREFIX}${randomUUID()}.jpg`,
    );
    if (photos.length > 0) {
      if (!this.storage.isConfigured())
        throw communityError('COMMUNITY_PHOTO_STORAGE_UNAVAILABLE');
      await this.cleanups.reserveUploads(viewer.userId, keys);
      const uploads = await Promise.allSettled(
        photos.map((photo, index) =>
          this.storage.upload(
            keys[index],
            photo.bytes,
            COMMUNITY_PHOTO_CACHE_CONTROL,
          ),
        ),
      );
      if (uploads.some((result) => result.status === 'rejected')) {
        await this.cleanups.processNow(keys);
        throw communityError('COMMUNITY_PHOTO_UPLOAD_FAILED');
      }
    }

    let postId: string;
    try {
      postId = await this.prisma.$transaction(async (tx) => {
        await this.lockWriter(tx, viewer.userId);
        if (!(await this.cleanups.claimUploads(tx, viewer.userId, keys)))
          throw communityError('COMMUNITY_PHOTO_UPLOAD_FAILED');
        const post = await tx.communityPost.create({
          data: {
            userId: viewer.userId,
            clientRequestId: input.clientRequestId,
            category: input.category,
            body: input.body,
            anonymous: input.anonymous,
            assetId: input.assetId,
          },
          select: { id: true },
        });
        if (photos.length > 0)
          await tx.communityPostPhoto.createMany({
            data: photos.map((photo, index) => ({
              postId: post.id,
              position: index,
              objectKey: keys[index],
              width: photo.width,
              height: photo.height,
              byteSize: photo.byteSize,
              sha256: photo.sha256,
            })),
          });
        return post.id;
      });
    } catch (error) {
      // Nothing committed: the uploaded objects and their leases go.
      if (keys.length > 0) await this.cleanups.processNow(keys);
      if (isUniqueViolation(error)) {
        const winner = await this.postReplay(viewer, input, photos);
        if (winner) return winner;
      }
      throw error;
    }
    const post = await this.render((tx) =>
      this.read.renderPost(tx, viewer, postId),
    );
    return { success: true as const, data: { post, replayed: false } };
  }

  /** Same member + request id: the stored post when the content matches. */
  private async postReplay(
    viewer: Viewer,
    input: PostInput,
    photos: CommunityPhoto[],
  ) {
    const existing = await this.prisma.communityPost.findUnique({
      where: {
        userId_clientRequestId: {
          userId: viewer.userId,
          clientRequestId: input.clientRequestId,
        },
      },
      select: {
        id: true,
        category: true,
        body: true,
        anonymous: true,
        assetId: true,
        deletedAt: true,
        hiddenBySanctionId: true,
        photos: { orderBy: { position: 'asc' }, select: { sha256: true } },
      },
    });
    if (!existing) return null;
    const same =
      existing.category === input.category &&
      existing.body === input.body &&
      existing.anonymous === input.anonymous &&
      existing.assetId === input.assetId &&
      existing.photos.length === photos.length &&
      existing.photos.every(
        (photo, index) => photo.sha256 === photos[index].sha256,
      );
    if (!same) throw communityError('COMMUNITY_IDEMPOTENCY_CONFLICT');
    if (existing.deletedAt || existing.hiddenBySanctionId)
      throw communityError('COMMUNITY_POST_NOT_FOUND');
    const post = await this.render((tx) =>
      this.read.renderPost(tx, viewer, existing.id),
    );
    return { success: true as const, data: { post, replayed: true } };
  }

  async deletePost(user: AuthenticatedUser | undefined, postId: string) {
    const viewer = viewerOf(user);
    if (!isEntityId(postId)) throw communityError('COMMUNITY_POST_NOT_FOUND');
    const keys = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM community_posts WHERE id = ${postId} FOR NO KEY UPDATE`;
      const row = locked
        ? await tx.communityPost.findUnique({
            where: { id: postId },
            select: {
              userId: true,
              deletionKind: true,
              hiddenBySanctionId: true,
            },
          })
        : null;
      if (
        !row ||
        row.userId !== viewer.userId ||
        row.hiddenBySanctionId ||
        row.deletionKind === 'operator'
      )
        throw communityError('COMMUNITY_POST_NOT_FOUND');
      if (row.deletionKind === 'author') return [];
      const now = await transactionNow(tx);
      await tx.communityPost.update({
        where: { id: postId },
        data: { deletedAt: now, deletionKind: 'author' },
      });
      const photos = await tx.communityPostPhoto.findMany({
        where: { postId },
        select: { objectKey: true },
      });
      const objectKeys = photos.map((photo) => photo.objectKey);
      await this.cleanups.enqueue(tx, objectKeys, now);
      return objectKeys;
    });
    await this.cleanups.processNow(keys);
    return { success: true as const, data: { postId, deleted: true as const } };
  }

  async setPostLike(
    user: AuthenticatedUser | undefined,
    postId: string,
    liked: boolean,
  ) {
    const viewer = viewerOf(user);
    if (!isEntityId(postId)) throw communityError('COMMUNITY_POST_NOT_FOUND');
    const likeCount = await this.prisma.$transaction(async (tx) => {
      if (liked) await this.lockWriter(tx, viewer.userId);
      const [post] = await tx.$queryRaw<{ userId: string }[]>`
        SELECT user_id AS "userId" FROM community_posts
        WHERE id = ${postId} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
        FOR SHARE`;
      if (!post) throw communityError('COMMUNITY_POST_NOT_FOUND');
      if (liked) {
        if (post.userId === viewer.userId)
          throw communityError('COMMUNITY_SELF_REACTION');
        await tx.communityPostLike.createMany({
          data: [{ postId, userId: viewer.userId }],
          skipDuplicates: true,
        });
      } else {
        await tx.communityPostLike.deleteMany({
          where: { postId, userId: viewer.userId },
        });
      }
      return tx.communityPostLike.count({ where: { postId } });
    });
    return { success: true as const, data: { liked, likeCount } };
  }

  async createComment(
    user: AuthenticatedUser | undefined,
    postId: string,
    body: unknown,
  ) {
    const viewer = viewerOf(user);
    const input = parseCommentBody(body);
    const post = isEntityId(postId)
      ? await this.prisma.communityPost.findUnique({
          where: { id: postId },
          select: {
            id: true,
            userId: true,
            anonymous: true,
            deletedAt: true,
            hiddenBySanctionId: true,
          },
        })
      : null;
    if (!post || post.deletedAt || post.hiddenBySanctionId)
      throw communityError('COMMUNITY_POST_NOT_FOUND');
    // The anonymous post's author can never reveal themselves in a comment.
    const anonymous = isAnonymousPostAuthor(post, viewer.userId)
      ? true
      : input.anonymous;
    const replay = await this.commentReplay(viewer, post.id, input, anonymous);
    if (replay) return replay;

    await this.prisma.$transaction(async (tx) => {
      const now = await transactionNow(tx);
      await assertCommunityWriteAllowed(tx, viewer.userId, now);
      const limit = COMMUNITY_RATE_LIMITS.comment;
      const recent = await tx.communityComment.count({
        where: {
          userId: viewer.userId,
          createdAt: { gte: new Date(now.getTime() - limit.windowMs) },
        },
      });
      if (recent >= limit.count) throw communityError('COMMUNITY_RATE_LIMITED');
      const duplicate = await tx.communityComment.findFirst({
        where: {
          userId: viewer.userId,
          postId: post.id,
          body: input.body,
          createdAt: {
            gte: new Date(now.getTime() - COMMUNITY_DUPLICATE_WINDOW_MS),
          },
          ...NOT_AUTHOR_DELETED,
        },
        select: { id: true },
      });
      if (duplicate) throw communityError('COMMUNITY_DUPLICATE_CONTENT');
    });

    let commentId: string;
    try {
      commentId = await this.prisma.$transaction(async (tx) => {
        await this.lockWriter(tx, viewer.userId);
        // The post row lock serializes this post's alias numbering.
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM community_posts
          WHERE id = ${post.id} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
          FOR NO KEY UPDATE`;
        if (!locked) throw communityError('COMMUNITY_POST_NOT_FOUND');
        if (input.parentCommentId) {
          const parent = await tx.communityComment.findUnique({
            where: { id: input.parentCommentId },
            select: {
              postId: true,
              parentCommentId: true,
              deletedAt: true,
              hiddenBySanctionId: true,
            },
          });
          if (
            !parent ||
            parent.postId !== post.id ||
            parent.deletedAt ||
            parent.hiddenBySanctionId
          )
            throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
          if (parent.parentCommentId !== null)
            throw communityError('INVALID_COMMUNITY_COMMENT');
        }
        if (anonymous && !isAnonymousPostAuthor(post, viewer.userId))
          await ensureAlias(tx, post.id, viewer.userId);
        const created = await tx.communityComment.create({
          data: {
            postId: post.id,
            userId: viewer.userId,
            parentCommentId: input.parentCommentId,
            clientRequestId: input.clientRequestId,
            body: input.body,
            anonymous,
          },
          select: { id: true },
        });
        return created.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.commentReplay(
          viewer,
          post.id,
          input,
          anonymous,
        );
        if (winner) return winner;
      }
      throw error;
    }
    const comment = await this.render((tx) =>
      this.read.renderComment(tx, viewer, commentId),
    );
    return { success: true as const, data: { comment, replayed: false } };
  }

  private async commentReplay(
    viewer: Viewer,
    postId: string,
    input: CommentInput,
    anonymous: boolean,
  ) {
    const existing = await this.prisma.communityComment.findUnique({
      where: {
        userId_clientRequestId: {
          userId: viewer.userId,
          clientRequestId: input.clientRequestId,
        },
      },
      select: {
        id: true,
        postId: true,
        parentCommentId: true,
        body: true,
        anonymous: true,
      },
    });
    if (!existing) return null;
    if (
      existing.postId !== postId ||
      existing.parentCommentId !== input.parentCommentId ||
      existing.body !== input.body ||
      existing.anonymous !== anonymous
    )
      throw communityError('COMMUNITY_IDEMPOTENCY_CONFLICT');
    const comment = await this.render((tx) =>
      this.read.renderComment(tx, viewer, existing.id),
    );
    return { success: true as const, data: { comment, replayed: true } };
  }

  async deleteComment(user: AuthenticatedUser | undefined, commentId: string) {
    const viewer = viewerOf(user);
    if (!isEntityId(commentId))
      throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.communityComment.findUnique({
        where: { id: commentId },
        select: { postId: true },
      });
      if (!found) throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
      // Lock order: post, then comment.
      const [post] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM community_posts
        WHERE id = ${found.postId} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
        FOR NO KEY UPDATE`;
      if (!post) throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
      await tx.$queryRaw`
        SELECT id FROM community_comments WHERE id = ${commentId} FOR NO KEY UPDATE`;
      const row = await tx.communityComment.findUnique({
        where: { id: commentId },
        select: { userId: true, deletionKind: true, hiddenBySanctionId: true },
      });
      if (
        !row ||
        row.userId !== viewer.userId ||
        row.hiddenBySanctionId ||
        row.deletionKind === 'operator'
      )
        throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
      if (row.deletionKind === 'author') return;
      const now = await transactionNow(tx);
      await tx.communityComment.update({
        where: { id: commentId },
        data: { deletedAt: now, deletionKind: 'author' },
      });
    });
    const comment = await this.render((tx) =>
      this.read.renderComment(tx, viewer, commentId),
    );
    return { success: true as const, data: { comment } };
  }

  async setCommentLike(
    user: AuthenticatedUser | undefined,
    commentId: string,
    liked: boolean,
  ) {
    const viewer = viewerOf(user);
    if (!isEntityId(commentId))
      throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
    const likeCount = await this.prisma.$transaction(async (tx) => {
      if (liked) await this.lockWriter(tx, viewer.userId);
      const found = await tx.communityComment.findUnique({
        where: { id: commentId },
        select: { postId: true },
      });
      if (!found) throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
      const [post] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM community_posts
        WHERE id = ${found.postId} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
        FOR SHARE`;
      const [comment] = post
        ? await tx.$queryRaw<{ userId: string | null }[]>`
            SELECT user_id AS "userId" FROM community_comments
            WHERE id = ${commentId} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
            FOR SHARE`
        : [];
      if (!comment) throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
      if (liked) {
        if (comment.userId === viewer.userId)
          throw communityError('COMMUNITY_SELF_REACTION');
        await tx.communityCommentLike.createMany({
          data: [{ commentId, userId: viewer.userId }],
          skipDuplicates: true,
        });
      } else {
        await tx.communityCommentLike.deleteMany({
          where: { commentId, userId: viewer.userId },
        });
      }
      return tx.communityCommentLike.count({ where: { commentId } });
    });
    return { success: true as const, data: { liked, likeCount } };
  }

  async report(user: AuthenticatedUser | undefined, body: unknown) {
    const viewer = viewerOf(user);
    const input = record(body);
    const note = parseOptionalNote(input.note, COMMUNITY_NOTE_MAX);
    if (
      (input.targetType !== 'post' && input.targetType !== 'comment') ||
      !isEntityId(input.targetId) ||
      !isCommunityReason(input.reason) ||
      !note.ok
    )
      throw communityError('INVALID_COMMUNITY_REPORT');
    const targetType = input.targetType;
    const targetId = input.targetId;
    const reason = input.reason;
    const target =
      targetType === 'post' ? { postId: targetId } : { commentId: targetId };
    const view = (row: { reason: string; createdAt: Date }) => ({
      targetType,
      targetId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    });
    const existing = await this.prisma.communityReport.findFirst({
      where: { userId: viewer.userId, ...target },
      select: { reason: true, createdAt: true },
    });
    if (existing)
      return {
        success: true as const,
        data: { report: view(existing), replayed: true },
      };
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const now = await this.lockWriter(tx, viewer.userId);
        let ownerId: string | null;
        if (targetType === 'post') {
          const [post] = await tx.$queryRaw<{ userId: string }[]>`
            SELECT user_id AS "userId" FROM community_posts
            WHERE id = ${targetId} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
            FOR SHARE`;
          if (!post) throw communityError('COMMUNITY_POST_NOT_FOUND');
          ownerId = post.userId;
        } else {
          const found = await tx.communityComment.findUnique({
            where: { id: targetId },
            select: { postId: true },
          });
          const [post] = found
            ? await tx.$queryRaw<{ id: string }[]>`
                SELECT id FROM community_posts
                WHERE id = ${found.postId} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
                FOR SHARE`
            : [];
          const [comment] = post
            ? await tx.$queryRaw<{ userId: string | null }[]>`
                SELECT user_id AS "userId" FROM community_comments
                WHERE id = ${targetId} AND deleted_at IS NULL AND hidden_by_sanction_id IS NULL
                FOR SHARE`
            : [];
          if (!comment) throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
          ownerId = comment.userId;
        }
        if (ownerId === viewer.userId)
          throw communityError('COMMUNITY_SELF_REPORT');
        const limit = COMMUNITY_RATE_LIMITS.report;
        const recent = await tx.communityReport.count({
          where: {
            userId: viewer.userId,
            createdAt: { gte: new Date(now.getTime() - limit.windowMs) },
          },
        });
        if (recent >= limit.count)
          throw communityError('COMMUNITY_RATE_LIMITED');
        return tx.communityReport.create({
          data: {
            userId: viewer.userId,
            ...target,
            reason,
            note: note.note,
          },
          select: { reason: true, createdAt: true },
        });
      });
      return {
        success: true as const,
        data: { report: view(created), replayed: false },
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.prisma.communityReport.findFirst({
          where: { userId: viewer.userId, ...target },
          select: { reason: true, createdAt: true },
        });
        if (winner)
          return {
            success: true as const,
            data: { report: view(winner), replayed: true },
          };
      }
      throw error;
    }
  }

  async consent(user: AuthenticatedUser | undefined, body: unknown) {
    const viewer = viewerOf(user);
    if (record(body).rulesVersion !== COMMUNITY_RULES_VERSION)
      throw communityError('INVALID_COMMUNITY_RULES_VERSION');
    const consent = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.communityRuleConsent.findUnique({
        where: { userId: viewer.userId },
        select: { rulesVersion: true, acceptedAt: true },
      });
      if (existing?.rulesVersion === COMMUNITY_RULES_VERSION) return existing;
      const now = await transactionNow(tx);
      return tx.communityRuleConsent.upsert({
        where: { userId: viewer.userId },
        create: {
          userId: viewer.userId,
          rulesVersion: COMMUNITY_RULES_VERSION,
          acceptedAt: now,
        },
        update: { rulesVersion: COMMUNITY_RULES_VERSION, acceptedAt: now },
        select: { rulesVersion: true, acceptedAt: true },
      });
    });
    return {
      success: true as const,
      data: {
        rulesVersion: consent.rulesVersion,
        acceptedAt: consent.acceptedAt.toISOString(),
      },
    };
  }
}

/** The member's number on this post: existing, or max + 1 under the post
 * row lock the caller holds (the unique keys back it up). */
export async function ensureAlias(
  tx: Tx,
  postId: string,
  userId: string,
): Promise<number> {
  const existing = await tx.communityPostAlias.findUnique({
    where: { postId_userId: { postId, userId } },
    select: { aliasNo: true },
  });
  if (existing) return existing.aliasNo;
  const [next] = await tx.$queryRaw<{ aliasNo: number }[]>`
    SELECT (COALESCE(MAX(alias_no), 0) + 1)::int AS "aliasNo"
    FROM community_post_aliases WHERE post_id = ${postId}`;
  await tx.communityPostAlias.create({
    data: { postId, userId, aliasNo: next.aliasNo },
  });
  return next.aliasNo;
}
