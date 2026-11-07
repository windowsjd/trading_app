import type { Prisma } from '../generated/prisma/client';

// UUID text ordering agrees with PostgreSQL's C collation.
export function friendshipPair(a: string, b: string) {
  return a < b
    ? { lowUserId: a, highUserId: b }
    : { lowUserId: b, highUserId: a };
}

export function acceptedFriendUserWhere(
  viewerId: string,
): Prisma.UserWhereInput {
  return {
    status: 'active',
    OR: [
      {
        friendshipsLow: { some: { highUserId: viewerId, status: 'accepted' } },
      },
      {
        friendshipsHigh: { some: { lowUserId: viewerId, status: 'accepted' } },
      },
    ],
  };
}

export type PortfolioAccess =
  | 'available'
  | 'private'
  | 'not_friend'
  | 'unavailable';

/**
 * Whether `viewerId` may read `targetId`'s current-season portfolio.
 * `viewerId` must be the authenticated caller, never a client-sent id.
 * Owners read their own (2026-11-06): only the friendship and the sharing
 * switch are skipped — an inactive owner stays unavailable, and the caller's
 * season/participant/account checks and post-read recheck still apply.
 */
export async function readPortfolioAccess(
  prisma: Pick<Prisma.TransactionClient, 'user'>,
  viewerId: string,
  targetId: string,
): Promise<PortfolioAccess> {
  const user = await prisma.user.findUnique({
    where: { id: targetId },
    select: {
      status: true,
      portfolioPublic: true,
      friendshipsLow: {
        where: { highUserId: viewerId, status: 'accepted' },
        select: { id: true },
      },
      friendshipsHigh: {
        where: { lowUserId: viewerId, status: 'accepted' },
        select: { id: true },
      },
    },
  });
  if (!user || user.status !== 'active') return 'unavailable';
  if (viewerId === targetId) return 'available';
  if (!user.friendshipsLow.length && !user.friendshipsHigh.length)
    return 'not_friend';
  return user.portfolioPublic ? 'available' : 'private';
}
