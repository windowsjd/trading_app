import { HttpException } from '@nestjs/common';
import { classifyFailureCause } from '../common/safe-failure-cause';
import { redactStoredText } from '../common/sensitive-data';

export const MAX_LIMIT_MATCHING_SAMPLES = 10;
const MAX_SAMPLE_ID_LENGTH = 128;

export function observedReason<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
): T | 'not_observed' {
  return typeof value === 'string' && vocabulary.includes(value as T)
    ? (value as T)
    : 'not_observed';
}

export function countReason<T extends string>(
  counts: Partial<Record<T, number>>,
  reason: T,
  amount = 1,
): void {
  if (amount > 0) counts[reason] = (counts[reason] ?? 0) + amount;
}

/** Exact existing selector/eligibility reasons, never source names or prices. */
export const SNAPSHOT_SELECTION_REASONS = [
  'selected',
  'workflow_ineligible',
  'asset_ineligible',
  'provider_missing',
  'source_type_mismatch',
  'source_name_mismatch',
  'non_positive_value',
  'effective_at_in_future',
  'captured_at_in_future',
  'captured_at_stale',
  'market_calendar_unavailable',
  'market_closed',
  'effective_at_outside_current_session',
] as const;
export type SnapshotSelectionReason =
  | (typeof SNAPSHOT_SELECTION_REASONS)[number]
  | 'not_observed';
export type PathAReason =
  | 'snapshot_selection_failed'
  | 'before_submission'
  | 'limit_not_crossed'
  | 'trigger_found';
export type PathBReason =
  | 'not_evaluated_path_a_selected'
  | 'calendar_unavailable'
  | 'no_closed_candle_rows'
  | 'all_candle_rows_excluded'
  | 'no_eligible_candle'
  | 'no_order_eligible_candle'
  | 'no_limit_touch'
  | 'trigger_found';
export type CandleExclusionReason =
  | 'outside_lookback'
  | 'future_evidence'
  | 'malformed_window'
  | 'session_invalid';
export type CandleOrderExclusionReason =
  | 'before_first_boundary'
  | 'after_season_end'
  | 'limit_not_touched';

export const EXECUTION_SKIP_REASONS = [
  'order_not_found',
  'not_submitted_limit',
  'season_not_active',
  'participant_not_active',
  'asset_inactive',
  'account_not_active',
  'MARKET_CLOSED',
  'MARKET_CALENDAR_UNAVAILABLE',
  'ASSET_NOT_TRADABLE',
  'market_not_open',
  'price_evidence_unavailable',
  'candle_evidence_invalid',
  'price_outside_limit',
  'fx_evidence_unavailable',
] as const;
type ExecutionSkipReason =
  | (typeof EXECUTION_SKIP_REASONS)[number]
  | 'not_observed';

const EXECUTION_ERROR_CODES = [
  'ORDER_RESERVATION_INCONSISTENT',
  'ORDER_RESERVATION_CONFLICT',
  'LIMIT_ORDER_EXECUTION_CONFLICT',
  'TRADING_ACCOUNT_LINK_INTEGRITY',
  'TRADING_ACCOUNT_SCOPE_MISMATCH',
  'TRADING_SCOPE_REPAIR_REQUIRED',
  'FINANCIAL_SCOPE_REPAIR_REQUIRED',
  'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
  'ORDER_EXECUTION_TRANSACTION_FAILED',
  'GENERAL_PERFORMANCE_NOT_INITIALIZED',
  'GENERAL_PERFORMANCE_INTEGRITY',
  'PARTICIPANT_NOT_FOUND',
  'SEASON_NOT_ACTIVE',
  'INTERNAL_ERROR',
  'FX_RATE_UNAVAILABLE',
] as const;
type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

export type LimitExecutionStage =
  | 'transaction'
  | 'authorization_lock'
  | 'order_lock'
  | 'order_validation'
  | 'transaction_clock'
  | 'scope_validation'
  | 'market_validation'
  | 'snapshot_validation'
  | 'candle_validation'
  | 'amounts_validation'
  | 'fx_evidence'
  | 'wallet_settlement'
  | 'candle_evidence_persistence'
  | 'position_settlement'
  | 'wallet_credit'
  | 'ledger_order_finalization'
  | 'portfolio_snapshot'
  | 'not_observed';

