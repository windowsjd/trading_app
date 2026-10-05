import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { UserRole, UserStatus } from '../../models/dto/user';
import { Platform } from 'react-native';
import { assertCurrentSession, getSessionGeneration } from '../../services/api/sessionOwnership';
import { PROFILE_IMAGE_MAX_BYTES, type ProfileImageUpload, ProfileImageSelectionError } from './profileImageTypes';

export interface MeDto {
  id: string;
  email: string;
  nickname: string;
  profileImageUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  portfolioPublic: boolean;
}

export interface UpdateMeRequestDto {
  portfolioPublic?: boolean;
  nickname?: string;
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

export async function uploadProfileImage(image: ProfileImageUpload) {
  const owner = getSessionGeneration();
  const form = new FormData();
  if (Platform.OS === 'web') {
    const response = await fetch(image.uri);
    const blob = await response.blob();
    if (blob.size > PROFILE_IMAGE_MAX_BYTES) throw new ProfileImageSelectionError('too_large');
    form.append('file', blob, image.name);
  } else {
    // React Native FormData accepts a URI descriptor instead of a DOM Blob.
    form.append('file', image as unknown as Blob);
  }
  assertCurrentSession(owner);
  const response = await apiClient.post<ApiSuccessResponse<MeDto>>('/me/profile-image', form, {
    // The browser supplies the boundary. RN's Axios adapter needs this hint.
    headers: { 'Content-Type': Platform.OS === 'web' ? undefined : 'multipart/form-data' },
    timeout: 30000,
  });
  return response.data.data;
}

export async function deleteProfileImage() {
  const response = await apiClient.delete<ApiSuccessResponse<MeDto>>('/me/profile-image', { timeout: 30000 });
  return response.data.data;
}
