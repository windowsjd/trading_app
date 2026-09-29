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
  if (!user.friendshipsLow.length && !user.friendshipsHigh.length)
    return 'not_friend';
  return user.portfolioPublic ? 'available' : 'private';
}
