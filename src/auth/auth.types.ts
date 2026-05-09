import { Request } from 'express';
import { UserStatus } from '../generated/prisma/client';

export type AuthenticatedUser = {
  userId: string;
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
    };
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
