import { apiClient } from '../../services/api/client';
import type { ApiSuccessResponse } from '../../models/dto/common';
import type { NoticeDraftRequest, NoticeSectionDraft } from '../notice/noticeDraft';

/**
 * 관리자 전용 콘솔 › 공지사항 관리 (2026-11-13) over the existing operator
 * notice API (backend docs/push-notifications-contract.md §4): create a
 * draft (idempotent by key), publish it once with `confirm: true`, withdraw
 * it. The server decides who may: its OperatorGuard re-reads the role from
 * the database on every request; the console itself is shown to admins only
 * (adminRole.ts).
 */

export type AdminNoticeStatus = 'draft' | 'published' | 'withdrawn';
export type AdminNotice = {
  id: string;
  title: string;
  summary: string;
  sections: NoticeSectionDraft[];
  showPopup: boolean;
  status: AdminNoticeStatus;
  createdAt: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
  /** Push outbox rows by status (pending/sent/skipped/failed …), when the server counts them. */
  delivery: Record<string, number>;
};

export class AdminNoticeResponseError extends Error {
  constructor() {
    super('공지 처리 결과를 확인할 수 없습니다.');
    this.name = 'AdminNoticeResponseError';
  }
}

const STATUSES: readonly AdminNoticeStatus[] = ['draft', 'published', 'withdrawn'];
const str = (value: unknown) => (typeof value === 'string' ? value : null);

const isText = (value: unknown): value is string => typeof value === 'string';

function parseSections(value: unknown): NoticeSectionDraft[] | null {
  if (!Array.isArray(value)) return null;
  const sections: NoticeSectionDraft[] = [];
  for (const item of value) {
    const section = item as { heading?: unknown; paragraphs?: unknown } | null;
    const heading = str(section?.heading);
    const paragraphs: unknown = section?.paragraphs;
    if (!heading || !Array.isArray(paragraphs) || !paragraphs.every(isText)) return null;
    sections.push({ heading, paragraphs });
  }
  return sections;
}

/** A server notice, or null when anything the console relies on is missing. */
export function parseAdminNotice(value: unknown): AdminNotice | null {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const id = str(row.id);
  const title = str(row.title);
  const summary = str(row.summary);
  const sections = parseSections(row.sections);
  const status = STATUSES.find((item) => item === row.status) ?? null;
  const createdAt = str(row.createdAt);
  if (!id || !title || !summary || !sections || !status || !createdAt) return null;
  const delivery = row.delivery && typeof row.delivery === 'object'
    ? Object.fromEntries(Object.entries(row.delivery as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
    : {};
  return {
    id, title, summary, sections, status, createdAt, delivery,
    // A server from before popups has no field: no popup.
    showPopup: row.showPopup === true,
    publishedAt: str(row.publishedAt),
    withdrawnAt: str(row.withdrawnAt),
  };
}

export async function getAdminNotices(signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<{ notices: unknown }>>('/operator/notices', { signal });
  const notices = response.data?.data?.notices;
  if (!Array.isArray(notices)) throw new AdminNoticeResponseError();
  return notices.map(parseAdminNotice).filter((notice): notice is AdminNotice => !!notice);
}

function noticeOf(data: unknown): AdminNotice {
  const notice = parseAdminNotice((data as { notice?: unknown } | null)?.notice);
  if (!notice) throw new AdminNoticeResponseError();
  return notice;
}

/** A draft; the same key with the same content replays the stored draft (no duplicate). */
export async function createAdminNotice(request: NoticeDraftRequest & { idempotencyKey: string }) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>('/operator/notices', request);
  return noticeOf(response.data?.data);
}

/** Draft → published, once: it appears in 공지사항 (and, if chosen, as the entry popup) and starts the push fan-out. */
export async function publishAdminNotice(noticeId: string) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>(`/operator/notices/${encodeURIComponent(noticeId)}/publish`, { confirm: true });
  return noticeOf(response.data?.data);
}

/** Published → withdrawn: hidden from 공지사항 and the popup; unsent pushes stop. */
export async function withdrawAdminNotice(noticeId: string) {
  const response = await apiClient.post<ApiSuccessResponse<unknown>>(`/operator/notices/${encodeURIComponent(noticeId)}/withdraw`);
  return noticeOf(response.data?.data);
}
