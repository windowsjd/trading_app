import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildPagination } from '../common/pagination';
import { friendshipPair } from './friendship.policy';
import type { Prisma } from '../generated/prisma/client';

export type FriendsQuery = {
  nickname?: string;
  limit?: string;
  offset?: string;
};
const publicUserSelect = {
  id: true,
  nickname: true,
  profileImageUrl: true,
  status: true,
} as const;

@Injectable()
export class FriendsService {
  constructor(private readonly prisma: PrismaService) {}

  private fail(status: HttpStatus, code: string, message: string): never {
    throw new HttpException(
      { success: false, error: { code, message } },
      status,
    );
  }

  private viewer(userId: string | undefined): string {
    if (!userId) this.fail(401, 'UNAUTHORIZED', 'Unauthorized');
    return userId;
  }

  private page(query: FriendsQuery) {
    const parse = (
      value: string | undefined,
      fallback: number,
      max: number,
      min: number,
    ) => {
      const number = value === undefined ? fallback : Number(value);
      if (
        (value !== undefined && !/^\d+$/.test(value)) ||
        !Number.isSafeInteger(number) ||
        number < min ||
        number > max
      ) {
        this.fail(400, 'INVALID_PAGINATION', 'Invalid pagination.');
      }
      return number;
    };
    return {
      limit: parse(query.limit, 30, 100, 1),
      offset: parse(query.offset, 0, 1000000, 0),
    };
  }

  async search(userId: string | undefined, query: FriendsQuery) {
    const viewer = this.viewer(userId);
    const nickname = query.nickname?.trim() ?? '';
    if (!nickname || nickname.length > 30)
      this.fail(400, 'INVALID_NICKNAME', 'Enter 1 to 30 characters.');
    const page = this.page(query);
    // Escape LIKE wildcards: a nickname is literal user input.
    const prefix = nickname.replace(/[\\%_]/g, '\\$&');
    const where: Prisma.UserWhereInput = {
      status: 'active',
      id: { not: viewer },
      nickname: { startsWith: prefix, mode: 'insensitive' },
    };
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: publicUserSelect,
        orderBy: [{ nickname: 'asc' }, { id: 'asc' }],
        skip: page.offset,
        take: page.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    const ids = users.map((user) => user.id);
    const relationships = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { lowUserId: viewer, highUserId: { in: ids } },
          { highUserId: viewer, lowUserId: { in: ids } },
        ],
      },
    });
    const byUser = new Map(
      relationships.map((row) => [
        row.lowUserId === viewer ? row.highUserId : row.lowUserId,
        row,
      ]),
    );
    return {
      success: true,
      data: {
        users: users.map((user) => {
          const relation = byUser.get(user.id);
          return {
            userId: user.id,
            nickname: user.nickname,
            profileImageUrl: user.profileImageUrl,
            relationship: !relation
              ? 'none'
              : relation.status === 'accepted'
                ? 'friend'
                : relation.requesterUserId === viewer
                  ? 'sent'
                  : 'received',
            requestId: relation?.id ?? null,
          };
        }),
        pagination: buildPagination({ ...page, total, returned: users.length }),
      },
    };
  }

  async list(
    userId: string | undefined,
    query: FriendsQuery,
    requests = false,
  ) {
    const viewer = this.viewer(userId);
    const page = this.page(query);
    const where: Prisma.FriendshipWhereInput = {
      OR: [{ lowUserId: viewer }, { highUserId: viewer }],
      status: requests ? 'pending' : 'accepted',
      ...(requests
        ? {
            requesterUserId: { not: viewer },
            lowUser: { status: 'active' },
            highUser: { status: 'active' },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.friendship.findMany({
        where,
        include: {
          lowUser: { select: publicUserSelect },
          highUser: { select: publicUserSelect },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: page.offset,
        take: page.limit,
      }),
      this.prisma.friendship.count({ where }),
    ]);
    return {
      success: true,
      data: {
        users: rows.map((row) => {
          const user = row.lowUserId === viewer ? row.highUser : row.lowUser;
          return {
            userId: user.id,
            nickname: user.nickname,
            profileImageUrl: user.profileImageUrl,
            active: user.status === 'active',
            requestId: row.id,
            relationship: requests ? 'received' : 'friend',
          };
        }),
        pagination: buildPagination({ ...page, total, returned: rows.length }),
      },
    };
  }

  async request(userId: string | undefined, body: { userId?: unknown } = {}) {
    const viewer = this.viewer(userId);
    if (typeof body?.userId !== 'string' || !body.userId.trim())
      this.fail(400, 'INVALID_USER_ID', 'A target user is required.');
    const targetId = body.userId.trim();
    if (viewer === targetId)
      this.fail(400, 'SELF_FRIEND_REQUEST', 'You cannot request yourself.');
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { status: true },
    });
    if (!target || target.status !== 'active')
      this.fail(404, 'USER_NOT_FOUND', 'Active user not found.');
    try {
      const row = await this.prisma.friendship.create({
        data: { ...friendshipPair(viewer, targetId), requesterUserId: viewer },
        select: { id: true },
      });
      return { success: true, data: { requestId: row.id } };
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        this.fail(
          409,
          'FRIENDSHIP_EXISTS',
          'A request or friendship already exists.',
        );
      }
      throw error;
    }
  }

  async respond(
    userId: string | undefined,
    requestId: string,
    accept: boolean,
  ) {
    const viewer = this.viewer(userId);
    const where: Prisma.FriendshipWhereInput = {
      id: requestId,
      status: 'pending',
      requesterUserId: { not: viewer },
      OR: [{ lowUserId: viewer }, { highUserId: viewer }],
      ...(accept
        ? { lowUser: { status: 'active' }, highUser: { status: 'active' } }
        : {}),
    };
    const result = accept
      ? await this.prisma.friendship.updateMany({
          where,
          data: { status: 'accepted' },
        })
      : await this.prisma.friendship.deleteMany({ where });
    if (!result.count)
      this.fail(
        404,
        'FRIEND_REQUEST_NOT_FOUND',
        'Pending incoming request not found.',
      );
    return { success: true, data: { accepted: accept } };
  }

  async remove(userId: string | undefined, friendshipId: string) {
    const viewer = this.viewer(userId);
    const result = await this.prisma.friendship.deleteMany({
      where: {
        id: friendshipId,
        status: 'accepted',
        OR: [{ lowUserId: viewer }, { highUserId: viewer }],
      },
    });
    if (!result.count)
      this.fail(404, 'FRIENDSHIP_NOT_FOUND', 'Friendship not found.');
    return { success: true, data: { deleted: true } };
  }
}
