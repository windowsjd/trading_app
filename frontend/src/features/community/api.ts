import { Platform } from 'react-native';
import { apiClient } from '../../services/api/client';
import { assertCurrentSession, getSessionGeneration } from '../../services/api/sessionOwnership';
import type { ApiSuccessResponse, OffsetPagination } from '../../models/dto/common';
import type { UserRole, UserStatus } from '../../models/dto/user';
import type { CommunityPhotoUpload } from './photoRules';
import { canManageCommunity } from './permissions';

export { canManageCommunity };

/**
 * The community API (backend/docs/community-api-contract.md). Every response
 * is checked before the app uses it: a payload that does not have the
 * contract's shape is a read error (CommunityResponseError), never guessed.
 * The server decides every author display (public, 익명N, 글쓴이, 탈퇴계정);
 * the app never derives an identity from anything else.
 */

export type CommunityCategory = 'free' | 'theory';
export type CommunityFeedCategory = 'all' | CommunityCategory | 'hot';
export type CommunityCommentSort = 'latest' | 'likes';
export const COMMUNITY_REASON_CODES = [
  'AD_SPAM', 'ABUSE', 'FLOOD', 'PERSONAL_INFO', 'ILLEGAL_OR_SOLICITATION', 'INAPPROPRIATE_MEDIA', 'OTHER',
] as const;
export type CommunityReasonCode = (typeof COMMUNITY_REASON_CODES)[number];
export const COMMUNITY_TIERS = ['master', 'diamond', 'platinum', 'gold', 'silver', 'bronze'] as const;
export type CommunityTier = (typeof COMMUNITY_TIERS)[number];

export const COMMUNITY_FEED_CATEGORIES: readonly { key: CommunityFeedCategory; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'free', label: '자유' },
  { key: 'theory', label: '이론' },
  { key: 'hot', label: 'HOT' },
];
export const COMMUNITY_POST_CATEGORIES: readonly { key: CommunityCategory; label: string }[] = [
  { key: 'free', label: '자유' },
  { key: 'theory', label: '이론' },
];
/** The server's limits; bootstrap repeats them and wins when it differs. */
export const COMMUNITY_LIMITS = { postBody: 500, commentBody: 300, photos: 4, note: 200 } as const;
export const COMMUNITY_PAGE_SIZE = 20;
export const COMMUNITY_COMMENT_PAGE_SIZE = 50;
/** Home's rolling card: the top of the HOT list as the feed returns it. */
export const COMMUNITY_HOT_PREVIEW_LIMIT = 3;

export type CommunityPublicAuthor = {
  kind: 'public'; userId: string; nickname: string; profileImageUrl: string | null; tier: CommunityTier | null;
};
export type CommunityPostAuthor = CommunityPublicAuthor | { kind: 'anonymous'; label: string };
export type CommunityCommentAuthor = CommunityPublicAuthor
  | { kind: 'anonymous'; label: string; isPostAuthor: boolean }
  | { kind: 'deleted_member'; label: string };
export type CommunityAdminAuthor = { userId: string; nickname: string };
export type CommunityAssetTag = { id: string; symbol: string; name: string; market: string; assetType: string };
export type CommunityPhoto = { url: string; width: number; height: number };

export type CommunityPostDto = {
  id: string;
  category: CommunityCategory;
  body: string;
  createdAt: string;
  author: CommunityPostAuthor;
  asset: CommunityAssetTag | null;
  photos: CommunityPhoto[];
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  mine: boolean;
  isHot: boolean;
  /** Operator responses only. */
  reportCount?: number;
  /** Operator responses only: the post detail of an anonymous post. */
  adminAuthor?: CommunityAdminAuthor;
};

export type CommunityCommentDto = {
  id: string;
  postId: string;
  parentCommentId: string | null;
  /** Deleted or hidden: the comment keeps only its place. */
  deleted: boolean;
  body: string | null;
  createdAt: string;
  author: CommunityCommentAuthor | null;
  likeCount: number;
  likedByMe: boolean;
  mine: boolean;
  reportCount?: number;
  adminAuthor?: CommunityAdminAuthor;
};

