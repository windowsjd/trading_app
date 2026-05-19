jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  RefreshTokenSessionStatus: {
    active: 'active',
    revoked: 'revoked',
  },
  UserStatus: {
    active: 'active',
    suspended: 'suspended',
    deleted: 'deleted',
  },
}));

import { createHash } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  RefreshTokenSessionStatus,
  UserStatus,
} from '../generated/prisma/client';
import { AuthService } from './auth.service';
import * as argon2 from 'argon2';

const mockedArgon2 = jest.mocked(argon2);

describe('AuthService', () => {
  const createdAt = new Date('2026-05-09T00:00:00.000Z');
  const refreshToken = 'r'.repeat(64);
  const nextRefreshToken = 's'.repeat(64);
  const refreshTokenHash = createHash('sha256')
    .update(refreshToken)
    .digest('hex');
  const futureExpiresAt = new Date('2030-01-01T00:00:00.000Z');
  const expiredAt = new Date('2020-01-01T00:00:00.000Z');

  const activeUser = {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'hashed-password',
    nickname: 'traderKim',
    profileImageUrl: null,
    status: UserStatus.active,
    createdAt,
  };

  const createPrisma = () => {
    const prisma = {
      $transaction: jest.fn(),
      refreshTokenSession: {
        create: jest.fn().mockResolvedValue({ id: 'refresh-session-1' }),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );

    return prisma;
  };

  const createService = (
    options: {
      refreshTtl?: string | undefined;
      secret?: string | undefined;
      ttl?: string | undefined;
    } = {},
  ) => {
    const prisma = createPrisma();
    const jwtService = {
      signAsync: jest.fn().mockResolvedValue('access-token'),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'JWT_ACCESS_SECRET') {
          return options.secret === undefined ? 'test-secret' : options.secret;
        }

        if (key === 'JWT_ACCESS_TTL') {
          return options.ttl === undefined ? '15m' : options.ttl;
        }

        if (key === 'REFRESH_TOKEN_TTL') {
          return Object.prototype.hasOwnProperty.call(options, 'refreshTtl')
            ? options.refreshTtl
            : '7d';
        }

        return undefined;
      }),
    };
    const service = new AuthService(
      prisma as never,
      jwtService as never,
      configService as never,
    );

    return { configService, jwtService, prisma, service };
  };

  const hashToken = (token: string) =>
    createHash('sha256').update(token).digest('hex');

  const expectHttpError = async (
    promise: Promise<unknown>,
    status: HttpStatus,
    code: string,
  ) => {
    try {
      await promise;
      throw new Error('Expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(status);
      expect(httpError.getResponse()).toMatchObject({
        success: false,
        error: {
          code,
        },
      });
    }
  };

  const expectRefreshSessionCreate = (
    prisma: ReturnType<typeof createPrisma>,
    userId = activeUser.id,
  ) => {
    expect(prisma.refreshTokenSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId,
          tokenHash: expect.any(String),
          status: RefreshTokenSessionStatus.active,
          expiresAt: expect.any(Date),
        }),
        select: {
          id: true,
        },
      }),
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedArgon2.hash.mockResolvedValue('hashed-password');
    mockedArgon2.verify.mockResolvedValue(true);
  });

  it('signs up an active user, stores passwordHash, creates a refresh session, and hides secrets', async () => {
    const { jwtService, prisma, service } = createService();
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.user.create.mockResolvedValueOnce({
      id: activeUser.id,
      email: activeUser.email,
      nickname: activeUser.nickname,
      status: activeUser.status,
    });

    const response = await service.signup({
      email: 'USER@example.com ',
      password: 'Password123!',
      nickname: ' traderKim ',
    });

    expect(mockedArgon2.hash).toHaveBeenCalledWith('Password123!');
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          email: 'user@example.com',
          passwordHash: 'hashed-password',
          nickname: 'traderKim',
          status: UserStatus.active,
        },
      }),
    );
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      { sub: activeUser.id },
      { secret: 'test-secret', expiresIn: '15m' },
    );
    expect(response).toEqual({
      success: true,
      data: {
        user: {
          id: activeUser.id,
          email: activeUser.email,
          nickname: activeUser.nickname,
          status: activeUser.status,
        },
        tokens: {
          accessToken: 'access-token',
          refreshToken: expect.any(String),
          accessTokenExpiresIn: '15m',
          refreshTokenExpiresAt: expect.any(String),
        },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expectRefreshSessionCreate(prisma);
    const storedTokenHash =
      prisma.refreshTokenSession.create.mock.calls[0][0].data.tokenHash;
    expect(storedTokenHash).not.toBe(response.data.tokens.refreshToken);
    expect(storedTokenHash).toBe(hashToken(response.data.tokens.refreshToken));
    expect(JSON.stringify(response)).not.toContain('passwordHash');
  });

  it('rejects duplicate email during signup', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'existing-user' });

    await expectHttpError(
      service.signup({
        email: 'user@example.com',
        password: 'Password123!',
        nickname: 'traderKim',
      }),
      HttpStatus.CONFLICT,
      'EMAIL_ALREADY_EXISTS',
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate nickname during signup', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'existing-user',
    });

    await expectHttpError(
      service.signup({
        email: 'user@example.com',
        password: 'Password123!',
        nickname: 'traderKim',
      }),
      HttpStatus.CONFLICT,
      'NICKNAME_ALREADY_EXISTS',
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it('logs in and issues access and refresh tokens', async () => {
    const { jwtService, prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(activeUser);

    const response = await service.login({
      email: 'USER@example.com ',
      password: 'Password123!',
    });

    expect(mockedArgon2.verify).toHaveBeenCalledWith(
      'hashed-password',
      'Password123!',
    );
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      { sub: activeUser.id },
      { secret: 'test-secret', expiresIn: '15m' },
    );
    expect(response.data.tokens.accessToken).toBe('access-token');
    expect(response.data.tokens.refreshToken).toEqual(expect.any(String));
    expect(response.data.tokens.accessTokenExpiresIn).toBe('15m');
    expect(response.data.tokens.refreshTokenExpiresAt).toEqual(
      expect.any(String),
    );
    expectRefreshSessionCreate(prisma);
    expect(JSON.stringify(response)).not.toContain('passwordHash');
  });

  it('does not store the raw refresh token during login', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(activeUser);

    const response = await service.login({
      email: 'user@example.com',
      password: 'Password123!',
    });
    const storedTokenHash =
      prisma.refreshTokenSession.create.mock.calls[0][0].data.tokenHash;

    expect(storedTokenHash).not.toBe(response.data.tokens.refreshToken);
    expect(storedTokenHash).toBe(hashToken(response.data.tokens.refreshToken));
  });

  it.each(['15m', '1h', '30s'])('accepts JWT_ACCESS_TTL=%s', async (ttl) => {
    const { jwtService, prisma, service } = createService({ ttl });
    prisma.user.findUnique.mockResolvedValueOnce(activeUser);

    await service.login({
      email: 'user@example.com',
      password: 'Password123!',
    });

    expect(jwtService.signAsync).toHaveBeenCalledWith(
      { sub: activeUser.id },
      { secret: 'test-secret', expiresIn: ttl },
    );
  });

  it.each(['7d', '14d', '30d'])(
    'accepts REFRESH_TOKEN_TTL=%s',
    async (refreshTtl) => {
      const { prisma, service } = createService({ refreshTtl });
      prisma.user.findUnique.mockResolvedValueOnce(activeUser);

      await service.login({
        email: 'user@example.com',
        password: 'Password123!',
      });

      expectRefreshSessionCreate(prisma);
    },
  );

  it.each(['900', '15 m', '1y', '500ms'])(
    'rejects invalid JWT_ACCESS_TTL=%s',
    async (ttl) => {
      const { prisma, service } = createService({ ttl });
      prisma.user.findUnique.mockResolvedValueOnce(activeUser);

      await expectHttpError(
        service.login({
          email: 'user@example.com',
          password: 'Password123!',
        }),
        HttpStatus.INTERNAL_SERVER_ERROR,
        'AUTH_CONFIGURATION_ERROR',
      );
      expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
    },
  );

  it.each(['900', '15 d', '500ms', '1y', ''])(
    'rejects invalid REFRESH_TOKEN_TTL=%s',
    async (refreshTtl) => {
      const { prisma, service } = createService({ refreshTtl });

      await expectHttpError(
        service.login({
          email: 'user@example.com',
          password: 'Password123!',
        }),
        HttpStatus.INTERNAL_SERVER_ERROR,
        'AUTH_CONFIGURATION_ERROR',
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
    },
  );

  it('fails closed when JWT_ACCESS_SECRET is missing', () => {
    const { service } = createService({ secret: '' });

    expect(() => service.onModuleInit()).toThrow(HttpException);
    try {
      service.onModuleInit();
    } catch (error) {
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(httpError.getResponse()).toMatchObject({
        success: false,
        error: {
          code: 'AUTH_CONFIGURATION_ERROR',
        },
      });
    }
  });

  it('fails closed when REFRESH_TOKEN_TTL is missing', () => {
    const { service } = createService({ refreshTtl: undefined });

    expect(() => service.onModuleInit()).toThrow(HttpException);
    try {
      service.onModuleInit();
    } catch (error) {
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(httpError.getResponse()).toMatchObject({
        success: false,
        error: {
          code: 'AUTH_CONFIGURATION_ERROR',
        },
      });
    }
  });

  it('rejects login with a wrong password', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(activeUser);
    mockedArgon2.verify.mockResolvedValueOnce(false);

    await expectHttpError(
      service.login({
        email: 'user@example.com',
        password: 'wrong-password',
      }),
      HttpStatus.UNAUTHORIZED,
      'INVALID_CREDENTIALS',
    );
    expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it.each([UserStatus.suspended, UserStatus.deleted])(
    'rejects login for %s users',
    async (status) => {
      const { prisma, service } = createService();
      prisma.user.findUnique.mockResolvedValueOnce({
        ...activeUser,
        status,
      });

      await expectHttpError(
        service.login({
          email: 'user@example.com',
          password: 'Password123!',
        }),
        HttpStatus.FORBIDDEN,
        'USER_NOT_ACTIVE',
      );
      expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
    },
  );

  it('rotates a valid refresh token and revokes the old session', async () => {
    const { jwtService, prisma, service } = createService();
    prisma.refreshTokenSession.findUnique.mockResolvedValueOnce({
      id: 'refresh-session-1',
      userId: activeUser.id,
      status: RefreshTokenSessionStatus.active,
      expiresAt: futureExpiresAt,
      user: {
        id: activeUser.id,
        email: activeUser.email,
        nickname: activeUser.nickname,
        status: UserStatus.active,
      },
    });
    prisma.refreshTokenSession.create.mockResolvedValueOnce({
      id: 'refresh-session-2',
    });

    const response = await service.refresh({
      refreshToken,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.refreshTokenSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tokenHash: refreshTokenHash,
        },
      }),
    );
    expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'refresh-session-1',
          status: RefreshTokenSessionStatus.active,
        },
        data: expect.objectContaining({
          status: RefreshTokenSessionStatus.revoked,
          revokedAt: expect.any(Date),
          replacedBySessionId: 'refresh-session-2',
        }),
      }),
    );
    expect(jwtService.signAsync).toHaveBeenCalledWith(
      { sub: activeUser.id },
      { secret: 'test-secret', expiresIn: '15m' },
    );
    expect(response.data.tokens.accessToken).toBe('access-token');
    expect(response.data.tokens.refreshToken).not.toBe(refreshToken);
    expect(response.data.tokens.refreshToken).toEqual(expect.any(String));
  });

  it('rejects reuse of a revoked refresh token', async () => {
    const { prisma, service } = createService();
    prisma.refreshTokenSession.findUnique.mockResolvedValueOnce({
      id: 'refresh-session-1',
      userId: activeUser.id,
      status: RefreshTokenSessionStatus.revoked,
      expiresAt: futureExpiresAt,
      user: {
        id: activeUser.id,
        email: activeUser.email,
        nickname: activeUser.nickname,
        status: UserStatus.active,
      },
    });

    await expectHttpError(
      service.refresh({
        refreshToken,
      }),
      HttpStatus.UNAUTHORIZED,
      'INVALID_REFRESH_TOKEN',
    );
    expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it('rejects expired refresh tokens', async () => {
    const { prisma, service } = createService();
    prisma.refreshTokenSession.findUnique.mockResolvedValueOnce({
      id: 'refresh-session-1',
      userId: activeUser.id,
      status: RefreshTokenSessionStatus.active,
      expiresAt: expiredAt,
      user: {
        id: activeUser.id,
        email: activeUser.email,
        nickname: activeUser.nickname,
        status: UserStatus.active,
      },
    });

    await expectHttpError(
      service.refresh({
        refreshToken,
      }),
      HttpStatus.UNAUTHORIZED,
      'INVALID_REFRESH_TOKEN',
    );
    expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it('rejects unknown refresh tokens', async () => {
    const { prisma, service } = createService();
    prisma.refreshTokenSession.findUnique.mockResolvedValueOnce(null);

    await expectHttpError(
      service.refresh({
        refreshToken,
      }),
      HttpStatus.UNAUTHORIZED,
      'INVALID_REFRESH_TOKEN',
    );
    expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
  });

  it.each([UserStatus.suspended, UserStatus.deleted])(
    'rejects refresh for %s users',
    async (status) => {
      const { prisma, service } = createService();
      prisma.refreshTokenSession.findUnique.mockResolvedValueOnce({
        id: 'refresh-session-1',
        userId: activeUser.id,
        status: RefreshTokenSessionStatus.active,
        expiresAt: futureExpiresAt,
        user: {
          id: activeUser.id,
          email: activeUser.email,
          nickname: activeUser.nickname,
          status,
        },
      });

      await expectHttpError(
        service.refresh({
          refreshToken,
        }),
        HttpStatus.FORBIDDEN,
        'USER_NOT_ACTIVE',
      );
      expect(prisma.refreshTokenSession.create).not.toHaveBeenCalled();
    },
  );

  it('rejects missing or malformed refresh tokens', async () => {
    const { prisma, service } = createService();

    await expectHttpError(
      service.refresh({}),
      HttpStatus.UNAUTHORIZED,
      'INVALID_REFRESH_TOKEN',
    );
    await expectHttpError(
      service.refresh({
        refreshToken: 'not a token',
      }),
      HttpStatus.UNAUTHORIZED,
      'INVALID_REFRESH_TOKEN',
    );
    expect(prisma.refreshTokenSession.findUnique).not.toHaveBeenCalled();
  });

  it('revokes an active refresh session on logout without exposing token existence', async () => {
    const { prisma, service } = createService();

    await expect(
      service.logout({
        refreshToken,
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        revoked: true,
      },
    });
    expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tokenHash: refreshTokenHash,
          status: RefreshTokenSessionStatus.active,
        },
        data: expect.objectContaining({
          status: RefreshTokenSessionStatus.revoked,
          revokedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('keeps logout idempotent for unknown or already revoked refresh tokens', async () => {
    const { prisma, service } = createService();
    prisma.refreshTokenSession.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.logout({
        refreshToken: nextRefreshToken,
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        revoked: true,
      },
    });
  });

  it('revokes all active refresh sessions for the authenticated user on logout-all', async () => {
    const { prisma, service } = createService();

    await expect(service.logoutAll(activeUser.id)).resolves.toEqual({
      success: true,
      data: {
        revoked: true,
      },
    });
    expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: activeUser.id,
          status: RefreshTokenSessionStatus.active,
        },
        data: expect.objectContaining({
          status: RefreshTokenSessionStatus.revoked,
          revokedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('rejects logout-all without an authenticated user id', async () => {
    const { prisma, service } = createService();

    await expectHttpError(
      service.logoutAll(undefined),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
    expect(prisma.refreshTokenSession.updateMany).not.toHaveBeenCalled();
  });

  it('returns the current user without passwordHash', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(activeUser);

    const response = await service.me(activeUser.id);

    expect(response).toEqual({
      success: true,
      data: {
        id: activeUser.id,
        email: activeUser.email,
        nickname: activeUser.nickname,
        profileImageUrl: null,
        status: UserStatus.active,
        createdAt: createdAt.toISOString(),
      },
    });
    expect(JSON.stringify(response)).not.toContain('passwordHash');
  });
});
