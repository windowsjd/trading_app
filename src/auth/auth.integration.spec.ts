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
          REFRESH_TOKEN_TTL: process.env.REFRESH_TOKEN_TTL || '7d',
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
import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RefreshTokenSessionStatus, UserStatus } from './src/generated/prisma/client';
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

    if (key === 'REFRESH_TOKEN_TTL') {
      return process.env.REFRESH_TOKEN_TTL;
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
    assert.ok(signupResponse.data.tokens.refreshToken);
    assert.equal(JSON.stringify(signupResponse).includes('passwordHash'), false);

    const activeUser = await prisma.user.findUniqueOrThrow({
      where: { email: activeEmail },
    });
    assert.notEqual(activeUser.passwordHash, password);
    assert.equal(await argon2.verify(activeUser.passwordHash, password), true);
    const signupRefreshSession = await prisma.refreshTokenSession.findUniqueOrThrow({
      where: {
        tokenHash: hashRefreshToken(signupResponse.data.tokens.refreshToken),
      },
    });
    assert.equal(signupRefreshSession.userId, activeUser.id);
    assert.equal(signupRefreshSession.status, RefreshTokenSessionStatus.active);
    assert.notEqual(signupRefreshSession.tokenHash, signupResponse.data.tokens.refreshToken);

    const loginResponse = await authService.login({
      email: activeEmail,
      password,
    });
    assert.equal(loginResponse.success, true);
    assert.ok(loginResponse.data.tokens.accessToken);
    assert.ok(loginResponse.data.tokens.refreshToken);

    const refreshResponse = await authService.refresh({
      refreshToken: loginResponse.data.tokens.refreshToken,
    });
    assert.equal(refreshResponse.success, true);
    assert.ok(refreshResponse.data.tokens.accessToken);
    assert.ok(refreshResponse.data.tokens.refreshToken);
    assert.notEqual(
      refreshResponse.data.tokens.refreshToken,
      loginResponse.data.tokens.refreshToken,
    );
    const oldLoginRefreshSession = await prisma.refreshTokenSession.findUniqueOrThrow({
      where: {
        tokenHash: hashRefreshToken(loginResponse.data.tokens.refreshToken),
      },
    });
    const rotatedRefreshSession = await prisma.refreshTokenSession.findUniqueOrThrow({
      where: {
        tokenHash: hashRefreshToken(refreshResponse.data.tokens.refreshToken),
      },
    });
    assert.equal(oldLoginRefreshSession.status, RefreshTokenSessionStatus.revoked);
    assert.equal(oldLoginRefreshSession.replacedBySessionId, rotatedRefreshSession.id);
    assert.equal(rotatedRefreshSession.status, RefreshTokenSessionStatus.active);

    try {
      await authService.refresh({
        refreshToken: loginResponse.data.tokens.refreshToken,
      });
      throw new Error('Expected old refresh token reuse to fail');
    } catch (error) {
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), 401);
      assert.equal(error.getResponse().error.code, 'INVALID_REFRESH_TOKEN');
    }

    const logoutResponse = await authService.logout({
      refreshToken: refreshResponse.data.tokens.refreshToken,
    });
    assert.equal(logoutResponse.success, true);
    assert.equal(logoutResponse.data.revoked, true);
    const loggedOutSession = await prisma.refreshTokenSession.findUniqueOrThrow({
      where: {
        tokenHash: hashRefreshToken(refreshResponse.data.tokens.refreshToken),
      },
    });
    assert.equal(loggedOutSession.status, RefreshTokenSessionStatus.revoked);
    const secondLogoutResponse = await authService.logout({
      refreshToken: refreshResponse.data.tokens.refreshToken,
    });
    assert.equal(secondLogoutResponse.success, true);

    const logoutAllLoginOne = await authService.login({
      email: activeEmail,
      password,
    });
    const logoutAllLoginTwo = await authService.login({
      email: activeEmail,
      password,
    });
    assert.ok(logoutAllLoginOne.data.tokens.refreshToken);
    assert.ok(logoutAllLoginTwo.data.tokens.refreshToken);
    const logoutAllResponse = await authService.logoutAll(activeUser.id);
    assert.equal(logoutAllResponse.success, true);
    const activeRefreshSessionCount = await prisma.refreshTokenSession.count({
      where: {
        userId: activeUser.id,
        status: RefreshTokenSessionStatus.active,
      },
    });
    assert.equal(activeRefreshSessionCount, 0);

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

function hashRefreshToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
