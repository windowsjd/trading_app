import { Injectable } from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiError } from '../common/api-error';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthEmailService, type EmailPurpose } from './auth-email.service';
import type { RequestAuthMetadata } from './auth.types';

export type EmailRequestBody = { email?: unknown; purpose?: unknown };
export type EmailVerifyBody = EmailRequestBody & {
  challengeId?: unknown;
  code?: unknown;
};
const TEN_MINUTES = 600_000;
const HOUR = 3_600_000;
const INVALID = 'EMAIL_CODE_INVALID';

export function authEmail(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  ) {
    throw createApiError('INVALID_EMAIL', 'Email must be a valid email.', 400);
  }
  return value.trim().toLowerCase();
}

function purposeOf(value: unknown): EmailPurpose {
  if (
    value !== 'signup' &&
    value !== 'password_reset' &&
    value !== 'account_deletion'
  )
    throw createApiError(INVALID, 'Email verification is invalid.', 400);
  return value;
}

function proofHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: AuthEmailService,
  ) {}

  private digest(parts: string[]) {
    return createHmac('sha256', this.mail.configuration().secret)
      .update(JSON.stringify(parts))
      .digest('hex');
  }

  async now(tx: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Date> {
    // Epoch avoids adapter/session timezone interpretation of TIMESTAMPTZ.
    const [row] = await tx.$queryRaw<
      { epochMs: string }[]
    >`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS "epochMs"`;
    return new Date(Number(row.epochMs));
  }

  /** Also taken by account deletion before the user row (same order). */
  async lockEmail(tx: Prisma.TransactionClient, email: string) {
    // One lock namespace for both purposes and every state transition.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email-auth:${email}`}, 0))::text AS locked`;
  }

  async limit(
    action: 'send' | 'verify' | 'complete' | 'status',
    metadata: RequestAuthMetadata,
  ) {
    const ip =
      metadata.ipAddress && isIP(metadata.ipAddress)
        ? metadata.ipAddress
        : 'unknown';
    const key = this.digest(['ip', action, ip]);
    const max = action === 'verify' || action === 'status' ? 100 : 30;
    const duration = action === 'send' ? HOUR : TEN_MINUTES;
    // Separate committed operation: failed validation/transactions cannot refund abuse budgets.
    const [bucket] = await this.prisma.$queryRaw<{ hits: number }[]>`
      INSERT INTO email_auth_rate_buckets (key, hits, expires_at)
      VALUES (${key}, 1, timezone('UTC', clock_timestamp()) + ${duration} * interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN email_auth_rate_buckets.expires_at <= timezone('UTC', clock_timestamp())
          THEN 1 ELSE LEAST(email_auth_rate_buckets.hits + 1, ${max + 1}) END,
        expires_at = CASE WHEN email_auth_rate_buckets.expires_at <= timezone('UTC', clock_timestamp())
          THEN timezone('UTC', clock_timestamp()) + ${duration} * interval '1 millisecond' ELSE email_auth_rate_buckets.expires_at END
      RETURNING hits`;
    if (bucket.hits > max) this.rateLimited();
  }

  async request(
    body: EmailRequestBody = {},
    metadata: RequestAuthMetadata = {},
  ) {
    const started = performance.now();
    this.mail.configuration();
    await this.limit('send', metadata);
    const email = authEmail(body.email);
    const purpose = purposeOf(body.purpose);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const id = randomUUID();
    const reserved = await this.prisma.$transaction(async (tx) => {
      await this.lockEmail(tx, email);
      const now = await this.now(tx);
      const recent = await tx.emailAuthChallenge.findMany({
        where: { email, createdAt: { gt: new Date(now.getTime() - HOUR) } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { createdAt: true },
      });
      if (
        recent.length >= 5 ||
        (recent[0] && now.getTime() - recent[0].createdAt.getTime() < 60_000)
      )
        this.rateLimited();
      const target = await tx.user.findUnique({
        where: { email },
        select: { id: true, status: true, tokenVersion: true },
      });
      const eligible =
        purpose === 'signup' ? !target : target?.status === 'active';
      // Reset and deletion proofs are bound to the account and its token
      // version at issue time, so a later reset/deletion invalidates them.
      const bound = purpose !== 'signup' && eligible;
      await tx.emailAuthChallenge.updateMany({
        where: { email, purpose, consumedAt: null },
        data: { consumedAt: now },
      });
      const challenge = await tx.emailAuthChallenge.create({
        data: {
          id,
          email,
          purpose,
          codeHash: this.digest(['code', id, email, purpose, code]),
          createdAt: now,
          expiresAt: new Date(now.getTime() + TEN_MINUTES),
          targetUserId: bound ? target?.id : null,
          targetVersion: bound ? target?.tokenVersion : null,
        },
      });
      return { challenge, eligible };
    });
    try {
      if (reserved.eligible) {
        await this.mail.send(email, purpose, code, id);
        await this.prisma.emailAuthChallenge.updateMany({
          where: { id, consumedAt: null },
          data: { deliveredAt: new Date() },
        });
      }
    } catch {
      // Ambiguous timeout may have delivered a mail; its code must still be unusable.
      await this.prisma.emailAuthChallenge.updateMany({
        where: { id },
        data: { consumedAt: new Date() },
      });
    }
    // Provider outcome, existence and status share status/body and a bounded timing envelope.
    await this.padResponse(started);
    const serverTime = await this.now(this.prisma);
    return {
      success: true,
      data: {
        challengeId: id,
        expiresAt: reserved.challenge.expiresAt.toISOString(),
        resendAt: new Date(
          reserved.challenge.createdAt.getTime() + 60_000,
        ).toISOString(),
        serverTime: serverTime.toISOString(),
        message:
          purpose === 'signup'
            ? '입력하신 이메일로 가입할 수 있다면 인증번호가 발송됩니다.'
            : '입력하신 이메일로 계정이 등록되어 있다면 인증번호가 발송됩니다.',
      },
    };
  }

  async padResponse(started: number) {
    await delay(
      Math.max(0, 5_000 + randomInt(0, 201) - (performance.now() - started)),
    );
  }

  async verify(body: EmailVerifyBody = {}, metadata: RequestAuthMetadata = {}) {
    await this.limit('verify', metadata);
    const email = authEmail(body.email);
    const purpose = purposeOf(body.purpose);
    if (
      typeof body.challengeId !== 'string' ||
      body.challengeId.length > 64 ||
      typeof body.code !== 'string' ||
      !/^\d{6}$/.test(body.code)
    )
      this.codeError(INVALID);
    const id = body.challengeId;
    const code = body.code;
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockEmail(tx, email);
      const now = await this.now(tx);
      const challenge = await tx.emailAuthChallenge.findUnique({
        where: { id },
      });
      if (
        !challenge ||
        challenge.email !== email ||
        challenge.purpose !== purpose ||
        challenge.consumedAt ||
        challenge.verifiedAt
      )
        return { error: INVALID };
      if (challenge.expiresAt <= now) return { error: 'EMAIL_CODE_EXPIRED' };
      if (challenge.attempts >= 5) return { error: 'EMAIL_CODE_EXHAUSTED' };
      const actual = Buffer.from(
        this.digest(['code', id, email, purpose, code]),
        'hex',
      );
      const expected = Buffer.from(challenge.codeHash, 'hex');
      const matches =
        expected.length === actual.length && timingSafeEqual(actual, expected);
      if (!matches || !challenge.deliveredAt) {
        await tx.emailAuthChallenge.update({
          where: { id },
          data: { attempts: { increment: 1 } },
        });
        return {
          error: challenge.attempts === 4 ? 'EMAIL_CODE_EXHAUSTED' : INVALID,
        };
      }
      const verificationToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + TEN_MINUTES);
      await tx.emailAuthChallenge.update({
        where: { id },
        data: {
          verifiedAt: now,
          proofHash: proofHash(verificationToken),
          proofExpiresAt: expiresAt,
        },
      });
      return {
        data: {
          verificationToken,
          expiresAt: expiresAt.toISOString(),
          serverTime: now.toISOString(),
        },
      };
    });
    // Throw after commit so failed attempts are durable.
    if (result.error) this.codeError(result.error);
    return { success: true, data: result.data! };
  }

  async consume(
    tx: Prisma.TransactionClient,
    email: string,
    purpose: EmailPurpose,
    token: unknown,
  ) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      this.proofError();
    await this.lockEmail(tx, email);
    const now = await this.now(tx);
    const challenge = await tx.emailAuthChallenge.findUnique({
      where: { proofHash: proofHash(token) },
    });
    if (
      !challenge ||
      challenge.email !== email ||
      challenge.purpose !== purpose ||
      !challenge.verifiedAt ||
      !challenge.deliveredAt ||
      challenge.consumedAt ||
      !challenge.proofExpiresAt ||
      challenge.proofExpiresAt <= now
    )
      this.proofError();
    await tx.emailAuthChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: now },
    });
    return { ...challenge, now };
  }

  proofError(): never {
    throw createApiError(
      'EMAIL_VERIFICATION_REQUIRED',
      'Verify your email again.',
      400,
    );
  }
  private codeError(code: string): never {
    const messages: Record<string, string> = {
      EMAIL_CODE_INVALID: 'Email verification is invalid.',
      EMAIL_CODE_EXPIRED: 'Email verification has expired.',
      EMAIL_CODE_EXHAUSTED: 'Email verification attempts exceeded.',
    };
    throw createApiError(code, messages[code], 400);
  }
  private rateLimited(): never {
    throw createApiError(
      'EMAIL_RATE_LIMITED',
      'Try email verification again later.',
      429,
    );
  }
}
