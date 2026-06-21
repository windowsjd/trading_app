export type MoneyString = string;
export type QuantityString = string;
export type RateString = string;
export type IsoDateTimeString = string;

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

export interface CursorPageInfo {
  nextCursor: string | null;
  hasNext: boolean;
}

export interface CursorPageResponse<T> {
  items: T[];
  pageInfo: CursorPageInfo;
}
