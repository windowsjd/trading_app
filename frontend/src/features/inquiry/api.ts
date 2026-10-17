import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse, OffsetPagination } from '../../models/dto/common';

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