export type CommunityReason = { code: CommunityReasonCode; label: string; description: string; noteRequired: boolean };
export type CommunitySanctionNotice = { reason: CommunityReasonCode; until: string | null };
export type CommunityBootstrapDto = {
  rulesVersion: string;
  rulesAccepted: boolean;
  reasons: CommunityReason[];
  maxPhotos: number;
  postBodyMaxLength: number;
  commentBodyMaxLength: number;
  me: CommunityPublicAuthor;
  activeSanction: CommunitySanctionNotice | null;
};

export type CommunitySanctionDto = {
  id: string; userId: string; reason: CommunityReasonCode; note: string | null; hideContent: boolean;
  createdAt: string; until: string | null; active: boolean; carriedOver: boolean;
  createdByUserId: string | null; revokedAt: string | null; revokedByUserId: string | null;
};
export type OperatorCommunityUserDto = {
  user: {
    id: string; nickname: string; profileImageUrl: string | null; tier: CommunityTier | null;
    role: UserRole; status: UserStatus; joinedAt: string;
  };
  stats: { postCount: number; commentCount: number; reportCount: number; removedCount: number };
  activeSanction: CommunitySanctionDto | null;
  sanctionable: boolean;
};
export type CommunityRemovalDto = {
  targetType: 'post' | 'comment'; targetId: string; deletionKind: 'operator' | 'author';
  reason: CommunityReasonCode | null; removedAt: string;
};
export type CommunitySanctionDuration = '7d' | '30d' | 'permanent';

export class CommunityResponseError extends Error {
  constructor() {
    super('커뮤니티 응답을 확인할 수 없습니다.');
    this.name = 'CommunityResponseError';
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTime = (value: unknown): value is string => isText(value) && !Number.isNaN(new Date(value).getTime());
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isReason = (value: unknown): value is CommunityReasonCode => COMMUNITY_REASON_CODES.includes(value as CommunityReasonCode);
const isTier = (value: unknown): value is CommunityTier => COMMUNITY_TIERS.includes(value as CommunityTier);
const fail = (): never => { throw new CommunityResponseError(); };
const nullableText = (value: unknown) => (value === null ? null : isText(value) ? value : fail());

function toPublicAuthor(value: Json): CommunityPublicAuthor {
  if (!isText(value.userId) || !isText(value.nickname)) fail();
  const image = value.profileImageUrl;
  const tier = value.tier;
  return {
    kind: 'public', userId: value.userId as string, nickname: value.nickname as string,
    profileImageUrl: image === null || image === undefined ? null : isText(image) ? image : fail(),
    // An unknown tier name from a newer server reads as no tier, never a guess.
    tier: isTier(tier) ? tier : null,
  };
}

function toPostAuthor(value: unknown): CommunityPostAuthor {
  if (!isRecord(value)) return fail();
  if (value.kind === 'public') return toPublicAuthor(value);
  if (value.kind === 'anonymous' && isText(value.label)) return { kind: 'anonymous', label: value.label };
  return fail();
}

function toCommentAuthor(value: unknown): CommunityCommentAuthor {
  if (!isRecord(value)) return fail();
  if (value.kind === 'public') return toPublicAuthor(value);
  if (value.kind === 'anonymous' && isText(value.label) && typeof value.isPostAuthor === 'boolean') {
    return { kind: 'anonymous', label: value.label, isPostAuthor: value.isPostAuthor };
  }
  if (value.kind === 'deleted_member' && isText(value.label)) return { kind: 'deleted_member', label: value.label };
  return fail();
}

function toAdminAuthor(value: unknown): CommunityAdminAuthor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !isText(value.userId) || !isText(value.nickname)) return fail();
  return { userId: value.userId, nickname: value.nickname };
}

function toAsset(value: unknown): CommunityAssetTag | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isText(value.id) || !isText(value.symbol) || !isText(value.name)
    || !isText(value.market) || !isText(value.assetType)) return fail();
  return { id: value.id, symbol: value.symbol, name: value.name, market: value.market, assetType: value.assetType };
}

