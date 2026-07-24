import { Injectable } from '@nestjs/common';
import type { AssetType } from '../generated/prisma/client';
import type { TradeRouteProvider } from './provider-trade-route.registry';

/**
 * Provider trade capability matrix — the NORMATIVE, code-level declaration of
 * what each provider trade route can prove about its events, and therefore
 * whether Path A (live-trade execution) may run on it.
 *
 * See `docs/limit-order-event-authority.md` (§3–§4) for the contract. The one
 * rule that governs every value here: a capability is only `true` when it is
 * grounded in provider documentation AND in what our parser actually captures.
 * We never assume a capability, and a code comment is never sufficient
 * evidence. A route we cannot classify is fail-closed (`unsupported`), never a
 * silent fall-through to arrival-order Path A.
 *
 * Grounding for the current classification:
 *  - Binance `@trade` carries `t`, a per-symbol strictly-increasing unique
 *    trade id, captured as BOTH providerEventId and providerSequence
 *    (`binance-websocket.parser.ts`). That is an authoritative identity and a
 *    monotonic ordering key within (binance, asset) → `provider_sequence`.
 *  - KIS domestic trades carry a SYNTHETIC composite id and `sequence =
 *    ACML_VOL` (cumulative volume), which is not a documented per-trade
 *    monotonic authority (it ties, resets per session, and is not a trade
 *    ordinal) (`kis-websocket.trade-parser.ts`) → `path_b_only`.
 *  - KIS US is an explicitly DELAYED feed → `path_b_only`, never "real-time".
 */

export type ProviderTradeActivationMode =
  | 'provider_sequence'
  | 'provider_time_watermark'
  | 'path_b_only'
  | 'unsupported';

export type ProviderTradeCapability = {
  provider: TradeRouteProvider;
  /** Stable route key, `${provider}:${route}` — the matrix primary key. */
  route: string;
  /** Normalized trade `sourceName` this route stamps onto events. */
  sourceName: string;
  /** Provider documents a globally-unique (within provider+asset) trade id. */
  supportsAuthoritativeEventId: boolean;
  /** Provider documents a monotonic per-trade sequence (an ordering authority). */
  supportsMonotonicSequence: boolean;
  /** Provider event time is itself a reliable ordering authority (with tie-break). */
  supportsAuthoritativeEventTime: boolean;
  /** Provider documents an ordering/finality boundary per window. */
  supportsDocumentedFinality: boolean;
  /** Provider offers a verifiable replay/gap-recovery mechanism. */
  supportsReplay: boolean;
  /** Provider documents a bounded delivery lag we can rely on. */
  supportsBoundedDeliveryLag: boolean;
  /** The documented bound, ms; non-null iff `supportsBoundedDeliveryLag`. */
  maxDocumentedDeliveryLagMs: number | null;
  /** Path A (live-trade execution) is permitted on this route. */
  pathAExecutionAllowed: boolean;
  /** Path B (closed-candle safety net) is required on this route. */
  pathBRequired: boolean;
  activationMode: ProviderTradeActivationMode;
};

export const BINANCE_SPOT_TRADE_ROUTE = 'binance:spot-trade';
export const KIS_DOMESTIC_TRADE_ROUTE = 'kis:domestic-trade';
export const KIS_OVERSEAS_DELAYED_TRADE_ROUTE = 'kis:overseas-delayed-trade';

/**
 * The matrix. Frozen and validated at module load (`validateCapability`), so an
 * internally-inconsistent row (e.g. Path A allowed on a `path_b_only` route)
 * fails fast instead of silently authorizing an unsafe fill.
 */
