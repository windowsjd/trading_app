jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { HttpException } from '@nestjs/common';
import { FriendsService } from './friends.service';

type Row = {
  id: string;
  status: 'pending' | 'accepted';
  requesterUserId: string;
};

/** The service over a two-table fake: one user lookup, one pair lookup. */
function service(user: { status: string } | null, row: Row | null) {
  const prisma = {
    user: { findUnique: jest.fn(() => Promise.resolve(user)) },
    friendship: { findUnique: jest.fn(() => Promise.resolve(row)) },
  };
  return { friends: new FriendsService(prisma as never), prisma };
}

async function failure(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return {
    status: http.getStatus(),
    code: (http.getResponse() as { error: { code: string } }).error.code,
  };
}

describe('GET /friends/relationships/:userId (FriendsService.relationship)', () => {
  it('reads the one stored pair by the sorted ids and answers from the viewer side', async () => {
    const cases: Array<[Row | null, string, string | null]> = [
      [null, 'none', null],
      [
        { id: 'r1', status: 'pending', requesterUserId: 'viewer' },
        'sent',
        'r1',
      ],
      [
        { id: 'r2', status: 'pending', requesterUserId: 'target' },
        'received',
        'r2',
      ],
      [
        { id: 'r3', status: 'accepted', requesterUserId: 'target' },
        'friend',
        'r3',
      ],
      [
        { id: 'r4', status: 'accepted', requesterUserId: 'viewer' },
        'friend',
        'r4',
      ],
    ];
    for (const [row, relationship, requestId] of cases) {
      const { friends, prisma } = service({ status: 'active' }, row);
      await expect(friends.relationship('viewer', 'target')).resolves.toEqual({
        success: true,
        data: { userId: 'target', relationship, requestId },
      });
      // 'target' < 'viewer': the pair is stored low/high whichever side asks.
      expect(prisma.friendship.findUnique).toHaveBeenCalledWith({
        where: {
          lowUserId_highUserId: { lowUserId: 'target', highUserId: 'viewer' },
        },
        select: { id: true, status: true, requesterUserId: true },
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'target' },
        select: { status: true },
      });
    }
  });

  it('names self without any read; no viewer is 401', async () => {
    const { friends, prisma } = service(null, null);
    await expect(friends.relationship('viewer', 'viewer')).resolves.toEqual({
      success: true,
      data: { userId: 'viewer', relationship: 'self', requestId: null },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.friendship.findUnique).not.toHaveBeenCalled();
    await expect(
      failure(friends.relationship(undefined, 'target')),
    ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('an unknown or inactive user is 404 USER_NOT_FOUND, as for a request, and no pair is read', async () => {
    for (const user of [null, { status: 'suspended' }, { status: 'deleted' }]) {
      const { friends, prisma } = service(user, {
        id: 'r',
        status: 'accepted',
        requesterUserId: 'viewer',
      });
      await expect(
        failure(friends.relationship('viewer', 'target')),
      ).resolves.toEqual({ status: 404, code: 'USER_NOT_FOUND' });
      expect(prisma.friendship.findUnique).not.toHaveBeenCalled();
    }
  });
});
