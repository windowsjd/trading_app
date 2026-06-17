import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';

export type OperatorMeResponse = {
  success: true;
  data: {
    userId: string;
    role: AuthenticatedUser['role'];
  };
};

@Injectable()
export class OperatorService {
  me(user: AuthenticatedUser | undefined): OperatorMeResponse {
    if (!user) {
      throw new UnauthorizedException({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        },
      });
    }

    return {
      success: true,
      data: {
        userId: user.userId,
        role: user.role,
      },
    };
  }
}
