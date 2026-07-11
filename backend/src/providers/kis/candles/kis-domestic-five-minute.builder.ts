import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  KisDomesticBuildResult,
  NormalizedKisCandleRow,
} from './kis-candle.types';
import { getZonedParts, zonedDateTimeToUtc } from './kis-candle-time';

const TIME_ZONE = 'Asia/Seoul';
const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;

@Injectable()
export class KisDomesticFiveMinuteBuilder {
  build(input: {
    rows: readonly NormalizedKisCandleRow[];
    now?: Date;
  }): KisDomesticBuildResult {
    const buckets = new Map<number, NormalizedKisCandleRow[]>();
    const rejectedBucketKeys = new Set<string>();
    const uniqueRows = new Map<number, NormalizedKisCandleRow>();
    for (const row of input.rows) {
      const time = row.openTime.getTime();
      const existing = uniqueRows.get(time);
      if (
        !existing ||
        row.sourceUpdatedAt.getTime() > existing.sourceUpdatedAt.getTime()
      ) {
        uniqueRows.set(time, row);
      }
    }
    for (const row of uniqueRows.values()) {
      const local = getZonedParts(row.openTime, TIME_ZONE);
      const minuteOfDay = local.hour * 60 + local.minute;
      if (
        local.second !== 0 ||
        minuteOfDay < 9 * 60 ||
        minuteOfDay >= 15 * 60 + 30
      ) {
        rejectedBucketKeys.add(
          `${local.year}-${local.month}-${local.day}:${local.hour}:${Math.floor(local.minute / 5)}`,
        );
        continue;
      }
      const bucketMinute = minuteOfDay - ((minuteOfDay - 9 * 60) % 5);
      const date = `${local.year}${String(local.month).padStart(2, '0')}${String(local.day).padStart(2, '0')}`;
      const time = `${String(Math.floor(bucketMinute / 60)).padStart(2, '0')}${String(bucketMinute % 60).padStart(2, '0')}00`;
      const bucketOpen = zonedDateTimeToUtc(date, time, TIME_ZONE);
      if (!bucketOpen) {
        rejectedBucketKeys.add(`${date}:${time}`);
        continue;
      }
      const entries = buckets.get(bucketOpen.getTime()) ?? [];
      entries.push(row);
      buckets.set(bucketOpen.getTime(), entries);
    }

    const nowMs = (input.now ?? new Date()).getTime();
    const candles: KisDomesticBuildResult['candles'] = [];
    let completeBuckets = 0;
    let incompleteBuckets = 0;
    for (const [bucketMs, rawRows] of [...buckets.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const rows = [...rawRows].sort(
        (a, b) => a.openTime.getTime() - b.openTime.getTime(),
      );
      const closeMs = bucketMs + FIVE_MINUTES_MS;
      const isCurrent = bucketMs <= nowMs && nowMs < closeMs;
      const requiredCount = isCurrent
        ? Math.min(5, Math.floor((nowMs - bucketMs) / MINUTE_MS) + 1)
        : 5;
      const contiguous =
        rows.length === requiredCount &&
        rows.every(
          (row, index) =>
            row.openTime.getTime() === bucketMs + index * MINUTE_MS,
        );
      if (!contiguous) {
        incompleteBuckets += 1;
        continue;
      }
      completeBuckets += 1;
      candles.push({
        openTime: new Date(bucketMs),
        closeTime: new Date(closeMs),
        open: rows[0].open,
        high: Prisma.Decimal.max(...rows.map((row) => row.high)),
        low: Prisma.Decimal.min(...rows.map((row) => row.low)),
        close: rows[rows.length - 1].close,
        volume: rows.reduce(
          (sum, row) => sum.add(row.volume),
          new Prisma.Decimal(0),
        ),
        amount: rows.every((row) => row.amount !== null)
          ? rows.reduce(
              (sum, row) => sum.add(row.amount!),
              new Prisma.Decimal(0),
            )
          : null,
        sourceUpdatedAt: new Date(
          Math.max(...rows.map((row) => row.sourceUpdatedAt.getTime())),
        ),
        isClosed: !isCurrent,
      });
    }
    return {
      candles,
      completeBuckets,
      incompleteBuckets,
      rejectedBuckets: rejectedBucketKeys.size,
    };
  }
}