const CAPABILITIES: readonly ProviderTradeCapability[] = [
  {
    provider: 'binance',
    route: BINANCE_SPOT_TRADE_ROUTE,
    sourceName: 'binance_spot_ws_trade',
    supportsAuthoritativeEventId: true,
    supportsMonotonicSequence: true,
    // Trade time `T` ties within a millisecond and is NOT the ordering
    // authority (the trade id is), so we do not claim time authority.
    supportsAuthoritativeEventTime: false,
    supportsDocumentedFinality: false,
    supportsReplay: false,
    supportsBoundedDeliveryLag: false,
    maxDocumentedDeliveryLagMs: null,
    pathAExecutionAllowed: true,
    pathBRequired: true,
    activationMode: 'provider_sequence',
  },
  {
    provider: 'kis',
    route: KIS_DOMESTIC_TRADE_ROUTE,
    sourceName: 'kis_krx_realtime_trade',
    supportsAuthoritativeEventId: false,
    supportsMonotonicSequence: false,
    supportsAuthoritativeEventTime: false,
    supportsDocumentedFinality: false,
    supportsReplay: false,
    supportsBoundedDeliveryLag: false,
    maxDocumentedDeliveryLagMs: null,
    pathAExecutionAllowed: false,
    pathBRequired: true,
    activationMode: 'path_b_only',
  },
  {
    provider: 'kis',
    route: KIS_OVERSEAS_DELAYED_TRADE_ROUTE,
    sourceName: 'kis_us_delayed_trade',
    supportsAuthoritativeEventId: false,
    supportsMonotonicSequence: false,
    supportsAuthoritativeEventTime: false,
    supportsDocumentedFinality: false,
    supportsReplay: false,
    supportsBoundedDeliveryLag: false,
    maxDocumentedDeliveryLagMs: null,
    pathAExecutionAllowed: false,
    pathBRequired: true,
    activationMode: 'path_b_only',
  },
];

export class ProviderTradeCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTradeCapabilityError';
  }
}

/**
 * Structural invariants every row must satisfy. Exported so a unit test can
 * freeze them and so the module self-checks at load. A violation is a
 * programming error (an unsafe matrix), so it throws rather than degrades.
 */
export function validateCapability(capability: ProviderTradeCapability): void {
  const fail = (why: string): never => {
    throw new ProviderTradeCapabilityError(`${capability.route}: ${why}`);
  };
  if (!capability.route.trim()) fail('route is empty.');
  if (!capability.sourceName.trim()) fail('sourceName is empty.');
  if (!capability.route.startsWith(`${capability.provider}:`)) {
    fail('route must be prefixed with its provider.');
  }
  const pathA = capability.pathAExecutionAllowed;
  const mode = capability.activationMode;
  if (
    pathA &&
    mode !== 'provider_sequence' &&
    mode !== 'provider_time_watermark'
  ) {
    fail(
      `pathAExecutionAllowed requires an authoritative activationMode, got ${mode}.`,
    );
  }
  if (
    !pathA &&
    (mode === 'provider_sequence' || mode === 'provider_time_watermark')
  ) {
    fail(`activationMode ${mode} requires pathAExecutionAllowed.`);
  }
  if (mode === 'provider_sequence' && !capability.supportsMonotonicSequence) {
    fail('provider_sequence requires supportsMonotonicSequence.');
  }
  if (
    mode === 'provider_time_watermark' &&
    !(
      capability.supportsAuthoritativeEventTime &&
      capability.supportsDocumentedFinality
    )
  ) {
    fail(
      'provider_time_watermark requires authoritative event time AND documented finality.',
    );
  }
  if ((mode === 'path_b_only' || mode === 'unsupported') && pathA) {
    fail(`activationMode ${mode} must not allow Path A.`);
  }
  if (pathA && !capability.pathBRequired) {
    fail('Path A routes must keep Path B as the safety net (pathBRequired).');
  }
  if (
    (capability.maxDocumentedDeliveryLagMs !== null) !==
    capability.supportsBoundedDeliveryLag
  ) {
    fail(
      'supportsBoundedDeliveryLag must agree with maxDocumentedDeliveryLagMs.',
    );
  }
  if (
    capability.maxDocumentedDeliveryLagMs !== null &&
    !(
      Number.isFinite(capability.maxDocumentedDeliveryLagMs) &&
      capability.maxDocumentedDeliveryLagMs > 0
    )
  ) {
    fail('maxDocumentedDeliveryLagMs must be a positive finite number.');
  }
}

