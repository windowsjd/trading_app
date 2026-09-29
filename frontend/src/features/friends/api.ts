import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  OffsetPagination,
} from '../../models/dto/common';
export type FriendUser = {
  userId: string;
  nickname: string;
  profileImageUrl: string | null;
  relationship: 'none' | 'sent' | 'received' | 'friend';
  requestId: string | null;
  active?: boolean;
};
export type FriendsPage = { users: FriendUser[]; pagination: OffsetPagination };
export async function getFriends(
  kind: 'list' | 'requests' | 'search',
  nickname: string,
  offset: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ offset: String(offset), limit: '30' });
  if (kind === 'search') query.set('nickname', nickname);
  const path = kind === 'list' ? '/friends' : `/friends/${kind}`;
  const response = await apiClient.get<ApiSuccessResponse<FriendsPage>>(
    `${path}?${query}`,
    { signal },
  );
  return response.data.data;
}
export type FriendAction = {
  action: 'request' | 'accept' | 'reject' | 'remove';
  user: FriendUser;
};
export async function changeFriendship({ action, user }: FriendAction) {
  if (action === 'request')
    return apiClient.post('/friends/requests', { userId: user.userId });
  if (!user.requestId) throw new Error('친구 관계를 다시 조회해주세요.');
  const id = encodeURIComponent(user.requestId);
  if (action === 'remove') return apiClient.delete(`/friends/${id}`);
  return apiClient.post(`/friends/requests/${id}/${action}`);
}