function toPhotos(value: unknown): CommunityPhoto[] {
  if (!Array.isArray(value)) return fail();
  return value.map((photo) => {
    if (!isRecord(photo) || !isText(photo.url) || !isCount(photo.width) || !isCount(photo.height)
      || photo.width < 1 || photo.height < 1) return fail();
    return { url: photo.url, width: photo.width, height: photo.height };
  });
}

const optionalCount = (value: unknown) => (value === undefined ? undefined : isCount(value) ? value : fail());

export function toCommunityPost(value: unknown): CommunityPostDto {
  if (!isRecord(value) || !isText(value.id) || (value.category !== 'free' && value.category !== 'theory')
    || typeof value.body !== 'string' || !isTime(value.createdAt) || !isCount(value.likeCount)
    || !isCount(value.commentCount) || typeof value.likedByMe !== 'boolean' || typeof value.mine !== 'boolean'
    || typeof value.isHot !== 'boolean') return fail();
  const post: CommunityPostDto = {
    id: value.id, category: value.category, body: value.body, createdAt: value.createdAt,
    author: toPostAuthor(value.author), asset: toAsset(value.asset), photos: toPhotos(value.photos),
    likeCount: value.likeCount, commentCount: value.commentCount, likedByMe: value.likedByMe,
    mine: value.mine, isHot: value.isHot,
  };
  const reportCount = optionalCount(value.reportCount);
  const adminAuthor = toAdminAuthor(value.adminAuthor);
  if (reportCount !== undefined) post.reportCount = reportCount;
  if (adminAuthor) post.adminAuthor = adminAuthor;
  return post;
}

export function toCommunityComment(value: unknown): CommunityCommentDto {
  if (!isRecord(value) || !isText(value.id) || !isText(value.postId) || typeof value.deleted !== 'boolean'
    || !isTime(value.createdAt) || !isCount(value.likeCount) || typeof value.likedByMe !== 'boolean'
    || typeof value.mine !== 'boolean') return fail();
  const deleted = value.deleted;
  // A deleted comment carries neither text nor author; a live one carries both.
  if (deleted ? value.body !== null || value.author !== null : typeof value.body !== 'string') return fail();
  const comment: CommunityCommentDto = {
    id: value.id, postId: value.postId,
    parentCommentId: value.parentCommentId === null || value.parentCommentId === undefined
      ? null : isText(value.parentCommentId) ? value.parentCommentId : fail(),
    deleted, body: deleted ? null : value.body as string, createdAt: value.createdAt,
    author: deleted ? null : toCommentAuthor(value.author),
    likeCount: value.likeCount, likedByMe: value.likedByMe, mine: value.mine,
  };
  const reportCount = optionalCount(value.reportCount);
  const adminAuthor = toAdminAuthor(value.adminAuthor);
  if (reportCount !== undefined) comment.reportCount = reportCount;
  if (adminAuthor) comment.adminAuthor = adminAuthor;
  return comment;
}

function toReasons(value: unknown): CommunityReason[] {
  if (!Array.isArray(value) || !value.length) return fail();
  return value.map((reason) => {
    if (!isRecord(reason) || !isReason(reason.code) || !isText(reason.label) || typeof reason.description !== 'string'
      || typeof reason.noteRequired !== 'boolean') return fail();
    return { code: reason.code, label: reason.label, description: reason.description, noteRequired: reason.noteRequired };
  });
}

function toSanctionNotice(value: unknown): CommunitySanctionNotice | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isReason(value.reason) || !(value.until === null || isTime(value.until))) return fail();
  return { reason: value.reason, until: value.until as string | null };
}

const positive = (value: unknown, fallback: number) => (value === undefined ? fallback
  : typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fail());

export function toCommunityBootstrap(value: unknown): CommunityBootstrapDto {
  if (!isRecord(value) || !isText(value.rulesVersion) || typeof value.rulesAccepted !== 'boolean' || !isRecord(value.me)) {
    return fail();
  }
  return {
    rulesVersion: value.rulesVersion, rulesAccepted: value.rulesAccepted, reasons: toReasons(value.reasons),
    maxPhotos: positive(value.maxPhotos, COMMUNITY_LIMITS.photos),
    postBodyMaxLength: positive(value.postBodyMaxLength, COMMUNITY_LIMITS.postBody),
    commentBodyMaxLength: positive(value.commentBodyMaxLength, COMMUNITY_LIMITS.commentBody),
    me: toPublicAuthor({ ...value.me, kind: 'public' }),
    activeSanction: toSanctionNotice(value.activeSanction),
  };
}

