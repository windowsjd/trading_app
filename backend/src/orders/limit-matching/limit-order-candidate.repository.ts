import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type LimitOrderCandidate = {
  id: string;
  seasonParticipantId: string;
};

@Injectable()
export class LimitOrderCandidateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Path-A candidates for one live trade event.
   *
   * Ordering is decided ONLY by the Redis Stream ID cursor. The previous
   * `submitted_at <= receivedAt` predicate compared a PostgreSQL
   * clock_timestamp() against a Node process clock and dropped valid events
   * whenever the two hosts' clocks differed — the stream ID is a single-writer
   * monotonic sequence and needs no clock agreement at all.
   */
  findCandidates(input: {
    assetId: string;
    eventPrice: string;
    currencyCode: string;
    streamId: string;
    batchSize: number;
  }): Promise<LimitOrderCandidate[]> {
    return this.prisma.$queryRaw<LimitOrderCandidate[]>`
      SELECT
        o."id",
        o."season_participant_id" AS "seasonParticipantId"
      FROM "orders" o
      JOIN "season_participants" sp
        ON sp."id" = o."season_participant_id"
      JOIN "seasons" s ON s."id" = sp."season_id"
      JOIN "assets" a ON a."id" = o."asset_id"
      WHERE o."asset_id" = ${input.assetId}
        AND o."order_type" = 'limit'
        AND o."side" = 'buy'
        AND o."status" = 'submitted'
        AND o."limit_price" >= ${input.eventPrice}::numeric
        AND o."currency_code" = ${input.currencyCode}::"CurrencyCode"
        AND o."reserved_amount" IS NOT NULL
        AND o."reservation_fee_rate" IS NOT NULL
        AND o."matching_activation_stream_id" IS NOT NULL
        AND (
          split_part(o."matching_activation_stream_id", '-', 1)::numeric,
          split_part(o."matching_activation_stream_id", '-', 2)::numeric
        ) < (
          split_part(${input.streamId}, '-', 1)::numeric,
          split_part(${input.streamId}, '-', 2)::numeric
        )
        AND sp."participant_status" = 'active'
        AND s."status" = 'active'
        AND s."start_at" <= clock_timestamp()
        AND clock_timestamp() < s."end_at"
        AND a."is_active" = true
      ORDER BY o."submitted_at" ASC, o."id" ASC
      LIMIT ${input.batchSize}
    `;
  }

  /**
   * Path-B candidates for one canonical closed 5m candle.
   *
   * `candle_matching_eligible_from` is the order's first fully-elapsed 5m
   * window, so the partially elapsed candle an order was submitted into is
   * excluded by the window comparison, never by a timestamp difference.
   * Orders that predate path B keep a NULL boundary and are filtered out here
   * — they are never retroactively activated.
   *
   * The result is a candidate list, not an authorization: every condition is
   * re-checked against locked rows inside the execution transaction.
   */
  findCandleCandidates(input: {
    assetId: string;
    candleLow: string;
    candleOpenTime: Date;
    candleCloseTime: Date;
    batchSize: number;
  }): Promise<LimitOrderCandidate[]> {
    return this.prisma.$queryRaw<LimitOrderCandidate[]>`
      SELECT
        o."id",
        o."season_participant_id" AS "seasonParticipantId"
      FROM "orders" o
      JOIN "season_participants" sp
        ON sp."id" = o."season_participant_id"
      JOIN "seasons" s ON s."id" = sp."season_id"
      JOIN "assets" a ON a."id" = o."asset_id"
      WHERE o."asset_id" = ${input.assetId}
        AND o."order_type" = 'limit'
        AND o."side" = 'buy'
        AND o."status" = 'submitted'
        AND o."limit_price" >= ${input.candleLow}::numeric
        AND o."candle_matching_eligible_from" IS NOT NULL
        AND o."candle_matching_eligible_from" <= ${input.candleOpenTime}
        AND o."reserved_amount" IS NOT NULL
        AND o."reservation_fee_rate" IS NOT NULL
        AND sp."participant_status" = 'active'
        AND s."status" = 'active'
        AND s."start_at" <= clock_timestamp()
        AND clock_timestamp() < s."end_at"
        AND ${input.candleCloseTime} <= s."end_at"
        AND a."is_active" = true
      ORDER BY o."submitted_at" ASC, o."id" ASC
      LIMIT ${input.batchSize}
    `;
  }
}
