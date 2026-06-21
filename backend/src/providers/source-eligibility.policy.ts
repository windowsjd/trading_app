import { CurrencyCode, Prisma } from '../generated/prisma/client';
import type { AssetType } from '../generated/prisma/client';

export const PROVIDER_SOURCE_NAMES = {
  fxUsdKrw: 'exchange_rate_api',
  fxUsdKrwKoreaExim: 'korea_exim_exchange_rate',
  fxUsdKrwExchangeRateApi: 'exchange_rate_api',
  cryptoUsd: 'binance_public_rest_24hr_ticker',
  domesticStockKrx: 'kis_krx_realtime_trade',
  usStock: 'kis_us_delayed_trade',
} as const;

export const FX_USD_KRW_PROVIDER_SOURCE_PRIORITY = [
  PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
  PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
] as const;

export type ProviderEligibleWorkflow =
  | 'fx_quote'
  | 'fx_execute'
  | 'assets_with_price'
  | 'orders_quote'
  | 'orders_execute'
  | 'live_portfolio_valuation'
  | 'home_live_valuation'
  | 'positions_live_valuation'
  | 'daily_portfolio_snapshot'
  | 'season_settlement';

export type ProviderDeniedWorkflow =
  | 'orders_create'
  | 'season_ranking'
  | 'reward_final_tier'
  | 'reward_fulfillment';

export type ProviderWorkflow =
  | ProviderEligibleWorkflow
  | ProviderDeniedWorkflow;

export type ProviderSourceName =
  (typeof PROVIDER_SOURCE_NAMES)[keyof typeof PROVIDER_SOURCE_NAMES];

export type SourceDecision = {
  selectedSourceType: 'provider_api' | 'admin_manual' | null;
  selectedSourceName: string | null;
  selectedSnapshotId: string | null;
  selectedEffectiveAt: Date | null;
  selectedCapturedAt: Date | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  rejectedProviderReason: string | null;
  freshnessAgeSeconds: number | null;
};

type ProviderSnapshotSourceType = string;

export type ProviderSnapshotCandidate = {
  id: string;
  sourceType: ProviderSnapshotSourceType;
  sourceName: string | null;
  effectiveAt: Date;
  capturedAt: Date;
};

export type ProviderSnapshotSelection<T extends ProviderSnapshotCandidate> =
  | {
      state: 'selected';
      snapshot: T;
      decision: SourceDecision;
    }
  | {
      state: 'not_selected';
      decision: SourceDecision;
    };

export type ProviderAssetCandidate = {
  id?: string;
  assetType: AssetType;
  market: string;
  currencyCode: CurrencyCode;
};

const ALLOWED_WORKFLOWS: ReadonlySet<ProviderEligibleWorkflow> = new Set([
  'fx_quote',
  'fx_execute',
  'assets_with_price',
  'orders_quote',
  'orders_execute',
  'live_portfolio_valuation',
  'home_live_valuation',
  'positions_live_valuation',
  'daily_portfolio_snapshot',
  'season_settlement',
]);

const DENIED_WORKFLOWS: ReadonlySet<ProviderDeniedWorkflow> = new Set([
  'orders_create',
  'season_ranking',
  'reward_final_tier',
  'reward_fulfillment',
]);

export const PROVIDER_FRESHNESS_THRESHOLDS_SECONDS = {
  fxUsdKrw: 300,
  fxUsdKrwExecute: 60,
  assetPrice: 60,
  assetPriceExecute: 10,
} as const;

export function isProviderWorkflowAllowed(
  workflow: string,
): workflow is ProviderEligibleWorkflow {
  return ALLOWED_WORKFLOWS.has(workflow as ProviderEligibleWorkflow);
}

export function isProviderWorkflowDenied(
  workflow: string,
): workflow is ProviderDeniedWorkflow {
  return DENIED_WORKFLOWS.has(workflow as ProviderDeniedWorkflow);
}

export function resolveFxProviderEligibility(input: {
  workflow: ProviderWorkflow;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
}):
  | {
      eligible: true;
      sourceName: typeof PROVIDER_SOURCE_NAMES.fxUsdKrw;
      sourceNames: typeof FX_USD_KRW_PROVIDER_SOURCE_PRIORITY;
      freshnessThresholdSeconds: number;
    }
  | { eligible: false; reason: string } {
  if (!isProviderWorkflowAllowed(input.workflow)) {
    return { eligible: false, reason: 'workflow_ineligible' };
  }

  if (
    input.baseCurrency !== CurrencyCode.USD ||
    input.quoteCurrency !== CurrencyCode.KRW
  ) {
    return { eligible: false, reason: 'fx_pair_ineligible' };
  }

  return {
    eligible: true,
    sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrw,
    sourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
    freshnessThresholdSeconds:
      input.workflow === 'fx_execute' || input.workflow === 'orders_execute'
        ? PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.fxUsdKrwExecute
        : PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.fxUsdKrw,
  };
}