function toSanction(value: unknown): CommunitySanctionDto {
  if (!isRecord(value) || !isText(value.id) || !isText(value.userId) || !isReason(value.reason)
    || typeof value.hideContent !== 'boolean' || !isTime(value.createdAt) || !(value.until === null || isTime(value.until))
    || typeof value.active !== 'boolean' || typeof value.carriedOver !== 'boolean'
    || !(value.revokedAt === null || isTime(value.revokedAt))) return fail();
  return {
    id: value.id, userId: value.userId, reason: value.reason, note: nullableText(value.note ?? null),
    hideContent: value.hideContent, createdAt: value.createdAt, until: value.until as string | null,
    active: value.active, carriedOver: value.carriedOver,
    createdByUserId: nullableText(value.createdByUserId ?? null), revokedAt: value.revokedAt as string | null,
    revokedByUserId: nullableText(value.revokedByUserId ?? null),
  };
}

function toPage<T>(data: unknown, key: 'posts' | 'comments', item: (value: unknown) => T, offset: number) {
  if (!isRecord(data) || !Array.isArray(data[key]) || !isRecord(data.pagination)) return fail();
  const items = (data[key] as unknown[]).map(item);
  const { nextOffset, total } = data.pagination as unknown as OffsetPagination;
  if (!(nextOffset === null || (isCount(nextOffset) && nextOffset > offset)) || !isCount(total)) return fail();
  return { items, nextOffset, total };
}

export type CommunityPage<T> = { items: T[]; nextOffset: number | null; total: number };

export async function getCommunityBootstrap(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<unknown>>('/community/bootstrap', { signal });
  return toCommunityBootstrap(response.data?.data);
}

/** One feed page; HOT is the server's computed list (at most 30 posts). */
export async function getCommunityPosts(category: CommunityFeedCategory, offset: number, limit = COMMUNITY_PAGE_SIZE,
  signal?: AbortSignal): Promise<CommunityPage<CommunityPostDto>> {
  const response = await apiClient.get<ApiSuccessResponse<unknown>>(
    `/community/posts?category=${category}&limit=${limit}&offset=${offset}`, { signal });
  return toPage(response.data?.data, 'posts', toCommunityPost, offset);
}

export async function getCommunityPost(postId: string, signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ post: unknown }>>(
    `/community/posts/${encodeURIComponent(postId)}`, { signal });
  const post = toCommunityPost(response.data?.data?.post);
  if (post.id !== postId) fail();
  return post;
}

export async function getCommunityComments(postId: string, sort: CommunityCommentSort, offset: number,
  signal?: AbortSignal): Promise<CommunityPage<CommunityCommentDto>> {
  const response = await apiClient.get<ApiSuccessResponse<unknown>>(
    `/community/posts/${encodeURIComponent(postId)}/comments?sort=${sort}&limit=${COMMUNITY_COMMENT_PAGE_SIZE}&offset=${offset}`,
    { signal });
  const page = toPage(response.data?.data, 'comments', toCommunityComment, offset);
  if (page.items.some((comment) => comment.postId !== postId)) fail();
  return page;
}

export type CommunityPostDraft = {
  clientRequestId: string;
  category: CommunityCategory;
  body: string;
  anonymous: boolean;
  assetId: string | null;
  photos: CommunityPhotoUpload[];
};

/**
 * multipart: `payload` (JSON text) and one `photos` part per photo, in order.
 * Only a server receipt for this exact request id counts as posted; a retry
 * with the same id replays it instead of posting twice.
 */
