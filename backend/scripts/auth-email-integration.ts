import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { AuthService } from '../src/auth/auth.service';
import { AccessTokenGuard } from '../src/auth/access-token.guard';
import {
  EmailAuthCleanupService,
  EMAIL_AUTH_CLEANUP_BATCH,
} from '../src/auth/email-auth-cleanup.service';
import { EmailVerificationService } from '../src/auth/email-verification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { authEmailFixture } from './lib/auth-email-fixture';

const url = new URL(process.env.DATABASE_URL ?? '');
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    /test/.test(url.pathname),
  'Use an explicit loopback test database.',
);
const db = new PrismaService();
const fixture = authEmailFixture(db);
const v = fixture.verification;
const suffix = `auth-email-${randomUUID()}`;
const email = (name: string) => `${name}-${suffix}@example.com`;
const password = 'Original-password-123!';
const nextPassword = 'Changed-password-456!';
const jwt = new JwtService();
const config = new ConfigService({
  JWT_ACCESS_SECRET: 'integration-jwt-secret-only',
  JWT_ACCESS_TTL: '15m',
  REFRESH_TOKEN_TTL: '7d',
});
const auth = new AuthService(db, jwt, config, v);
const guard = new AccessTokenGuard(jwt, db, new Reflector(), config);
let checks = 0;

async function rejects(work: Promise<unknown>, code: string) {
  await assert.rejects(
    work,
    (error: unknown) =>
      error instanceof HttpException &&
      (error.getResponse() as { error: { code: string } }).error.code === code,
  );
  checks++;
}
async function allowed(token: string) {
  return guard.canActivate({
    getHandler: () => function protectedRoute() {},
    getClass: () => class Protected {},
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
    }),
  } as unknown as ExecutionContext);
}
async function requestCode(
  address: string,
  purpose: 'signup' | 'password_reset' = 'signup',
  service = v,
) {
  const response = await service.request(
    { email: address, purpose },
    fixture.metadata,
  );
  return {
    ...response.data,
    email: address,
    purpose,
    code: fixture.codes.get(response.data.challengeId)!,
  };
}
async function verify(
  requested: Awaited<ReturnType<typeof requestCode>>,
  overrides = {},
) {
  return v.verify({ ...requested, ...overrides }, fixture.metadata);
}
async function age(address: string) {
  await db.emailAuthChallenge.updateMany({
    where: { email: address },
    data: { createdAt: new Date(Date.now() - 61_000) },
  });
}
async function user(
  address: string,
  status: 'active' | 'suspended' | 'deleted' = 'active',
) {
  return db.user.create({
    data: {
      email: address,
      nickname: address,
      passwordHash: await argon2.hash(password),
      status,
      role: 'operator',
      portfolioPublic: false,
    },
  });
}

