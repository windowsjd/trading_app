import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { resolveMarketSession } from '../../../orders/market-calendar.policy';
import {
  type CanonicalFiveMinuteCandle,
  type KisNormalizationResult,
  type KisRawCandleRow,
  type NormalizedKisCandleRow,
} from './kis-candle.types';
import { getZonedParts, zonedDateTimeToUtc } from './kis-candle-time';

const KOREA_TIME_ZONE = 'Asia/Seoul';
const US_TIME_ZONE = 'America/New_York';
const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * Per-row classification. Benign exclusions and integrity failures are kept
 * apart because only the latter make a fetched range data-incomplete:
 * - excluded: pre-market/after-hours/holiday/weekend rows (per the audited
 *   market calendar), rows outside the requested range, future rows (the
 *   bucket has not opened yet), and in-progress buckets whose OHLCV has not
 *   finished forming — the provider legitimately returns them and they carry
 *   no completeness signal.
 * - integrity_failed: observable regular-session corruption — an unparsable
 *   timestamp (fail-safe: it cannot be proven benign), a regular-session
 *   timestamp off the 5-minute grid, or malformed OHLCV in a CLOSED bucket.
 *   Malformed OHLCV in a still-open bucket is a benign in-progress exclusion,
 *   not corruption; the same bucket becomes an integrity failure once it has
 *   closed and the provider still returns it malformed.
 */
type KisRowClassification =
  | { state: 'accepted'; row: NormalizedKisCandleRow }
  | { state: 'excluded' }
  | { state: 'integrity_failed' };

@Injectable()
export class KisCandleNormalizerService {
  normalizeDomesticOneMinuteRows(input: {
    rows: readonly KisRawCandleRow[];
    from: Date;
    to: Date;
    now?: Date;
  }): KisNormalizationResult {
    // Domestic data completeness is measured downstream by the five-minute
    // builder (incompleteBuckets from 1m coverage), so malformed domestic
    // rows stay plain rejections here: a dropped 1m row surfaces as an
    // incomplete bucket, never as a silently complete range.
    return this.normalizeRows(input, (raw) => {
      const date = strictString(raw.value.stck_bsop_date);
      const time = strictString(raw.value.stck_cntg_hour);
      const openTime =
        date && time ? zonedDateTimeToUtc(date, time, KOREA_TIME_ZONE) : null;
      const row = this.parseOhlcv(raw, openTime, {
        open: 'stck_oprc',
        high: 'stck_hgpr',
        low: 'stck_lwpr',
        close: 'stck_prpr',
        volume: 'cntg_vol',
        amount: ['cntg_tr_pbmn', 'tr_pbmn'],
      });
      return row ? { state: 'accepted', row } : { state: 'excluded' };
    });
  }

  normalizeUsFiveMinuteRows(input: {
    rows: readonly KisRawCandleRow[];
    from: Date;
    to: Date;
    now?: Date;
  }): KisNormalizationResult & { candles: CanonicalFiveMinuteCandle[] } {
    const fromMs = input.from.getTime();
    const toMs = input.to.getTime();
    const nowMs = (input.now ?? new Date()).getTime();
    // The audited market calendar decides the regular session per local
    // date (weekends, holidays, early closes, delayed opens, and DST come
    // from the calendar + IANA time zone — nothing is re-hardcoded here).
    // A date without a session (closed day, or an uncovered calendar year,
    // which fails safe to "no session") has no regular-session rows at all.
    const sessionByLocalDate = new Map<
      string,
      ReturnType<typeof resolveMarketSession>
    >();
    const normalized = this.normalizeRows(input, (raw) => {
      const date = firstString(raw.value, ['xymd', 'date', 'stck_bsop_date']);
      const time = firstString(raw.value, ['xhms', 'time', 'stck_cntg_hour']);
      const openTime =
        date && time ? zonedDateTimeToUtc(date, time, US_TIME_ZONE) : null;
      // Unparsable timestamps are observable provider corruption: they
      // cannot be proven benign, so they count against completeness.
      if (!openTime) return { state: 'integrity_failed' };
      const openMs = openTime.getTime();
      // Out of the requested range or in the future (bucket not yet open):
      // benign — irrelevant to this range's completeness. In-progress buckets
      // (already open, not yet closed) fall through: they are accepted when
      // valid and benignly excluded when their OHLCV has not finished forming.
      if (openMs < fromMs || openMs >= toMs || openMs > nowMs) {
        return { state: 'excluded' };
      }
      const local = getZonedParts(openTime, US_TIME_ZONE);
      const localDate = `${local.year}${String(local.month).padStart(2, '0')}${String(local.day).padStart(2, '0')}`;
      let session = sessionByLocalDate.get(localDate);
      if (session === undefined) {
        session = resolveMarketSession('US', localDate);
        sessionByLocalDate.set(localDate, session);
      }
      // Pre-market/after-hours (including the tail after an early close)
      // and closed days: benign exclusions.
      if (
        !session ||
        openMs < session.openTime.getTime() ||
        openMs >= session.closeTime.getTime()
      ) {
        return { state: 'excluded' };
      }
      // Inside the regular session the provider contract is 5-minute-grid
      // buckets; an off-grid timestamp is corrupt data regardless of whether
      // the bucket has closed (its true boundary is unknowable), so it always
      // fails integrity.
      if (local.second !== 0 || local.minute % 5 !== 0) {
        return { state: 'integrity_failed' };
      }
      const row = this.parseOhlcv(raw, openTime, {
        open: 'open',
        high: 'high',
        low: 'low',
        close: 'last',
        volume: 'evol',
        amount: ['eamt'],
      });
      if (row) return { state: 'accepted', row };
      // Strict OHLCV validation failed. The row is dropped either way (never
      // repaired or synthesized), but its completeness meaning depends on
      // whether the bucket has closed:
      // - a CLOSED regular-session bucket with malformed OHLCV is an
      //   observable hole -> integrity_failed (the range must not be declared
      //   complete);
      // - an IN-PROGRESS bucket whose OHLCV has not finished forming is a
      //   benign in-progress exclusion -> not stored, not counted against
      //   completeness, and never fails a historical range.
      const closed = openMs + FIVE_MINUTES_MS <= nowMs;
      return closed ? { state: 'integrity_failed' } : { state: 'excluded' };
    });
    return {
      ...normalized,
      candles: normalized.rows.map((row) => ({
        ...row,
        closeTime: new Date(row.openTime.getTime() + FIVE_MINUTES_MS),
        isClosed: row.openTime.getTime() + FIVE_MINUTES_MS <= nowMs,
      })),
    };
  }

