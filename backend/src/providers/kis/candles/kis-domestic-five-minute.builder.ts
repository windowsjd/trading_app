import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { resolveMarketSession } from '../../../orders/market-calendar.policy';
import type {
  KisDomesticBuildResult,
  NormalizedKisCandleRow,
} from './kis-candle.types';
import { getZonedParts } from './kis-candle-time';

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
      const date = `${local.year}${String(local.month).padStart(2, '0')}${String(local.day).padStart(2, '0')}`;
      const session = resolveMarketSession('KRX', date);
      const rowMs = row.openTime.getTime();
      if (
        !session ||
        local.second !== 0 ||
        rowMs < session.openTime.getTime() ||
        rowMs >= session.closeTime.getTime() ||
        (rowMs - session.openTime.getTime()) % MINUTE_MS !== 0
      ) {
        rejectedBucketKeys.add(
          `${local.year}-${local.month}-${local.day}:${local.hour}:${Math.floor(local.minute / 5)}`,
        );
        continue;
      }
      const bucketMs =
        session.openTime.getTime() +
        Math.floor((rowMs - session.openTime.getTime()) / FIVE_MINUTES_MS) *
          FIVE_MINUTES_MS;
      const entries = buckets.get(bucketMs) ?? [];
      entries.push(row);
      buckets.set(bucketMs, entries);
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
      const local = getZonedParts(new Date(bucketMs), TIME_ZONE);
      const date = `${local.year}${String(local.month).padStart(2, '0')}${String(local.day).padStart(2, '0')}`;
      const session = resolveMarketSession('KRX', date);
      if (!session) {
        incompleteBuckets += 1;
        continue;
      }
      const closeMs = Math.min(
        bucketMs + FIVE_MINUTES_MS,
        session.closeTime.getTime(),
      );
      const isCurrent = bucketMs <= nowMs && nowMs < closeMs;
      const sessionRequiredCount = (closeMs - bucketMs) / MINUTE_MS;
      const requiredCount = isCurrent
        ? Math.min(
            sessionRequiredCount,
            Math.floor((nowMs - bucketMs) / MINUTE_MS) + 1,
          )
        : sessionRequiredCount;
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
