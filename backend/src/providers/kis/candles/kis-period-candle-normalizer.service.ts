import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  findLastMarketSessionOfWeek,
  resolveMarketSession,
} from '../../../orders/market-calendar.policy';
import type { KisRawCandleRow } from './kis-candle.types';
import {
  type CanonicalPeriodCandle,
  type KisPeriodInterval,
  type KisPeriodNormalizationResult,
} from './kis-period-candle.types';
import { zonedDateTimeToUtc } from './kis-candle-time';

const KOREA_TIME_ZONE = 'Asia/Seoul';
const US_TIME_ZONE = 'America/New_York';
type PeriodMarket = {
  timeZone: string;
  calendarMarket: 'KRX' | 'US';
  fields: {
    date: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    amount: readonly string[];
  };
};

const DOMESTIC_MARKET: PeriodMarket = {
  timeZone: KOREA_TIME_ZONE,
  calendarMarket: 'KRX',
  fields: {
    date: 'stck_bsop_date',
    open: 'stck_oprc',
    high: 'stck_hgpr',
    low: 'stck_lwpr',
    close: 'stck_clpr',
    volume: 'acml_vol',
    amount: ['acml_tr_pbmn'],
  },
};

const OVERSEAS_MARKET: PeriodMarket = {
  timeZone: US_TIME_ZONE,
  calendarMarket: 'US',
  fields: {
    date: 'xymd',
    open: 'open',
    high: 'high',
    low: 'low',
    close: 'clos',
    volume: 'tvol',
    amount: ['tamt'],
  },
};

/**
 * Strict normalizer for provider-native KIS daily/weekly rows.
 *
 * Daily candles cover the local trading date: openTime is local midnight of
 * the reported date and closeTime the next local midnight (DST-length days in
 * America/New_York come out as 23h/25h windows via the IANA timezone).
 * Weekly candles are anchored to the Monday of the ISO week containing the
 * reported date, regardless of whether the provider reports the week's first
 * or last trading day, so re-syncs of the same week always hit the same
 * (assetId, interval, openTime) row.
 *
 * A row is accepted when its window intersects [from, to) and its openTime is
 * not in the future. Nothing is synthesized: malformed OHLCV rows are
 * rejected, a missing amount stays null, and missing trading days are simply
 * absent.
 */
@Injectable()
export class KisPeriodCandleNormalizerService {
  normalizeDomesticPeriodRows(input: {
    rows: readonly KisRawCandleRow[];
    interval: KisPeriodInterval;
    from: Date;
    to: Date;
    now?: Date;
  }): KisPeriodNormalizationResult {
    return this.normalize(input, DOMESTIC_MARKET);
  }

  normalizeOverseasPeriodRows(input: {
    rows: readonly KisRawCandleRow[];
    interval: KisPeriodInterval;
    from: Date;
    to: Date;
    now?: Date;
  }): KisPeriodNormalizationResult {
    return this.normalize(input, OVERSEAS_MARKET);
  }

  private normalize(
    input: {
      rows: readonly KisRawCandleRow[];
      interval: KisPeriodInterval;
      from: Date;
      to: Date;
      now?: Date;
    },
    market: PeriodMarket,
  ): KisPeriodNormalizationResult {
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const fromMs = input.from.getTime();
    const toMs = input.to.getTime();
    const byOpenTime = new Map<
      number,
      CanonicalPeriodCandle & { receivedAtMs: number }
    >();
    let rejectedRows = 0;
    let duplicateRows = 0;

    for (const raw of input.rows) {
      const parsed = this.parseRow(raw, input.interval, market, nowMs);
      if (
        !parsed ||
        parsed.openTime.getTime() >= toMs ||
        parsed.closeTime.getTime() <= fromMs ||
        parsed.openTime.getTime() > nowMs
      ) {
        rejectedRows += 1;
        continue;
      }
      const key = parsed.openTime.getTime();
      const existing = byOpenTime.get(key);
      if (existing) {
        duplicateRows += 1;
        if (parsed.receivedAtMs >= existing.receivedAtMs) {
          byOpenTime.set(key, parsed);
        }
        continue;
      }
      byOpenTime.set(key, parsed);
    }

    const candles = [...byOpenTime.values()]
      .sort((left, right) => left.openTime.getTime() - right.openTime.getTime())
      .map((row) => {
        const candle = { ...row } as Partial<typeof row>;
        delete candle.receivedAtMs;
        return candle as CanonicalPeriodCandle;
      });
    return {
      candles,
      acceptedRows: candles.length,
      rejectedRows,
      duplicateRows,
    };
  }

