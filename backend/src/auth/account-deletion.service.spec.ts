jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<Record<string, unknown>>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class {},
    Prisma: { sql: runtime.sqltag, raw: runtime.raw, join: runtime.join },
  };
});

import { Logger } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { AccountDeletionService } from './account-deletion.service';
import type { AuthService } from './auth.service';
import type { EmailVerificationService } from './email-verification.service';
import type { ProfileImageCleanupService } from './profile-image-cleanup.service';
import type { ProfileImageStorageService } from './profile-image-storage.service';
import type { PrismaService } from '../prisma/prisma.service';

const userId = '7f6e8d0a-6f1b-4c49-9f3c-1d2e3f4a5b6c';
const key = 'k'.repeat(43);
const receipt = {
  status: 'completed' as const,
  deletedAt: new Date('2026-10-18T00:00:00.000Z'),
  completedAt: new Date('2026-10-18T00:00:00.000Z'),
};
const metadata = { ipAddress: '2001:db8::1' };

function harness(
  member: Record<string, unknown> | null = {
    id: userId,
    email: 'member@example.com',
    passwordHash: 'hash',
    tokenVersion: 0,
    status: 'active',
    role: 'user',
  },
) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(member) },
    accountDeletion: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(receipt),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ found: false }]),
    $transaction: jest.fn().mockResolvedValue({
      id: 'deletion',
      waiting: 0,
      preserved: 0,
      rows: {},
    }),
  };
  const auth = {
    verifyPassword: jest
      .fn()
      .mockImplementation((_hash: string, password: string) =>
        Promise.resolve(password === 'correct-password'),
      ),
  };
  const emailVerification = {
    limit: jest.fn().mockResolvedValue(undefined),
  };
  const cleanups = {
    processAccountDeletion: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AccountDeletionService(
    prisma as unknown as PrismaService,
    auth as unknown as AuthService,
    emailVerification as unknown as EmailVerificationService,
    {} as ProfileImageStorageService,
    cleanups as unknown as ProfileImageCleanupService,
  );
  return { service, prisma, auth, emailVerification, cleanups };
}
const app = (h: ReturnType<typeof harness>, body: Record<string, unknown>) =>
  h.service.deleteFromApp(
    userId,
    { password: 'correct-password', requestKey: key, confirm: true, ...body },
    metadata,
  );
const code = (error: unknown) =>
  (error as { response?: { error?: { code?: string } } }).response?.error?.code;