export function resolveAssetProviderEligibility(input: {
  workflow: ProviderWorkflow;
  asset: ProviderAssetCandidate;
}):
  | {
      eligible: true;
      sourceName: ProviderSourceName;
      freshnessThresholdSeconds: number;
    }
  | { eligible: false; reason: string } {
  if (!isProviderWorkflowAllowed(input.workflow)) {
    return { eligible: false, reason: 'workflow_ineligible' };
  }

  const market = input.asset.market.trim().toUpperCase();
  if (
    input.asset.assetType === 'domestic_stock' &&
    input.asset.currencyCode === CurrencyCode.KRW &&
    isKrxMarketFamily(market)
  ) {
    return {
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.domesticStockKrx,
      freshnessThresholdSeconds:
        input.workflow === 'orders_execute'
          ? PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPriceExecute
          : PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPrice,
    };
  }

  if (
    input.asset.assetType === 'us_stock' &&
    input.asset.currencyCode === CurrencyCode.USD &&
    isUsNasNysMarketFamily(market)
  ) {
    return {
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.usStock,
      freshnessThresholdSeconds:
        input.workflow === 'orders_execute'
          ? PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPriceExecute
          : PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPrice,
    };
  }

  if (
    input.asset.assetType === 'crypto' &&
    input.asset.currencyCode === CurrencyCode.USD &&
    market === 'BINANCE'
  ) {
    return {
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.cryptoUsd,
      freshnessThresholdSeconds:
        input.workflow === 'orders_execute'
          ? PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPriceExecute
          : PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPrice,
    };
  }

  return { eligible: false, reason: 'asset_ineligible' };
}

export function selectFreshProviderSnapshot<
  T extends ProviderSnapshotCandidate,
>(input: {
  candidates: readonly T[];
  expectedSourceName: string;
  now: Date;
  freshnessThresholdSeconds: number;
  isPositiveValue: (candidate: T) => boolean;
}): ProviderSnapshotSelection<T> {
  if (input.candidates.length === 0) {
    return {
      state: 'not_selected',
      decision: buildEmptyDecision({
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
        rejectedProviderReason: null,
      }),
    };
  }

  let rejectedProviderReason: string | null = null;
  let freshnessAgeSeconds: number | null = null;

  for (const candidate of input.candidates) {
    const evaluation = evaluateProviderSnapshot({
      candidate,
      expectedSourceName: input.expectedSourceName,
      now: input.now,
      freshnessThresholdSeconds: input.freshnessThresholdSeconds,
      isPositiveValue: () => input.isPositiveValue(candidate),
    });

    if (evaluation.eligible) {
      return {
        state: 'selected',
        snapshot: candidate,
        decision: {
          selectedSourceType: 'provider_api',
          selectedSourceName: candidate.sourceName,
          selectedSnapshotId: candidate.id,
          selectedEffectiveAt: candidate.effectiveAt,
          selectedCapturedAt: candidate.capturedAt,
          fallbackUsed: false,
          fallbackReason: null,
          rejectedProviderReason: null,
          freshnessAgeSeconds: evaluation.freshnessAgeSeconds,
        },
      };
    }

    rejectedProviderReason ??= evaluation.reason;
    freshnessAgeSeconds ??= evaluation.freshnessAgeSeconds;
  }

  return {
    state: 'not_selected',
    decision: buildEmptyDecision({
      fallbackUsed: true,
      fallbackReason: 'provider_rejected',
      rejectedProviderReason,
      freshnessAgeSeconds,
    }),
  };
}

export function selectFreshProviderSnapshotBySourcePriority<
  T extends ProviderSnapshotCandidate,
