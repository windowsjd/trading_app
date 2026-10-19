jest.mock('../generated/prisma/client', () => ({ PrismaClient: class {} }));

import { Logger } from '@nestjs/common';
import {
  PROFILE_IMAGE_UPLOAD_LEASE_MS,
  ProfileImageCleanupService,
  profileImageCleanupDelayMs,
} from './profile-image-cleanup.service';
import type { ProfileImageStorageService } from './profile-image-storage.service';
import type { PrismaService } from '../prisma/prisma.service';

const userId = 'cbdc80ec-8f69-44fd-8a76-32b1c136e06a';
const key = `profile-images/${userId}/d1645c18-a1a4-43c9-b1f3-a90c3d63b30b.jpg`;
const now = new Date('2026-10-18T12:00:00.000Z');

function harness(options: { configured?: boolean } = {}) {
  const queries: string[] = [];
  const tx = {
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('epoch'))
        return Promise.resolve([{ epochMs: String(now.getTime()) }]);
      if (text.includes('FROM users'))
        return Promise.resolve([{ status: 'active' }]);
      if (text.includes('SELECT attempts'))
        return Promise.resolve([{ attempts: 2 }]);
      return Promise.resolve([]);
    }),
    profileImageCleanup: {
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
  };
  const prisma = {
    ...tx,
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('epoch'))
        return Promise.resolve([{ epochMs: String(now.getTime()) }]);
      if (text.includes('DELETE FROM profile_image_cleanups'))
        return Promise.resolve([{ accountDeletionId: 'deletion' }]);
      return Promise.resolve([]);
    }),
    $transaction: jest
      .fn()
      .mockImplementation((work: (t: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    accountDeletion: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  prisma.profileImageCleanup = {
    ...tx.profileImageCleanup,
    findMany: jest.fn().mockResolvedValue([{ objectKey: key }]),
    findFirst: jest.fn().mockResolvedValue(null),
  } as typeof tx.profileImageCleanup;
  const storage = {
    isConfigured: jest.fn().mockReturnValue(options.configured ?? true),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ProfileImageCleanupService(
    prisma as unknown as PrismaService,
    storage as unknown as ProfileImageStorageService,
  );
  return { service, prisma, tx, storage, queries };
}

describe('ProfileImageCleanupService', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => {}),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  it('backs off from one minute to a six-hour ceiling and never gives up', () => {
    expect(
      [1, 2, 3, 4, 9, 10, 50].map((n) => profileImageCleanupDelayMs(n)),
    ).toEqual([
      60_000, 120_000, 240_000, 480_000, 15_360_000, 21_600_000, 21_600_000,
    ]);
    expect(profileImageCleanupDelayMs(0)).toBe(60_000);
  });

  it('reserves an upload under the member lock with a lease', async () => {
    const h = harness();
    await h.service.reserveUpload(userId, key);
    expect(h.queries.some((q) => q.includes('FOR UPDATE'))).toBe(true);
    expect(h.tx.profileImageCleanup.create).toHaveBeenCalledWith({
      data: {
        objectKey: key,
        nextAttemptAt: new Date(now.getTime() + PROFILE_IMAGE_UPLOAD_LEASE_MS),
      },
    });
  });

  it('refuses a reservation for a missing or inactive member', async () => {
    for (const [rows, expected] of [
      [[], 401],
      [[{ status: 'deleted' }], 403],
    ] as const) {
      const h = harness();
      h.tx.$queryRaw.mockResolvedValueOnce(rows);
      await expect(h.service.reserveUpload(userId, key)).rejects.toMatchObject({
        status: expected,
      });
      expect(h.tx.profileImageCleanup.create).not.toHaveBeenCalled();
    }
  });

  it('removes the row and settles its deletion after a successful storage delete', async () => {
    const h = harness();
    await expect(h.service.process(key)).resolves.toBe(true);
    expect(h.storage.delete).toHaveBeenCalledWith(key);
    expect(h.prisma.accountDeletion.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'deletion',
        status: 'cleanup_pending',
        profileImageCleanups: { none: {} },
      },
      data: { status: 'completed', completedAt: now },
    });
  });

  it('keeps a failed removal queued with a bounded error code and no key in logs', async () => {
    for (const [configured, name, expected] of [
      [true, 'Error', 'STORAGE_DELETE_FAILED'],
      [true, 'TimeoutError', 'STORAGE_TIMEOUT'],
      [true, 'AbortError', 'STORAGE_TIMEOUT'],
      [false, 'Error', 'STORAGE_UNAVAILABLE'],
    ] as const) {
      const h = harness({ configured });
      const failure = new Error(`provider said ${key}`);
      failure.name = name;
      h.storage.delete.mockRejectedValue(failure);
      await expect(h.service.process(key)).resolves.toBe(false);
      expect(h.tx.profileImageCleanup.upsert).toHaveBeenCalledWith({
        where: { objectKey: key },
        create: {
          objectKey: key,
          attempts: 3,
          nextAttemptAt: new Date(now.getTime() + 240_000),
          lastErrorCode: expected,
        },
        update: {
          attempts: 3,
          nextAttemptAt: new Date(now.getTime() + 240_000),
          lastErrorCode: expected,
        },
      });
      expect(h.prisma.accountDeletion.updateMany).not.toHaveBeenCalled();
    }
    const logged = JSON.stringify(
      logs.map((spy) => spy.mock.calls as unknown[]),
    );
    expect(logged).toContain('profile_image_cleanup_failed');
    expect(logged).not.toContain(userId);
    expect(logged).not.toContain('provider said');
  });

  it('links in-flight reservations of the member without shortening their lease', async () => {
    const h = harness();
    const waiting = await h.service.adoptForAccountDeletion(h.tx as never, {
      userId,
      currentKey: key,
      accountDeletionId: 'deletion',
      now,
    });
    expect(waiting).toBe(1);
    expect(h.tx.profileImageCleanup.upsert).toHaveBeenCalledWith({
      where: { objectKey: key },
      create: {
        objectKey: key,
        accountDeletionId: 'deletion',
        nextAttemptAt: now,
      },
      update: { accountDeletionId: 'deletion', nextAttemptAt: now },
    });
    expect(h.tx.profileImageCleanup.updateMany).toHaveBeenCalledWith({
      where: { objectKey: { startsWith: `profile-images/${userId}/` } },
      data: { accountDeletionId: 'deletion' },
    });
    await expect(
      h.service.adoptForAccountDeletion(h.tx as never, {
        userId: '%',
        currentKey: null,
        accountDeletionId: 'deletion',
        now,
      }),
    ).rejects.toThrow();
  });

  it('consumes only an unlinked reservation when the URL is published', async () => {
    const h = harness();
    await expect(h.service.claimUpload(h.tx as never, key)).resolves.toBe(true);
    expect(h.tx.profileImageCleanup.deleteMany).toHaveBeenCalledWith({
      where: { objectKey: key, accountDeletionId: null },
    });
    h.tx.profileImageCleanup.deleteMany.mockResolvedValue({ count: 0 });
    await expect(h.service.claimUpload(h.tx as never, key)).resolves.toBe(
      false,
    );
  });

  it('reports a pass over due rows, settles orphaned receipts and counts overdue deletions', async () => {
    const h = harness();
    h.prisma.accountDeletion.findMany.mockResolvedValue([{ id: 'orphan' }]);
    h.prisma.accountDeletion.count.mockResolvedValue(2);
    const run = await h.service.runDue();
    expect(run).toEqual({
      due: 1,
      removed: 1,
      failed: 0,
      settled: 1,
      overdue: 2,
    });
    const [overdueQuery] = h.prisma.accountDeletion.count.mock.calls[0] as [
      { where: { deletedAt: { lt: Date } } },
    ];
    expect(overdueQuery.where.deletedAt.lt).toEqual(
      new Date(now.getTime() - 7 * 86_400_000),
    );
  });
});
