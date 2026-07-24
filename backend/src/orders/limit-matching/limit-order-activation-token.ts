import type {
  ProviderTradeActivationMode,
  ProviderTradeCapability,
} from '../../providers/provider-trade-capability';

/**
 * Order activation token & event-eligibility decision.
 *
 * See `docs/limit-order-event-authority.md` §7–§8. This module is the decided,
 * side-effect-free heart of two guarantees:
 *
 *  - Goal #1 (Path A priority): the matcher only fills an order from a live
 *    event that is strictly AFTER the order's activation on an authoritative
 *    ordering key — never on arrival order.
 *  - Goal #2 (delayed-event defense): a trade that OCCURRED before the order
 *    (sequence ≤ activation) cannot fill it no matter when it was delivered.
 *
 * Everything here is pure so it can be frozen by unit tests independently of
 * the durable-ingress / Redis / Prisma wiring that feeds it. Any uncertainty
 * (missing token, malformed evidence, mode/route/generation/epoch mismatch,
 * non-Path-A route) resolves to a REJECTION — fail-closed, never a fill.
 */

export type LimitOrderActivationToken = {
  provider: string;
  route: string;
  generation: string;
  epoch: string;
  activationMode: ProviderTradeActivationMode;
  /** Required for provider_sequence; the exclusive lower bound (non-negative int string). */
  providerSequence: string | null;
  /** Required for provider_time_watermark; the exclusive lower bound (ISO-8601). */
  providerEventAt: string | null;
  ingressSeq: string | null;
  coverageVersion: string | null;
  /** Retained arrival cursor — a convenience, never the ordering authority. */
  streamId: string | null;
};

/** The authoritative fields the matcher extracts from a candidate live event. */
export type EvaluatedTradeEvent = {
  provider: string;
  route: string;
  generation: string;
  epoch: string;
  providerSequence: string | null;
  providerEventAt: string | null;
};

export type EligibilityRejectionReason =
  | 'route_not_path_a'
  | 'activation_token_missing'
  | 'activation_token_malformed'
  | 'route_mismatch'
  | 'generation_mismatch'
  | 'epoch_mismatch'
  | 'activation_mode_mismatch'
  | 'malformed_sequence'
  | 'sequence_not_after_activation'
  | 'time_watermark_unsupported'
  | 'malformed_event_time'
  | 'event_time_not_after_activation';

export type EventOrderEligibility =
  | { eligible: true; basis: 'provider_sequence' | 'provider_time_watermark' }
  | { eligible: false; reason: EligibilityRejectionReason };

function reject(reason: EligibilityRejectionReason): EventOrderEligibility {
  return { eligible: false, reason };
}

/** Non-negative integer string → bigint, else null (malformed → fail-closed). */
export function parseProviderSequence(value: string | null): bigint | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d{1,40}$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** Parseable ISO timestamp → epoch ms, else null. */
function parseEventTimeMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reads a persisted token defensively. Returns null when the required evidence
 * for its declared mode is absent/malformed, which callers treat as
 * fail-closed (no Path-A fill) rather than trusting a broken token.
 */
export function parseActivationToken(
  raw: Partial<LimitOrderActivationToken> | null | undefined,
): LimitOrderActivationToken | null {
  if (!raw) return null;
  const { provider, route, generation, epoch, activationMode } = raw;
  if (
    !isNonEmpty(provider) ||
    !isNonEmpty(route) ||
    !isNonEmpty(generation) ||
    !isNonEmpty(epoch) ||
    !isMode(activationMode)
  ) {
    return null;
  }
  const token: LimitOrderActivationToken = {
    provider,
    route,
    generation,
    epoch,
    activationMode,
    providerSequence: raw.providerSequence ?? null,
    providerEventAt: raw.providerEventAt ?? null,
    ingressSeq: raw.ingressSeq ?? null,
    coverageVersion: raw.coverageVersion ?? null,
    streamId: raw.streamId ?? null,
  };
  if (activationMode === 'provider_sequence') {
    if (parseProviderSequence(token.providerSequence) === null) return null;
  }
  if (activationMode === 'provider_time_watermark') {
    if (parseEventTimeMs(token.providerEventAt) === null) return null;
  }
  return token;
}

/**
 * The single decision: may `event` fill an order activated by `token` on a
 * route described by `capability`? Ordering is decided by the authoritative
 * key (provider sequence / documented time watermark), NEVER by arrival order.
 */
export function evaluateEventOrderEligibility(input: {
  token: LimitOrderActivationToken | null;
  event: EvaluatedTradeEvent;
  capability: ProviderTradeCapability | null;
}): EventOrderEligibility {
  const { token, event, capability } = input;

  // A route that cannot prove ordering authority never fills on Path A.
  if (!capability || !capability.pathAExecutionAllowed) {
    return reject('route_not_path_a');
  }
  if (
    capability.activationMode !== 'provider_sequence' &&
    capability.activationMode !== 'provider_time_watermark'
  ) {
    return reject('route_not_path_a');
  }

  // Legacy / malformed orders carry no usable token → fail-closed.
  if (!token) return reject('activation_token_missing');
  const parsed = parseActivationToken(token);
  if (!parsed) return reject('activation_token_malformed');

  // Provenance fencing: same route, generation and owner epoch.
  if (parsed.provider !== event.provider || parsed.route !== event.route) {
    return reject('route_mismatch');
  }
  if (parsed.route !== capability.route) return reject('route_mismatch');
  if (parsed.generation !== event.generation) {
    return reject('generation_mismatch');
  }
  if (parsed.epoch !== event.epoch) return reject('epoch_mismatch');

  // The token's mode must still match the route's current capability.
  if (parsed.activationMode !== capability.activationMode) {
    return reject('activation_mode_mismatch');
  }

  if (capability.activationMode === 'provider_sequence') {
    const activation = parseProviderSequence(parsed.providerSequence);
    const eventSeq = parseProviderSequence(event.providerSequence);
    if (activation === null || eventSeq === null) {
      return reject('malformed_sequence');
    }
    // Strictly after: `=` is the boundary event, which activation excludes;
    // `<` is a delayed/pre-submission trade. Both are rejected.
    if (eventSeq <= activation) return reject('sequence_not_after_activation');
    return { eligible: true, basis: 'provider_sequence' };
  }

  // provider_time_watermark — only reachable if a route ever documents the
  // required properties (none does today). It still fails closed on missing
  // authority or malformed/regressing timestamps.
  if (
    !(
      capability.supportsAuthoritativeEventTime &&
      capability.supportsDocumentedFinality
    )
  ) {
    return reject('time_watermark_unsupported');
  }
  const activationMs = parseEventTimeMs(parsed.providerEventAt);
  const eventMs = parseEventTimeMs(event.providerEventAt);
  if (activationMs === null || eventMs === null) {
    return reject('malformed_event_time');
  }
  if (eventMs <= activationMs) return reject('event_time_not_after_activation');
  return { eligible: true, basis: 'provider_time_watermark' };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMode(value: unknown): value is ProviderTradeActivationMode {
  return (
    value === 'provider_sequence' ||
    value === 'provider_time_watermark' ||
    value === 'path_b_only' ||
    value === 'unsupported'
  );
}
