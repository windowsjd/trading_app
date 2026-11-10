import { CurrencyCode, Prisma } from '../generated/prisma/client';
import type { AssetType } from '../generated/prisma/client';
import {
  resolveStockMarketSessionState,
  type StockMarketSessionState,
} from '../orders/market-calendar.policy';
import { usExtendedHoursPriceEnabled } from '../orders/us-extended-hours.config';
import {
  usExtendedHoursStateFrom,
  type UsExtendedHoursWindow,
} from '../orders/us-extended-hours.policy';
import { readUsStockPriceProvider } from './us-stock-price-provider.config';

export const PROVIDER_SOURCE_NAMES = {
  fxUsdKrw: 'exchange_rate_api',
  fxUsdKrwKoreaExim: 'korea_exim_exchange_rate',
  fxUsdKrwExchangeRateApi: 'exchange_rate_api',
  cryptoUsd: 'binance_public_rest_24hr_ticker',
  cryptoUsdRest: 'binance_public_rest_24hr_ticker',
  cryptoUsdWebSocket: 'binance_spot_ws_ticker',
  domesticStockKrx: 'koscom_krx_realtime_price',
  domesticStockLegacy: 'kis_krx_realtime_trade',
  usStock: 'kis_us_delayed_trade',
  /** Tiingo reference price (`tngoLast`) stored in official mode (2026-10-17);
   * the trial's display-only value keeps `tiingo_equity_reference_price`. */
  usStockTiingo: 'tiingo_us_reference_price',
  /** The same Tiingo reference price observed in US pre-market/after-hours
   * (2026-11-10). A distinct name keeps it out of every regular-session read
   * (Season settlement, daily snapshots, LOC, candles, conditional triggers):
   * only the extended-hours display/live-valuation reads and the extended
   * limit matcher ask for it. */
  usStockTiingoExtended: 'tiingo_us_extended_reference_price',
} as const;

export {
  readUsStockPriceProvider,
  type UsStockPriceProvider,
} from './us-stock-price-provider.config';

/**
 * Where-clause guard for every admin_manual asset-price fallback: operator
 * prices never stand in for US stocks priced by Tiingo (2026-10-17); other
 * assets keep the existing fallback unchanged.
 */
export function adminManualAssetPriceScope(
  asset: { assetType: string },
  env: Record<string, string | undefined> = process.env,
): Prisma.AssetPriceSnapshotWhereInput {
  return asset.assetType === 'us_stock' &&
    readUsStockPriceProvider(env) === 'tiingo'
    ? { id: { in: [] } }
    : {};
}

export function usStockPriceSourceName(
  env: Record<string, string | undefined> = process.env,
):
  | typeof PROVIDER_SOURCE_NAMES.usStock
  | typeof PROVIDER_SOURCE_NAMES.usStockTiingo {
  return readUsStockPriceProvider(env) === 'tiingo'
    ? PROVIDER_SOURCE_NAMES.usStockTiingo
    : PROVIDER_SOURCE_NAMES.usStock;
}

export const FX_USD_KRW_PROVIDER_SOURCE_PRIORITY = [
  PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
  PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
] as const;

export const BINANCE_CRYPTO_USD_PROVIDER_SOURCE_PRIORITY = [
  PROVIDER_SOURCE_NAMES.cryptoUsdWebSocket,
  PROVIDER_SOURCE_NAMES.cryptoUsdRest,
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
  fxUsdKrwDisplay: 7200,
  fxUsdKrwQuote: 300,
  fxUsdKrwExecute: 60,
  assetPriceDisplay: 300,
  assetPriceQuote: 60,
  assetPriceExecute: 10,
} as const;

export type ProviderFreshnessThresholdsSeconds = Record<
  keyof typeof PROVIDER_FRESHNESS_THRESHOLDS_SECONDS,
  number
>;

type FreshnessEnv = Record<string, string | undefined>;

export function getProviderFreshnessThresholdsSeconds(
  env: FreshnessEnv = process.env,
): ProviderFreshnessThresholdsSeconds {
  return {
    ...PROVIDER_FRESHNESS_THRESHOLDS_SECONDS,
    fxUsdKrwDisplay: readFreshnessOverride(
      env.PROVIDER_FX_RATE_DISPLAY_FRESHNESS_SECONDS,
      PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.fxUsdKrwDisplay,
    ),
    fxUsdKrwQuote: readFreshnessOverride(
      env.PROVIDER_FX_RATE_QUOTE_FRESHNESS_SECONDS,
      PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.fxUsdKrwQuote,
    ),
    assetPriceDisplay: readFreshnessOverride(
      env.PROVIDER_ASSET_PRICE_DISPLAY_FRESHNESS_SECONDS,
      PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPriceDisplay,
    ),
    assetPriceQuote: readFreshnessOverride(
      env.PROVIDER_ASSET_PRICE_QUOTE_FRESHNESS_SECONDS,
      PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.assetPriceQuote,
    ),
  };
}

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
    freshnessThresholdSeconds: resolveFxFreshnessThresholdSeconds(
      input.workflow,
    ),
  };
}

