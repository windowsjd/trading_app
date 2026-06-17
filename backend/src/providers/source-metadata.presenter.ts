import type { SourceDecision } from './source-eligibility.policy';

export type PublicSourceMetadata = {
  sourceType: 'provider_api' | 'admin_manual' | null;
  sourceName: string | null;
  snapshotId: string | null;
  effectiveAt: string | null;
  capturedAt: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  rejectedProviderReason: string | null;
  freshnessAgeSeconds: number | null;
};

const SECRET_LIKE_PATTERN =
  /(approval[_-]?key|access[_-]?token|refresh[_-]?token|kis[_-]?app[_-]?(key|secret)|database_url|authorization|bearer\s+|postgres:\/\/|password=|secret=|token=)/i;

export function presentSourceDecision(
  decision: SourceDecision | null | undefined,
): PublicSourceMetadata | null {
  if (!decision) {
    return null;
  }

  return {
    sourceType: decision.selectedSourceType,
    sourceName: safeTextOrNull(decision.selectedSourceName),
    snapshotId: safeTextOrNull(decision.selectedSnapshotId),
    effectiveAt: formatNullableDate(decision.selectedEffectiveAt),
    capturedAt: formatNullableDate(decision.selectedCapturedAt),
    fallbackUsed: decision.fallbackUsed,
    fallbackReason: safeTextOrNull(decision.fallbackReason),
    rejectedProviderReason: safeTextOrNull(decision.rejectedProviderReason),
    freshnessAgeSeconds: decision.freshnessAgeSeconds,
  };
}

export function presentLimitPriceSource(): PublicSourceMetadata {
  return {
    sourceType: null,
    sourceName: null,
    snapshotId: null,
    effectiveAt: null,
    capturedAt: null,
    fallbackUsed: false,
    fallbackReason: 'limit_price_provided',
    rejectedProviderReason: null,
    freshnessAgeSeconds: null,
  };
}

function formatNullableDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function safeTextOrNull(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return SECRET_LIKE_PATTERN.test(value) ? null : value;
}
