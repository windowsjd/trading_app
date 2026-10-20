import Decimal from 'decimal.js';
import { isPreviewFxAvailable } from '../tradingAccount/indicativePreview.ts';
import type { FxRateDto } from '../wallet/api';
import { formatKrwDecimal, formatPercent } from '../../utils/format.ts';
import type { FuturesCandles, FuturesChartWindow, FuturesInstrument } from './api';

/**
 * Display rules of the futures contract detail (2026-10-20), the asset detail's
 * layout over a contract. Display only: nothing here prices an order, a margin
 * or a settlement, and the contract keeps trading and settling in USD.
 */

/** A futures day: 00:00 to 24:00 UTC, the grid of the contract's own 1d klines. */
const UTC_DAY_MS = 86_400_000;

/**
 * 전일대비's read: the contract's 1d chart route and window (the server's
 * shared 1d cache), only its newest two buckets. A settled previous UTC day is
 * always one of them — only today's bucket can follow it.
 */
export const FUTURES_PREVIOUS_DAY_WINDOW: FuturesChartWindow = { interval: '1d', range: '1y', limit: 2 };
/** How soon a detail still without that settled close asks again (with it: the 1d chart's cadence). */
export const FUTURES_PREVIOUS_DAY_RETRY_MS = 15_000;

/** Open of the UTC day before the one containing `serverNow` (that day's 1d kline time). */
export function futuresPreviousUtcDayStart(serverNow: number): number {
  return Math.floor(serverNow / UTC_DAY_MS) * UTC_DAY_MS - UTC_DAY_MS;
}

/**
 * The close of THIS contract's own settled 1d kline (contract trade price,
 * never Mark, Index or Spot) for the UTC day before `serverNow`, or null: a
 * read of another contract or interval, a read not received after that day
 * ended (its own `fetchedAt`), a provisional bucket, or no bucket for exactly
 * that day (an older day never stands in) leaves 전일대비 unknown.
 */
export function futuresPreviousDayClose(
  daily: FuturesCandles | undefined,
  instrument: Pick<FuturesInstrument, 'id' | 'underlying'> | undefined,
  serverNow: number,
): Decimal | null {
  if (!daily || !instrument) return null;
  const symbol = instrument.underlying.symbol;
  if (
    daily.instrument.id !== instrument.id ||
    daily.instrument.symbol !== symbol ||
    daily.source.symbol !== symbol ||
    daily.interval !== '1d' ||
    daily.priceBasis !== 'contract_last_trade' ||
    daily.source.provider !== 'binance_usdm' ||
    daily.source.contractType !== 'PERPETUAL'
  ) {
    return null;
  }
  const dayStart = futuresPreviousUtcDayStart(serverNow);
  if (!(Date.parse(daily.source.fetchedAt ?? '') >= dayStart + UTC_DAY_MS)) return null;
  const day = daily.candles.filter((candle) => Date.parse(candle.time) === dayStart);
  return day.length === 1 && day[0].provisional === false ? positiveDecimal(day[0].close) : null;
}

/**
 * 전일대비 (%): the fresh Futures Last against the previous UTC day's settled
 * close of the same contract, both in USD (a won display never mixes the
 * USD/KRW rate in). Null — shown as `-`, never 0% — without either price.
 * Never Binance's rolling 24h ticker.
 */
export function futuresPreviousDayChange(input: {
  last: string | null;
  lastFresh: boolean;
  previousClose: Decimal | null;
}): Decimal | null {
  const last = input.lastFresh ? positiveDecimal(input.last) : null;
  if (!last || !input.previousClose) return null;
  return last.minus(input.previousClose).div(input.previousClose).times(100);
}

/** `전일대비 +2.35%` in the asset detail's words and percent format, or `전일대비 -` while unknown. */
export function futuresPreviousDayChangeLabel(change: Decimal | null): string {
  if (!change) return '전일대비 -';
  const text = formatPercent(change.toString());
  return `전일대비 ${change.gt(0) ? '+' : ''}${text}%`;
}

function positiveDecimal(value: string | null): Decimal | null {
  if (!value) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
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