async function retentionChecks() {
  const cleanup = new EmailAuthCleanupService(db);
  const address = email('retention');
  const prefix = `retention-${suffix}-`;
  const old = new Date('1900-01-01T00:00:00.000Z'),
    now = Date.now();
  const fresh = new Date(now + 600_000),
    recent = new Date(now - 12 * 3_600_000);
  const expired = Array.from(
    { length: EMAIL_AUTH_CLEANUP_BATCH + 7 },
    (_, i) => ({
      id: `${prefix}old-${i}`,
      email: address,
      purpose: 'signup' as const,
      codeHash: 'fixture-digest',
      expiresAt: old,
      proofExpiresAt: old,
    }),
  );
  const keep = [
    { id: `${prefix}code`, expiresAt: fresh, proofExpiresAt: null },
    { id: `${prefix}proof`, expiresAt: old, proofExpiresAt: fresh },
    { id: `${prefix}proof-grace`, expiresAt: old, proofExpiresAt: recent },
    { id: `${prefix}code-grace`, expiresAt: recent, proofExpiresAt: null },
  ];
  await db.emailAuthChallenge.createMany({
    data: [
      ...expired,
      ...keep.map((row) => ({
        ...row,
        email: address,
        purpose: 'signup' as const,
        codeHash: 'fixture-digest',
      })),
    ],
  });
  const bucketKeys = [
    ...expired.map((_, i) => `${prefix}bucket-${i}`),
    `${prefix}active`,
    `${prefix}recent`,
    `${prefix}renewed`,
  ];
  await db.emailAuthRateBucket.createMany({
    data: bucketKeys.map((key) => ({
      key,
      hits: 30,
      expiresAt: key.endsWith('active')
        ? fresh
        : key.endsWith('recent')
          ? recent
          : old,
    })),
  });
  const usersBefore = await db.user.count(),
    sessionsBefore = await db.refreshTokenSession.count(),
    walletsBefore = await db.cashWallet.count();
  try {
    // A competing instance holding the advisory lock skips the whole pass.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('email-auth-retention', 0))::text`;
      assert.equal((await cleanup.deleteBatch()) === null, true);
    });
    // A rate-budget renewal in flight is skipped and its new expiry is retained.
    await db.$transaction(async (tx) => {
      await tx.emailAuthRateBucket.update({
        where: { key: `${prefix}renewed` },
        data: { expiresAt: fresh },
      });
      const batch = await cleanup.deleteBatch();
      assert.equal(batch?.challenges, EMAIL_AUTH_CLEANUP_BATCH);
      assert.equal(batch?.buckets, EMAIL_AUTH_CLEANUP_BATCH);
    });
    assert.equal(
      await db.emailAuthChallenge.count({
        where: { id: { in: expired.map((row) => row.id) } },
      }),
      7,
    );
    const passes = await Promise.all([
      cleanup.deleteBatch(),
      new EmailAuthCleanupService(db).deleteBatch(),
    ]);
    for (const pass of passes)
      if (pass) {
        assert.ok(pass.challenges <= EMAIL_AUTH_CLEANUP_BATCH);
        assert.ok(pass.buckets <= EMAIL_AUTH_CLEANUP_BATCH);
      }
    assert.equal(
      await db.emailAuthChallenge.count({
        where: { id: { in: expired.map((row) => row.id) } },
      }),
      0,
    );
    assert.equal(
      await db.emailAuthChallenge.count({
        where: { id: { in: keep.map((row) => row.id) } },
      }),
      keep.length,
    );
    assert.equal(
      await db.emailAuthRateBucket.count({
        where: { key: { in: bucketKeys } },
      }),
      3,
    );
    assert.equal(
      (
        await db.emailAuthRateBucket.findUniqueOrThrow({
          where: { key: `${prefix}renewed` },
        })
      ).hits,
      30,
    );
    assert.equal(await db.user.count(), usersBefore);
    assert.equal(await db.refreshTokenSession.count(), sessionsBefore);
    assert.equal(await db.cashWallet.count(), walletsBefore);
    // A locked old challenge must not hold up a batch or be deleted.
    await db.emailAuthChallenge.create({
      data: { ...expired[0], id: `${prefix}locked` },
    });
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM email_auth_challenges WHERE id = ${`${prefix}locked`} FOR UPDATE`;
      await cleanup.deleteBatch();
      assert.equal(
        await tx.emailAuthChallenge.count({ where: { id: `${prefix}locked` } }),
        1,
      );
    });
    // Failure after the first table rolls back both tables; the request path is unaffected.
    const execute = db.$transaction.bind(db);
    const broken = {
      $transaction: (work: (tx: any) => Promise<unknown>, options: any) =>
        execute(async (tx) => {
          const wrapped = new Proxy(tx, {
            get(target, property) {
              if (property === '$executeRaw')
                return async (
                  strings: TemplateStringsArray,
                  ...values: unknown[]
                ) => {
                  if (
                    strings
                      .join('')
                      .includes('DELETE FROM email_auth_rate_buckets')
                  )
                    throw new Error('fixture DB failure');
                  return tx.$executeRaw(strings, ...values);
                };
              return Reflect.get(target, property);
            },
          });
          return work(wrapped);
        }, options),
    };
    await assert.rejects(
      new EmailAuthCleanupService(broken as never).deleteBatch(),
      /fixture DB failure/,
    );
    assert.equal(
      await db.emailAuthChallenge.count({ where: { id: `${prefix}locked` } }),
      1,
    );
    await cleanup.deleteBatch();
    checks += 10;
  } finally {
    await db.emailAuthChallenge.deleteMany({ where: { email: address } });
    await db.emailAuthRateBucket.deleteMany({
      where: { key: { in: bucketKeys } },
    });
  }
}

async function main() {
  await db.$connect();
  try {
    const signupEmail = email('signup');
    await rejects(
      auth.signup(
        { email: signupEmail, nickname: signupEmail, password },
        fixture.metadata,
      ),
      'EMAIL_VERIFICATION_REQUIRED',
    );
    assert.equal(await db.user.count({ where: { email: signupEmail } }), 0);
    const request = await requestCode(signupEmail);
    assert.equal(await db.user.count({ where: { email: signupEmail } }), 0);
    const stored = await db.emailAuthChallenge.findUniqueOrThrow({
      where: { id: request.challengeId },
    });
    assert.notEqual(stored.codeHash, request.code);
    assert.equal(stored.codeHash.length, 64);
    await rejects(
      verify(request, { purpose: 'password_reset' }),
      'EMAIL_CODE_INVALID',
    );
    await rejects(
      verify(request, { email: email('other') }),
      'EMAIL_CODE_INVALID',
    );
    const proof = (await verify(request)).data.verificationToken;
    await rejects(verify(request), 'EMAIL_CODE_INVALID');
    await rejects(
      auth.resetPassword(
        {
          email: signupEmail,
          password: nextPassword,
          verificationToken: proof,
        },
        fixture.metadata,
      ),
      'EMAIL_VERIFICATION_REQUIRED',
    );
    const signupResults = await Promise.allSettled(
      [1, 2].map(() =>
        auth.signup(
          {
            email: signupEmail,
            password,
            nickname: signupEmail,
            verificationToken: proof,
          },
          fixture.metadata,
        ),
      ),
    );
    assert.equal(
      signupResults.filter((x) => x.status === 'fulfilled').length,
      1,
    );
    const signup = (
      signupResults.find(
        (x) => x.status === 'fulfilled',
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof auth.signup>>>
    ).value;
    const created = await db.user.findUniqueOrThrow({
      where: { email: signupEmail },
    });
    assert.ok(created.emailVerifiedAt);
    assert.equal(
      await db.refreshTokenSession.count({ where: { userId: created.id } }),
      1,
    );
    assert.equal(
      await db.tradingAccount.count({ where: { userId: created.id } }),
      0,
    );
    assert.equal(
      await db.seasonParticipant.count({ where: { userId: created.id } }),
      0,
    );
    assert.equal(await allowed(signup.data.tokens.accessToken), true);
    checks += 9;

    // Legacy unverified account retains login and legacy JWT compatibility.
    const legacy = await user(email('legacy'));
    assert.equal(legacy.emailVerifiedAt === null, true);
    const account = await db.tradingAccount.create({
      data: {
        userId: legacy.id,
        mode: 'general',
        initialCapitalKrw: '1234',
        openedAt: new Date(),
      },
    });
    await db.cashWallet.create({
      data: {
        tradingAccountId: account.id,
        walletScope: 'securities',
        currencyCode: 'KRW',
        balanceAmount: '1234',
        reservedAmount: '123',
      },
    });
    const walletsBefore = JSON.stringify(
      await db.cashWallet.findMany({ where: { tradingAccountId: account.id } }),
    );
    const accountBefore = JSON.stringify(
      await db.tradingAccount.findUnique({ where: { id: account.id } }),
    );
    const login = await auth.login(
      { email: legacy.email, password },
      fixture.metadata,
    );
    const legacyToken = await jwt.signAsync(
      { sub: legacy.id },
      { secret: config.get('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    assert.equal(await allowed(legacyToken), true);
    const reset = await requestCode(legacy.email, 'password_reset');
    assert.equal(
      await allowed(login.data.tokens.accessToken),
      true,
      'requesting reset must not revoke a session',
    );
    const resetProof = (await verify(reset)).data.verificationToken;
    await rejects(
      auth.resetPassword(
        {
          email: signupEmail,
          password: nextPassword,
          verificationToken: resetProof,
        },
        fixture.metadata,
      ),
      'EMAIL_VERIFICATION_REQUIRED',
    );
    const resetResults = await Promise.allSettled(
      [1, 2].map(() =>
        auth.resetPassword(
          {
            email: legacy.email,
            password: nextPassword,
            verificationToken: resetProof,
          },
          fixture.metadata,
        ),
      ),
    );
    assert.equal(
      resetResults.filter((x) => x.status === 'fulfilled').length,
      1,
    );
    const updated = await db.user.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    assert.equal(updated.tokenVersion, 1);
    assert.ok(updated.emailVerifiedAt);
    assert.equal(updated.role, legacy.role);
    assert.equal(updated.status, legacy.status);
    assert.equal(updated.portfolioPublic, legacy.portfolioPublic);
    assert.equal(updated.nickname, legacy.nickname);
    assert.equal(
      JSON.stringify(
        await db.tradingAccount.findUnique({ where: { id: account.id } }),
      ),
      accountBefore,
    );
    assert.equal(
      JSON.stringify(
        await db.cashWallet.findMany({
          where: { tradingAccountId: account.id },
        }),
      ),
      walletsBefore,
    );
    await rejects(
      auth.login({ email: legacy.email, password }),
      'INVALID_CREDENTIALS',
    );
    await rejects(
      auth.refresh({ refreshToken: login.data.tokens.refreshToken }),
      'INVALID_REFRESH_TOKEN',
    );
    await rejects(allowed(login.data.tokens.accessToken), 'UNAUTHORIZED');
    await rejects(allowed(legacyToken), 'UNAUTHORIZED');
    const newLogin = await auth.login(
      { email: legacy.email, password: nextPassword },
      fixture.metadata,
    );
    assert.equal(await allowed(newLogin.data.tokens.accessToken), true);
    const rotated = await auth.refresh({
      refreshToken: newLogin.data.tokens.refreshToken,
    });
    assert.equal(await allowed(rotated.data.tokens.accessToken), true);
    checks += 11;

    // Missing/inactive users never receive mail and share the same external shape.
    for (const status of ['suspended', 'deleted'] as const)
      await user(email(status), status);
    const sentBefore = fixture.deliveries.length;
    for (const name of ['unknown', 'suspended', 'deleted']) {
      const hidden = await requestCode(email(name), 'password_reset');
      assert.equal(hidden.message, reset.message);
      await rejects(verify(hidden, { code: '123456' }), 'EMAIL_CODE_INVALID');
    }
    assert.equal(fixture.deliveries.length, sentBefore);
    checks++;

    // Five failed attempts persist even though API rejects; expiry is DB-authoritative.
    const wrong = await requestCode(email('wrong'));
    const incorrect = wrong.code === '000000' ? '999999' : '000000';
    for (let i = 0; i < 5; i++)
      await rejects(
        verify(wrong, { code: incorrect }),
        i === 4 ? 'EMAIL_CODE_EXHAUSTED' : 'EMAIL_CODE_INVALID',
      );
    await rejects(verify(wrong), 'EMAIL_CODE_EXHAUSTED');
    assert.equal(
      (
        await db.emailAuthChallenge.findUniqueOrThrow({
          where: { id: wrong.challengeId },
        })
      ).attempts,
      5,
    );
    const expired = await requestCode(email('expired'));
    await db.emailAuthChallenge.update({
      where: { id: expired.challengeId },
      data: { expiresAt: new Date(0) },
    });
    await rejects(verify(expired), 'EMAIL_CODE_EXPIRED');

    // Resend revokes both previous code and a previously verified proof.
    const old = await requestCode(email('resend'));
    await rejects(requestCode(old.email), 'EMAIL_RATE_LIMITED');
    await age(old.email);
    const replacement = await requestCode(old.email);
    await rejects(verify(old), 'EMAIL_CODE_INVALID');
    const oldProof = (await verify(replacement)).data.verificationToken;
    await age(old.email);
    await requestCode(old.email);
    await rejects(
      auth.signup(
        {
          email: old.email,
          password,
          nickname: old.email,
          verificationToken: oldProof,
        },
        fixture.metadata,
      ),
      'EMAIL_VERIFICATION_REQUIRED',
    );
    for (let i = 0; i < 2; i++) {
      await age(old.email);
      await requestCode(old.email);
    }
    await age(old.email);
    await rejects(
      requestCode(old.email, 'password_reset'),
      'EMAIL_RATE_LIMITED',
    );

    // Concurrent replicas share email locking and code consumption.
    const replica = new EmailVerificationService(
      db,
      (v as unknown as { mail: never }).mail,
    );
    replica.padResponse = async () => {};
    const concurrentEmail = email('concurrent');
    const sends = await Promise.allSettled(
      [v, replica].map((service) =>
        requestCode(concurrentEmail, 'signup', service),
      ),
    );
    assert.equal(sends.filter((x) => x.status === 'fulfilled').length, 1);
    const one = (
      sends.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof requestCode>>
      >
    ).value;
    const verifies = await Promise.allSettled(
      [v, replica].map((service) => service.verify(one, fixture.metadata)),
    );
    assert.equal(verifies.filter((x) => x.status === 'fulfilled').length, 1);
    checks += 2;

    fixture.failDelivery(true);
    const failed = await requestCode(email('send-failed'));
    fixture.failDelivery(false);
    assert.equal(failed.message, request.message);
    await rejects(verify(failed, { code: '123456' }), 'EMAIL_CODE_INVALID');

    // Proof expiry and failed DB change roll back evidence, password and session revocation.
    const rollbackUser = await user(email('rollback'));
    const rollbackLogin = await auth.login(
      { email: rollbackUser.email, password },
      fixture.metadata,
    );
    const rollbackProof = await fixture.proof(
      rollbackUser.email,
      'password_reset',
    );
    const failingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction')
          return (callback: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(transaction, key) {
                    if (key === 'refreshTokenSession')
                      return {
                        ...transaction.refreshTokenSession,
                        updateMany: async () => {
                          throw new Error('Fixture write failure');
                        },
                      };
                    return Reflect.get(transaction, key);
                  },
                }),
              ),
            );
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failing = new AuthService(failingDb, jwt, config, v);
    await assert.rejects(
      failing.resetPassword(
        {
          email: rollbackUser.email,
          password: nextPassword,
          verificationToken: rollbackProof,
        },
        fixture.metadata,
      ),
      /Fixture write failure/,
    );
    assert.equal(
      await argon2.verify(
        (await db.user.findUniqueOrThrow({ where: { id: rollbackUser.id } }))
          .passwordHash,
        password,
      ),
      true,
    );
    assert.equal(await allowed(rollbackLogin.data.tokens.accessToken), true);
    assert.equal(
      await db.refreshTokenSession.count({
        where: { userId: rollbackUser.id, status: 'active' },
      }),
      1,
    );
    await auth.resetPassword(
      {
        email: rollbackUser.email,
        password: nextPassword,
        verificationToken: rollbackProof,
      },
      fixture.metadata,
    );
    const proofExpiredUser = await user(email('proof-expired'));
    const expiredProof = await fixture.proof(
      proofExpiredUser.email,
      'password_reset',
    );
    await db.emailAuthChallenge.updateMany({
      where: { email: proofExpiredUser.email },
      data: { proofExpiresAt: new Date(0) },
    });
    await rejects(
      auth.resetPassword(
        {
          email: proofExpiredUser.email,
          password: nextPassword,
          verificationToken: expiredProof,
        },
        fixture.metadata,
      ),
      'EMAIL_VERIFICATION_REQUIRED',
    );
    checks += 2;

    // Status change between verification and completion cannot bypass suspension/deletion.
    for (const status of ['suspended', 'deleted'] as const) {
      const changed = await user(email(`changed-${status}`));
      const evidence = await fixture.proof(changed.email, 'password_reset');
      await db.user.update({ where: { id: changed.id }, data: { status } });
      await rejects(
        auth.resetPassword(
          {
            email: changed.email,
            password: nextPassword,
            verificationToken: evidence,
          },
          fixture.metadata,
        ),
        'EMAIL_VERIFICATION_REQUIRED',
      );
      const unchanged = await db.user.findUniqueOrThrow({
        where: { id: changed.id },
      });
      assert.equal(unchanged.status, status);
      assert.equal(unchanged.tokenVersion, 0);
      assert.equal(unchanged.passwordHash, changed.passwordHash);
    }

    // Email/nickname conflicts are checked only after valid proof and leave it unconsumed.
    const collisionEmail = email('collision');
    const collisionProof = await fixture.proof(collisionEmail, 'signup');
    await rejects(
      auth.signup(
        {
          email: collisionEmail,
          nickname: signupEmail,
          password,
          verificationToken: collisionProof,
        },
        fixture.metadata,
      ),
      'NICKNAME_ALREADY_EXISTS',
    );
    await user(collisionEmail);
    await rejects(
      auth.signup(
        {
          email: collisionEmail,
          nickname: collisionEmail,
          password,
          verificationToken: collisionProof,
        },
        fixture.metadata,
      ),
      'EMAIL_ALREADY_EXISTS',
    );

    // Budgets persist on failures and are shared by service instances.
    for (const [action, max] of [
      ['send', 30],
      ['verify', 100],
      ['complete', 30],
    ] as const) {
      const metadata = {
        ipAddress: `2001:db8::${action === 'send' ? 'a' : action === 'verify' ? 'b' : 'c'}`,
      };
      const key = createHmac('sha256', fixture.secret)
        .update(JSON.stringify(['ip', action, metadata.ipAddress]))
        .digest('hex');
      await db.emailAuthRateBucket.deleteMany({ where: { key } });
      for (let i = 0; i < max; i++) await v.limit(action, metadata);
      await rejects(replica.limit(action, metadata), 'EMAIL_RATE_LIMITED');
      await db.emailAuthRateBucket.update({
        where: { key },
        data: { expiresAt: new Date(0) },
      });
      await replica.limit(action, metadata);
      await db.emailAuthRateBucket.delete({ where: { key } });
    }
    await retentionChecks();
    console.log(
      `auth email PostgreSQL integration ok (${checks} grouped checks)`,
    );
  } finally {
    const ids = (
      await db.user.findMany({
        where: { email: { contains: suffix } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await db.cashWallet.deleteMany({
      where: { tradingAccount: { userId: { in: ids } } },
    });
    await db.tradingAccount.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.emailAuthChallenge.deleteMany({
      where: { email: { contains: suffix } },
    });
    const keys = ['send', 'verify', 'complete'].map((action) =>
      createHmac('sha256', fixture.secret)
        .update(JSON.stringify(['ip', action, fixture.metadata.ipAddress]))
        .digest('hex'),
    );
    await db.emailAuthRateBucket.deleteMany({ where: { key: { in: keys } } });
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  // Assertions use primitives; never dump Prisma records/requests or fixture codes.
  console.error(
    error instanceof assert.AssertionError
      ? error.stack
      : error instanceof Error
        ? error.message
        : 'Auth integration failed',
  );
  process.exitCode = 1;
});