>(input: {
  candidates: readonly T[];
  expectedSourceNames: readonly string[];
  now: Date;
  freshnessThresholdSeconds: number;
  isPositiveValue: (candidate: T) => boolean;
}): ProviderSnapshotSelection<T> {
  if (input.candidates.length === 0) {
    return {
      state: 'not_selected',
      decision: buildEmptyDecision({
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
        rejectedProviderReason: null,
      }),
    };
  }

  let rejectedProviderReason: string | null = null;
  let freshnessAgeSeconds: number | null = null;
  let sawPrioritizedSource = false;

  for (const expectedSourceName of input.expectedSourceNames) {
    const sourceCandidates = input.candidates.filter(
      (candidate) => candidate.sourceName === expectedSourceName,
    );

    if (sourceCandidates.length === 0) {
      continue;
    }

    sawPrioritizedSource = true;

    for (const candidate of sourceCandidates) {
      const evaluation = evaluateProviderSnapshot({
        candidate,
        expectedSourceName,
        now: input.now,
        freshnessThresholdSeconds: input.freshnessThresholdSeconds,
        isPositiveValue: () => input.isPositiveValue(candidate),
      });

      if (evaluation.eligible) {
        return {
          state: 'selected',
          snapshot: candidate,
          decision: {
            selectedSourceType: 'provider_api',
            selectedSourceName: candidate.sourceName,
            selectedSnapshotId: candidate.id,
            selectedEffectiveAt: candidate.effectiveAt,
            selectedCapturedAt: candidate.capturedAt,
            fallbackUsed: false,
            fallbackReason: null,
            rejectedProviderReason: null,
            freshnessAgeSeconds: evaluation.freshnessAgeSeconds,
          },
        };
      }

      rejectedProviderReason ??= evaluation.reason;
      freshnessAgeSeconds ??= evaluation.freshnessAgeSeconds;
    }
  }

  return {
    state: 'not_selected',
    decision: buildEmptyDecision({
      fallbackUsed: true,
      fallbackReason: 'provider_rejected',
      rejectedProviderReason: sawPrioritizedSource
        ? rejectedProviderReason
        : 'source_name_mismatch',
      freshnessAgeSeconds,
    }),
  };
}

export function selectProviderSnapshotAtOrBefore<
  T extends ProviderSnapshotCandidate,
>(input: {
  candidates: readonly T[];
  expectedSourceName: string;
  valuationAt: Date;
  isPositiveValue: (candidate: T) => boolean;
}): ProviderSnapshotSelection<T> {
  if (input.candidates.length === 0) {
    return {
      state: 'not_selected',
      decision: buildEmptyDecision({
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
        rejectedProviderReason: null,
      }),
    };
  }

  let rejectedProviderReason: string | null = null;

  for (const candidate of input.candidates) {
    const evaluation = evaluateProviderSnapshotAtOrBefore({
      candidate,
      expectedSourceName: input.expectedSourceName,
      valuationAt: input.valuationAt,
      isPositiveValue: () => input.isPositiveValue(candidate),
    });

    if (evaluation.eligible) {
      return {
        state: 'selected',
        snapshot: candidate,
        decision: {
          selectedSourceType: 'provider_api',
          selectedSourceName: candidate.sourceName,
          selectedSnapshotId: candidate.id,
          selectedEffectiveAt: candidate.effectiveAt,
          selectedCapturedAt: candidate.capturedAt,
          fallbackUsed: false,
          fallbackReason: null,
          rejectedProviderReason: null,
          freshnessAgeSeconds: null,
        },
      };
    }

    rejectedProviderReason ??= evaluation.reason;
  }

  return {
    state: 'not_selected',
    decision: buildEmptyDecision({
      fallbackUsed: true,
      fallbackReason: 'provider_rejected',
      rejectedProviderReason,
    }),
  };
}

export function selectProviderSnapshotAtOrBeforeBySourcePriority<
  T extends ProviderSnapshotCandidate,
>(input: {
  candidates: readonly T[];
  expectedSourceNames: readonly string[];
  valuationAt: Date;
  isPositiveValue: (candidate: T) => boolean;
}): ProviderSnapshotSelection<T> {
  if (input.candidates.length === 0) {
    return {
      state: 'not_selected',
      decision: buildEmptyDecision({
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
        rejectedProviderReason: null,
      }),
    };
  }

  let rejectedProviderReason: string | null = null;
  let sawPrioritizedSource = false;

  for (const expectedSourceName of input.expectedSourceNames) {
    const sourceCandidates = input.candidates.filter(
      (candidate) => candidate.sourceName === expectedSourceName,
    );

    if (sourceCandidates.length === 0) {
      continue;
    }

    sawPrioritizedSource = true;

    for (const candidate of sourceCandidates) {
      const evaluation = evaluateProviderSnapshotAtOrBefore({
        candidate,
        expectedSourceName,
        valuationAt: input.valuationAt,
        isPositiveValue: () => input.isPositiveValue(candidate),
      });

      if (evaluation.eligible) {
        return {
          state: 'selected',
          snapshot: candidate,
          decision: {
            selectedSourceType: 'provider_api',
            selectedSourceName: candidate.sourceName,
            selectedSnapshotId: candidate.id,
            selectedEffectiveAt: candidate.effectiveAt,
            selectedCapturedAt: candidate.capturedAt,
            fallbackUsed: false,
            fallbackReason: null,
            rejectedProviderReason: null,
            freshnessAgeSeconds: null,
          },
        };
      }

      rejectedProviderReason ??= evaluation.reason;
    }
  }

  return {
    state: 'not_selected',
    decision: buildEmptyDecision({
      fallbackUsed: true,
      fallbackReason: 'provider_rejected',
      rejectedProviderReason: sawPrioritizedSource
        ? rejectedProviderReason
        : 'source_name_mismatch',
    }),
  };
}

