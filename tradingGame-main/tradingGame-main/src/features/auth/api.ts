import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export interface AuthUserDto {
  id: string;
  email: string;
  nickname: string;
  status: 'active' | 'blocked';
}

export interface AuthTokensDto {
  accessToken: string;
  refreshToken: string;
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