export function resolveAssetProviderEligibility(input: {
  workflow: ProviderWorkflow;
  asset: ProviderAssetCandidate;
}):
  | {
      eligible: true;
      sourceName: ProviderSourceName;
      sourceNames: readonly ProviderSourceName[];
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
      sourceNames:
        input.workflow === 'daily_portfolio_snapshot' ||
        input.workflow === 'season_settlement'
          ? [
              PROVIDER_SOURCE_NAMES.domesticStockKrx,
              PROVIDER_SOURCE_NAMES.domesticStockLegacy,
            ]
          : [PROVIDER_SOURCE_NAMES.domesticStockKrx],
      freshnessThresholdSeconds: resolveAssetPriceFreshnessThresholdSeconds(
        input.workflow,
      ),
    };
  }

  if (
    input.asset.assetType === 'us_stock' &&
    input.asset.currencyCode === CurrencyCode.USD &&
    isUsNasNysMarketFamily(market)
  ) {
    const sourceName = usStockPriceSourceName();
    return {
      eligible: true,
      sourceName,
      sourceNames: [sourceName],
      freshnessThresholdSeconds: resolveAssetPriceFreshnessThresholdSeconds(
        input.workflow,
      ),
    };
  }

  if (
    input.asset.assetType === 'crypto' &&
    input.asset.currencyCode === CurrencyCode.USD &&
    market === 'BINANCE'
  ) {
    return {
      eligible: true,
      sourceName: PROVIDER_SOURCE_NAMES.cryptoUsdWebSocket,
      sourceNames: BINANCE_CRYPTO_USD_PROVIDER_SOURCE_PRIORITY,
      freshnessThresholdSeconds: resolveAssetPriceFreshnessThresholdSeconds(
        input.workflow,
      ),
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

export const CLOSED_MARKET_CARRY_FORWARD_WORKFLOWS: ReadonlySet<ProviderWorkflow> =
  new Set([
    'assets_with_price',
    'live_portfolio_valuation',
    'home_live_valuation',
    'positions_live_valuation',
    'daily_portfolio_snapshot',
  ]);

/**
 * Reads that may show a US stock's pre-market/after-hours price while
 * US_STOCK_EXTENDED_HOURS_PRICE_ENABLED is on (2026-11-10): display and live
 * valuation (home, positions, live portfolio and the current ranking). Daily
 * snapshots, Season settlement and every order/trigger workflow never do —
 * the extended limit matcher selects its own evidence explicitly.
 */
export const EXTENDED_HOURS_PRICE_WORKFLOWS: ReadonlySet<ProviderWorkflow> =
  new Set([
    'assets_with_price',
    'home_live_valuation',
    'positions_live_valuation',
    'live_portfolio_valuation',
  ]);

/**
 * The extended-hours window whose prices this read may show now, or null:
 * a US stock, an extended-hours workflow, the price switch on, and `now`
 * inside the pre-market/after-hours of the CURRENT New York trading date.
 */
export function resolveExtendedHoursPriceWindow(input: {
  asset: Pick<ProviderAssetCandidate, 'assetType' | 'market'>;
  workflow: ProviderWorkflow;
  now: Date;
  marketState: StockMarketSessionState | null;
}): UsExtendedHoursWindow | null {
  if (
    input.asset.assetType !== 'us_stock' ||
    !EXTENDED_HOURS_PRICE_WORKFLOWS.has(input.workflow) ||
    !usExtendedHoursPriceEnabled()
  )
    return null;
  const state = usExtendedHoursStateFrom(input.marketState, input.now);
  return 'window' in state ? state.window : null;
}

/**
 * The newest positive extended-hours price inside `window` (never an earlier
 * window's: yesterday's after-hours is not today's pre-market). Like the
 * closed-market carry-forward it has no capturedAt limit — extended-hours
 * trading is sparse, and the app labels the price with its session and time
 * — but it is never a regular-session price, never an order price (orders
 * use selectUsExtendedHoursExecutionSnapshot, 10 s fresh) and it ends with
 * its window.
 */
export function selectExtendedHoursDisplaySnapshot<
  T extends ProviderSnapshotCandidate,
>(input: {
  candidates: readonly T[];
  window: UsExtendedHoursWindow;
  now: Date;
  isPositiveValue: (candidate: T) => boolean;
}): ProviderSnapshotSelection<T> {
  const sourceName = PROVIDER_SOURCE_NAMES.usStockTiingoExtended;
  const candidates = input.candidates.filter((candidate) =>
    isInsideExtendedWindow(candidate, input.window, input.now),
  );
  const selection = selectProviderSnapshotAtOrBeforeBySourcePriority({
    candidates,
    expectedSourceNames: [sourceName],
    valuationAt: input.now,
    isPositiveValue: input.isPositiveValue,
  });
  if (selection.state !== 'selected') return selection;
  return {
    ...selection,
    decision: {
      ...selection.decision,
      freshnessAgeSeconds: Math.max(
        0,
        Math.floor(
          (input.now.getTime() - selection.snapshot.capturedAt.getTime()) /
            1000,
        ),
      ),
    },
  };
}

/**
 * Execution evidence for an extended-hours limit fill: a positive
 * extended-hours price of the CURRENT window, received at most
 * `freshnessThresholdSeconds` ago (the regular order-execute 10 s policy).
 * The caller decides that extended matching applies at all.
 */
export function selectUsExtendedHoursExecutionSnapshot<
  T extends ProviderSnapshotCandidate,
>(input: {
  candidates: readonly T[];
  window: UsExtendedHoursWindow;
  now: Date;
  freshnessThresholdSeconds: number;
  isPositiveValue: (candidate: T) => boolean;
}): ProviderSnapshotSelection<T> {
  const candidates = input.candidates.filter((candidate) =>
    isInsideExtendedWindow(candidate, input.window, input.now),
  );
  if (candidates.length === 0 && input.candidates.length > 0)
    return notSelectedForMarket('effective_at_outside_extended_hours_window');
  return selectFreshProviderSnapshotBySourcePriority({
    candidates,
    expectedSourceNames: [PROVIDER_SOURCE_NAMES.usStockTiingoExtended],
    now: input.now,
    freshnessThresholdSeconds: input.freshnessThresholdSeconds,
    isPositiveValue: input.isPositiveValue,
  });
}

function isInsideExtendedWindow(
  candidate: ProviderSnapshotCandidate,
  window: UsExtendedHoursWindow,
  now: Date,
): boolean {
  const effectiveAt = candidate.effectiveAt.getTime();
  return (
    candidate.sourceName === PROVIDER_SOURCE_NAMES.usStockTiingoExtended &&
    effectiveAt >= window.startsAt.getTime() &&
    effectiveAt < window.endsAt.getTime() &&
    effectiveAt <= now.getTime() &&
    candidate.capturedAt.getTime() <= now.getTime()
  );
}

/**
 * Shared stock-price selection policy for reads, valuations, snapshots,
 * ranking, health, and orders.
 *
 * - crypto remains continuous and uses capturedAt freshness;
 * - an open stock market requires both capturedAt freshness and an
 *   effectiveAt inside the current session;
 * - an eligible closed-market read/valuation may use only a price whose
 *   effectiveAt lies inside the latest completed session;
 * - order workflows never carry a completed-session price forward;
 * - with extended-hours prices on, a US display/live-valuation read inside
 *   the current pre-market/after-hours first takes that window's newest
 *   extended price (EXTENDED_HOURS_PRICE_WORKFLOWS), else the rules above.
 */
export function selectMarketAwareAssetPriceSnapshotBySourcePriority<
  T extends ProviderSnapshotCandidate,
>(input: {
  asset: Pick<ProviderAssetCandidate, 'assetType' | 'market'>;
  workflow: ProviderWorkflow;
  candidates: readonly T[];
  expectedSourceNames: readonly string[];
  now: Date;
  freshnessThresholdSeconds: number;
  isPositiveValue: (candidate: T) => boolean;
}): ProviderSnapshotSelection<T> {
  if (input.asset.assetType === 'crypto') {
    return selectFreshProviderSnapshotBySourcePriority(input);
  }

  const marketState = resolveStockMarketSessionState(input.asset, input.now);
  if (!marketState || marketState.state === 'calendar_unavailable') {
    return notSelectedForMarket('market_calendar_unavailable');
  }

  if (marketState.state === 'open') {
    const sessionCandidates = input.candidates.filter(
      (candidate) =>
        candidate.effectiveAt.getTime() >=
          marketState.currentSession.openTime.getTime() &&
        candidate.effectiveAt.getTime() <= input.now.getTime(),
    );
    if (sessionCandidates.length === 0 && input.candidates.length > 0) {
      return notSelectedForMarket('effective_at_outside_current_session');
    }
    return selectFreshProviderSnapshotBySourcePriority({
      ...input,
      candidates: sessionCandidates,
    });
  }

  const extendedWindow = resolveExtendedHoursPriceWindow({
    asset: input.asset,
    workflow: input.workflow,
    now: input.now,
    marketState,
  });
  if (extendedWindow) {
    const extended = selectExtendedHoursDisplaySnapshot({
      candidates: input.candidates,
      window: extendedWindow,
      now: input.now,
      isPositiveValue: input.isPositiveValue,
    });
    if (extended.state === 'selected') return extended;
  }

  if (!CLOSED_MARKET_CARRY_FORWARD_WORKFLOWS.has(input.workflow)) {
    return notSelectedForMarket('market_closed');
  }
  const completedSession = marketState.latestCompletedSession;
  if (!completedSession) {
    return notSelectedForMarket('last_completed_session_unavailable');
  }
  const sessionCandidates = input.candidates.filter(
    (candidate) =>
      candidate.effectiveAt.getTime() >= completedSession.openTime.getTime() &&
      candidate.effectiveAt.getTime() <= completedSession.closeTime.getTime(),
  );
  if (sessionCandidates.length === 0 && input.candidates.length > 0) {
    return notSelectedForMarket('effective_at_outside_last_completed_session');
  }
  const selection = selectProviderSnapshotAtOrBeforeBySourcePriority({
    candidates: sessionCandidates,
    expectedSourceNames: input.expectedSourceNames,
    valuationAt: completedSession.closeTime,
    isPositiveValue: input.isPositiveValue,
  });
  if (selection.state !== 'selected') return selection;
  return {
    ...selection,
    decision: {
      ...selection.decision,
      freshnessAgeSeconds: Math.max(
        0,
        Math.floor(
          (input.now.getTime() - selection.snapshot.capturedAt.getTime()) /
            1000,
        ),
      ),
    },
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

  if (
    candidate.sourceName === PROVIDER_SOURCE_NAMES.domesticStockKrx &&
    input.now.getTime() - candidate.effectiveAt.getTime() >
      input.freshnessThresholdSeconds * 1000
  ) {
    return {
      eligible: false,
      reason: 'effective_at_stale',
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

function notSelectedForMarket<T extends ProviderSnapshotCandidate>(
  reason: string,
): ProviderSnapshotSelection<T> {
  return {
    state: 'not_selected',
    decision: buildEmptyDecision({
      fallbackUsed: true,
      fallbackReason: 'provider_rejected',
      rejectedProviderReason: reason,
    }),
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

function resolveFxFreshnessThresholdSeconds(
  workflow: ProviderEligibleWorkflow,
): number {
  const thresholds = getProviderFreshnessThresholdsSeconds();
  if (workflow === 'fx_execute' || workflow === 'orders_execute') {
    return thresholds.fxUsdKrwExecute;
  }

  if (workflow === 'fx_quote' || workflow === 'orders_quote') {
    return thresholds.fxUsdKrwQuote;
  }

  if (isDisplayFreshnessWorkflow(workflow)) {
    return thresholds.fxUsdKrwDisplay;
  }

  return thresholds.fxUsdKrwQuote;
}

function resolveAssetPriceFreshnessThresholdSeconds(
  workflow: ProviderEligibleWorkflow,
): number {
  const thresholds = getProviderFreshnessThresholdsSeconds();
  if (workflow === 'orders_execute') {
    return thresholds.assetPriceExecute;
  }

  if (isDisplayFreshnessWorkflow(workflow)) {
    return thresholds.assetPriceDisplay;
  }

  return thresholds.assetPriceQuote;
}

function isDisplayFreshnessWorkflow(
  workflow: ProviderEligibleWorkflow,
): boolean {
  return (
    workflow === 'assets_with_price' ||
    workflow === 'home_live_valuation' ||
    workflow === 'positions_live_valuation' ||
    workflow === 'live_portfolio_valuation' ||
    workflow === 'daily_portfolio_snapshot'
  );
}

function readFreshnessOverride(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
