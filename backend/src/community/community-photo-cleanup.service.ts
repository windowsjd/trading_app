import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  databaseNow,
  profileImageCleanupDelayMs,
  settleAccountDeletionReceipt,
} from '../auth/profile-image-cleanup.service';
import { ProfileImageStorageService } from '../auth/profile-image-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { communityError } from './community-errors';
import { COMMUNITY_PHOTO_UPLOAD_LEASE_MS } from './community.policy';

type Tx = Prisma.TransactionClient;

export type CommunityPhotoCleanupRun = {
  due: number;
  removed: number;
  failed: number;
  settled: number;
};

/**
 * Durable removal of community photo objects (`community_photo_cleanups`,
 * docs/community-api-contract.md §10.3–§10.5), the profile-photo pattern:
 * an upload reserves its keys under a lease before any storage write, the
 * post transaction consumes them, removed posts and deleted accounts enqueue
 * their keys due at once, and failures back off and retry forever. Storage
 * calls never run inside a transaction. Logs carry no key or member id.
 */
@Injectable()
export class CommunityPhotoCleanupService {
  private readonly logger = new Logger(CommunityPhotoCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ProfileImageStorageService,
  ) {}

  /** Before any storage write: the member must still exist and be active
   * (FOR SHARE serializes with an account deletion, which then adopts the
   * keys), and each key gets a lease row. */
  async reserveUploads(userId: string, objectKeys: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM users WHERE id = ${userId} FOR SHARE`;
      if (!user) throw communityError('UNAUTHORIZED');
      if (user.status !== 'active')
        throw communityError('COMMUNITY_PHOTO_UPLOAD_FAILED');
      const now = await databaseNow(tx);
      await tx.communityPhotoCleanup.createMany({
        data: objectKeys.map((objectKey) => ({
          objectKey,
          userId,
          nextAttemptAt: new Date(
            now.getTime() + COMMUNITY_PHOTO_UPLOAD_LEASE_MS,
          ),
        })),
      });
    });
  }

  /** In the post transaction: consumes this upload's own leases. False when
   * any is gone (adopted by an account deletion or already processed), so a
   * post never references a removed object. */
  async claimUploads(
    tx: Tx,
    userId: string,
    objectKeys: string[],
  ): Promise<boolean> {
    if (objectKeys.length === 0) return true;
    const { count } = await tx.communityPhotoCleanup.deleteMany({
      where: {
        objectKey: { in: objectKeys },
        userId,
        accountDeletionId: null,
      },
    });
    return count === objectKeys.length;
  }

  /** Removal due now (a deleted or operator-removed post's photos). */
  async enqueue(tx: Tx, objectKeys: string[], now: Date): Promise<void> {
    for (const objectKey of objectKeys)
      await tx.communityPhotoCleanup.upsert({
        where: { objectKey },
        create: { objectKey, nextAttemptAt: now },
        update: { nextAttemptAt: now },
      });
  }

  /** Immediate attempts after a commit; failures stay queued for the worker. */
  async processNow(objectKeys: string[]): Promise<void> {
    for (const objectKey of objectKeys) {
      try {
        await this.process(objectKey);
      } catch {
        this.logger.warn(
          JSON.stringify({ event: 'community_photo_cleanup_deferred' }),
        );
      }
    }
  }

  /** One storage delete. Success removes the row (and settles a waiting
   * account deletion); failure keeps it with a backoff. */
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
      DELETE FROM community_photo_cleanups WHERE object_key = ${objectKey}
      RETURNING account_deletion_id AS "accountDeletionId"`;
    const accountDeletionId = removed[0]?.accountDeletionId;
    if (accountDeletionId)
      await settleAccountDeletionReceipt(this.prisma, accountDeletionId);
    return true;
  }

  /** Right after an account deletion commits: its due community objects,
   * then the receipt status (the profile cleanup settles it too). */
  async processAccountDeletion(accountDeletionId: string): Promise<void> {
    const now = await databaseNow(this.prisma);
    const due = await this.prisma.communityPhotoCleanup.findMany({
      where: { accountDeletionId, nextAttemptAt: { lte: now } },
      orderBy: { objectKey: 'asc' },
      take: 20,
      select: { objectKey: true },
    });
    for (const row of due) await this.process(row.objectKey);
    await settleAccountDeletionReceipt(this.prisma, accountDeletionId);
  }

  /** Cheap probe so an idle worker takes no lease and writes nothing. */
  async hasWork(): Promise<boolean> {
    const now = await databaseNow(this.prisma);
    const due = await this.prisma.communityPhotoCleanup.findFirst({
      where: { nextAttemptAt: { lte: now } },
      select: { objectKey: true },
    });
    return Boolean(due);
  }

  async runDue(limit = 50): Promise<CommunityPhotoCleanupRun> {
    const now = await databaseNow(this.prisma);
    const due = await this.prisma.communityPhotoCleanup.findMany({
      where: { nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { objectKey: 'asc' }],
      take: limit,
      select: { objectKey: true, accountDeletionId: true },
    });
    let removed = 0;
    let failed = 0;
    for (const row of due) {
      if (await this.process(row.objectKey)) removed++;
      else failed++;
    }
    let settled = 0;
    const receipts = new Set(
      due.flatMap((row) =>
        row.accountDeletionId ? [row.accountDeletionId] : [],
      ),
    );
    for (const id of receipts)
      if (await settleAccountDeletionReceipt(this.prisma, id)) settled++;
    return { due: due.length, removed, failed, settled };
  }

  private async recordFailure(objectKey: string, code: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const now = await databaseNow(tx);
        const [row] = await tx.$queryRaw<{ attempts: number }[]>`
          SELECT attempts FROM community_photo_cleanups
          WHERE object_key = ${objectKey} FOR UPDATE`;
        const attempts = (row?.attempts ?? 0) + 1;
        const nextAttemptAt = new Date(
          now.getTime() + profileImageCleanupDelayMs(attempts),
        );
        await tx.communityPhotoCleanup.upsert({
          where: { objectKey },
          create: { objectKey, attempts, nextAttemptAt, lastErrorCode: code },
          update: { attempts, nextAttemptAt, lastErrorCode: code },
        });
      });
    } catch {
      // The row keeps its previous schedule; the next pass retries it.
      this.logger.error(
        JSON.stringify({ event: 'community_photo_cleanup_record_failed' }),
      );
    }
    this.logger.warn(
      JSON.stringify({ event: 'community_photo_cleanup_failed', code }),
    );
  }

  private failureCode(cause: unknown): string {
    if (!this.storage.isConfigured()) return 'STORAGE_UNAVAILABLE';
    const name =
      cause && typeof cause === 'object' && 'name' in cause
        ? String((cause as { name: unknown }).name)
        : '';
    return /abort|timeout/iu.test(name)
      ? 'STORAGE_TIMEOUT'
      : 'STORAGE_DELETE_FAILED';
  }
}
