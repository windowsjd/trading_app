import { Injectable, Logger } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileImageStorageService } from './profile-image-storage.service';

type Tx = Prisma.TransactionClient;

/** An upload's reservation outlives its storage write (10 s abort) by far, so
 * nothing removes an object whose upload may still be in flight. */
export const PROFILE_IMAGE_UPLOAD_LEASE_MS = 10 * 60_000;
/** Deletion policy target for external cleanup. Reaching it is reported; the
 * retries never stop (docs/account-deletion-contract.md §6). */
export const PROFILE_IMAGE_CLEANUP_TARGET_MS = 7 * 24 * 3_600_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 3_600_000;
const ACCOUNT_DELETION_IMMEDIATE_LIMIT = 20;

/** 1, 2, 4 … minutes after the n-th failed attempt, capped at 6 hours. */
export function profileImageCleanupDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

/** Database clock as an epoch, avoiding adapter/session timezone handling. */
export async function databaseNow(
  client: Pick<Tx, '$queryRaw'>,
): Promise<Date> {
  const [row] = await client.$queryRaw<{ epochMs: string }[]>`
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS "epochMs"`;
  return new Date(Number(row.epochMs));
}

export type ProfileImageCleanupRun = {
  due: number;
  removed: number;
  failed: number;
  settled: number;
  overdue: number;
};

/**
 * Durable removal of managed profile image objects (`profile_image_cleanups`).
 *
 * Every managed object the application may stop referencing has a row until
 * the storage delete succeeds: an upload reserves its key (with a lease)
 * before the storage write, a replaced/deleted photo and a deleted account's
 * photo are enqueued due at once, and failures back off and retry. Storage
 * calls never run inside a database transaction. Logs carry no key or user id.
 */
@Injectable()
export class ProfileImageCleanupService {
  private readonly logger = new Logger(ProfileImageCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ProfileImageStorageService,
  ) {}

