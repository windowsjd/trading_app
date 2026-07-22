import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type LimitOrderCandidate = {
  id: string;
  seasonParticipantId: string;
};

@Injectable()
export class LimitOrderCandidateRepository {
  constructor(private readonly prisma: PrismaService) {}

  findCandidates(input: {
    assetId: string;
    eventPrice: string;
    eventReceivedAt: Date;
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
        AND o."submitted_at" <= ${input.eventReceivedAt}
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
}