export async function createCommunityPost(draft: CommunityPostDraft) {
  const owner = getSessionGeneration();
  const form = new FormData();
  form.append('payload', JSON.stringify({
    clientRequestId: draft.clientRequestId, category: draft.category, body: draft.body,
    anonymous: draft.anonymous, ...(draft.assetId ? { assetId: draft.assetId } : {}),
  }));
  for (const photo of draft.photos) {
    if (Platform.OS === 'web') {
      const file = await fetch(photo.uri);
      form.append('photos', await file.blob(), photo.name);
    } else {
      // React Native FormData accepts a URI descriptor instead of a DOM Blob.
      form.append('photos', { uri: photo.uri, name: photo.name, type: photo.type } as unknown as Blob);
    }
  }
  assertCurrentSession(owner);
  const response = await apiClient.post<ApiSuccessResponse<{ post: unknown; replayed: unknown }>>('/community/posts', form, {
    // The browser supplies the boundary; RN's Axios adapter needs the hint.
    headers: { 'Content-Type': Platform.OS === 'web' ? undefined : 'multipart/form-data' },
    timeout: 60000,
  });
  const post = toCommunityPost(response.data?.data?.post);
  if (!post.mine || post.body !== draft.body.trim() || post.category !== draft.category) fail();
  return { post, replayed: response.data.data.replayed === true };
}

export async function deleteCommunityPost(postId: string) {
  const response = await apiClient.delete<ApiSuccessResponse<{ postId: unknown; deleted: unknown }>>(
    `/community/posts/${encodeURIComponent(postId)}`);
  if (response.data?.data?.postId !== postId || response.data.data.deleted !== true) fail();
  return { postId };
}

function toLike(value: unknown, liked: boolean) {
  if (!isRecord(value) || value.liked !== liked || !isCount(value.likeCount)) return fail();
  return { liked, likeCount: value.likeCount };
}

export async function setCommunityPostLike(postId: string, liked: boolean) {
  const path = `/community/posts/${encodeURIComponent(postId)}/like`;
  const response = liked
    ? await apiClient.put<ApiSuccessResponse<unknown>>(path)
    : await apiClient.delete<ApiSuccessResponse<unknown>>(path);
  return toLike(response.data?.data, liked);
}

export async function setCommunityCommentLike(commentId: string, liked: boolean) {
  const path = `/community/comments/${encodeURIComponent(commentId)}/like`;
  const response = liked
    ? await apiClient.put<ApiSuccessResponse<unknown>>(path)
    : await apiClient.delete<ApiSuccessResponse<unknown>>(path);
  return toLike(response.data?.data, liked);
}

export type CommunityCommentDraft = {
  clientRequestId: string; body: string; anonymous: boolean; parentCommentId: string | null;
};

export async function createCommunityComment(postId: string, draft: CommunityCommentDraft) {
  const response = await apiClient.post<ApiSuccessResponse<{ comment: unknown; replayed: unknown }>>(
    `/community/posts/${encodeURIComponent(postId)}/comments`, {
      clientRequestId: draft.clientRequestId, body: draft.body, anonymous: draft.anonymous,
      ...(draft.parentCommentId ? { parentCommentId: draft.parentCommentId } : {}),
    });
  const comment = toCommunityComment(response.data?.data?.comment);
  if (comment.postId !== postId || comment.deleted || !comment.mine || comment.body !== draft.body.trim()
    || comment.parentCommentId !== draft.parentCommentId) fail();
  return { comment, replayed: response.data.data.replayed === true };
}

export async function deleteCommunityComment(commentId: string) {
  const response = await apiClient.delete<ApiSuccessResponse<{ comment: unknown }>>(
    `/community/comments/${encodeURIComponent(commentId)}`);
  const comment = toCommunityComment(response.data?.data?.comment);
  if (comment.id !== commentId || !comment.deleted) fail();
  return comment;
}

export type CommunityReportRequest = {
  targetType: 'post' | 'comment'; targetId: string; reason: CommunityReasonCode; note?: string;
};

export async function reportCommunityTarget(request: CommunityReportRequest) {
  const response = await apiClient.post<ApiSuccessResponse<{ report: unknown; replayed: unknown }>>('/community/reports', request);
  const report = response.data?.data?.report;
  if (!isRecord(report) || report.targetType !== request.targetType || report.targetId !== request.targetId
    || !isReason(report.reason) || !isTime(report.createdAt)) fail();
  return { replayed: response.data.data.replayed === true };
}

