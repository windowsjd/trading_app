jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' },
  },
  UserRole: { user: 'user', operator: 'operator', admin: 'admin' },
  OperatorAuditResult: { success: 'success', failure: 'failure' },
}));
jest.mock('./community-tier.reader', () => ({ CommunityTierReader: class {} }));
jest.mock('../auth/profile-image-storage.service', () => ({
  ProfileImageStorageService: class {},
}));
jest.mock('./community-photo-cleanup.service', () => ({
  CommunityPhotoCleanupService: class {},
}));

import { type ExecutionContext, HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { OperatorGuard } from '../operator/operator.guard';
import { OperatorCommunityController } from './community.controller';
import {
  CommunityModerationService,
  parseModeration,
  parseSanction,
} from './community-moderation.service';

/* eslint-disable @typescript-eslint/require-await -- the fake mirrors Prisma's async client */

const NOW = new Date('2026-11-07T12:00:00.000Z');
const OPERATOR = { userId: 'user-operator', role: 'operator' as const };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException)
      return (error.getResponse() as { error: { code: string } }).error.code;
    throw error;
  }
  return 'NONE';
}

async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return {
      status: error.getStatus(),
      code: (error.getResponse() as { error: { code: string } }).error.code,
    };
  }
  return { status: 0, code: 'NONE' };
}

type Sanction = {
  id: string;
  userId: string;
  reason: string;
  note: string | null;
  hideContent: boolean;
  createdAt: Date;
  endsAt: Date | null;
  carriedOver: boolean;
  createdByUserId: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
};

function harness(
  options: {
    target?: { id: string; role: string } | null;
    active?: Sanction | null;
    existing?: Sanction | null;
    post?: {
      deletedAt: Date | null;
      deletionKind: string | null;
      removalReason: string | null;
    } | null;
  } = {},
) {
  const audits: { action: string; inTx: boolean }[] = [];
  const target =
    options.target === undefined
      ? { id: 'user-target', role: 'user' }
      : options.target;
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    communitySanction: {
      findUnique: jest.fn(async () =>
        options.existing ? { userId: options.existing.userId } : null,
      ),
    },
  };
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('extract(epoch'))
        return [{ epochMs: String(NOW.getTime()) }];
      if (sql.includes('FROM users')) return target ? [target] : [];
      if (sql.includes('FROM community_sanctions'))
        return options.existing ? [{ id: options.existing.id }] : [];
      if (sql.includes('FROM community_posts'))
        return options.post ? [{ id: 'post-1' }] : [];
      return [];
    }),
    communitySanction: {
      findFirst: jest.fn(async () => options.active ?? null),
      create: jest.fn(async (args: { data: Partial<Sanction> }) => ({
        id: 'sanction-new',
        note: null,
        carriedOver: false,
        revokedAt: null,
        revokedByUserId: null,
        endsAt: null,
        ...args.data,
      })),
      findUniqueOrThrow: jest.fn(async () => options.existing),
      update: jest.fn(async (args: { data: Partial<Sanction> }) => ({
        ...options.existing,
        ...args.data,
      })),
    },
    communityPost: {
      updateMany: jest.fn(async () => ({ count: 2 })),
      findUniqueOrThrow: jest.fn(async () => options.post),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        deletedAt: NOW,
        deletionKind: 'operator',
        removalReason: args.data.removalReason,
      })),
    },
    communityPostPhoto: {
      findMany: jest.fn(async () => [{ objectKey: 'community-images/a.jpg' }]),
    },
    communityComment: { updateMany: jest.fn(async () => ({ count: 3 })) },
  };
  const audit = {
    recordSuccess: jest.fn(
      async (input: { action: string }, client?: unknown) => {
        audits.push({ action: input.action, inTx: client === tx });
      },
    ),
    recordFailure: jest.fn(async (input: { action: string }) => {
      audits.push({ action: input.action, inTx: false });
    }),
  };
  const cleanups = {
    enqueue: jest.fn(async () => undefined),
    processNow: jest.fn(async () => undefined),
  };
  const service = new CommunityModerationService(
    prisma as never,
    audit as never,
    cleanups as never,
    { read: jest.fn(async () => new Map()) } as never,
  );
  return { service, tx, audits, cleanups };
}

const sanctionRow = (overrides: Partial<Sanction> = {}): Sanction => ({
  id: 'sanction-1',
  userId: 'user-target',
  reason: 'ABUSE',
  note: null,
  hideContent: true,
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  endsAt: new Date('2026-12-01T00:00:00.000Z'),
  carriedOver: false,
  createdByUserId: 'user-operator',
  revokedAt: null,
  revokedByUserId: null,
  ...overrides,
});

