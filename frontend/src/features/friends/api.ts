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
/** The signed-in member's side of one pair; `self` for the member's own id. */
export type FriendRelationship = {
  userId: string;
  relationship: FriendUser['relationship'] | 'self';
  requestId: string | null;
};
const RELATIONSHIPS: ReadonlySet<string> = new Set(['none', 'sent', 'received', 'friend', 'self']);
/**
 * One user's relationship by user id (GET /friends/relationships/:userId,
 * read only). An answer for another user or of an unknown kind is an error,
 * never "none".
 */
export async function getFriendRelationship(userId: string, signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<FriendRelationship>>(
    `/friends/relationships/${encodeURIComponent(userId)}`,
    { signal },
  );
  const data = response.data.data;
  if (data?.userId !== userId || !RELATIONSHIPS.has(data.relationship))
    throw new Error('친구 관계를 확인할 수 없습니다.');
  return data;
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
