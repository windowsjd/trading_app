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
export type LimitMatchCursor = { submittedAt: Date; id: string };

export type LimitMatchScanRow = {
  cursor: LimitMatchCursor;
  assetId: string;
  candidate: LimitMatchCandidate | null;
};

export type LimitMatchCandidate = {
  id: string;
  side?: OrderSide;
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
  tradingAccountId: true,
  assetId: true,
  quantity: true,
  limitPrice: true,
  currencyCode: true,
  reservedAmount: true,
  reservedQuantity: true,
  reservationFeeRate: true,
  submittedAt: true,
  tradingAccount: {
    select: {
      seasonParticipant: {
        select: { season: { select: { id: true, endAt: true } } },
      },
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
              tradingAccount: {
                mode: TradingAccountMode.season,
                status: TradingAccountStatus.active,
                seasonParticipant: {
                  participantStatus: ParticipantStatus.active,
                  season: {
                    status: SeasonStatus.active,
                    startAt: { lte: now },
                    endAt: { gt: now },
                  },
                },
              },
            },
            {
              tradingAccount: {
                mode: TradingAccountMode.general,
                status: TradingAccountStatus.active,
                seasonParticipant: null,
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
   * A bounded page across ALL assets, ordered by the existing FIFO key.
   * The cursor is a value, not a row reference: cancellation/fill may remove
   * its row before the next cycle. Locked execution remains the authority.
   */
  async findFillableLimitOrdersAfter(
    now: Date,
    limit: number,
    after: LimitMatchCursor | null,
  ): Promise<LimitMatchScanRow[]> {
    const where: Prisma.OrderWhereInput = after
      ? {
          AND: [
            this.fillableWhere(now),
            {
              OR: [
                { submittedAt: { gt: after.submittedAt } },
                { submittedAt: after.submittedAt, id: { gt: after.id } },
              ],
            },
          ],
        }
      : this.fillableWhere(now);
    const rows = await this.prisma.order.findMany({
      where,
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: CANDIDATE_SELECT,
    });

    return rows.map((row) => {
      // Keep even a defensive narrowing failure in the scan, so it cannot
      // pin progress at the same page. Execution still validates every field.
      const cursor = { submittedAt: row.submittedAt, id: row.id };
      if (
        row.reservationFeeRate === null ||
        (row.side === OrderSide.buy && row.reservedAmount === null) ||
        (row.side === OrderSide.sell && row.reservedQuantity === null) ||
        !row.tradingAccountId
      ) {
        return { cursor, assetId: row.assetId, candidate: null };
      }
      const season = row.tradingAccount.seasonParticipant?.season ?? null;
      return {
        cursor,
        assetId: row.assetId,
        candidate: {
          id: row.id,
          side: row.side,
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
      };
    });
  }
}
