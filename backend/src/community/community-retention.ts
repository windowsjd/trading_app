import type { Prisma } from '../generated/prisma/client';
import { COMMUNITY_RETENTION } from './community.policy';

type Tx = Prisma.TransactionClient;

export type CommunityRetentionBatch = {
  communityPosts: number;
  communityComments: number;
  communityReports: number;
  sanctionCarryovers: number;
};

/**
 * Community retention (docs/community-api-contract.md §13), run by
 * DataRetentionCleanupService inside its advisory-locked batch transaction.
 * Fixed statements, cutoffs from the transaction's UTC clock, at most `batch`
 * candidates per step, locked rows skipped (a later run retries them).
 * - Author-deleted posts after 30 days, operator-removed after 1 year:
 *   the post and everything under it are deleted (photo objects were queued
 *   for storage deletion when the post was deleted).
 * - Deleted comments, same periods: body, note and author link erased
 *   (erased_at); the empty placeholder stays for replies; its likes and
 *   reports are deleted.
 * - Reports after 1 year; sanction carryovers at expires_at.
 */
export async function deleteCommunityRetentionBatch(
  tx: Tx,
  batch: number,
): Promise<CommunityRetentionBatch> {
  const authorDays = COMMUNITY_RETENTION.authorDeletedDays;
  const operatorDays = COMMUNITY_RETENTION.operatorRemovedDays;
  const reportDays = COMMUNITY_RETENTION.reportDays;

  const sanctionCarryovers = await tx.$executeRaw`
    WITH candidates AS (
      SELECT id FROM community_sanction_carryovers
      WHERE expires_at <= timezone('UTC', transaction_timestamp())
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM community_sanction_carryovers c USING candidates d
    WHERE c.id = d.id`;

  const posts = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM community_posts
    WHERE (deletion_kind = 'author'
        AND deleted_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${authorDays}::int))
       OR (deletion_kind = 'operator'
        AND deleted_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${operatorDays}::int))
    LIMIT ${batch}
    FOR UPDATE SKIP LOCKED`;
  if (posts.length) {
    const ids = posts.map((row) => row.id);
    await tx.$executeRaw`
      DELETE FROM community_comment_likes
      WHERE comment_id IN (SELECT id FROM community_comments WHERE post_id = ANY(${ids}::text[]))`;
    await tx.$executeRaw`
      DELETE FROM community_post_likes WHERE post_id = ANY(${ids}::text[])`;
    await tx.$executeRaw`
      DELETE FROM community_reports
      WHERE post_id = ANY(${ids}::text[])
         OR comment_id IN (SELECT id FROM community_comments WHERE post_id = ANY(${ids}::text[]))`;
    await tx.$executeRaw`
      DELETE FROM community_post_aliases WHERE post_id = ANY(${ids}::text[])`;
    await tx.$executeRaw`
      DELETE FROM community_post_photos WHERE post_id = ANY(${ids}::text[])`;
    await tx.$executeRaw`
      DELETE FROM community_comments WHERE post_id = ANY(${ids}::text[])`;
    await tx.$executeRaw`
      DELETE FROM community_posts WHERE id = ANY(${ids}::text[])`;
  }

  const comments = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM community_comments
    WHERE erased_at IS NULL
      AND ((deletion_kind = 'author'
          AND deleted_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${authorDays}::int))
        OR (deletion_kind = 'operator'
          AND deleted_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${operatorDays}::int)))
    LIMIT ${batch}
    FOR UPDATE SKIP LOCKED`;
  if (comments.length) {
    const ids = comments.map((row) => row.id);
    await tx.$executeRaw`
      DELETE FROM community_comment_likes WHERE comment_id = ANY(${ids}::text[])`;
    await tx.$executeRaw`
      DELETE FROM community_reports WHERE comment_id = ANY(${ids}::text[])`;
    await tx.$executeRaw`
      UPDATE community_comments
      SET body = NULL, removal_note = NULL, user_id = NULL,
          hidden_by_sanction_id = NULL,
          erased_at = timezone('UTC', transaction_timestamp())
      WHERE id = ANY(${ids}::text[])`;
  }

  const communityReports = await tx.$executeRaw`
    WITH candidates AS (
      SELECT id FROM community_reports
      WHERE created_at < timezone('UTC', transaction_timestamp()) - make_interval(days => ${reportDays}::int)
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM community_reports r USING candidates d
    WHERE r.id = d.id`;

  return {
    communityPosts: posts.length,
    communityComments: comments.length,
    communityReports,
    sanctionCarryovers,
  };
}
