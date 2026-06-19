import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';

export interface RewardItemDto {
  seasonId: string;
  rewardCode: string;
  rewardName: string;
  rewardType: string;
  grantedAt: string;
}

export interface RewardsDto {
  items: RewardItemDto[];
}

export interface BadgeItemDto {
  seasonId: string;
  badgeCode: string;
  badgeName: string;
  awardedAt: string;
}

export interface BadgesDto {
  items: BadgeItemDto[];
}

export async function getMyRewards() {
  const response = await apiClient.get<ApiSuccessResponse<RewardsDto>>(
    '/rewards/me',
  );

  return response.data.data;
}

export async function getMyBadges() {
  const response = await apiClient.get<ApiSuccessResponse<BadgesDto>>(
    '/badges/me',
  );

  return response.data.data;
}