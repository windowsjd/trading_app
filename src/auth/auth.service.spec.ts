jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  UserStatus: {
    active: 'active',
    suspended: 'suspended',
    deleted: 'deleted',
  },
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { UserStatus } from '../generated/prisma/client';
import { AuthService } from './auth.service';
import * as argon2 from 'argon2';

const mockedArgon2 = jest.mocked(argon2);

describe('AuthService', () => {
  const createdAt = new Date('2026-05-09T00:00:00.000Z');

  const activeUser = {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'hashed-password',
    nickname: 'traderKim',
    profileImageUrl: null,
    status: UserStatus.active,
    createdAt,
  };

  const createPrisma = () => ({
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  });

  const createService = () => {
    const prisma = createPrisma();
    const jwtService = {
      signAsync: jest.fn().mockResolvedValue('access-token'),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'JWT_ACCESS_SECRET') {
          return 'test-secret';
        }

        if (key === 'JWT_ACCESS_TTL') {
          return '15m';
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockedArgon2.hash.mockResolvedValue('hashed-password');
    mockedArgon2.verify.mockResolvedValue(true);
  });

  it('signs up an active user, stores passwordHash, and hides passwordHash', async () => {
    const { jwtService, prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
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
        },
      },
    });
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
  });

  it('logs in and issues an access token', async () => {
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
    expect(JSON.stringify(response)).not.toContain('passwordHash');
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
    },
  );

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
