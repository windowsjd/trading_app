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

export type InquiryDto = {
  id: string;
  category: InquiryCategory;
  title: string;
  content: string;
  createdAt: string;
};
export type InquiryRequest = { clientRequestId: string; category: InquiryCategory; title: string; content: string };

export class InquiryResponseError extends Error {
  constructor() {
    super('문의 접수 결과를 확인할 수 없습니다.');
    this.name = 'InquiryResponseError';
  }
}

const isInquiry = (value: unknown): value is InquiryDto => {
  const item = value as Partial<InquiryDto> | null;
  return !!item && typeof item.id === 'string' && !!item.id && typeof item.title === 'string' &&
    typeof item.content === 'string' && typeof item.createdAt === 'string' &&
    INQUIRY_CATEGORIES.some(category => category.key === item.category);
};

/** Only a server receipt (an id for this exact submission) counts as filed. */
export async function createInquiry(body: InquiryRequest) {
  const response = await apiClient.post<ApiSuccessResponse<{ inquiry: InquiryDto; replayed: boolean }>>('/inquiries', body);
  const inquiry = response.data?.data?.inquiry;
  if (!isInquiry(inquiry) || inquiry.title !== body.title.trim() || inquiry.category !== body.category) {
    throw new InquiryResponseError();
  }
  return { inquiry, replayed: response.data.data.replayed === true };
}

export async function getMyInquiries(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ items: InquiryDto[]; pagination: OffsetPagination }>>(
    '/inquiries/me?limit=20&offset=0', { signal });
  const items = response.data?.data?.items;
  if (!Array.isArray(items) || !items.every(isInquiry)) throw new InquiryResponseError();
  return items;
}
