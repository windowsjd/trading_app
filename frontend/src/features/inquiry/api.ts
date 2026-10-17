import { apiClient } from '../../services/api/client';
import { getApiErrorInfo } from '../../services/api/errorMapper';
import type { ApiSuccessResponse, OffsetPagination } from '../../models/dto/common';
import type { UserRole, UserStatus } from '../../models/dto/user';

export const INQUIRY_CATEGORIES = [
  { key: 'account', label: '계정·로그인' },
  { key: 'trading', label: '주문·거래' },
  { key: 'wallet', label: '지갑·환전·이체' },
  { key: 'season_ranking', label: '시즌·랭킹' },
  { key: 'bug', label: '오류 신고' },
  { key: 'other', label: '기타' },
] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number]['key'];
/** Same limits as the server (title 2–100, content 10–2000 characters). */
export const INQUIRY_LIMITS = { title: { min: 2, max: 100 }, content: { min: 10, max: 2000 } } as const;
/** Same limits as the server's official answer (2–2000 characters). */
export const INQUIRY_ANSWER_LIMITS = { min: 2, max: 2000 } as const;

/** Characters as the server counts them (code points, trimmed). */
export const inquiryTextLength = (value: string) => [...value.trim()].length;
export const inquiryCategoryLabel = (key: InquiryCategory) => INQUIRY_CATEGORIES.find(item => item.key === key)?.label ?? '기타';
export const formatInquiryTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** The operator's official answer; one per inquiry, never edited. */
export type InquiryAnswerDto = { content: string; answeredAt: string };
export type InquiryDto = {
  id: string;
  category: InquiryCategory;
  title: string;
  content: string;
  createdAt: string;
  /** 답변 대기 / 답변 완료, from the server's stored answer only. */
  status: 'pending' | 'answered';
  answer: InquiryAnswerDto | null;
};
/** Server page size; older inquiries are read page by page. */
export const INQUIRY_PAGE_SIZE = 20;
export type InquiryRequest = { clientRequestId: string; category: InquiryCategory; title: string; content: string };

export class InquiryResponseError extends Error {
  constructor() {
    super('문의 접수 결과를 확인할 수 없습니다.');
    this.name = 'InquiryResponseError';
  }
}

const isAnswer = (value: unknown): value is InquiryAnswerDto => {
  const answer = value as Partial<InquiryAnswerDto> | null;
  return !!answer && typeof answer.content === 'string' && !!answer.content.trim() &&
    typeof answer.answeredAt === 'string' && !Number.isNaN(new Date(answer.answeredAt).getTime());
};

/**
 * A server inquiry, or null. 답변 완료 needs both the status and a readable
 * answer; a server from before answers existed (no status, no answer) reads
 * as 답변 대기. Any other combination is rejected, never guessed.
 */
function toInquiry(value: unknown): InquiryDto | null {
  const item = value as (Partial<InquiryDto> & Record<string, unknown>) | null;
  const category = INQUIRY_CATEGORIES.find(option => option.key === item?.category)?.key;
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' ||
    typeof item.content !== 'string' || typeof item.createdAt !== 'string' || !category) return null;
  const base = { id: item.id, category, title: item.title, content: item.content, createdAt: item.createdAt };
  if (item.status === 'answered' && isAnswer(item.answer))
    return { ...base, status: 'answered', answer: { content: item.answer.content, answeredAt: item.answer.answeredAt } };
  if ((item.status === 'pending' && item.answer === null) || (item.status === undefined && item.answer === undefined))
    return { ...base, status: 'pending', answer: null };
  return null;
}

/** Only a server receipt (an id for this exact submission) counts as filed. */
export async function createInquiry(body: InquiryRequest) {
  const response = await apiClient.post<ApiSuccessResponse<{ inquiry: unknown; replayed: boolean }>>('/inquiries', body);
  const inquiry = toInquiry(response.data?.data?.inquiry);
  if (!inquiry || inquiry.title !== body.title.trim() || inquiry.category !== body.category) {
    throw new InquiryResponseError();
  }
  return { inquiry, replayed: response.data.data.replayed === true };
}

/** One page of the caller's own inquiries, newest first. */
export async function getMyInquiries(offset: number, signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ items: unknown[]; pagination: OffsetPagination }>>(
    `/inquiries/me?limit=${INQUIRY_PAGE_SIZE}&offset=${offset}`, { signal });
  const raw = response.data?.data?.items;
  const items = Array.isArray(raw) ? raw.map(toInquiry) : null;
  const next = response.data?.data?.pagination?.nextOffset;
  if (!items || !items.every((item): item is InquiryDto => item !== null) ||
    !(next === null || (typeof next === 'number' && Number.isInteger(next) && next > offset))) {
    throw new InquiryResponseError();
  }
  return { items, nextOffset: next };
}

