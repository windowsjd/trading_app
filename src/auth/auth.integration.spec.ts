import { spawnSync } from 'node:child_process';

const RUN_AUTH_DB_SMOKE = process.env.AUTH_DB_SMOKE === '1';

describe('Auth DB smoke', () => {
  it(
    RUN_AUTH_DB_SMOKE
      ? 'verifies signup, login, guard, me, inactive user, and cleanup against PostgreSQL'
      : 'is disabled unless AUTH_DB_SMOKE=1',
    () => {
      if (!RUN_AUTH_DB_SMOKE) {
        expect(process.env.AUTH_DB_SMOKE).not.toBe('1');
        return;
      }

      const result = spawnSync('pnpm', ['tsx', '-e', AUTH_DB_SMOKE_RUNNER], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JWT_ACCESS_SECRET:
            process.env.JWT_ACCESS_SECRET || 'auth-db-smoke-test-secret',
          JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL || '15m',
        },
        encoding: 'utf8',
        timeout: 60_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'Auth DB smoke runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('auth db smoke ok');
    },
    70_000,
  );
});

const AUTH_DB_SMOKE_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { AuthService } from './src/auth/auth.service';
import { AccessTokenGuard } from './src/auth/access-token.guard';
import * as argon2 from 'argon2';

const TEST_PREFIX = 'auth-db-smoke';
const suffix = Date.now() + '-' + Math.random().toString(36).slice(2);
const activeEmail = TEST_PREFIX + '-active-' + suffix + '@example.com';
const suspendedEmail = TEST_PREFIX + '-suspended-' + suffix + '@example.com';
const activeNickname = TEST_PREFIX + '-active-' + suffix;
const suspendedNickname = TEST_PREFIX + '-suspended-' + suffix;
const password = 'Password123!';
const prisma = new PrismaService();
const jwtService = new JwtService();
const configService = {
  get(key) {
    if (key === 'JWT_ACCESS_SECRET') {
      return process.env.JWT_ACCESS_SECRET;
    }

    if (key === 'JWT_ACCESS_TTL') {
      return process.env.JWT_ACCESS_TTL || '15m';
    }

    return undefined;
  },
};
const authService = new AuthService(prisma, jwtService, configService);
const reflector = {
  getAllAndOverride() {
    return false;
  },
};
const guard = new AccessTokenGuard(jwtService, prisma, reflector, configService);

async function main() {
  await prisma.$connect();

  try {
    await cleanup();

    const signupResponse = await authService.signup({
      email: activeEmail,
      password,
      nickname: activeNickname,
    });
    assert.equal(signupResponse.success, true);
    assert.equal(signupResponse.data.user.email, activeEmail);
    assert.equal(signupResponse.data.user.nickname, activeNickname);
    assert.equal(signupResponse.data.user.status, UserStatus.active);
    assert.ok(signupResponse.data.tokens.accessToken);
    assert.equal(JSON.stringify(signupResponse).includes('passwordHash'), false);

    const activeUser = await prisma.user.findUniqueOrThrow({
      where: { email: activeEmail },
    });
    assert.notEqual(activeUser.passwordHash, password);
    assert.equal(await argon2.verify(activeUser.passwordHash, password), true);

    const loginResponse = await authService.login({
      email: activeEmail,
      password,
    });
    assert.equal(loginResponse.success, true);
    assert.ok(loginResponse.data.tokens.accessToken);

    const request = {
      headers: {
        authorization: 'Bearer ' + loginResponse.data.tokens.accessToken,
      },
    };
    const context = {
      getClass() {
        return class ProtectedClass {};
      },
      getHandler() {
        return function protectedHandler() {};
      },
      switchToHttp() {
        return {
          getRequest() {
            return request;
          },
        };
      },
    };
    assert.equal(await guard.canActivate(context), true);
    assert.deepEqual(request.user, { userId: activeUser.id });

    const meResponse = await authService.me(request.user.userId);
    assert.equal(meResponse.data.email, activeEmail);
    assert.equal(meResponse.data.status, UserStatus.active);
    assert.equal(JSON.stringify(meResponse).includes('passwordHash'), false);

    const suspendedHash = await argon2.hash(password);
    const suspendedUser = await prisma.user.create({
      data: {
        email: suspendedEmail,
        passwordHash: suspendedHash,
        nickname: suspendedNickname,
        status: UserStatus.suspended,
      },
    });
    const suspendedToken = await jwtService.signAsync(
      { sub: suspendedUser.id },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: process.env.JWT_ACCESS_TTL || '15m',
      },
    );
    const suspendedRequest = {
      headers: {
        authorization: 'Bearer ' + suspendedToken,
      },
    };
    const suspendedContext = {
      ...context,
      switchToHttp() {
        return {
          getRequest() {
            return suspendedRequest;
          },
        };
      },
    };

    try {
      await guard.canActivate(suspendedContext);
      throw new Error('Expected suspended guard check to fail');
    } catch (error) {
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), 403);
      assert.equal(error.getResponse().error.code, 'USER_NOT_ACTIVE');
    }

    console.log('auth db smoke ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function cleanup() {
  await prisma.user.deleteMany({
    where: {
      email: {
        in: [activeEmail, suspendedEmail],
      },
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
