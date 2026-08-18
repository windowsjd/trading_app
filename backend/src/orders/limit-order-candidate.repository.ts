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
  TradingAccountMode,
  TradingAccountStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A submitted limit order that is currently fillable. Season rows require an
 * active/unexpired season and participant; general rows require an active
 * participant-less account. The execution transaction re-verifies every fact,
 * so these filters are work-reduction only, never authority.
 */
export type LimitMatchCandidate = {
  id: string;
  side?: OrderSide;
  seasonParticipantId: string | null;
  tradingAccountId: string;
  assetId: string;
  quantity: Prisma.Decimal;
  limitPrice: Prisma.Decimal;
  currencyCode: CurrencyCode;
  reservedAmount: Prisma.Decimal | null;
  reservedQuantity?: Prisma.Decimal | null;
  reservationFeeRate: Prisma.Decimal;
  submittedAt: Date;
  seasonId: string | null;
  seasonEndAt: Date | null;
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
  side: true,
  seasonParticipantId: true,
  tradingAccountId: true,
  assetId: true,
  quantity: true,
  limitPrice: true,
  currencyCode: true,
  reservedAmount: true,
  reservedQuantity: true,
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
   * Shared candidate clause for submitted buy/sell reservations in either a
   * tradable season account or an active participant-less general account.
   */
  private fillableWhere(now: Date): Prisma.OrderWhereInput {
    return {
      status: OrderStatus.submitted,
      orderType: OrderType.limit,
      reservationFeeRate: { not: null },
      asset: { isActive: true },
      AND: [
        {
          OR: [
            { side: OrderSide.buy, reservedAmount: { not: null } },
            { side: OrderSide.sell, reservedQuantity: { not: null } },
          ],
        },
        {
          OR: [
            {
              seasonParticipant: {
                participantStatus: ParticipantStatus.active,
                season: {
                  status: SeasonStatus.active,
                  startAt: { lte: now },
                  endAt: { gt: now },
                },
              },
              tradingAccount: {
                mode: TradingAccountMode.season,
                status: TradingAccountStatus.active,
              },
            },
            {
              seasonParticipantId: null,
              tradingAccount: {
                mode: TradingAccountMode.general,
                status: TradingAccountStatus.active,
              },
            },
          ],
        },
      ],
    };
  }

  /**
   * Distinct asset ids that currently have at least one fillable submitted
   * limit order. Bounded so one cycle never scans an unbounded asset universe.
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
   * Fillable submitted limit orders for one asset, oldest first (FIFO by
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
      // Reservation fields are non-null by the where clause; narrow explicitly
      // for Prisma's nullable field types. Locked execution remains the final
      // integrity authority.
      if (
        row.reservationFeeRate === null ||
        (row.side === OrderSide.buy && row.reservedAmount === null) ||
        (row.side === OrderSide.sell && row.reservedQuantity === null)
      ) {
        return [];
      }
      if (!row.tradingAccountId) return [];
      const season = row.seasonParticipant?.season ?? null;
      return [
        {
          id: row.id,
          side: row.side,
          seasonParticipantId: row.seasonParticipantId,
          tradingAccountId: row.tradingAccountId,
          assetId: row.assetId,
          quantity: row.quantity,
          limitPrice: row.limitPrice as Prisma.Decimal,
          currencyCode: row.currencyCode,
          reservedAmount: row.reservedAmount,
          reservedQuantity: row.reservedQuantity,
          reservationFeeRate: row.reservationFeeRate,
          submittedAt: row.submittedAt,
          seasonId: season?.id ?? null,
          seasonEndAt: season?.endAt ?? null,
          asset: row.asset,
        },
      ];
    });
  }
}
