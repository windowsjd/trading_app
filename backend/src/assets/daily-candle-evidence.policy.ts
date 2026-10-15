import type { Prisma } from '../generated/prisma/client';
import { KIS_DOMESTIC_PERIOD_SOURCE } from '../providers/kis/candles/kis-period-candle.types';
import { KOSCOM_HISTORY_SOURCE } from '../providers/koscom/koscom.config';

/** A stored 1d row as the daily audit and the G4-H gate read it. */
export type DailyCandleEvidenceRow = {
  sourceProvider: string;
  isClosed: boolean;
  closeTime: Date;
  sourceUpdatedAt: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal | null;
};

/** One trading date's daily window: [00:00, next 00:00) local, closed at the session close. */
export type DailyCandleWindow = {
  openTime: Date;
  closeTime: Date;
  closedAt: Date;
};

export type DailyCandleDefect =
  | 'source'
  | 'not_closed'
  | 'close_time'
  | 'updated_before_close'
  | 'updated_after_observation'
  | 'ohlcv';

/**
 * Why a stored 1d row does not confirm its window (empty = confirmed), the
 * daily audit's rule: the run's source — a closed KIS period row also counts
 * for a KOSCOM history run, since closed KIS rows are never overwritten —
 * closed, the window's exact close, received after the session close and
 * not after the observation, and sane OHLCV.
 */
export function dailyCandleDefects(
  row: DailyCandleEvidenceRow,
  window: DailyCandleWindow,
  expected: { sourceProvider: string; observedAt: Date },
): DailyCandleDefect[] {
  const defects: DailyCandleDefect[] = [];
  if (
    row.sourceProvider !== expected.sourceProvider &&
    !(
      expected.sourceProvider === KOSCOM_HISTORY_SOURCE &&
      row.sourceProvider === KIS_DOMESTIC_PERIOD_SOURCE
    )
  )
    defects.push('source');
  if (!row.isClosed) defects.push('not_closed');
  if (row.closeTime.getTime() !== window.closeTime.getTime())
    defects.push('close_time');
  if (
    !Number.isFinite(row.sourceUpdatedAt.getTime()) ||
    row.sourceUpdatedAt < window.closedAt
  )
    defects.push('updated_before_close');
  else if (row.sourceUpdatedAt > expected.observedAt)
    defects.push('updated_after_observation');
  if (
    !(
      [row.open, row.high, row.low, row.close].every(
        (value) => value.isFinite() && value.gt(0),
      ) &&
      row.high.gte(row.open) &&
      row.high.gte(row.close) &&
      row.high.gte(row.low) &&
      row.low.lte(row.open) &&
      row.low.lte(row.close) &&
      row.volume.isFinite() &&
      row.volume.gte(0) &&
      (row.amount === null || (row.amount.isFinite() && row.amount.gte(0)))
    )
  )
    defects.push('ohlcv');
  return defects;
}
