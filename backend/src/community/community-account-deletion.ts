import type { Prisma } from '../generated/prisma/client';
import { recordCommunitySanctionCarryovers } from './community-sanction-carryover';

type Tx = Prisma.TransactionClient;

/**
 * Community steps of the account deletion transaction
 * (docs/community-api-contract.md §12). The DELETE statements themselves
 * live in purgeDeletionScope; these run before it, in the same transaction.
 */

/** After the existing scope locks: the member's posts, then comments, so
 * replies, likes and reports racing onto them wait (lock order users →
 * posts → comments, as every community writer). */
export async function lockCommunityDeletionScope(
  tx: Pick<Tx, '$queryRaw'>,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM community_posts WHERE user_id = ${userId} ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`
    SELECT id FROM community_comments WHERE user_id = ${userId} ORDER BY id FOR UPDATE`;
}

/**
 * Before the purge:
 * 1. ongoing sanctions → carryovers by email hash (re-applied at signup);
 * 2. the member's comments on OTHER members' posts that a sanction hides
 *    become that sanction's operator removal (they never reappear), and any
 *    remaining sanction link on them is cleared;
 * 3. the member's comments on other members' posts lose the member link
 *    (shown as 탈퇴계정; replies, likes and reports under them stay);
 * 4. the member's post photos are queued due now and linked to the receipt,
 *    in-flight upload leases move to the receipt (lease kept, member link
 *    cleared).
 * Returns how many photo objects the receipt waits on.
 */
export async function prepareCommunityAccountDeletion(
  tx: Tx,
  input: {
    userId: string;
    email: string;
    accountDeletionId: string;
    now: Date;
  },
): Promise<number> {
  const user = input.userId;
  await recordCommunitySanctionCarryovers(tx, input);
  await tx.$executeRaw`
    UPDATE community_comments c
    SET deleted_at = timezone('UTC', transaction_timestamp()),
        deletion_kind = 'operator',
        removed_by_user_id = s.created_by_user_id,
        removal_reason = s.reason,
        removal_note = s.note,
        hidden_by_sanction_id = NULL
    FROM community_sanctions s, community_posts p
    WHERE c.hidden_by_sanction_id = s.id
      AND c.user_id = ${user}
      AND c.deleted_at IS NULL
      AND s.created_by_user_id IS NOT NULL
      AND p.id = c.post_id AND p.user_id <> ${user}`;
  await tx.$executeRaw`
    UPDATE community_comments c
    SET hidden_by_sanction_id = NULL
    FROM community_posts p
    WHERE c.user_id = ${user} AND c.hidden_by_sanction_id IS NOT NULL
      AND p.id = c.post_id AND p.user_id <> ${user}`;
  await tx.$executeRaw`
    UPDATE community_comments c
    SET user_id = NULL
    FROM community_posts p
    WHERE c.user_id = ${user} AND p.id = c.post_id AND p.user_id <> ${user}`;
  await tx.$executeRaw`
    INSERT INTO community_photo_cleanups
      (object_key, account_deletion_id, attempts, next_attempt_at, created_at, updated_at)
    SELECT ph.object_key, ${input.accountDeletionId}, 0,
           timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp()),
           timezone('UTC', clock_timestamp())
    FROM community_post_photos ph
    JOIN community_posts p ON p.id = ph.post_id
    WHERE p.user_id = ${user}
    ON CONFLICT (object_key) DO UPDATE
      SET account_deletion_id = EXCLUDED.account_deletion_id,
          user_id = NULL,
          next_attempt_at = LEAST(community_photo_cleanups.next_attempt_at, EXCLUDED.next_attempt_at),
          updated_at = EXCLUDED.updated_at`;
  await tx.$executeRaw`
    UPDATE community_photo_cleanups
    SET account_deletion_id = ${input.accountDeletionId},
        user_id = NULL,
        updated_at = timezone('UTC', clock_timestamp())
    WHERE user_id = ${user}`;
  return tx.communityPhotoCleanup.count({
    where: { accountDeletionId: input.accountDeletionId },
  });
}
