import { HttpException, Injectable } from '@nestjs/common';
import {
  type CommunityModerationReason,
  Prisma,
  UserRole,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { OperatorAuditService } from '../operator/operator-audit.service';
import type { OperatorRequestContext } from '../operator/operator-account-management.service';
import { PrismaService } from '../prisma/prisma.service';
import { communityError } from './community-errors';
import { CommunityPhotoCleanupService } from './community-photo-cleanup.service';
import { activeSanctionOf, transactionNow } from './community-read.service';
import { sequential } from './community-sequential';
import { isEntityId, parseOptionalNote } from './community-text';
import { CommunityTierReader } from './community-tier.reader';
import {
  COMMUNITY_MODERATION_REASONS,
  COMMUNITY_NOTE_MAX,
  COMMUNITY_SANCTION_DURATIONS,
  type CommunitySanctionDuration,
  isCommunityReason,
} from './community.policy';

type Actor = { userId: string; role: UserRole };

type Moderation = { reason: CommunityModerationReason; note: string | null };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reason required and known; OTHER needs a note (contract §8). */
export function parseModeration(body: unknown): Moderation {
  const input = record(body);
  const note = parseOptionalNote(input.note, COMMUNITY_NOTE_MAX);
  if (!isCommunityReason(input.reason) || !note.ok)
    throw communityError('INVALID_COMMUNITY_MODERATION');
  const definition = COMMUNITY_MODERATION_REASONS.find(
    (reason) => reason.code === input.reason,
  );
  if (definition?.noteRequired && !note.note)
    throw communityError('INVALID_COMMUNITY_MODERATION');
  return { reason: input.reason, note: note.note };
}

export function parseSanction(body: unknown): Moderation & {
  duration: CommunitySanctionDuration;
  hideContent: boolean;
} {
  const input = record(body);
  const moderation = parseModeration(body);
  if (
    typeof input.duration !== 'string' ||
    !Object.hasOwn(COMMUNITY_SANCTION_DURATIONS, input.duration) ||
    typeof input.hideContent !== 'boolean'
  )
    throw communityError('INVALID_COMMUNITY_MODERATION');
  return {
    ...moderation,
    duration: input.duration as CommunitySanctionDuration,
    hideContent: input.hideContent,
  };
}

const SANCTION_SELECT = {
  id: true,
  userId: true,
  reason: true,
  note: true,
  hideContent: true,
  createdAt: true,
  endsAt: true,
  carriedOver: true,
  createdByUserId: true,
  revokedAt: true,
  revokedByUserId: true,
} satisfies Prisma.CommunitySanctionSelect;

type SanctionRow = Prisma.CommunitySanctionGetPayload<{
  select: typeof SANCTION_SELECT;
}>;

export function sanctionView(row: SanctionRow, now: Date) {
  return {
    id: row.id,
    userId: row.userId,
    reason: row.reason,
    note: row.note,
    hideContent: row.hideContent,
    createdAt: row.createdAt.toISOString(),
    until: row.endsAt?.toISOString() ?? null,
    active:
      row.revokedAt === null &&
      (row.endsAt === null || row.endsAt.getTime() > now.getTime()),
    carriedOver: row.carriedOver,
    createdByUserId: row.createdByUserId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
  };
}

/**
 * Operator moderation of the community (docs/community-api-contract.md §9).
 * Removal is a soft delete keeping the body; a sanction is the
 * community-only restriction (never users.status). Every write and its
 * success audit commit together; replays and failures are audited best
 * effort outside the transaction, never with body or note text.
 */
@Injectable()
export class CommunityModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OperatorAuditService,
    private readonly cleanups: CommunityPhotoCleanupService,
    private readonly tiers: CommunityTierReader,
  ) {}

  private actor(user: AuthenticatedUser | undefined): Actor {
    if (!user?.userId) throw communityError('UNAUTHORIZED');
    return { userId: user.userId, role: user.role };
  }

  async removePost(
    user: AuthenticatedUser | undefined,
    postId: string,
    body: unknown,
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    return this.audited(
      actor,
      'operator.community.post.remove',
      'community_post',
      postId,
      context,
      async () => {
        const input = parseModeration(body);
        if (!isEntityId(postId))
          throw communityError('COMMUNITY_POST_NOT_FOUND');
        const result = await this.prisma.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM community_posts WHERE id = ${postId} FOR NO KEY UPDATE`;
          if (!locked) throw communityError('COMMUNITY_POST_NOT_FOUND');
          const current = await tx.communityPost.findUniqueOrThrow({
            where: { id: postId },
            select: {
              deletedAt: true,
              deletionKind: true,
              removalReason: true,
            },
          });
          if (current.deletedAt)
            return {
              replayed: true,
              removal: removalView('post', postId, current),
              keys: [],
            };
          const now = await transactionNow(tx);
          const updated = await tx.communityPost.update({
            where: { id: postId },
            data: {
              deletedAt: now,
              deletionKind: 'operator',
              removedByUserId: actor.userId,
              removalReason: input.reason,
              removalNote: input.note,
            },
            select: {
              deletedAt: true,
              deletionKind: true,
              removalReason: true,
            },
          });
          const photos = await tx.communityPostPhoto.findMany({
            where: { postId },
            select: { objectKey: true },
          });
          const keys = photos.map((photo) => photo.objectKey);
          await this.cleanups.enqueue(tx, keys, now);
          await this.audit.recordSuccess(
            {
              actorUserId: actor.userId,
              actorRole: actor.role,
              action: 'operator.community.post.remove',
              targetType: 'community_post',
              targetId: postId,
              ...context,
              metadataJson: {
                reason: input.reason,
                hasNote: input.note !== null,
              },
            },
            tx,
          );
          return {
            replayed: false,
            removal: removalView('post', postId, updated),
            keys,
          };
        });
        await this.cleanups.processNow(result.keys);
        return { removal: result.removal, replayed: result.replayed };
      },
    );
  }

  async removeComment(
    user: AuthenticatedUser | undefined,
    commentId: string,
    body: unknown,
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    return this.audited(
      actor,
      'operator.community.comment.remove',
      'community_comment',
      commentId,
      context,
      async () => {
        const input = parseModeration(body);
        if (!isEntityId(commentId))
          throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
        const removal = await this.prisma.$transaction(async (tx) => {
          const found = await tx.communityComment.findUnique({
            where: { id: commentId },
            select: { postId: true },
          });
          if (!found) throw communityError('COMMUNITY_COMMENT_NOT_FOUND');
          // Lock order: post, then comment.
          await tx.$queryRaw`SELECT id FROM community_posts WHERE id = ${found.postId} FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM community_comments WHERE id = ${commentId} FOR NO KEY UPDATE`;
          const current = await tx.communityComment.findUniqueOrThrow({
            where: { id: commentId },
            select: {
              deletedAt: true,
              deletionKind: true,
              removalReason: true,
            },
          });
          if (current.deletedAt)
            return {
              replayed: true,
              removal: removalView('comment', commentId, current),
            };
          const now = await transactionNow(tx);
          const updated = await tx.communityComment.update({
            where: { id: commentId },
            data: {
              deletedAt: now,
              deletionKind: 'operator',
              removedByUserId: actor.userId,
              removalReason: input.reason,
              removalNote: input.note,
            },
            select: {
              deletedAt: true,
              deletionKind: true,
              removalReason: true,
            },
          });
          await this.audit.recordSuccess(
            {
              actorUserId: actor.userId,
              actorRole: actor.role,
              action: 'operator.community.comment.remove',
              targetType: 'community_comment',
              targetId: commentId,
              ...context,
              metadataJson: {
                reason: input.reason,
                hasNote: input.note !== null,
              },
            },
            tx,
          );
          return {
            replayed: false,
            removal: removalView('comment', commentId, updated),
          };
        });
        return removal;
      },
    );
  }

  async userSummary(
    user: AuthenticatedUser | undefined,
    userId: string,
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    if (!isEntityId(userId)) throw communityError('TARGET_USER_NOT_FOUND');
    const data = await this.prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            nickname: true,
            profileImageUrl: true,
            role: true,
            status: true,
            createdAt: true,
          },
        });
        if (!target) throw communityError('TARGET_USER_NOT_FOUND');
        const now = await transactionNow(tx);
        const [
          posts,
          comments,
          reports,
          removedPosts,
          removedComments,
          sanction,
          tiers,
        ] = await sequential([
          () => tx.communityPost.count({ where: { userId } }),
          () => tx.communityComment.count({ where: { userId } }),
          () =>
            tx.communityReport.count({
              where: { OR: [{ post: { userId } }, { comment: { userId } }] },
            }),
          () =>
            tx.communityPost.count({
              where: { userId, deletionKind: 'operator' },
            }),
          () =>
            tx.communityComment.count({
              where: { userId, deletionKind: 'operator' },
            }),
          () => activeSanctionOf(tx, userId, now),
          () => this.tiers.read(tx, [userId]),
        ] as const);
        return {
          user: {
            id: target.id,
            nickname: target.nickname,
            profileImageUrl: target.profileImageUrl,
            tier: tiers.get(target.id) ?? null,
            role: target.role,
            status: target.status,
            joinedAt: target.createdAt.toISOString(),
          },
          stats: {
            postCount: posts,
            commentCount: comments,
            reportCount: reports,
            removedCount: removedPosts + removedComments,
          },
          activeSanction: sanction ? sanctionView(sanction, now) : null,
          sanctionable:
            target.role === UserRole.user && target.id !== actor.userId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    await this.audit
      .recordSuccess({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'operator.community.user.get',
        targetType: 'user',
        targetId: userId,
        ...context,
      })
      .catch(() => undefined);
    return { success: true as const, data };
  }

  async createSanction(
    user: AuthenticatedUser | undefined,
    userId: string,
    body: unknown,
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    return this.audited(
      actor,
      'operator.community.sanction.create',
      'user',
      userId,
      context,
      async () => {
        const input = parseSanction(body);
        if (!isEntityId(userId)) throw communityError('TARGET_USER_NOT_FOUND');
        return this.prisma.$transaction(async (tx) => {
          // The member's row serializes with their own community writes
          // (FOR SHARE) and with their account deletion.
          const [target] = await tx.$queryRaw<{ id: string; role: string }[]>`
          SELECT id, role::text AS role FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
          if (!target) throw communityError('TARGET_USER_NOT_FOUND');
          if (target.role !== UserRole.user || target.id === actor.userId)
            throw communityError('COMMUNITY_SANCTION_TARGET_FORBIDDEN');
          const now = await transactionNow(tx);
          if (await activeSanctionOf(tx, userId, now))
            throw communityError('COMMUNITY_SANCTION_ALREADY_ACTIVE');
          const duration = COMMUNITY_SANCTION_DURATIONS[input.duration];
          const sanction = await tx.communitySanction.create({
            data: {
              userId,
              reason: input.reason,
              note: input.note,
              hideContent: input.hideContent,
              createdAt: now,
              endsAt:
                duration === null ? null : new Date(now.getTime() + duration),
              createdByUserId: actor.userId,
            },
            select: SANCTION_SELECT,
          });
          let hidden = { posts: 0, comments: 0 };
          if (input.hideContent) {
            const [posts, comments] = [
              await tx.communityPost.updateMany({
                where: { userId, deletedAt: null, hiddenBySanctionId: null },
                data: { hiddenBySanctionId: sanction.id },
              }),
              await tx.communityComment.updateMany({
                where: { userId, deletedAt: null, hiddenBySanctionId: null },
                data: { hiddenBySanctionId: sanction.id },
              }),
            ];
            hidden = { posts: posts.count, comments: comments.count };
          }
          await this.audit.recordSuccess(
            {
              actorUserId: actor.userId,
              actorRole: actor.role,
              action: 'operator.community.sanction.create',
              targetType: 'user',
              targetId: userId,
              ...context,
              metadataJson: {
                sanctionId: sanction.id,
                reason: input.reason,
                duration: input.duration,
                hideContent: input.hideContent,
                hiddenPosts: hidden.posts,
                hiddenComments: hidden.comments,
              },
            },
            tx,
          );
          return { sanction: sanctionView(sanction, now), hidden };
        });
      },
    );
  }

  async revokeSanction(
    user: AuthenticatedUser | undefined,
    sanctionId: string,
    context: OperatorRequestContext = {},
  ) {
    const actor = this.actor(user);
    return this.audited(
      actor,
      'operator.community.sanction.revoke',
      'community_sanction',
      sanctionId,
      context,
      async () => {
        const found = isEntityId(sanctionId)
          ? await this.prisma.communitySanction.findUnique({
              where: { id: sanctionId },
              select: { userId: true },
            })
          : null;
        if (!found) throw communityError('COMMUNITY_SANCTION_NOT_FOUND');
        const result = await this.prisma.$transaction(async (tx) => {
          // Same order as creation and account deletion: member, then sanction.
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.userId} FOR NO KEY UPDATE`;
          const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM community_sanctions WHERE id = ${sanctionId} FOR UPDATE`;
          if (!locked) throw communityError('COMMUNITY_SANCTION_NOT_FOUND');
          const now = await transactionNow(tx);
          const current = await tx.communitySanction.findUniqueOrThrow({
            where: { id: sanctionId },
            select: SANCTION_SELECT,
          });
          if (current.revokedAt)
            return {
              sanction: sanctionView(current, now),
              restored: { posts: 0, comments: 0 },
              replayed: true,
            };
          const wasActive = sanctionView(current, now).active;
          const revoked = await tx.communitySanction.update({
            where: { id: sanctionId },
            data: { revokedAt: now, revokedByUserId: actor.userId },
            select: SANCTION_SELECT,
          });
          // Exactly what this sanction hid; removed rows stay removed.
          const posts = await tx.communityPost.updateMany({
            where: { hiddenBySanctionId: sanctionId },
            data: { hiddenBySanctionId: null },
          });
          const comments = await tx.communityComment.updateMany({
            where: { hiddenBySanctionId: sanctionId },
            data: { hiddenBySanctionId: null },
          });
          const restored = { posts: posts.count, comments: comments.count };
          await this.audit.recordSuccess(
            {
              actorUserId: actor.userId,
              actorRole: actor.role,
              action: 'operator.community.sanction.revoke',
              targetType: 'community_sanction',
              targetId: sanctionId,
              ...context,
              metadataJson: {
                userId: current.userId,
                wasActive,
                restoredPosts: restored.posts,
                restoredComments: restored.comments,
              },
            },
            tx,
          );
          return {
            sanction: sanctionView(revoked, now),
            restored,
            replayed: false,
          };
        });
        return result;
      },
    );
  }

  /** Runs a write; audits its replay or failure best effort (code only). */
  private async audited<T extends object>(
    actor: Actor,
    action: string,
    targetType: string,
    targetId: string,
    context: OperatorRequestContext,
    work: () => Promise<T>,
  ) {
    const safeTarget =
      typeof targetId === 'string' && isEntityId(targetId) ? targetId : null;
    let data: T;
    try {
      data = await work();
    } catch (error) {
      const response =
        error instanceof HttpException
          ? (error.getResponse() as { error?: { code?: unknown } })
          : null;
      const code =
        typeof response?.error?.code === 'string'
          ? response.error.code
          : 'COMMUNITY_MODERATION_FAILED';
      await this.audit
        .recordFailure({
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: `${action}.failed`,
          targetType,
          targetId: safeTarget,
          ...context,
          errorCode: code,
        })
        .catch(() => undefined);
      throw error;
    }
    if ('replayed' in data && data.replayed === true)
      await this.audit
        .recordSuccess({
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: `${action}.replay`,
          targetType,
          targetId: safeTarget,
          ...context,
        })
        .catch(() => undefined);
    return { success: true as const, data };
  }
}

function removalView(
  targetType: 'post' | 'comment',
  targetId: string,
  row: {
    deletedAt: Date | null;
    deletionKind: 'author' | 'operator' | null;
    removalReason: CommunityModerationReason | null;
  },
) {
  return {
    targetType,
    targetId,
    deletionKind: row.deletionKind,
    reason: row.removalReason,
    removedAt: row.deletedAt?.toISOString() ?? null,
  };
}
