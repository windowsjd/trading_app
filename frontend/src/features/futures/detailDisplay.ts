import Decimal from 'decimal.js';
import { isPreviewFxAvailable } from '../tradingAccount/indicativePreview.ts';
import type { FxRateDto } from '../wallet/api';
import { formatKrwDecimal, formatPercent } from '../../utils/format.ts';
import type { FuturesMarketStats } from './api';

/**
 * Display rules of the futures contract detail (2026-10-20), the asset detail's
 * layout over a contract. Display only: nothing here prices an order, a margin
 * or a settlement, and the contract keeps trading and settling in USD.
 */

/** The server's own window for the 24h ticker (futures-market-data.ts). */
export const FUTURES_DAY_CHANGE_MAX_AGE_MS = 60_000;
const FUTURES_DAY_CHANGE_MAX_FUTURE_MS = 5_000;

/**
 * The contract's rolling 24h change (Binance's own ticker of THIS contract),
 * while the read that carried it is still current on the server clock. Never
 * labelled "전일 대비": it is a rolling 24 hours, not a session change.
 */
export function futuresDayChange(
  stats: FuturesMarketStats | undefined,
  serverNow: number,
): Decimal | null {
  if (stats?.state !== 'available') return null;
  const received = Date.parse(stats.receivedAt);
  const age = serverNow - received;
  if (
    !Number.isFinite(received) ||
    age > FUTURES_DAY_CHANGE_MAX_AGE_MS ||
    age < -FUTURES_DAY_CHANGE_MAX_FUTURE_MS
  ) {
    return null;
  }
  try {
    const value = new Decimal(stats.priceChangePercent);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
}

/** `24시간 변동률 +2.35%`, or `24시간 변동률 -` while unknown. */
export function futuresDayChangeLabel(change: Decimal | null): string {
  if (!change) return '24시간 변동률 -';
  const text = formatPercent(change.toString());
  return `24시간 변동률 ${change.gt(0) ? '+' : ''}${text}%`;
}

/**
 * The fresh Futures Last in won at a current USD/KRW rate, or null: a stale
 * Last or an unavailable/expired rate never produces a won figure.
 */
export function futuresKrwPrice(input: {
  last: string | null;
  lastFresh: boolean;
  fxRate: FxRateDto | null | undefined;
  now: number;
}): string | null {
  if (!input.last || !input.lastFresh) return null;
  if (!isPreviewFxAvailable(input.fxRate, input.now)) return null;
  try {
    const won = new Decimal(input.last).mul(input.fxRate.rate);
    return won.isFinite() && won.gt(0) ? `${formatKrwDecimal(won.toFixed(0))}원` : null;
  } catch {
    return null;
  }
}