  /** Locks the user like every profile write, then reserves the key. An
   * account deletion therefore sees this reservation and waits for it, or
   * the upload finds no active user and never writes to storage. */
  async reserveUpload(userId: string, objectKey: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!user) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
      if (user.status !== 'active')
        throw createApiError('USER_NOT_ACTIVE', 'User is not active.', 403);
      const now = await databaseNow(tx);
      await tx.profileImageCleanup.create({
        data: {
          objectKey,
          nextAttemptAt: new Date(
            now.getTime() + PROFILE_IMAGE_UPLOAD_LEASE_MS,
          ),
        },
      });
    });
  }

  /** In the URL-change transaction: consumes the upload's own reservation.
   * False when it is gone, so the URL never points at a removed object. */
  async claimUpload(tx: Tx, objectKey: string): Promise<boolean> {
    const { count } = await tx.profileImageCleanup.deleteMany({
      where: { objectKey, accountDeletionId: null },
    });
    return count === 1;
  }

  /** Durable removal due now (a replaced or deleted photo). */
  async enqueue(tx: Tx, objectKey: string, now: Date): Promise<void> {
    await tx.profileImageCleanup.upsert({
      where: { objectKey },
      create: { objectKey, nextAttemptAt: now },
      update: { nextAttemptAt: now },
    });
  }

  /** In the account deletion transaction (user row locked): enqueues the
   * current photo and links every row under the user's prefix, keeping an
   * in-flight upload's lease. Returns how many objects the deletion waits on. */
  async adoptForAccountDeletion(
    tx: Tx,
    input: {
      userId: string;
      currentKey: string | null;
      accountDeletionId: string;
      now: Date;
    },
  ): Promise<number> {
    if (!/^[A-Za-z0-9-]+$/.test(input.userId)) {
      // @diagnosticSurface internal: User ids are database UUIDs; the deletion transaction maps this to ACCOUNT_DELETION_FAILED.
      throw new Error('Unexpected user id shape.');
    }
    if (input.currentKey) {
      await tx.profileImageCleanup.upsert({
        where: { objectKey: input.currentKey },
        create: {
          objectKey: input.currentKey,
          accountDeletionId: input.accountDeletionId,
          nextAttemptAt: input.now,
        },
        update: {
          accountDeletionId: input.accountDeletionId,
          nextAttemptAt: input.now,
        },
      });
    }
    await tx.profileImageCleanup.updateMany({
      where: { objectKey: { startsWith: `profile-images/${input.userId}/` } },
      data: { accountDeletionId: input.accountDeletionId },
    });
    return tx.profileImageCleanup.count({
      where: { accountDeletionId: input.accountDeletionId },
    });
  }

  /** One storage delete. Success removes the row and settles the account
   * deletion waiting on it; failure keeps (or recreates) the row with a
   * backoff. Never throws for a storage failure. */
  async process(objectKey: string): Promise<boolean> {
    try {
      await this.storage.delete(objectKey);
    } catch (cause) {
      await this.recordFailure(objectKey, this.failureCode(cause));
      return false;
    }
    const removed = await this.prisma.$queryRaw<
      { accountDeletionId: string | null }[]
    >`
      DELETE FROM profile_image_cleanups WHERE object_key = ${objectKey}
      RETURNING account_deletion_id AS "accountDeletionId"`;
    const accountDeletionId = removed[0]?.accountDeletionId;
    if (accountDeletionId) await this.settle(accountDeletionId);
    return true;
  }

  /** `completed` once no object of the deletion is left; idempotent. */
  async settle(accountDeletionId: string): Promise<boolean> {
    const now = await databaseNow(this.prisma);
    const { count } = await this.prisma.accountDeletion.updateMany({
      where: {
        id: accountDeletionId,
        status: 'cleanup_pending',
        profileImageCleanups: { none: {} },
      },
      data: { status: 'completed', completedAt: now },
    });
    return count === 1;
  }

  /** Right after a deletion commits: its due objects, then its status. */
  async processAccountDeletion(accountDeletionId: string): Promise<void> {
    const now = await databaseNow(this.prisma);
    const due = await this.prisma.profileImageCleanup.findMany({
      where: { accountDeletionId, nextAttemptAt: { lte: now } },
      orderBy: { objectKey: 'asc' },
      take: ACCOUNT_DELETION_IMMEDIATE_LIMIT,
      select: { objectKey: true },
    });
    for (const row of due) await this.process(row.objectKey);
    await this.settle(accountDeletionId);
  }

  /** Cheap probe so an idle worker takes no lease and writes nothing. */
  async hasWork(): Promise<boolean> {
    const now = await databaseNow(this.prisma);
    const [due, pending] = await Promise.all([
      this.prisma.profileImageCleanup.findFirst({
        where: { nextAttemptAt: { lte: now } },
        select: { objectKey: true },
      }),
      this.prisma.accountDeletion.findFirst({
        where: { status: 'cleanup_pending' },
        select: { id: true },
      }),
    ]);
    return Boolean(due || pending);
  }

  /** One worker pass over due rows, the settle safety net and the 7-day
   * target report. */
  async runDue(limit = 50): Promise<ProfileImageCleanupRun> {
    const now = await databaseNow(this.prisma);
    const due = await this.prisma.profileImageCleanup.findMany({
      where: { nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { objectKey: 'asc' }],
      take: limit,
      select: { objectKey: true },
    });
    let removed = 0;
    let failed = 0;
    for (const row of due) {
      if (await this.process(row.objectKey)) removed++;
      else failed++;
    }
    // A receipt whose last object was removed by a path that could not
    // settle it (e.g. a crash between the delete and the settle).
    const unsettled = await this.prisma.accountDeletion.findMany({
      where: { status: 'cleanup_pending', profileImageCleanups: { none: {} } },
      select: { id: true },
      take: 100,
    });
    let settled = 0;
    for (const receipt of unsettled)
      if (await this.settle(receipt.id)) settled++;
    const overdue = await this.prisma.accountDeletion.count({
      where: {
        status: 'cleanup_pending',
        deletedAt: {
          lt: new Date(now.getTime() - PROFILE_IMAGE_CLEANUP_TARGET_MS),
        },
      },
    });
    return { due: due.length, removed, failed, settled, overdue };
  }

  private async recordFailure(objectKey: string, code: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const now = await databaseNow(tx);
        const [row] = await tx.$queryRaw<{ attempts: number }[]>`
          SELECT attempts FROM profile_image_cleanups
          WHERE object_key = ${objectKey} FOR UPDATE`;
        const attempts = (row?.attempts ?? 0) + 1;
        const nextAttemptAt = new Date(
          now.getTime() + profileImageCleanupDelayMs(attempts),
        );
        await tx.profileImageCleanup.upsert({
          where: { objectKey },
          create: { objectKey, attempts, nextAttemptAt, lastErrorCode: code },
          update: { attempts, nextAttemptAt, lastErrorCode: code },
        });
      });
    } catch {
      // The row keeps its previous schedule; the next pass retries it.
      this.logger.error(
        JSON.stringify({ event: 'profile_image_cleanup_record_failed' }),
      );
    }
    this.logger.warn(
      JSON.stringify({ event: 'profile_image_cleanup_failed', code }),
    );
  }

  private failureCode(cause: unknown): string {
    if (!this.storage.isConfigured()) return 'STORAGE_UNAVAILABLE';
    const name =
      cause && typeof cause === 'object' && 'name' in cause
        ? String((cause as { name: unknown }).name)
        : '';
    return /abort|timeout/i.test(name)
      ? 'STORAGE_TIMEOUT'
      : 'STORAGE_DELETE_FAILED';
  }
}