describe('AccountDeletionService', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => {}),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  it('requires an explicit confirmation, a valid key and the password before any transaction', async () => {
    const h = harness();
    for (const [body, expected] of [
      [{ confirm: undefined }, 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED'],
      [{ confirm: 'true' }, 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED'],
      [{ requestKey: 'short' }, 'ACCOUNT_DELETION_REQUEST_KEY_INVALID'],
      [{ requestKey: `${key}!` }, 'ACCOUNT_DELETION_REQUEST_KEY_INVALID'],
      [{ password: 'wrong-password' }, 'ACCOUNT_DELETION_PASSWORD_MISMATCH'],
      [{ password: '' }, 'ACCOUNT_DELETION_PASSWORD_MISMATCH'],
      [{ password: 'x'.repeat(1025) }, 'ACCOUNT_DELETION_PASSWORD_MISMATCH'],
    ] as const) {
      const error = await app(h, body).catch((cause: unknown) => cause);
      expect(code(error)).toBe(expected);
    }
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    // A refused password is a 400, never a 401 that would end the session.
    const mismatch = await app(h, { password: 'wrong' }).catch(
      (cause: unknown) => cause as { status: number },
    );
    expect(mismatch.status).toBe(400);
  });

  it('refuses missing or inactive members', async () => {
    const missing = await harness(null)
      .service.deleteFromApp(
        userId,
        { password: 'correct-password', requestKey: key, confirm: true },
        metadata,
      )
      .catch((cause: unknown) => cause);
    expect(code(missing)).toBe('UNAUTHORIZED');
    const inactive = await app(
      harness({
        id: userId,
        email: 'm@example.com',
        passwordHash: 'h',
        tokenVersion: 0,
        status: 'suspended',
        role: 'user',
      }),
      {},
    ).catch((cause: unknown) => cause);
    expect(code(inactive)).toBe('USER_NOT_ACTIVE');
    const anonymous = await harness()
      .service.deleteFromApp(undefined, {}, metadata)
      .catch((cause: unknown) => cause);
    expect(code(anonymous)).toBe('UNAUTHORIZED');
  });

  it('returns the committed receipt for a retried request key without a new transaction', async () => {
    const h = harness();
    h.prisma.accountDeletion.findUnique.mockResolvedValue(receipt);
    const response = await app(h, {});
    expect(response.data.deletion).toEqual({
      status: 'completed',
      deletedAt: '2026-10-18T00:00:00.000Z',
      completedAt: '2026-10-18T00:00:00.000Z',
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retries deadlocks, lock timeouts and concurrent inserts, then commits once', async () => {
    const h = harness();
    h.prisma.$transaction
      .mockRejectedValueOnce(
        Object.assign(new Error('deadlock'), { code: '40P01' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('lock'), { code: '55P03' }),
      );
    const response = await app(h, {});
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(response.data.deletion.status).toBe('completed');
    const [, options] = h.prisma.$transaction.mock.calls[0] as [
      unknown,
      { timeout: number },
    ];
    expect(options.timeout).toBeGreaterThan(5_000);
  });

  it('maps exhausted or non-retryable failures to ACCOUNT_DELETION_FAILED without raw text in logs', async () => {
    for (const failure of [
      Object.assign(new Error('secret-db-detail'), { code: 'P0001' }),
      Object.assign(new Error('secret-db-detail'), { code: '40P01' }),
    ]) {
      const h = harness();
      h.prisma.$transaction.mockRejectedValue(failure);
      const error = await app(h, {}).catch((cause: unknown) => cause);
      expect(code(error)).toBe('ACCOUNT_DELETION_FAILED');
      expect((error as { status: number }).status).toBe(503);
      expect(h.prisma.$transaction).toHaveBeenCalledTimes(
        failure.code === '40P01' ? 3 : 1,
      );
    }
    const logged = JSON.stringify(
      logs.map((spy) => spy.mock.calls as unknown[]),
    );
    expect(logged).toContain('account_deletion_failed');
    expect(logged).not.toContain('secret-db-detail');
    expect(logged).not.toContain('correct-password');
    expect(logged).not.toContain(key);
    expect(logged).not.toContain(userId);
  });

  it('never retries a domain refusal raised inside the transaction', async () => {
    const h = harness();
    h.prisma.$transaction.mockRejectedValue(
      createApiError(
        'ACCOUNT_DELETION_REQUIRES_SUPPORT',
        'This account must be deleted with support.',
        409,
      ),
    );
    const error = await app(h, {}).catch((cause: unknown) => cause);
    expect(code(error)).toBe('ACCOUNT_DELETION_REQUIRES_SUPPORT');
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('answers success after commit even when the immediate photo removal fails', async () => {
    const h = harness();
    h.prisma.$transaction.mockResolvedValue({
      id: 'deletion',
      waiting: 1,
      preserved: 0,
      rows: {},
    });
    h.cleanups.processAccountDeletion.mockRejectedValue(new Error('storage'));
    h.prisma.accountDeletion.findUniqueOrThrow.mockResolvedValue({
      ...receipt,
      status: 'cleanup_pending',
      completedAt: null,
    });
    const response = await app(h, {});
    expect(response.data.deletion).toEqual({
      status: 'cleanup_pending',
      deletedAt: '2026-10-18T00:00:00.000Z',
      completedAt: null,
    });
  });

  it('checks the password and self-service eligibility without writing', async () => {
    const h = harness();
    await expect(
      h.service.checkPassword(
        userId,
        { password: 'correct-password' },
        metadata,
      ),
    ).resolves.toEqual({ success: true, data: { verified: true } });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    const operator = harness({
      id: userId,
      email: 'op@example.com',
      passwordHash: 'h',
      tokenVersion: 0,
      status: 'active',
      role: 'operator',
    });
    const refused = await operator.service
      .checkPassword(userId, { password: 'correct-password' }, metadata)
      .catch((cause: unknown) => cause);
    expect(code(refused)).toBe('ACCOUNT_DELETION_ROLE_RESTRICTED');
    const footprint = harness();
    footprint.prisma.$queryRaw.mockResolvedValue([{ found: true }]);
    const support = await footprint.service
      .checkPassword(userId, { password: 'correct-password' }, metadata)
      .catch((cause: unknown) => cause);
    expect(code(support)).toBe('ACCOUNT_DELETION_REQUIRES_SUPPORT');
    const placeholder = harness({
      id: userId,
      email: 'ghost-1@deleted-member.invalid',
      passwordHash: 'h',
      tokenVersion: 0,
      status: 'active',
      role: 'user',
    });
    const ghost = await placeholder.service
      .checkPassword(userId, { password: 'correct-password' }, metadata)
      .catch((cause: unknown) => cause);
    expect(code(ghost)).toBe('ACCOUNT_DELETION_REQUIRES_SUPPORT');
  });

  it('reads status only by the request key and hides unknown keys', async () => {
    const h = harness();
    const missing = await h.service
      .status({ requestKey: key }, metadata)
      .catch((cause: unknown) => cause);
    expect(code(missing)).toBe('ACCOUNT_DELETION_NOT_FOUND');
    h.prisma.accountDeletion.findUnique.mockResolvedValue(receipt);
    const found = await h.service.status({ requestKey: key }, metadata);
    expect(found.data.deletion.status).toBe('completed');
    const [lookup] = h.prisma.accountDeletion.findUnique.mock.calls[1] as [
      { where: { requestKeyHash: string } },
    ];
    // Only a SHA-256 of the key is ever used as the handle.
    expect(lookup.where.requestKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lookup.where.requestKeyHash).not.toContain(key);
    expect(h.emailVerification.limit).toHaveBeenCalledWith('status', metadata);
  });

  it('validates the web request before consuming any proof', async () => {
    const h = harness();
    for (const [body, expected] of [
      [
        { email: 'member@example.com', requestKey: key },
        'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
      ],
      [
        { email: 'not-an-email', requestKey: key, confirm: true },
        'INVALID_EMAIL',
      ],
      [
        { email: 'member@example.com', requestKey: 'x', confirm: true },
        'ACCOUNT_DELETION_REQUEST_KEY_INVALID',
      ],
    ] as const) {
      const error = await h.service
        .deleteFromWeb({ verificationToken: 'proof', ...body }, metadata)
        .catch((cause: unknown) => cause);
      expect(code(error)).toBe(expected);
    }
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.emailVerification.limit).toHaveBeenCalledWith(
      'complete',
      metadata,
    );
  });
});
