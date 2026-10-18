import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { UserRole, UserStatus } from '../../models/dto/user';

export interface AuthUserDto {
  id: string;
  email: string;
  nickname: string;
  role: UserRole;
  status: UserStatus;
}

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
}

export interface LogoutResponseDto {
  revoked: boolean;
}

export interface LoginRequestDto {
  email: string;
  password: string;
}

export interface LoginResponseDto {
  user: AuthUserDto;
  tokens: AuthTokensDto;
}

export interface SignupRequestDto {
  verificationToken: string;
  email: string;
  nickname: string;
  password: string;
}

export type EmailPurpose = 'signup' | 'password_reset';
export interface EmailChallengeDto {
  challengeId: string;
  expiresAt: string;
  resendAt: string;
  serverTime: string;
  message: string;
}
export interface EmailProofDto {
  verificationToken: string;
  expiresAt: string;
  serverTime: string;
}

export async function requestEmailCode(email: string, purpose: EmailPurpose) {
  const response = await apiClient.post<ApiSuccessResponse<EmailChallengeDto>>('/auth/email/request', { email, purpose }, { skipSessionAuth: true });
  return response.data.data;
}

export async function verifyEmailCode(email: string, purpose: EmailPurpose, challengeId: string, code: string) {
  const response = await apiClient.post<ApiSuccessResponse<EmailProofDto>>('/auth/email/verify', { email, purpose, challengeId, code }, { skipSessionAuth: true });
  return response.data.data;
}

export async function resetPassword(payload: { email: string; password: string; verificationToken: string }) {
  const response = await apiClient.post<ApiSuccessResponse<{ changed: true }>>('/auth/password/reset', payload, { skipSessionAuth: true });
  return response.data.data;
}

export interface SignupResponseDto {
  user: AuthUserDto;
  tokens: AuthTokensDto;
}

export async function login(payload: LoginRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<LoginResponseDto>>(
    '/auth/login',
    payload,
    { skipSessionAuth: true },
  );

  return response.data.data;
}

export async function signup(payload: SignupRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<SignupResponseDto>>(
    '/auth/signup',
    payload,
    { skipSessionAuth: true },
  );

  return response.data.data;
}

export async function logout(refreshToken?: string | null) {
  const response = await apiClient.post<ApiSuccessResponse<LogoutResponseDto>>(
    '/auth/logout',
    refreshToken ? { refreshToken } : {},
    { skipSessionAuth: true },
  );

  return response.data.data;
}

export async function logoutAll() {
  const response = await apiClient.post<ApiSuccessResponse<LogoutResponseDto>>(
    '/auth/logout-all',
  );

  return response.data.data;
}