const BY_ROUTE = ((): ReadonlyMap<string, ProviderTradeCapability> => {
  const map = new Map<string, ProviderTradeCapability>();
  for (const capability of CAPABILITIES) {
    validateCapability(capability);
    if (map.has(capability.route)) {
      throw new ProviderTradeCapabilityError(
        `Duplicate capability route: ${capability.route}.`,
      );
    }
    map.set(capability.route, Object.freeze({ ...capability }));
  }
  return map;
})();

/** Which route an asset type resolves to. Mirrors the provider routing. */
export function tradeRouteKeyForAssetType(assetType: AssetType): string {
  switch (assetType) {
    case 'crypto':
      return BINANCE_SPOT_TRADE_ROUTE;
    case 'domestic_stock':
      return KIS_DOMESTIC_TRADE_ROUTE;
    case 'us_stock':
      return KIS_OVERSEAS_DELAYED_TRADE_ROUTE;
    default: {
      // Exhaustiveness: a new AssetType must be classified explicitly, never
      // defaulted into an authoritative route.
      const exhaustive: never = assetType;
      throw new ProviderTradeCapabilityError(
        `Unclassified asset type for trade route: ${String(exhaustive)}.`,
      );
    }
  }
}

export function findCapabilityByRoute(
  route: string,
): ProviderTradeCapability | null {
  return BY_ROUTE.get(route) ?? null;
}

export function findCapabilityBySourceName(
  sourceName: string,
): ProviderTradeCapability | null {
  for (const capability of BY_ROUTE.values()) {
    if (capability.sourceName === sourceName) return capability;
  }
  return null;
}

export function findCapabilityForAssetType(
  assetType: AssetType,
): ProviderTradeCapability | null {
  return findCapabilityByRoute(tradeRouteKeyForAssetType(assetType));
}

export function allCapabilities(): readonly ProviderTradeCapability[] {
  return [...BY_ROUTE.values()];
}

/**
 * The gate decision for a NEW limit quote/create on a route, given the resolved
 * capability (or `null` when the route is unknown). This is where the
 * fail-closed default lives: an unknown or `unsupported` route BLOCKS new
 * orders; a `path_b_only` route is allowed but Path-B-only (the UI must not
 * imply immediate live matching); a Path-A route is allowed.
 */
export type NewLimitOrderRouteDecision =
  | { allowed: true; pathAExecutionAllowed: boolean; pathBOnly: boolean }
  | {
      allowed: false;
      code: 'LIMIT_ORDER_PROVIDER_CAPABILITY_UNSUPPORTED';
      reason: string;
    };

export function decideNewLimitOrderRoute(
  capability: ProviderTradeCapability | null,
): NewLimitOrderRouteDecision {
  if (!capability || capability.activationMode === 'unsupported') {
    return {
      allowed: false,
      code: 'LIMIT_ORDER_PROVIDER_CAPABILITY_UNSUPPORTED',
      reason: capability
        ? `Route ${capability.route} is unsupported for limit matching.`
        : 'No trade capability is declared for this route.',
    };
  }
  return {
    allowed: true,
    pathAExecutionAllowed: capability.pathAExecutionAllowed,
    pathBOnly: !capability.pathAExecutionAllowed,
  };
}

/**
 * Thin DI wrapper over the static matrix so services can inject it and it can
 * be swapped in tests. The matrix itself is process-wide immutable data.
 */
@Injectable()
export class ProviderTradeCapabilityRegistry {
  forRoute(route: string): ProviderTradeCapability | null {
    return findCapabilityByRoute(route);
  }

  forSourceName(sourceName: string): ProviderTradeCapability | null {
    return findCapabilityBySourceName(sourceName);
  }

  forAssetType(assetType: AssetType): ProviderTradeCapability | null {
    return findCapabilityForAssetType(assetType);
  }

  decideForAssetType(assetType: AssetType): NewLimitOrderRouteDecision {
    return decideNewLimitOrderRoute(this.forAssetType(assetType));
  }

  all(): readonly ProviderTradeCapability[] {
    return allCapabilities();
  }
}
