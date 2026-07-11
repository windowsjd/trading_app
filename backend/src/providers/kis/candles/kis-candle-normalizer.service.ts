import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
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

@Injectable()
export class KisCandleNormalizerService {
  normalizeDomesticOneMinuteRows(input: {
    rows: readonly KisRawCandleRow[];
    from: Date;
    to: Date;
    now?: Date;
  }): KisNormalizationResult {
    return this.normalizeRows(input, (raw) => {
      const date = strictString(raw.value.stck_bsop_date);
      const time = strictString(raw.value.stck_cntg_hour);
      const openTime =
        date && time ? zonedDateTimeToUtc(date, time, KOREA_TIME_ZONE) : null;
      return this.parseOhlcv(raw, openTime, {
        open: 'stck_oprc',
        high: 'stck_hgpr',
        low: 'stck_lwpr',
        close: 'stck_prpr',
        volume: 'cntg_vol',
        amount: ['cntg_tr_pbmn', 'tr_pbmn'],
      });
    });
  }

  normalizeUsFiveMinuteRows(input: {
    rows: readonly KisRawCandleRow[];
    from: Date;
    to: Date;
    now?: Date;
  }): KisNormalizationResult & { candles: CanonicalFiveMinuteCandle[] } {
    const normalized = this.normalizeRows(input, (raw) => {
      const date = firstString(raw.value, ['xymd', 'date', 'stck_bsop_date']);
      const time = firstString(raw.value, ['xhms', 'time', 'stck_cntg_hour']);
      const openTime =
        date && time ? zonedDateTimeToUtc(date, time, US_TIME_ZONE) : null;
      if (!openTime) return null;
      const local = getZonedParts(openTime, US_TIME_ZONE);
      const minuteOfDay = local.hour * 60 + local.minute;
      if (
        local.second !== 0 ||
        local.minute % 5 !== 0 ||
        minuteOfDay < 9 * 60 + 30 ||
        minuteOfDay >= 16 * 60
      ) {
        return null;
      }
      return this.parseOhlcv(raw, openTime, {
        open: 'open',
        high: 'high',
        low: 'low',
        close: 'last',
        volume: 'evol',
        amount: ['eamt'],
      });
    });
    const nowMs = (input.now ?? new Date()).getTime();
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
    parser: (row: KisRawCandleRow) => NormalizedKisCandleRow | null,
  ): KisNormalizationResult {
    const fromMs = input.from.getTime();
    const toMs = input.to.getTime();
    const nowMs = (input.now ?? new Date()).getTime();
    const byTimestamp = new Map<number, NormalizedKisCandleRow>();
    let rejectedRows = 0;
    let duplicateRows = 0;

    for (const raw of input.rows) {
      const parsed = parser(raw);
      const time = parsed?.openTime.getTime() ?? Number.NaN;
      if (!parsed || time < fromMs || time >= toMs || time > nowMs) {
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
    return { rows, acceptedRows: rows.length, rejectedRows, duplicateRows };
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
