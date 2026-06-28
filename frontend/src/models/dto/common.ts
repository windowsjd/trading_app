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

export type PublicSourceMetadata = {
  sourceType?: 'provider_api' | 'admin_manual' | 'official_batch' | string;
  sourceName?: string | null;
  snapshotId?: string | null;
  effectiveAt?: IsoDateTimeString | null;
  capturedAt?: IsoDateTimeString | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  rejectedProviderReason?: string | null;
  freshnessAgeSeconds?: number | null;
};

export type SourceMetadata = PublicSourceMetadata | string | null;

export function formatSourceMetadata(source?: SourceMetadata) {
  if (source === null || source === undefined || source === '') return '-';
  if (typeof source === 'string') return source;

  const label = source.sourceName ?? source.sourceType ?? '-';
  const details = [
    source.fallbackUsed ? 'fallback' : null,
    source.fallbackReason,
    source.rejectedProviderReason,
  ].filter((value): value is string => !!value);

  return details.length ? `${label} (${details.join(', ')})` : label;
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
