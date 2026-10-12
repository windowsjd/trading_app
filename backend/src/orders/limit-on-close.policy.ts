import { createApiError } from '../common/api-error';
import { AssetType, OrderSide, type Prisma } from '../generated/prisma/client';
import {
  resolveRegularSessionForEvent,
  resolveStockMarketSessionState,
  type MarketCalendarAsset,
  type MarketSessionWindow,
} from './market-calendar.policy';
import type { LimitOnCloseConfig } from './limit-on-close.config';
import { LIMIT_ORDER_CANCEL_REASONS } from './limit-order-policy';

/** Bumped only when the meaning of a final close evidence row changes. */
export const LOC_EVIDENCE_POLICY_VERSION = 1;

/** LimitOnCloseOrder.decisionReason vocabulary; no-fill reasons are also
 * the Order.cancelReason of the released reservation. */
export const LOC_DECISION_REASONS = {
  closeReached: 'loc_close_reached',
  closeNotReached: LIMIT_ORDER_CANCEL_REASONS.locCloseNotReached,
  evidenceUnavailable: LIMIT_ORDER_CANCEL_REASONS.locCloseEvidenceUnavailable,
  sessionInvalid: LIMIT_ORDER_CANCEL_REASONS.locSessionInvalid,
  fillNotPermitted: LIMIT_ORDER_CANCEL_REASONS.locFillNotPermitted,
} as const;

export type LimitOnCloseDecision = 'fill' | 'not_reached';

/**
 * Market-neutral virtual LOC rule. BUY fills when the final regular-session
 * close is at or below the limit; SELL (reserved for a later sell rework)
 * fills when it is at or above. Equality fills on both sides. The execution
 * price is always the close itself, never the limit.
 */
export function decideLimitOnClose(
  side: OrderSide,
  limitPrice: Prisma.Decimal,
  closePrice: Prisma.Decimal,
): LimitOnCloseDecision {
  if (!closePrice.isFinite() || closePrice.lte(0) || limitPrice.lte(0))
    return 'not_reached';
  return (
    side === OrderSide.buy
      ? closePrice.lte(limitPrice)
      : closePrice.gte(limitPrice)
  )
    ? 'fill'
    : 'not_reached';
}

/**
 * The evidence deadline also bounds the fill itself: at or after it no LOC
 * fill may commit, even with final close evidence (the order then expires as
 * `loc_fill_not_permitted`). Judged at the fill transaction's DB clock.
 */
export function limitOnCloseDeadlinePassed(
  now: Date,
  evidenceDeadlineAt: Date,
): boolean {
  return now.getTime() >= evidenceDeadlineAt.getTime();
}

export type LimitOnCloseRegistration = {
  market: 'KRX' | 'US';
  session: MarketSessionWindow;
  sessionDate: Date;
  evidenceDeadlineAt: Date;
};

/**
 * Registration rule shared by the quote courtesy check and the post-lock
 * create check. Only KRX stocks are enabled; US stocks wait for a confirmed
 * closing-price data provider and crypto has no LOC. The order binds to the
 * regular session OPEN at the DB clock and must close before Season end.
 */
export function resolveLimitOnCloseRegistration(input: {
  asset: MarketCalendarAsset;
  now: Date;
  seasonEndAt: Date | null;
  config: LimitOnCloseConfig;
}): LimitOnCloseRegistration {
  if (input.asset.assetType !== AssetType.domestic_stock)
    throw createApiError(
      'LOC_MARKET_NOT_SUPPORTED',
      'Limit-on-Close is available only for Korean stocks.',
      409,
    );
  const state = resolveStockMarketSessionState(input.asset, input.now);
  if (!state || state.state === 'calendar_unavailable')
    throw createApiError(
      'MARKET_CALENDAR_UNAVAILABLE',
      'Market calendar is unavailable.',
      409,
    );
  if (state.state !== 'open')
    throw createApiError(
      'LOC_SESSION_NOT_OPEN',
      'Limit-on-Close orders are accepted only during the regular session.',
      409,
    );
  const session = state.currentSession;
  if (input.seasonEndAt && input.seasonEndAt <= session.closeTime)
    throw createApiError(
      'LOC_SESSION_AFTER_SEASON_END',
      'The session closes after the Season ends.',
      409,
    );
  return {
    market: state.market,
    session,
    sessionDate: sessionDateValue(session.localDate),
    evidenceDeadlineAt: new Date(
      session.closeTime.getTime() + input.config.evidenceDeadlineMs,
    ),
  };
}

/**
 * Settlement-time binding. The CURRENT calendar (overrides included) must
 * still place the submission inside a regular session of the bound date; a
 * later closure or early close before the submission invalidates the order.
 */
export function resolveBoundLimitOnCloseSession(
  asset: MarketCalendarAsset,
  submittedAt: Date,
  sessionDate: Date,
): MarketSessionWindow | null {
  const session = resolveRegularSessionForEvent(asset, submittedAt);
  return session && session.localDate === sessionDateText(sessionDate)
    ? session
    : null;
}

/** `YYYY-MM-DD` exchange-local date ↔ PostgreSQL DATE (UTC midnight). */
export function sessionDateValue(localDate: string): Date {
  return new Date(`${localDate}T00:00:00.000Z`);
}

export function sessionDateText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export type CloseEvidenceRowState = {
  status: 'observing' | 'final';
  closePrice: Prisma.Decimal;
  firstObservedAt: Date;
  lastObservedAt: Date;
} | null;

export type CloseEvidenceTransition =
  | 'create'
  | 'extend'
  | 'finalize'
  | 'replace'
  | 'ignore';

/**
 * Finality is stability, not a single read: the same dated close must be
 * observed again at least `confirmMs` after its first post-close observation.
 * A different value restarts the confirmation. Final rows never change and
 * out-of-order observations are ignored.
 */
export function nextCloseEvidenceTransition(
  existing: CloseEvidenceRowState,
  observation: { closePrice: Prisma.Decimal; observedAt: Date },
  confirmMs: number,
): CloseEvidenceTransition {
  if (!existing) return 'create';
  if (existing.status === 'final') return 'ignore';
  if (observation.observedAt <= existing.lastObservedAt) return 'ignore';
  if (!observation.closePrice.eq(existing.closePrice)) return 'replace';
  return observation.observedAt.getTime() -
    existing.firstObservedAt.getTime() >=
    confirmMs
    ? 'finalize'
    : 'extend';
}