  private normalizeRows(
    input: {
      rows: readonly KisRawCandleRow[];
      from: Date;
      to: Date;
      now?: Date;
    },
    classify: (row: KisRawCandleRow) => KisRowClassification,
  ): KisNormalizationResult {
    const fromMs = input.from.getTime();
    const toMs = input.to.getTime();
    const nowMs = (input.now ?? new Date()).getTime();
    const byTimestamp = new Map<number, NormalizedKisCandleRow>();
    let rejectedRows = 0;
    let integrityFailedRows = 0;
    let duplicateRows = 0;

    for (const raw of input.rows) {
      const classified = classify(raw);
      if (classified.state !== 'accepted') {
        rejectedRows += 1;
        if (classified.state === 'integrity_failed') integrityFailedRows += 1;
        continue;
      }
      const parsed = classified.row;
      const time = parsed.openTime.getTime();
      if (time < fromMs || time >= toMs || time > nowMs) {
        rejectedRows += 1;
        continue;
      }
      const existing = byTimestamp.get(time);
      if (existing) {
        duplicateRows += 1;
        if (
          parsed.sourceUpdatedAt.getTime() > existing.sourceUpdatedAt.getTime()
        ) {
          byTimestamp.set(time, parsed);
        }
      } else {
        byTimestamp.set(time, parsed);
      }
    }
    const rows = [...byTimestamp.values()].sort(
      (left, right) => left.openTime.getTime() - right.openTime.getTime(),
    );
    return {
      rows,
      acceptedRows: rows.length,
      rejectedRows,
      integrityFailedRows,
      duplicateRows,
    };
  }

  private parseOhlcv(
    raw: KisRawCandleRow,
    openTime: Date | null,
    fields: {
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      amount: readonly string[];
    },
  ): NormalizedKisCandleRow | null {
    if (!openTime) return null;
    const open = decimal(raw.value[fields.open]);
    const high = decimal(raw.value[fields.high]);
    const low = decimal(raw.value[fields.low]);
    const close = decimal(raw.value[fields.close]);
    const volume = decimal(raw.value[fields.volume]);
    if (
      !open ||
      !high ||
      !low ||
      !close ||
      !volume ||
      !open.gt(0) ||
      !high.gt(0) ||
      !low.gt(0) ||
      !close.gt(0) ||
      volume.lt(0) ||
      high.lt(open) ||
      high.lt(close) ||
      high.lt(low) ||
      low.gt(open) ||
      low.gt(close)
    ) {
      return null;
    }
    const rawAmount = fields.amount
      .map((field) => raw.value[field])
      .find(
        (value) =>
          value !== undefined &&
          value !== null &&
          !(typeof value === 'string' && value.trim() === ''),
      );
    const amount = rawAmount === undefined ? null : decimal(rawAmount);
    if (rawAmount !== undefined && (!amount || amount.lt(0))) return null;
    return {
      openTime,
      open,
      high,
      low,
      close,
      volume,
      amount,
      sourceUpdatedAt: raw.receivedAt,
    };
  }
}

function decimal(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) return null;
  try {
    const parsed = new Prisma.Decimal(text);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function strictString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstString(
  value: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const result = strictString(value[field]);
    if (result) return result;
  }
  return null;
}
