import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  SectionState,
} from '../../models/dto/common';

export type RewardStatus = SectionState | 'pending' | 'ready' | 'granted';

export interface RewardItemDto {
  seasonId: string;
  rewardCode: string;
  rewardName: string;
  rewardType: string;
  grantedAt?: IsoDateTimeString | null;
  awardedAt?: IsoDateTimeString | null;
  createdAt?: IsoDateTimeString | null;
}

export interface RewardsDto {
  state?: RewardStatus;
  rewardStatus?: RewardStatus;
  pending?: boolean;
  items: RewardItemDto[];
}

export interface BadgeItemDto {
  seasonId: string;
  badgeCode: string;
  badgeName: string;
  awardedAt?: IsoDateTimeString | null;
  grantedAt?: IsoDateTimeString | null;
  createdAt?: IsoDateTimeString | null;
}

export interface BadgesDto {
  state?: RewardStatus;
  rewardStatus?: RewardStatus;
  pending?: boolean;
  items: BadgeItemDto[];
}

export function isRewardResponsePending(
  response?: Pick<RewardsDto | BadgesDto, 'state' | 'rewardStatus' | 'pending'> | null,
) {
  return (
    response?.pending === true ||
    response?.state === 'pending' ||
    response?.rewardStatus === 'pending'
  );
}

export function getRewardItemDate(
  item: Pick<RewardItemDto | BadgeItemDto, 'grantedAt' | 'awardedAt' | 'createdAt'>,
) {
  return item.grantedAt ?? item.awardedAt ?? item.createdAt ?? '-';
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
