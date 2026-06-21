import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { UserStatus } from '../../models/dto/user';

export interface MeDto {
  id: string;
  email: string;
  nickname: string;
  profileImageUrl: string | null;
  status: UserStatus;
  createdAt: string;
}

export interface UpdateMeRequestDto {
  nickname?: string;
  profileImageUrl?: string | null;
}

export async function getMe() {
  const response = await apiClient.get<ApiSuccessResponse<MeDto>>('/me');
  return response.data.data;
}

export async function updateMe(payload: UpdateMeRequestDto) {
  const response = await apiClient.patch<ApiSuccessResponse<MeDto>>(
    '/me',
    payload,
  );
  return response.data.data;
}
