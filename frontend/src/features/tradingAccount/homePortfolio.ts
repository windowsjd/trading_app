import Decimal from 'decimal.js';
import type { PositionItemDto } from '../position/api';
import type { FuturesPosition } from '../futures/api';
import type { FxRateDto } from '../wallet/api';
import type { TradingAccountPortfolioSummaryDto } from './api';
import { futuresHolding, getFuturesPositionDisplay } from '../futures/positionDisplay.ts';
import { FX_RATE_FALLBACK_INTERVAL_MS } from '../wallet/fxRateUpdates.ts';
import { isPreviewFxAvailable } from './indicativePreview.ts';

/**
 * Home's combined spot + futures presentation. Display only: every amount is a
 * server value, nothing here feeds total assets, return rate or an order.
 */

// Enough significant digits that adding two scale-8 money strings is exact.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const SIGNED_MONEY = /^-?\d+(\.\d+)?$/u;
const AMOUNT = /^\d+(\.\d+)?$/u;

/**
 * Home's 평가 손익: spot unrealized PnL plus futures Mark unrealized PnL. The
 * valuation sums them separately (spot positions vs futures positions) and
 * total assets already include both, so adding them double-counts nothing.
 * A missing or malformed part makes the total unknown, never zero.
 */
export function homeUnrealizedPnlKrw(
  summary: Pick<TradingAccountPortfolioSummaryDto, 'unrealizedPnlKrw' | 'futuresUnrealizedPnlKrw'>,
): string | null {
  const parts = [summary.unrealizedPnlKrw, summary.futuresUnrealizedPnlKrw];
  if (!parts.every((part): part is string => typeof part === 'string' && SIGNED_MONEY.test(part))) return null;
  return parts.reduce((sum, part) => sum.add(part), new D(0)).toFixed(8);
}

export type HomeHoldingEntry =
  | { kind: 'spot'; key: string; position: PositionItemDto }
  | { kind: 'futures'; key: string; position: FuturesPosition };

export type HomeHoldingsOrder = {
  entries: HomeHoldingEntry[];
  /** The first entry has an amount that was compared with every other amount. */
  topComparable: boolean;
  /** Valued spot and fresh futures exist but no usable USD/KRW rate joins them. */
  futuresUncompared: boolean;
};

/** The spot row's own KRW value (live or the server's cached valuation). */
function spotValueKrw(position: PositionItemDto) {
  const { valuation } = position;
  return valuation.state !== 'unavailable' && AMOUNT.test(valuation.positionValueKrw ?? '')
    ? new D(valuation.positionValueKrw) : null;
}

/** The futures row's own Mark notional (USD), only while the row shows it. */
function futuresNotionalUsd(position: FuturesPosition, evaluatedAt: string | undefined, now: number) {
  const notional = position.markNotional;
  return getFuturesPositionDisplay(futuresHolding(position), evaluatedAt, now).fresh && notional && AMOUNT.test(notional)
    ? new D(notional) : null;
}

/**
 * One list, largest amount first: spot by the server's KRW position value,
 * futures by Mark notional converted with the current USD/KRW rate. The
 * notional only orders rows; it is not equity and never margin.
 *
 * Amounts are compared only in one currency. Without a usable rate, fresh
 * futures follow the valued spot rows (ordered among themselves in USD) and
 * `futuresUncompared` says so. Rows without a shown amount keep the server
 * order at the end. Ties keep spot before futures, each in server order.
 */
export function orderHomeHoldings(input: {
  spot: readonly PositionItemDto[];
  futures: readonly FuturesPosition[];
  futuresEvaluatedAt: string | undefined;
  usdKrw: FxRateDto | null | undefined;
  now: number;
}): HomeHoldingsOrder {
  const rate = input.usdKrw && isPreviewFxAvailable(input.usdKrw, input.now) ? new D(input.usdKrw.rate) : null;
  type Ranked = { entry: HomeHoldingEntry; value: Decimal };
  const krw: Ranked[] = [], usd: Ranked[] = [], unvalued: HomeHoldingEntry[] = [];
  for (const position of input.spot) {
    const entry: HomeHoldingEntry = { kind: 'spot', key: `spot:${position.positionId}`, position };
    const value = spotValueKrw(position);
    if (value) krw.push({ entry, value }); else unvalued.push(entry);
  }
  for (const position of input.futures) {
    const entry: HomeHoldingEntry = { kind: 'futures', key: `futures:${position.id}`, position };
    const notional = futuresNotionalUsd(position, input.futuresEvaluatedAt, input.now);
    if (!notional) unvalued.push(entry);
    else if (rate) krw.push({ entry, value: notional.mul(rate) });
    else usd.push({ entry, value: notional });
  }
  // Array sort is stable, so equal amounts keep their input order.
  const ranked = (rows: Ranked[]) => rows.sort((a, b) => b.value.cmp(a.value)).map(row => row.entry);
  const futuresUncompared = krw.length > 0 && usd.length > 0;
  return {
    entries: [...ranked(krw), ...ranked(usd), ...unvalued],
    topComparable: !futuresUncompared && (krw.length > 0 || usd.length > 0),
    futuresUncompared,
  };
}

/** Re-read the rate just after its display validity ends, like the wallet. */
export function usdKrwRefetchDelay(validUntil: string | undefined, now: number) {
  const resyncAt = Date.parse(validUntil ?? '') + 1_001;
  return Number.isFinite(resyncAt) && resyncAt > now
    ? Math.min(resyncAt - now, FX_RATE_FALLBACK_INTERVAL_MS) : FX_RATE_FALLBACK_INTERVAL_MS;
}
