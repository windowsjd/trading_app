import { Request } from 'express';
import { UserRole, UserStatus } from '../generated/prisma/client';

export type AuthenticatedUser = {
  userId: string;
  role: UserRole;
};

export type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
};

export type AccessTokenPayload = {
  sub?: unknown;
};

export type SignupRequestBody = {
  email?: unknown;
  password?: unknown;
  nickname?: unknown;
};

export type LoginRequestBody = {
  email?: unknown;
  password?: unknown;
};

export type RefreshTokenRequestBody = {
  refreshToken?: unknown;
};

export type UpdateProfileRequestBody = {
  nickname?: unknown;
  profileImageUrl?: unknown;
};

export type RequestAuthMetadata = {
  userAgent?: string;
  ipAddress?: string;
};

export type AuthUser = {
  id: string;
  email: string;
  nickname: string;
  status: UserStatus;
};

export type AuthTokenResponse = {
  success: true;
  data: {
    user: AuthUser;
    tokens: {
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresIn: string;
      refreshTokenExpiresAt: string;
    };
  };
};

export type LogoutResponse = {
  success: true;
  data: {
    revoked: boolean;
  };
};

export type CurrentUserResponse = {
  success: true;
  data: {
    id: string;
    email: string;
    nickname: string;
    profileImageUrl: string | null;
    status: UserStatus;
    createdAt: string;
  };
};