  private parseRow(
    raw: KisRawCandleRow,
    interval: KisPeriodInterval,
    market: PeriodMarket,
    nowMs: number,
  ): (CanonicalPeriodCandle & { receivedAtMs: number }) | null {
    const dateText = strictString(raw.value[market.fields.date]);
    if (!dateText || !/^\d{8}$/u.test(dateText)) return null;
    const window = resolvePeriodWindow(dateText, interval, market);
    if (!window) return null;

    const open = decimal(raw.value[market.fields.open]);
    const high = decimal(raw.value[market.fields.high]);
    const low = decimal(raw.value[market.fields.low]);
    const close = decimal(raw.value[market.fields.close]);
    const volume = decimal(raw.value[market.fields.volume]);
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
    const rawAmount = market.fields.amount
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
      openTime: window.openTime,
      closeTime: window.closeTime,
      open,
      high,
      low,
      close,
      volume,
      amount,
      isClosed: window.closedAt.getTime() <= nowMs,
      sourceUpdatedAt: raw.receivedAt,
      receivedAtMs: raw.receivedAt.getTime(),
    };
  }
}

type PeriodWindow = {
  openTime: Date;
  closeTime: Date;
  // Instant after which the candle counts as closed (actual session end of
  // the trading date, or the week's last real session end).
  closedAt: Date;
};

function resolvePeriodWindow(
  dateText: string,
  interval: KisPeriodInterval,
  market: PeriodMarket,
): PeriodWindow | null {
  if (interval === '1d') {
    const session = resolveMarketSession(market.calendarMarket, dateText);
    if (!session) return null;
    const openTime = zonedDateTimeToUtc(dateText, '000000', market.timeZone);
    const nextDate = addDaysToYmd(dateText, 1);
    const closeTime = nextDate
      ? zonedDateTimeToUtc(nextDate, '000000', market.timeZone)
      : null;
    const closedAt = session.closeTime;
    if (!openTime || !closeTime || !closedAt) return null;
    return { openTime, closeTime, closedAt };
  }

  const monday = mondayOfWeek(dateText);
  if (!monday) return null;
  const nextMonday = addDaysToYmd(monday, 7);
  const openTime = zonedDateTimeToUtc(monday, '000000', market.timeZone);
  const closeTime = nextMonday
    ? zonedDateTimeToUtc(nextMonday, '000000', market.timeZone)
    : null;
  const closedAt = findLastMarketSessionOfWeek(
    market.calendarMarket,
    dateText,
  )?.closeTime;
  if (!openTime || !closeTime || !closedAt) return null;
  return { openTime, closeTime, closedAt };
}

function mondayOfWeek(dateText: string): string | null {
  const utcMs = ymdToUtcMs(dateText);
  if (utcMs === null) return null;
  const dayOfWeek = new Date(utcMs).getUTCDay();
  const mondayOffset = (dayOfWeek + 6) % 7;
  return formatUtcMsAsYmd(utcMs - mondayOffset * 86_400_000);
}

function addDaysToYmd(dateText: string, days: number): string | null {
  const utcMs = ymdToUtcMs(dateText);
  if (utcMs === null) return null;
  return formatUtcMsAsYmd(utcMs + days * 86_400_000);
}

function ymdToUtcMs(dateText: string): number | null {
  if (!/^\d{8}$/u.test(dateText)) return null;
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6));
  const day = Number(dateText.slice(6, 8));
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  return check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
    ? ms
    : null;
}

function formatUtcMsAsYmd(utcMs: number): string {
  const date = new Date(utcMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}`;
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
