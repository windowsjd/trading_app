import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createApiError } from '../common/api-error';
import { postgresErrorCode } from '../common/database-failure';
import { classifyFailureCause } from '../common/safe-failure-cause';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccountDeletionScopeChanged,
  hasOperatorFootprint,
  isAccountDeletionPlaceholderEmail,
  lockDeletionScope,
  preserveSettledFinalResults,
  purgeDeletionScope,
} from './account-deletion.purge';
import { AuthService } from './auth.service';
import type { RequestAuthMetadata } from './auth.types';
import {
  authEmail,
  EmailVerificationService,
} from './email-verification.service';
import {
  databaseNow,
  ProfileImageCleanupService,
} from './profile-image-cleanup.service';
import { ProfileImageStorageService } from './profile-image-storage.service';

export type AccountDeletionPasswordBody = { password?: unknown };
export type AppAccountDeletionBody = {
  password?: unknown;
  requestKey?: unknown;
  confirm?: unknown;
};
export type WebAccountDeletionBody = {
  email?: unknown;
  verificationToken?: unknown;
  requestKey?: unknown;
  confirm?: unknown;
};
export type AccountDeletionStatusBody = { requestKey?: unknown };

export type AccountDeletionReceipt = {
  status: 'cleanup_pending' | 'completed';
  deletedAt: string;
  completedAt: string | null;
};
export type AccountDeletionResponse = {
  success: true;
  data: { deletion: AccountDeletionReceipt };
};

type Target =
  | {
      channel: 'app';
      userId: string;
      email: string;
      passwordHash: string;
      tokenVersion: number;
      requestKeyHash: string;
    }
  | {
      channel: 'web';
      email: string;
      verificationToken: unknown;
      requestKeyHash: string;
    };

type LockedMember = {
  id: string;
  email: string;
  passwordHash: string;
  tokenVersion: number;
  status: string;
  role: string;
  profileImageUrl: string | null;
};

const MAX_ATTEMPTS = 3;
const REQUEST_KEY = /^[A-Za-z0-9_-]{32,128}$/;
// Argon2 cost is per byte; nothing legitimate is longer.
const MAX_PASSWORD_LENGTH = 1_024;
const RETRYABLE_SQL_STATES = new Set(['40P01', '40001', '55P03', '23503']);
const RETRYABLE_PRISMA_CODES = new Set(['P2034', 'P2003', 'P2002', 'P2028']);

function requestKeyHash(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_KEY.test(value))
    throw createApiError(
      'ACCOUNT_DELETION_REQUEST_KEY_INVALID',
      'A valid account deletion request key is required.',
      400,
    );
  return createHash('sha256').update(value).digest('hex');
}

function requireConfirmation(value: unknown) {
  if (value !== true)
    throw createApiError(
      'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
      'Confirm the account deletion to continue.',
      400,
    );
}

function passwordMismatch(): never {
  throw createApiError(
    'ACCOUNT_DELETION_PASSWORD_MISMATCH',
    'The password does not match.',
    400,
  );
}

function unauthorized(): never {
  throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
}

function notActive(): never {
  throw createApiError('USER_NOT_ACTIVE', 'User is not active.', 403);
}

function receiptOf(row: {
  status: 'cleanup_pending' | 'completed';
  deletedAt: Date;
  completedAt: Date | null;
}): AccountDeletionReceipt {
  return {
    status: row.status,
    deletedAt: row.deletedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AccountDeletionScopeChanged) return true;
  const state = postgresErrorCode(error);
  if (state && RETRYABLE_SQL_STATES.has(state)) return true;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === 'string' && RETRYABLE_PRISMA_CODES.has(code);
}