// Local metadata on the original exception; no ALS, wrapper, or retained payload.
const executionStages = new WeakMap<object, LimitExecutionStage>();
export function rememberLimitExecutionStage(
  error: unknown,
  stage: LimitExecutionStage,
): void {
  if (error && typeof error === 'object') executionStages.set(error, stage);
}

export function classifyLimitExecutionError(error: unknown) {
  let code: ExecutionErrorCode | undefined;
  if (error instanceof HttpException) {
    const response: unknown = error.getResponse();
    if (response && typeof response === 'object' && 'error' in response) {
      const detail = response.error;
      if (detail && typeof detail === 'object' && 'code' in detail) {
        const observed = observedReason(detail.code, EXECUTION_ERROR_CODES);
        if (observed !== 'not_observed') code = observed;
      }
    }
  }
  const cause = classifyFailureCause(error);
  const category = code
    ? code === 'ORDER_RESERVATION_INCONSISTENT'
      ? 'reservation_inconsistent'
      : code === 'ORDER_RESERVATION_CONFLICT'
        ? 'reservation_conflict'
        : /SCOPE|INTEGRITY|REPAIR_REQUIRED/u.test(code)
          ? 'scope_integrity'
          : code === 'LIMIT_ORDER_EXECUTION_CONFLICT'
            ? 'execution_conflict'
            : 'execution_error'
    : cause.category;
  return {
    reason: code ?? category,
    category,
    ...(code ? { code } : cause.code ? { code: cause.code } : {}),
    stage:
      error && typeof error === 'object'
        ? (executionStages.get(error) ?? 'not_observed')
        : 'not_observed',
  };
}

type Path = 'snapshot' | 'candle';
export type LimitMatchingSample = {
  orderId: string;
  assetId: string;
} & (
  | { phase: 'candidate'; reason: 'candidate_shape_invalid' }
  | {
      phase: 'no_plan';
      pathA: PathAReason;
      sourceSelectionReason: SnapshotSelectionReason;
      pathB: PathBReason;
    }
  | { phase: 'execution_skip'; path: Path; reason: ExecutionSkipReason }
  | ({ phase: 'execution_error'; path: Path } & ReturnType<
      typeof classifyLimitExecutionError
    >)
);

export function createLimitMatchingDiagnostics() {
  return {
    candidateRejections: {} as Partial<
      Record<'candidate_shape_invalid', number>
    >,
    planning: {
      noPlan: 0,
      pathA: {} as Partial<Record<PathAReason, number>>,
      pathB: {} as Partial<Record<PathBReason, number>>,
      // Once per asset, not per order; evidence is cached within each cycle.
      snapshotSelections: {} as Partial<
        Record<SnapshotSelectionReason, number>
      >,
      candleEvidence: {
        calendarUnavailableAssets: 0,
        rowsRead: 0,
        eligible: 0,
        exclusions: {} as Partial<Record<CandleExclusionReason, number>>,
      },
      candleOrderExclusions: {} as Partial<
        Record<CandleOrderExclusionReason, number>
      >,
    },
    execution: {
      attempts: { snapshot: 0, candle: 0 },
      skipReasons: {} as Partial<Record<ExecutionSkipReason, number>>,
      errorReasons: {} as Record<string, number>,
      errorStages: {} as Partial<Record<LimitExecutionStage, number>>,
      errorsByPath: { snapshot: 0, candle: 0 },
    },
    samples: [] as LimitMatchingSample[],
    samplesTruncated: false,
  };
}

export function boundLimitMatchingSample(
  sample: LimitMatchingSample,
): LimitMatchingSample {
  return {
    ...sample,
    orderId: redactStoredText(sample.orderId).slice(0, MAX_SAMPLE_ID_LENGTH),
    assetId: redactStoredText(sample.assetId).slice(0, MAX_SAMPLE_ID_LENGTH),
  };
}

export function addLimitMatchingSample(
  diagnostics: ReturnType<typeof createLimitMatchingDiagnostics>,
  sample: LimitMatchingSample,
): void {
  if (diagnostics.samples.length >= MAX_LIMIT_MATCHING_SAMPLES) {
    diagnostics.samplesTruncated = true;
    return;
  }
  diagnostics.samples.push(boundLimitMatchingSample(sample));
}