describe('community moderation', () => {
  it('requires a known reason, and a note for OTHER', () => {
    expect(codeOf(() => parseModeration({}))).toBe(
      'INVALID_COMMUNITY_MODERATION',
    );
    expect(codeOf(() => parseModeration({ reason: 'SPAM' }))).toBe(
      'INVALID_COMMUNITY_MODERATION',
    );
    expect(codeOf(() => parseModeration({ reason: 'OTHER' }))).toBe(
      'INVALID_COMMUNITY_MODERATION',
    );
    expect(codeOf(() => parseModeration({ reason: 'OTHER', note: '  ' }))).toBe(
      'INVALID_COMMUNITY_MODERATION',
    );
    expect(parseModeration({ reason: 'OTHER', note: '사유 메모' }).note).toBe(
      '사유 메모',
    );
    expect(parseModeration({ reason: 'ABUSE' }).note === null).toBe(true);
    expect(
      codeOf(() =>
        parseSanction({ reason: 'ABUSE', duration: '1d', hideContent: true }),
      ),
    ).toBe('INVALID_COMMUNITY_MODERATION');
    expect(
      codeOf(() => parseSanction({ reason: 'ABUSE', duration: '7d' })),
    ).toBe('INVALID_COMMUNITY_MODERATION');
    expect(
      parseSanction({
        reason: 'ABUSE',
        duration: 'permanent',
        hideContent: false,
      }).duration,
    ).toBe('permanent');
  });

  it('never restricts operators, administrators or the operator themselves', async () => {
    for (const target of [
      { id: 'user-op2', role: 'operator' },
      { id: 'user-admin', role: 'admin' },
      { id: OPERATOR.userId, role: 'user' },
    ]) {
      const h = harness({ target });
      const result = await failure(() =>
        h.service.createSanction(OPERATOR, target.id, {
          reason: 'ABUSE',
          duration: '7d',
          hideContent: false,
        }),
      );
      expect(result).toEqual({
        status: 403,
        code: 'COMMUNITY_SANCTION_TARGET_FORBIDDEN',
      });
      expect(h.audits.map((a) => a.action)).toEqual([
        'operator.community.sanction.create.failed',
      ]);
    }
  });

  it('refuses a second active restriction', async () => {
    const h = harness({ active: sanctionRow() });
    const result = await failure(() =>
      h.service.createSanction(OPERATOR, 'user-target', {
        reason: 'ABUSE',
        duration: '30d',
        hideContent: true,
      }),
    );
    expect(result).toEqual({
      status: 409,
      code: 'COMMUNITY_SANCTION_ALREADY_ACTIVE',
    });
  });

  it('restricts for 30 days, hides visible content and audits in the same transaction', async () => {
    const h = harness();
    const result = await h.service.createSanction(OPERATOR, 'user-target', {
      reason: 'ABUSE',
      duration: '30d',
      hideContent: true,
    });
    const created = h.tx.communitySanction.create.mock.calls[0][0] as {
      data: Sanction;
    };
    expect((created.data.endsAt as Date).getTime() - NOW.getTime()).toBe(
      30 * 24 * 3_600_000,
    );
    expect(created.data.createdByUserId).toBe(OPERATOR.userId);
    expect(result.data.hidden).toEqual({ posts: 2, comments: 3 });
    const hide = h.tx.communityPost.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(
      hide.where.deletedAt === null && hide.where.hiddenBySanctionId === null,
    ).toBe(true);
    expect(hide.data.hiddenBySanctionId).toBe('sanction-new');
    expect(h.audits).toEqual([
      { action: 'operator.community.sanction.create', inTx: true },
    ]);
  });

  it('restores exactly what the restriction hid when it is lifted, once', async () => {
    const h = harness({ existing: sanctionRow() });
    const result = await h.service.revokeSanction(OPERATOR, 'sanction-1');
    expect(result.data.replayed).toBe(false);
    expect(result.data.restored).toEqual({ posts: 2, comments: 3 });
    const restore = h.tx.communityComment.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(restore.where.hiddenBySanctionId).toBe('sanction-1');
    expect(h.audits).toEqual([
      { action: 'operator.community.sanction.revoke', inTx: true },
    ]);

    const again = harness({
      existing: sanctionRow({
        revokedAt: NOW,
        revokedByUserId: OPERATOR.userId,
      }),
    });
    const replay = await again.service.revokeSanction(OPERATOR, 'sanction-1');
    expect(replay.data.replayed).toBe(true);
    expect(again.tx.communityPost.updateMany).not.toHaveBeenCalled();
    expect(again.audits.map((a) => a.action)).toEqual([
      'operator.community.sanction.revoke.replay',
    ]);
  });

  it('removes a post once: soft delete, photos queued, audit in the transaction', async () => {
    const h = harness({
      post: { deletedAt: null, deletionKind: null, removalReason: null },
    });
    const result = await h.service.removePost(OPERATOR, 'post-1', {
      reason: 'AD_SPAM',
    });
    expect(result.data.replayed).toBe(false);
    expect(result.data.removal.deletionKind).toBe('operator');
    expect(h.cleanups.enqueue).toHaveBeenCalledTimes(1);
    expect(h.cleanups.processNow).toHaveBeenCalledWith([
      'community-images/a.jpg',
    ]);
    expect(h.audits).toEqual([
      { action: 'operator.community.post.remove', inTx: true },
    ]);

    const removed = harness({
      post: {
        deletedAt: NOW,
        deletionKind: 'operator',
        removalReason: 'ABUSE',
      },
    });
    const replay = await removed.service.removePost(OPERATOR, 'post-1', {
      reason: 'FLOOD',
    });
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.removal.reason).toBe('ABUSE');
    expect(removed.tx.communityPost.update).not.toHaveBeenCalled();
    expect(removed.audits.map((a) => a.action)).toEqual([
      'operator.community.post.remove.replay',
    ]);
  });

  it('keeps the operator API behind OperatorGuard, which refuses members', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      OperatorCommunityController,
    ) as unknown[];
    expect(guards.includes(OperatorGuard)).toBe(true);
    const context = (role: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: 'u', role } }),
        }),
      }) as unknown as ExecutionContext;
    const guard = new OperatorGuard();
    expect(codeOf(() => guard.canActivate(context('user')))).toBe(
      'OPERATOR_FORBIDDEN',
    );
    expect(guard.canActivate(context('operator'))).toBe(true);
    expect(guard.canActivate(context('admin'))).toBe(true);
  });
});