export function buildAdminManualFallbackDecision(input: {
  selectedSnapshotId: string;
  selectedSourceName?: string | null;
  selectedEffectiveAt: Date;
  selectedCapturedAt: Date;
  providerDecision: SourceDecision;
}): SourceDecision {
  return {
    selectedSourceType: 'admin_manual',
    selectedSourceName: input.selectedSourceName ?? null,
    selectedSnapshotId: input.selectedSnapshotId,
    selectedEffectiveAt: input.selectedEffectiveAt,
    selectedCapturedAt: input.selectedCapturedAt,
    fallbackUsed: true,
    fallbackReason:
      input.providerDecision.fallbackReason ?? 'provider_not_selected',
    rejectedProviderReason: input.providerDecision.rejectedProviderReason,
    freshnessAgeSeconds: input.providerDecision.freshnessAgeSeconds,
  };
}

export function isPositiveDecimal(value: Prisma.Decimal): boolean {
  return value.gt(0);
}

function evaluateProviderSnapshotAtOrBefore<
  T extends ProviderSnapshotCandidate,
>(input: {
  candidate: T;
  expectedSourceName: string;
  valuationAt: Date;
  isPositiveValue: () => boolean;
}):
  | {
      eligible: true;
    }
  | {
      eligible: false;
      reason: string;
    } {
  const candidate = input.candidate;

  if (candidate.sourceType !== 'provider_api') {
    return {
      eligible: false,
      reason: 'source_type_mismatch',
    };
  }

  if (candidate.sourceName !== input.expectedSourceName) {
    return {
      eligible: false,
      reason: 'source_name_mismatch',
    };
  }

  if (!input.isPositiveValue()) {
    return {
      eligible: false,
      reason: 'non_positive_value',
    };
  }

  if (candidate.effectiveAt.getTime() > input.valuationAt.getTime()) {
    return {
      eligible: false,
      reason: 'effective_at_in_future',
    };
  }

  return {
    eligible: true,
  };
}

function evaluateProviderSnapshot<T extends ProviderSnapshotCandidate>(input: {
  candidate: T;
  expectedSourceName: string;
  now: Date;
  freshnessThresholdSeconds: number;
  isPositiveValue: () => boolean;
}):
  | {
      eligible: true;
      freshnessAgeSeconds: number;
    }
  | {
      eligible: false;
      reason: string;
      freshnessAgeSeconds: number | null;
    } {
  const candidate = input.candidate;

  if (candidate.sourceType !== 'provider_api') {
    return {
      eligible: false,
      reason: 'source_type_mismatch',
      freshnessAgeSeconds: null,
    };
  }

  if (candidate.sourceName !== input.expectedSourceName) {
    return {
      eligible: false,
      reason: 'source_name_mismatch',
      freshnessAgeSeconds: null,
    };
  }

  if (!input.isPositiveValue()) {
    return {
      eligible: false,
      reason: 'non_positive_value',
      freshnessAgeSeconds: null,
    };
  }

  if (candidate.effectiveAt.getTime() > input.now.getTime()) {
    return {
      eligible: false,
      reason: 'effective_at_in_future',
      freshnessAgeSeconds: null,
    };
  }

  if (candidate.capturedAt.getTime() > input.now.getTime()) {
    return {
      eligible: false,
      reason: 'captured_at_in_future',
      freshnessAgeSeconds: null,
    };
  }

  const freshnessAgeSeconds = Math.floor(
    (input.now.getTime() - candidate.capturedAt.getTime()) / 1000,
  );

  if (freshnessAgeSeconds > input.freshnessThresholdSeconds) {
    return {
      eligible: false,
      reason: 'captured_at_stale',
      freshnessAgeSeconds,
    };
  }

  return {
    eligible: true,
    freshnessAgeSeconds,
  };
}

function buildEmptyDecision(input: {
  fallbackUsed: boolean;
  fallbackReason: string | null;
  rejectedProviderReason: string | null;
  freshnessAgeSeconds?: number | null;
}): SourceDecision {
  return {
    selectedSourceType: null,
    selectedSourceName: null,
    selectedSnapshotId: null,
    selectedEffectiveAt: null,
    selectedCapturedAt: null,
    fallbackUsed: input.fallbackUsed,
    fallbackReason: input.fallbackReason,
    rejectedProviderReason: input.rejectedProviderReason,
    freshnessAgeSeconds: input.freshnessAgeSeconds ?? null,
  };
}

function isKrxMarketFamily(market: string): boolean {
  return (
    market === 'KRX' ||
    market === 'KOSPI' ||
    market === 'KOSDAQ' ||
    market === 'KONEX'
  );
}

function isUsNasNysMarketFamily(market: string): boolean {
  return (
    market === 'NAS' ||
    market === 'NASDAQ' ||
    market === 'NYS' ||
    market === 'NYSE'
  );
}