/**
 * Self-service account deletion (docs/account-deletion-contract.md).
 *
 * Confirmation IS deletion: one database transaction locks the member, checks
 * the re-authentication evidence (password in the app, a single-use
 * `account_deletion` email proof on the web), deletes every personal and
 * virtual-trading row, preserves settled final results only as anonymous
 * placeholders, and writes the receipt. Either all of it commits or nothing
 * does. Only managed profile image objects outlive the commit; they are
 * removed right after it and retried durably by the cleanup worker, and the
 * receipt says `completed` only when they are gone.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly emailVerification: EmailVerificationService,
    private readonly storage: ProfileImageStorageService,
    private readonly cleanups: ProfileImageCleanupService,
  ) {}

  /** Step "본인 확인" of the app flow. Writes nothing (except the shared
   * abuse budget) and also reports a member who cannot delete here. */
  async checkPassword(
    userId: string | undefined,
    body: AccountDeletionPasswordBody = {},
    metadata: RequestAuthMetadata = {},
  ) {
    if (!userId) unauthorized();
    await this.emailVerification.limit('complete', metadata);
    const member = await this.readVerifiedMember(userId, body.password);
    await this.assertSelfServiceAllowed(this.prisma, member);
    return { success: true as const, data: { verified: true as const } };
  }

  async deleteFromApp(
    userId: string | undefined,
    body: AppAccountDeletionBody = {},
    metadata: RequestAuthMetadata = {},
  ): Promise<AccountDeletionResponse> {
    if (!userId) unauthorized();
    await this.emailVerification.limit('complete', metadata);
    requireConfirmation(body.confirm);
    const keyHash = requestKeyHash(body.requestKey);
    const member = await this.readVerifiedMember(userId, body.password);
    return this.execute({
      channel: 'app',
      userId,
      email: member.email,
      passwordHash: member.passwordHash,
      tokenVersion: member.tokenVersion,
      requestKeyHash: keyHash,
    });
  }

  async deleteFromWeb(
    body: WebAccountDeletionBody = {},
    metadata: RequestAuthMetadata = {},
  ): Promise<AccountDeletionResponse> {
    await this.emailVerification.limit('complete', metadata);
    requireConfirmation(body.confirm);
    const email = authEmail(body.email);
    const keyHash = requestKeyHash(body.requestKey);
    return this.execute({
      channel: 'web',
      email,
      verificationToken: body.verificationToken,
      requestKeyHash: keyHash,
    });
  }

  /** Server-side status for whoever holds the request key (app or web). */
  async status(
    body: AccountDeletionStatusBody = {},
    metadata: RequestAuthMetadata = {},
  ): Promise<AccountDeletionResponse> {
    await this.emailVerification.limit('status', metadata);
    const keyHash = requestKeyHash(body.requestKey);
    const receipt = await this.findReceipt(keyHash);
    if (!receipt)
      throw createApiError(
        'ACCOUNT_DELETION_NOT_FOUND',
        'Account deletion request not found.',
        404,
      );
    return { success: true, data: { deletion: receiptOf(receipt) } };
  }

  private findReceipt(keyHash: string) {
    return this.prisma.accountDeletion.findUnique({
      where: { requestKeyHash: keyHash },
      select: { status: true, deletedAt: true, completedAt: true },
    });
  }

  private async readVerifiedMember(userId: string, password: unknown) {
    const member = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        tokenVersion: true,
        status: true,
        role: true,
      },
    });
    if (!member) unauthorized();
    if (member.status !== 'active') notActive();
    if (
      typeof password !== 'string' ||
      !password ||
      password.length > MAX_PASSWORD_LENGTH ||
      !(await this.auth.verifyPassword(member.passwordHash, password))
    )
      passwordMismatch();
    return member;
  }

  private async assertSelfServiceAllowed(
    client: Pick<Prisma.TransactionClient, '$queryRaw'>,
    member: { id: string; email: string; role: string },
  ) {
    // Operators/admins keep audit, last-admin and moderation duties; their
    // accounts are handled by an administrator (contract §3).
    if (member.role !== 'user')
      throw createApiError(
        'ACCOUNT_DELETION_ROLE_RESTRICTED',
        'Operator and administrator accounts cannot be deleted here.',
        409,
      );
    if (
      isAccountDeletionPlaceholderEmail(member.email) ||
      (await hasOperatorFootprint(client, member.id))
    )
      throw createApiError(
        'ACCOUNT_DELETION_REQUIRES_SUPPORT',
        'This account must be deleted with support.',
        409,
      );
  }

  private async execute(target: Target): Promise<AccountDeletionResponse> {
    // A retried request (lost response) gets the committed receipt back.
    const replay = await this.findReceipt(target.requestKeyHash);
    if (replay) return { success: true, data: { deletion: receiptOf(replay) } };

    let committed:
      | {
          id: string;
          waiting: number;
          preserved: number;
          rows: Record<string, number>;
        }
      | { replay: AccountDeletionReceipt }
      | undefined;
    for (let attempt = 1; !committed; attempt++) {
      try {
        committed = await this.prisma.$transaction(
          (tx) => this.deleteInTransaction(tx, target),
          { maxWait: 10_000, timeout: 60_000 },
        );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (attempt < MAX_ATTEMPTS && isRetryable(error)) continue;
        this.logger.error(
          JSON.stringify({
            event: 'account_deletion_failed',
            channel: target.channel,
            attempt,
            safeCause: classifyFailureCause(error),
          }),
        );
        throw createApiError(
          'ACCOUNT_DELETION_FAILED',
          'Account deletion could not be completed. Try again.',
          503,
        );
      }
    }
    if ('replay' in committed)
      return { success: true, data: { deletion: committed.replay } };
    // Counts only: no member id, email or key reaches the log.
    this.logger.log(
      JSON.stringify({
        event: 'account_deletion_committed',
        deletionId: committed.id,
        channel: target.channel,
        preservedFinalResults: committed.preserved,
        profileImageObjects: committed.waiting,
        rows: committed.rows,
      }),
    );

    if (committed.waiting > 0) {
      try {
        await this.cleanups.processAccountDeletion(committed.id);
      } catch {
        // Committed already; the cleanup worker retries the objects.
        this.logger.warn(
          JSON.stringify({ event: 'account_deletion_cleanup_deferred' }),
        );
      }
    }
    const receipt = await this.prisma.accountDeletion.findUniqueOrThrow({
      where: { id: committed.id },
      select: { status: true, deletedAt: true, completedAt: true },
    });
    return { success: true, data: { deletion: receiptOf(receipt) } };
  }

  private async deleteInTransaction(
    tx: Prisma.TransactionClient,
    target: Target,
  ) {
    // Prisma's deadline does not cancel a PostgreSQL lock wait; these do.
    await tx.$queryRaw`SELECT set_config('lock_timeout', '10000', true)`;
    await tx.$queryRaw`SELECT set_config('statement_timeout', '30000', true)`;

    let member: LockedMember;
    if (target.channel === 'web') {
      // Consumes the single-use proof (email lock first, as in reset/signup).
      const evidence = await this.emailVerification.consume(
        tx,
        target.email,
        'account_deletion',
        target.verificationToken,
      );
      if (!evidence.targetUserId) this.emailVerification.proofError();
      const [locked] = await this.lockMember(tx, evidence.targetUserId);
      if (
        !locked ||
        locked.email !== target.email ||
        locked.status !== 'active' ||
        locked.tokenVersion !== evidence.targetVersion
      )
        this.emailVerification.proofError();
      member = locked;
    } else {
      await this.emailVerification.lockEmail(tx, target.email);
      const [locked] = await this.lockMember(tx, target.userId);
      if (!locked) {
        // Deleted by a concurrent request with this key: same receipt.
        const replay = await tx.accountDeletion.findUnique({
          where: { requestKeyHash: target.requestKeyHash },
          select: { status: true, deletedAt: true, completedAt: true },
        });
        if (replay) return { replay: receiptOf(replay) };
        unauthorized();
      }
      if (locked.status !== 'active') notActive();
      // A password reset or change since verification invalidates it.
      if (
        locked.passwordHash !== target.passwordHash ||
        locked.tokenVersion !== target.tokenVersion
      )
        passwordMismatch();
      member = locked;
    }
    await this.assertSelfServiceAllowed(tx, member);

    const scope = await lockDeletionScope(tx, member.id);
    const now = await databaseNow(tx);
    const receipt = await tx.accountDeletion.create({
      data: {
        requestKeyHash: target.requestKeyHash,
        channel: target.channel,
        status: 'cleanup_pending',
        deletedAt: now,
      },
      select: { id: true },
    });
    const preserved = await preserveSettledFinalResults(tx, scope);
    const rows = await purgeDeletionScope(tx, {
      userId: member.id,
      email: member.email,
      scope,
    });
    const waiting = await this.cleanups.adoptForAccountDeletion(tx, {
      userId: member.id,
      currentKey: this.storage.managedKey(member.profileImageUrl, member.id),
      accountDeletionId: receipt.id,
      now,
    });
    if (waiting === 0)
      await tx.accountDeletion.update({
        where: { id: receipt.id },
        data: { status: 'completed', completedAt: now },
      });
    return { id: receipt.id, waiting, preserved, rows };
  }

  private lockMember(tx: Prisma.TransactionClient, userId: string) {
    // NO KEY UPDATE: login/refresh/reset/profile writes (FOR UPDATE) and
    // operator status changes wait, while FK KEY SHARE inserters can finish;
    // the final DELETE of the row then waits for them (purge §lock order).
    return tx.$queryRaw<LockedMember[]>`
      SELECT id, email, password_hash AS "passwordHash",
             token_version AS "tokenVersion", status::text AS status,
             role::text AS role, profile_image_url AS "profileImageUrl"
      FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;
  }
}
