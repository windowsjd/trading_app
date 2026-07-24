import { Injectable } from '@nestjs/common';
import {
  AssetType,
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A submitted limit-buy order that is currently fillable: its season is active
 * and unexpired, its participant is active, and its asset is active. Every one
 * of these is re-verified against locked rows inside the execution transaction;
 * the query filters are a work-reduction pre-check, never the authority.
 */
export type LimitMatchCandidate = {
  id: string;
  seasonParticipantId: string;
  assetId: string;
  quantity: Prisma.Decimal;
  limitPrice: Prisma.Decimal;
  currencyCode: CurrencyCode;
  reservedAmount: Prisma.Decimal;
  reservationFeeRate: Prisma.Decimal;
  submittedAt: Date;
  seasonId: string;
  seasonEndAt: Date;
  asset: {
    id: string;
    assetType: AssetType;
    market: string;
    symbol: string;
    currencyCode: CurrencyCode;
    priceCurrency: CurrencyCode;
    settlementCurrency: CurrencyCode | null;
    isActive: boolean;
  };
};

const CANDIDATE_SELECT = {
  id: true,
  seasonParticipantId: true,
  assetId: true,
  quantity: true,
  limitPrice: true,
  currencyCode: true,
  reservedAmount: true,
  reservationFeeRate: true,
  submittedAt: true,
  seasonParticipant: {
    select: {
      season: { select: { id: true, endAt: true } },
    },
  },
  asset: {
    select: {
      id: true,
      assetType: true,
      market: true,
      symbol: true,
      currencyCode: true,
      priceCurrency: true,
      settlementCurrency: true,
      isActive: true,
    },
  },
} as const;

/**
 * Read-only candidate lookup for the matching job. It never mutates anything;
 * fills happen in LimitOrderExecutionService under row locks.
 */
@Injectable()
export class LimitOrderCandidateRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The where-clause shared by both queries: a submitted limit BUY whose
   * season is active and currently within [startAt, endAt), whose participant
   * is active, whose asset is active, and that carries a usable reservation.
   */
  private fillableWhere(now: Date): Prisma.OrderWhereInput {
    return {
      status: OrderStatus.submitted,
      orderType: OrderType.limit,
      side: OrderSide.buy,
      reservedAmount: { not: null },
      reservationFeeRate: { not: null },
      asset: { isActive: true },
      seasonParticipant: {
        participantStatus: ParticipantStatus.active,
        season: {
          status: SeasonStatus.active,
          startAt: { lte: now },
          endAt: { gt: now },
        },
      },
    };
  }

  /**
   * Distinct asset ids that currently have at least one fillable submitted
   * limit buy. Bounded so one cycle never scans an unbounded asset universe.
   */
  async findAssetIdsWithFillableLimitBuys(
    now: Date,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.order.findMany({
      where: this.fillableWhere(now),
      distinct: ['assetId'],
      orderBy: [{ assetId: 'asc' }],
      select: { assetId: true },
      take: limit,
    });
    return rows.map((row) => row.assetId);
  }

  /**
   * Fillable submitted limit buys for one asset, oldest first (FIFO by
   * submittedAt then id). Bounded to `limit`.
   */
  async findFillableLimitBuysForAsset(
    assetId: string,
    now: Date,
    limit: number,
  ): Promise<LimitMatchCandidate[]> {
    const rows = await this.prisma.order.findMany({
      where: { ...this.fillableWhere(now), assetId },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: CANDIDATE_SELECT,
    });

    return rows.flatMap((row) => {
      // reservedAmount/reservationFeeRate are non-null by the where clause, but
      // narrow explicitly so a corrupt row is skipped rather than crashed on.
      if (row.reservedAmount === null || row.reservationFeeRate === null) {
        return [];
      }
      const season = row.seasonParticipant.season;
      return [
        {
          id: row.id,
          seasonParticipantId: row.seasonParticipantId,
          assetId: row.assetId,
          quantity: row.quantity,
          limitPrice: row.limitPrice as Prisma.Decimal,
          currencyCode: row.currencyCode,
          reservedAmount: row.reservedAmount,
          reservationFeeRate: row.reservationFeeRate,
          submittedAt: row.submittedAt,
          seasonId: season.id,
          seasonEndAt: season.endAt,
          asset: row.asset,
        },
      ];
    });
  }
}
