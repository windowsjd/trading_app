import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { UserStatus } from '../../models/dto/user';

export interface AuthUserDto {
  id: string;
  email: string;
  nickname: string;
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
  email: string;
  nickname: string;
  password: string;
}

export interface SignupResponseDto {
  user: AuthUserDto;
  tokens: AuthTokensDto;
}

export async function login(payload: LoginRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<LoginResponseDto>>(
    '/auth/login',
    payload,
  );

  return response.data.data;
}

export async function signup(payload: SignupRequestDto) {
  const response = await apiClient.post<ApiSuccessResponse<SignupResponseDto>>(
    '/auth/signup',
    payload,
  );

  return response.data.data;
}

export async function logout(refreshToken?: string | null) {
  const response = await apiClient.post<ApiSuccessResponse<LogoutResponseDto>>(
    '/auth/logout',
    refreshToken ? { refreshToken } : {},
  );

  return response.data.data;
}

export async function logoutAll() {
  const response = await apiClient.post<ApiSuccessResponse<LogoutResponseDto>>(
    '/auth/logout-all',
  );

  return response.data.data;
}