export async function acceptCommunityRules(rulesVersion: string) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>('/community/rules/consent', { rulesVersion });
  const data = response.data?.data;
  if (!isRecord(data) || data.rulesVersion !== rulesVersion || !isTime(data.acceptedAt)) fail();
  return { rulesVersion, acceptedAt: (data as { acceptedAt: string }).acceptedAt };
}

export type CommunityModerationRequest = { reason: CommunityReasonCode; note?: string };

function toRemoval(value: unknown, targetType: 'post' | 'comment', targetId: string) {
  const data = isRecord(value) ? value : fail();
  const removal = data.removal;
  if (!isRecord(removal) || removal.targetType !== targetType || removal.targetId !== targetId
    || (removal.deletionKind !== 'operator' && removal.deletionKind !== 'author')
    || !(removal.reason === null || isReason(removal.reason)) || !isTime(removal.removedAt)) return fail();
  return { removal: removal as unknown as CommunityRemovalDto, replayed: data.replayed === true };
}

export async function removeCommunityPost(postId: string, request: CommunityModerationRequest) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>(
    `/operator/community/posts/${encodeURIComponent(postId)}/remove`, request);
  return toRemoval(response.data?.data, 'post', postId);
}

export async function removeCommunityComment(commentId: string, request: CommunityModerationRequest) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>(
    `/operator/community/comments/${encodeURIComponent(commentId)}/remove`, request);
  return toRemoval(response.data?.data, 'comment', commentId);
}

const ROLES: readonly unknown[] = ['user', 'operator', 'admin'];
const STATUSES: readonly unknown[] = ['active', 'suspended', 'deleted'];

export async function getOperatorCommunityUser(userId: string, signal?: AbortSignal): Promise<OperatorCommunityUserDto> {
  const response = await apiClient.get<ApiSuccessResponse<unknown>>(
    `/operator/community/users/${encodeURIComponent(userId)}`, { signal });
  const data = response.data?.data;
  if (!isRecord(data) || !isRecord(data.user) || !isRecord(data.stats) || typeof data.sanctionable !== 'boolean') return fail();
  const user = data.user, stats = data.stats;
  if (user.id !== userId || !isText(user.nickname) || !ROLES.includes(user.role) || !STATUSES.includes(user.status)
    || !isTime(user.joinedAt) || !isCount(stats.postCount) || !isCount(stats.commentCount)
    || !isCount(stats.reportCount) || !isCount(stats.removedCount)) return fail();
  const author = toPublicAuthor({ ...user, userId: user.id, kind: 'public' });
  return {
    user: {
      id: userId, nickname: author.nickname, profileImageUrl: author.profileImageUrl, tier: author.tier,
      role: user.role as UserRole, status: user.status as UserStatus, joinedAt: user.joinedAt,
    },
    stats: { postCount: stats.postCount, commentCount: stats.commentCount, reportCount: stats.reportCount, removedCount: stats.removedCount },
    activeSanction: data.activeSanction === null || data.activeSanction === undefined ? null : toSanction(data.activeSanction),
    sanctionable: data.sanctionable,
  };
}

export type CommunitySanctionRequest = {
  reason: CommunityReasonCode; note?: string; duration: CommunitySanctionDuration; hideContent: boolean;
};

export async function createCommunitySanction(userId: string, request: CommunitySanctionRequest) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>(
    `/operator/community/users/${encodeURIComponent(userId)}/sanctions`, request);
  const data = response.data?.data;
  if (!isRecord(data)) return fail();
  const sanction = toSanction(data.sanction);
  if (sanction.userId !== userId) fail();
  return sanction;
}

export async function revokeCommunitySanction(sanctionId: string) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>(
    `/operator/community/sanctions/${encodeURIComponent(sanctionId)}/revoke`, {});
  const data = response.data?.data;
  if (!isRecord(data)) return fail();
  const sanction = toSanction(data.sanction);
  if (sanction.id !== sanctionId || !sanction.revokedAt) fail();
  return sanction;
}