/**
 * 문의 관리 is offered to the session's operator/admin role only. This is a
 * display gate: every read and answer is still decided by the server's
 * OperatorGuard against the current DB role, and a refusal hides it again.
 */
export const canManageInquiries = (role: UserRole | null | undefined) => role === 'operator' || role === 'admin';
/** The server no longer accepts this session as an operator (role changed or account inactive). */
export const isOperatorAccessDenied = (error: unknown) => getApiErrorInfo(error).status === 403;

export type OperatorInquiryFilter = 'pending' | 'answered' | 'all';
/** The operator view: the author's view plus who wrote it and who answered. */
export type OperatorInquiryDto = Omit<InquiryDto, 'answer'> & {
  user: { id: string; nickname: string; status: UserStatus };
  answer: (InquiryAnswerDto & { answeredByUserId: string }) | null;
};
export type InquiryAnswerRequest = { content: string; idempotencyKey: string };
export const inquiryAuthorLabel = ({ nickname, status }: OperatorInquiryDto['user']) =>
  `${nickname}${status === 'suspended' ? ' (이용 정지)' : status === 'deleted' ? ' (탈퇴)' : ''}`;
const USER_STATUSES: readonly unknown[] = ['active', 'suspended', 'deleted'] satisfies UserStatus[];
const isUserStatus = (value: unknown): value is UserStatus => USER_STATUSES.includes(value);

/** An operator-view inquiry, or null: the same checks as the author's view,
 * with an explicit status, a readable author and, when answered, its operator. */
function toOperatorInquiry(value: unknown): OperatorInquiryDto | null {
  const raw = value as { status?: unknown; user?: Partial<OperatorInquiryDto['user']> | null; answer?: { answeredByUserId?: unknown } | null } | null;
  const inquiry = raw && (raw.status === 'pending' || raw.status === 'answered') ? toInquiry(value) : null;
  const user = raw?.user;
  if (!inquiry || !user || typeof user.id !== 'string' || !user.id || typeof user.nickname !== 'string' || !isUserStatus(user.status)) return null;
  const author = { id: user.id, nickname: user.nickname, status: user.status };
  if (!inquiry.answer) return { ...inquiry, user: author, answer: null };
  const answeredBy = raw.answer?.answeredByUserId;
  if (typeof answeredBy !== 'string' || !answeredBy) return null;
  return { ...inquiry, user: author, answer: { ...inquiry.answer, answeredByUserId: answeredBy } };
}

/** One page of every user's inquiries: 답변 대기 oldest first, 답변 완료 latest answer first, 전체 newest first. */
export async function getOperatorInquiries(filter: OperatorInquiryFilter, offset: number, signal?: AbortSignal) {
  const status = filter === 'all' ? '' : `&status=${filter}`;
  const response = await apiClient.get<ApiSuccessResponse<{ inquiries: unknown[]; pagination: OffsetPagination }>>(
    `/operator/inquiries?limit=${INQUIRY_PAGE_SIZE}&offset=${offset}${status}`, { signal });
  const raw = response.data?.data?.inquiries;
  const items = Array.isArray(raw) ? raw.map(toOperatorInquiry) : null;
  const next = response.data?.data?.pagination?.nextOffset;
  if (!items || !items.every((item): item is OperatorInquiryDto => item !== null && (filter === 'all' || item.status === filter)) ||
    !(next === null || (typeof next === 'number' && Number.isInteger(next) && next > offset))) {
    throw new InquiryResponseError();
  }
  return { items, nextOffset: next };
}

export async function getOperatorInquiry(inquiryId: string, signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ inquiry: unknown }>>(
    `/operator/inquiries/${encodeURIComponent(inquiryId)}`, { signal });
  const inquiry = toOperatorInquiry(response.data?.data?.inquiry);
  if (!inquiry || inquiry.id !== inquiryId) throw new InquiryResponseError();
  return inquiry;
}

/**
 * The official answer. Only the server's stored answer to this inquiry with
 * exactly this text counts as answered; a retry of the same request (same
 * key, same text) replays it instead of adding a second answer.
 */
export async function answerInquiry(inquiryId: string, body: InquiryAnswerRequest) {
  const response = await apiClient.post<ApiSuccessResponse<{ inquiry: unknown; replayed: boolean }>>(
    `/operator/inquiries/${encodeURIComponent(inquiryId)}/answer`, body);
  const inquiry = toOperatorInquiry(response.data?.data?.inquiry);
  if (!inquiry || inquiry.id !== inquiryId || inquiry.status !== 'answered' || inquiry.answer?.content !== body.content) {
    throw new InquiryResponseError();
  }
  return { inquiry, replayed: response.data.data.replayed === true };
}
