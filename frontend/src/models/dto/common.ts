export type MoneyString = string;
export type QuantityString = string;
export type RateString = string;
export type PercentString = string;
export type BpsString = string;
export type IsoDateTimeString = string;
export type SectionState =
  | 'available'
  | 'empty'
  | 'blocked'
  | 'unavailable'
  | 'error';

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface OffsetPagination {
  limit: number;
  offset: number;
  total: number;
  returned: number;
  nextOffset: number | null;
}

export interface OffsetPageResponse<T> {
  items: T[];
  pagination: OffsetPagination;
}

// Legacy cursor pagination remains for screens that have not moved to v2 yet.
export interface CursorPageInfo {
  nextCursor: string | null;
  hasNext: boolean;
}

export interface CursorPageResponse<T> {
  items: T[];
  pageInfo: CursorPageInfo;
}
