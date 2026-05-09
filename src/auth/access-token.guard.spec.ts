jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  UserStatus: {
    active: 'active',
    suspended: 'suspended',
    deleted: 'deleted',
  },
}));

import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserStatus } from '../generated/prisma/client';
import { AccessTokenGuard } from './access-token.guard';
import {
  IS_OPTIONAL_AUTH_ROUTE_KEY,
  IS_PUBLIC_ROUTE_KEY,
} from './auth.decorators';
import type { AuthenticatedRequest } from './auth.types';

describe('AccessTokenGuard', () => {
  const createRequest = (
    headers: Record<string, string | undefined> = {},
  ): AuthenticatedRequest =>
    ({
      headers,
    }) as AuthenticatedRequest;

  const createContext = (request: AuthenticatedRequest) =>
    ({
      getClass: jest.fn(),
      getHandler: jest.fn(),
      switchToHttp: jest.fn(() => ({
        getRequest: jest.fn(() => request),
      })),
    }) as unknown as ExecutionContext;

  const createGuard = () => {
    const jwtService = {
      verifyAsync: jest.fn(),
    };
    const prisma = {
      user: {
        findUnique: jest.fn(),
      },
    };
    const reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;
    const configService = {
      get: jest.fn((key: string) =>
        key === 'JWT_ACCESS_SECRET' ? 'test-secret' : undefined,
      ),
    };
    const guard = new AccessTokenGuard(
      jwtService as never,
      prisma as never,
      reflector,
      configService as never,
    );

    return { configService, guard, jwtService, prisma, reflector };
  };

  const mockRouteMetadata = (
    reflector: jest.Mocked<Reflector>,
    options: { public?: boolean; optional?: boolean } = {},
  ) => {
    reflector.getAllAndOverride.mockImplementation((key) => {
      if (key === IS_PUBLIC_ROUTE_KEY) {
        return options.public ?? false;
      }

      if (key === IS_OPTIONAL_AUTH_ROUTE_KEY) {
        return options.optional ?? false;
      }

      return undefined;
    });
  };

  const expectHttpError = async (
    promise: Promise<unknown>,
    status: HttpStatus,
    code: string,
  ) => {
    try {
      await promise;
      throw new Error('Expected guard to fail');
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

  it('allows public routes without a token', async () => {
    const { guard, jwtService, prisma, reflector } = createGuard();
    mockRouteMetadata(reflector, { public: true });

    await expect(guard.canActivate(createContext(createRequest()))).resolves.toBe(
      true,
    );
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('injects request.user.userId for a valid active-user token', async () => {
    const { guard, jwtService, prisma, reflector } = createGuard();
    mockRouteMetadata(reflector);
    const request = createRequest({
      authorization: 'Bearer valid-token',
    });
    jwtService.verifyAsync.mockResolvedValueOnce({ sub: 'user-1' });
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      status: UserStatus.active,
    });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);

    expect(jwtService.verifyAsync).toHaveBeenCalledWith('valid-token', {
      secret: 'test-secret',
    });
    expect(request.user).toEqual({
      userId: 'user-1',
    });
  });

  it('rejects protected routes when the token is missing', async () => {
    const { guard, reflector } = createGuard();
    mockRouteMetadata(reflector);

    await expectHttpError(
      guard.canActivate(createContext(createRequest())),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
  });

  it('rejects malformed or invalid tokens', async () => {
    const { guard, jwtService, prisma, reflector } = createGuard();
    mockRouteMetadata(reflector);
    jwtService.verifyAsync.mockRejectedValueOnce(new Error('bad token'));

    await expectHttpError(
      guard.canActivate(
        createContext(createRequest({ authorization: 'Bearer invalid-token' })),
      ),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('allows optional auth routes without a token', async () => {
    const { guard, jwtService, prisma, reflector } = createGuard();
    mockRouteMetadata(reflector, { optional: true });

    await expect(guard.canActivate(createContext(createRequest()))).resolves.toBe(
      true,
    );
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects optional auth routes when an invalid token is provided', async () => {
    const { guard, reflector } = createGuard();
    mockRouteMetadata(reflector, { optional: true });

    await expectHttpError(
      guard.canActivate(
        createContext(createRequest({ authorization: 'not-a-bearer-token' })),
      ),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
  });

  it.each([UserStatus.suspended, UserStatus.deleted])(
    'rejects %s users after token verification',
    async (status) => {
      const { guard, jwtService, prisma, reflector } = createGuard();
      mockRouteMetadata(reflector);
      jwtService.verifyAsync.mockResolvedValueOnce({ sub: 'user-1' });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        status,
      });

      await expectHttpError(
        guard.canActivate(
          createContext(createRequest({ authorization: 'Bearer valid-token' })),
        ),
        HttpStatus.FORBIDDEN,
        'USER_NOT_ACTIVE',
      );
    },
  );

  it('does not authenticate with x-user-id alone', async () => {
    const { guard, jwtService, reflector } = createGuard();
    mockRouteMetadata(reflector);

    await expectHttpError(
      guard.canActivate(
        createContext(createRequest({ 'x-user-id': 'user-1' })),
      ),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });
});
