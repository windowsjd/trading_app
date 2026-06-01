jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  UserRole: {
    user: 'user',
    operator: 'operator',
    admin: 'admin',
  },
}));

import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { UserRole } from '../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  AdminGuard,
  hasAdminRole,
  hasOperatorRole,
  OperatorGuard,
} from './operator.guard';

describe('OperatorGuard', () => {
  const createContext = (request: AuthenticatedRequest) =>
    ({
      switchToHttp: jest.fn(() => ({
        getRequest: jest.fn(() => request),
      })),
    }) as unknown as ExecutionContext;

  const expectHttpError = (
    callback: () => unknown,
    status: HttpStatus,
    code: string,
  ) => {
    try {
      callback();
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

  it('allows operator and admin roles', () => {
    const guard = new OperatorGuard();

    expect(
      guard.canActivate(
        createContext({
          user: {
            userId: 'operator-1',
            role: UserRole.operator,
          },
        } as AuthenticatedRequest),
      ),
    ).toBe(true);
    expect(
      guard.canActivate(
        createContext({
          user: {
            userId: 'admin-1',
            role: UserRole.admin,
          },
        } as AuthenticatedRequest),
      ),
    ).toBe(true);
  });

  it('rejects regular users with forbidden', () => {
    const guard = new OperatorGuard();

    expectHttpError(
      () =>
        guard.canActivate(
          createContext({
            user: {
              userId: 'user-1',
              role: UserRole.user,
            },
          } as AuthenticatedRequest),
        ),
      HttpStatus.FORBIDDEN,
      'OPERATOR_FORBIDDEN',
    );
  });

  it('rejects missing authenticated user context as unauthorized', () => {
    const guard = new OperatorGuard();

    expectHttpError(
      () => guard.canActivate(createContext({} as AuthenticatedRequest)),
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
    );
  });

  it('keeps admin-only role comparison explicit', () => {
    const guard = new AdminGuard();

    expect(hasOperatorRole(UserRole.operator)).toBe(true);
    expect(hasOperatorRole(UserRole.admin)).toBe(true);
    expect(hasOperatorRole(UserRole.user)).toBe(false);
    expect(hasAdminRole(UserRole.admin)).toBe(true);
    expect(hasAdminRole(UserRole.operator)).toBe(false);
    expect(
      guard.canActivate(
        createContext({
          user: {
            userId: 'admin-1',
            role: UserRole.admin,
          },
        } as AuthenticatedRequest),
      ),
    ).toBe(true);
    expectHttpError(
      () =>
        guard.canActivate(
          createContext({
            user: {
              userId: 'operator-1',
              role: UserRole.operator,
            },
          } as AuthenticatedRequest),
        ),
      HttpStatus.FORBIDDEN,
      'ADMIN_FORBIDDEN',
    );
  });
});
