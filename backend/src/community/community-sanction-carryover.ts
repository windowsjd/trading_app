import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import { COMMUNITY_RETENTION } from './community.policy';

type Tx = Prisma.TransactionClient;

/**
 * The only handle a carryover keeps (no member FK; 2026-11-07 decision 4):
 * SHA-256 of a fixed domain label + the email normalized as signup does
 * (trimmed, lower-cased), 64 hex characters.
 */
export function communitySanctionEmailHash(email: string): string {
  return createHash('sha256')
    .update(`community-sanction:${email.trim().toLowerCase()}`)
    .digest('hex');
}

/** In the account deletion transaction: every ongoing sanction of the
 * member (not revoked, permanent or not yet ended) is kept by email hash.
 * Retention end: a timed sanction's end, or the deletion + 3 years. */
export async function recordCommunitySanctionCarryovers(
  tx: Pick<Tx, 'communitySanction' | 'communitySanctionCarryover'>,
  input: { userId: string; email: string; now: Date },
): Promise<number> {
  const ongoing = await tx.communitySanction.findMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: input.now } }],
    },
    select: { reason: true, endsAt: true, createdAt: true },
  });
  if (ongoing.length === 0) return 0;
  const emailHash = communitySanctionEmailHash(input.email);
  const permanentExpiry = new Date(input.now);
  permanentExpiry.setUTCFullYear(
    permanentExpiry.getUTCFullYear() +
      COMMUNITY_RETENTION.permanentCarryoverYears,
  );
  const { count } = await tx.communitySanctionCarryover.createMany({
    data: ongoing.map((sanction) => ({
      emailHash,
      reason: sanction.reason,
      endsAt: sanction.endsAt,
      sanctionedAt: sanction.createdAt,
      expiresAt: sanction.endsAt ?? permanentExpiry,
    })),
  });
  return count;
}

/**
 * In the signup transaction, right after the member row: a live carryover of
 * the same email becomes the new member's sanction (same reason, same end;
 * the permanent or the latest-ending one when several), and every carryover
 * of that email is consumed. No operator, nothing hidden.
 */
export async function applyCommunitySanctionCarryover(
  tx: Pick<Tx, 'communitySanction' | 'communitySanctionCarryover'>,
  input: { userId: string; email: string; now: Date },
): Promise<boolean> {
  const emailHash = communitySanctionEmailHash(input.email);
  const carryovers = await tx.communitySanctionCarryover.findMany({
    where: { emailHash },
    select: { reason: true, endsAt: true, expiresAt: true },
  });
  if (carryovers.length === 0) return false;
  const live = carryovers.filter(
    (row) =>
      row.expiresAt.getTime() > input.now.getTime() &&
      (row.endsAt === null || row.endsAt.getTime() > input.now.getTime()),
  );
  const strongest =
    live.find((row) => row.endsAt === null) ??
    [...live].sort(
      (a, b) => (b.endsAt?.getTime() ?? 0) - (a.endsAt?.getTime() ?? 0),
    )[0];
  if (strongest)
    await tx.communitySanction.create({
      data: {
        userId: input.userId,
        reason: strongest.reason,
        hideContent: false,
        createdAt: input.now,
        endsAt: strongest.endsAt,
        carriedOver: true,
      },
    });
  await tx.communitySanctionCarryover.deleteMany({ where: { emailHash } });
  return Boolean(strongest);
}
