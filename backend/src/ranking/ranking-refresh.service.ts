import { Injectable, Logger } from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
  SnapshotReason,
} from '../generated/prisma/client';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assignSequentialRanks,
  compareRankingRows,
} from './ranking-calculation.policy';

type RankableParticipant = {
  id: string;
  seasonId: string;
  userId: string;
  initialCapitalKrw: Prisma.Decimal;
  totalFillCount: number;
};

type EquityPoint = {
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  capturedAt: Date;
  createdAt?: Date | null;
};

type CurrentRankingValuation = {
  participant: RankableParticipant;
  totalAssetKrw: string;
  returnRate: string;
  krwCash: string;
  usdCashKrw: string;
  domesticStockValueKrw: string;
  usStockValueKrw: string;
  cryptoValueKrw: string;
  maxDrawdown: string;
  reachedReturnAt: Date;
  history: EquityPoint[];
};

const CURRENT_RANK_TYPE = SeasonRankingType.daily;
const RANKABLE_PARTICIPANT_STATUSES: readonly ParticipantStatus[] = [
  ParticipantStatus.active,
  ParticipantStatus.finished,
  ParticipantStatus.rewarded,
];

@Injectable()
export class RankingRefreshService {
  private readonly logger = new Logger(RankingRefreshService.name);
  private readonly runningSeasonRefreshes = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService: PortfolioValuationService,
  ) {}

  async refreshCurrentRankingAfterParticipantChange(
    seasonId: string,
    seasonParticipantId: string,
    capturedAt = new Date(),
  ) {
    void seasonParticipantId;

    return this.refreshCurrentRankingForSeason(seasonId, {
      capturedAt,
      createEquitySnapshots: false,
      lockKey: `participant-change:${seasonId}`,
    });
  }

  async refreshCurrentRankingForSeason(
    seasonId: string,
    options: {
      capturedAt?: Date;
      createEquitySnapshots?: boolean;
      lockKey?: string;
    } = {},
  ) {
    const capturedAt = options.capturedAt ?? new Date();
    const createEquitySnapshots = options.createEquitySnapshots === true;
    const lockKey = options.lockKey ?? `season:${seasonId}`;

    if (this.runningSeasonRefreshes.has(lockKey)) {
      this.logger.warn(
        `Current ranking refresh skipped because a refresh is already running for ${lockKey}.`,
      );
      return { skipped: true as const, reason: 'already_running' as const };
    }

    this.runningSeasonRefreshes.add(lockKey);
    try {
      const season = await this.prisma.season.findUnique({
        where: {
          id: seasonId,
        },
        select: {
          id: true,
          status: true,
          startAt: true,
          endAt: true,
        },
      });

      if (!season) {
        throw new Error(`Season ${seasonId} was not found.`);
      }

      if (
        season.status !== SeasonStatus.active ||
        capturedAt.getTime() < season.startAt.getTime() ||
        capturedAt.getTime() >= season.endAt.getTime()
      ) {
        return { skipped: true as const, reason: 'season_not_active' as const };
      }

      const participants = await this.findRankableParticipants(seasonId);
      if (participants.length === 0) {
        return await this.replaceCurrentRankings({
          seasonId,
          rankingDate: this.toDateOnly(capturedAt),
          capturedAt,
          valuations: [],
          createEquitySnapshots,
        });
      }

      const valuations: CurrentRankingValuation[] = [];
      for (const participant of participants) {
        const valuation =
          await this.portfolioValuationService.calculateSeasonParticipantValuation(
            participant.id,
            capturedAt,
            'live_portfolio_valuation',
          );
        const history = await this.findEquityHistory(participant.id);
        const currentPoint = {
          totalAssetKrw: new Prisma.Decimal(valuation.totalAssetKrw),
          returnRate: new Prisma.Decimal(valuation.returnRate),
          capturedAt,
          createdAt: capturedAt,
        };
        const mergedHistory = appendCurrentPoint(history, currentPoint);
        const returnRate = new Prisma.Decimal(valuation.returnRate);

        valuations.push({
          participant,
          totalAssetKrw: valuation.totalAssetKrw,
          returnRate: valuation.returnRate,
          krwCash: valuation.krwCash,
          usdCashKrw: valuation.usdCashKrw,
          domesticStockValueKrw: valuation.domesticStockValueKrw,
          usStockValueKrw: valuation.usStockValueKrw,
          cryptoValueKrw: valuation.cryptoValueKrw,
          maxDrawdown: formatDecimal(calculateMaxDrawdown(mergedHistory), 8),
          reachedReturnAt: calculateReachedReturnAt(
            mergedHistory,
            returnRate,
            capturedAt,
          ),
          history: mergedHistory,
        });
      }

      return await this.replaceCurrentRankings({
        seasonId,
        rankingDate: this.toDateOnly(capturedAt),
        capturedAt,
        valuations,
        createEquitySnapshots,
      });
    } catch (error) {
      this.logger.error(
        `Current ranking refresh failed for season ${seasonId}.`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    } finally {
      this.runningSeasonRefreshes.delete(lockKey);
    }
  }

  async refreshCurrentRankingsForActiveSeasons(
    capturedAt = new Date(),
    options: { createEquitySnapshots?: boolean } = {},
  ) {
    const seasons = await this.prisma.season.findMany({
      where: {
        status: SeasonStatus.active,
        startAt: {
          lte: capturedAt,
        },
        endAt: {
          gt: capturedAt,
        },
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
      },
    });
    const results: unknown[] = [];

    for (const season of seasons) {
      results.push(
        await this.refreshCurrentRankingForSeason(season.id, {
          capturedAt,
          createEquitySnapshots: options.createEquitySnapshots === true,
          lockKey: `scheduled:${season.id}`,
        }),
      );
    }

    return {
      seasonsProcessed: seasons.length,
      results,
    };
  }

  private async findRankableParticipants(
    seasonId: string,
  ): Promise<RankableParticipant[]> {
    return this.prisma.seasonParticipant.findMany({
      where: {
        seasonId,
        participantStatus: {
          in: [...RANKABLE_PARTICIPANT_STATUSES],
        },
      },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        seasonId: true,
        userId: true,
        initialCapitalKrw: true,
        totalFillCount: true,
      },
    });
  }

  private async findEquityHistory(
    seasonParticipantId: string,
  ): Promise<EquityPoint[]> {
    return this.prisma.equitySnapshot.findMany({
      where: {
        seasonParticipantId,
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
        createdAt: true,
      },
    });
  }

  private async replaceCurrentRankings(input: {
    seasonId: string;
    rankingDate: Date;
    capturedAt: Date;
    valuations: readonly CurrentRankingValuation[];
    createEquitySnapshots: boolean;
  }) {
    const rows = assignSequentialRanks(
      input.valuations
        .map((valuation) => ({
          seasonParticipantId: valuation.participant.id,
          userId: valuation.participant.userId,
          totalAssetKrw: valuation.totalAssetKrw,
          returnRate: valuation.returnRate,
          maxDrawdown: valuation.maxDrawdown,
          totalFillCount: valuation.participant.totalFillCount,
          reachedReturnAt: valuation.reachedReturnAt,
        }))
        .toSorted(compareRankingRows),
    );

    await this.prisma.$transaction(async (tx) => {
      if (input.createEquitySnapshots) {
        const bucketStart = floorToFiveMinuteBucket(input.capturedAt);
        const bucketEnd = new Date(bucketStart.getTime() + 5 * 60_000);
        for (const valuation of input.valuations) {
          const existing = await tx.equitySnapshot.findFirst({
            where: {
              seasonParticipantId: valuation.participant.id,
              snapshotReason: SnapshotReason.scheduled,
              capturedAt: {
                gte: bucketStart,
                lt: bucketEnd,
              },
            },
            select: {
              id: true,
            },
          });
          if (existing) {
            continue;
          }

          await tx.equitySnapshot.create({
            data: {
              seasonParticipantId: valuation.participant.id,
              totalAssetKrw: valuation.totalAssetKrw,
              returnRate: valuation.returnRate,
              krwCash: valuation.krwCash,
              usdCashKrw: valuation.usdCashKrw,
              domesticStockValueKrw: valuation.domesticStockValueKrw,
              usStockValueKrw: valuation.usStockValueKrw,
              cryptoValueKrw: valuation.cryptoValueKrw,
              snapshotReason: SnapshotReason.scheduled,
              capturedAt: input.capturedAt,
            },
          });
        }
      }

      for (const valuation of input.valuations) {
        const row = rows.find(
          (candidate) =>
            candidate.seasonParticipantId === valuation.participant.id,
        );
        await tx.seasonParticipant.update({
          where: {
            id: valuation.participant.id,
          },
          data: {
            totalAssetKrw: valuation.totalAssetKrw,
            totalReturnRate: valuation.returnRate,
            maxDrawdown: valuation.maxDrawdown,
            currentRank: row?.rank ?? null,
          },
          select: {
            id: true,
          },
        });
      }

      await tx.seasonRanking.deleteMany({
        where: {
          seasonId: input.seasonId,
          rankType: CURRENT_RANK_TYPE,
          rankingDate: input.rankingDate,
        },
      });

      for (const row of rows) {
        await tx.seasonRanking.create({
          data: {
            seasonId: input.seasonId,
            seasonParticipantId: row.seasonParticipantId,
            rankType: CURRENT_RANK_TYPE,
            rank: row.rank,
            totalAssetKrw: row.totalAssetKrw,
            returnRate: row.returnRate,
            maxDrawdown: row.maxDrawdown,
            totalFillCount: row.totalFillCount,
            reachedReturnAt: row.reachedReturnAt,
            rankingDate: input.rankingDate,
            capturedAt: input.capturedAt,
          },
          select: {
            id: true,
          },
        });
      }
    });

    this.logger.log(
      `Current ranking refreshed for season ${input.seasonId}: ${rows.length} participants.`,
    );

    return {
      skipped: false as const,
      rankingsCreated: rows.length,
      rankingDate: input.rankingDate.toISOString().slice(0, 10),
    };
  }

  private toDateOnly(date: Date) {
    return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
}

export function calculateMaxDrawdown(
  snapshots: readonly Pick<EquityPoint, 'totalAssetKrw' | 'capturedAt'>[],
): Prisma.Decimal {
  const sorted = snapshots
    .slice()
    .sort(
      (left, right) => left.capturedAt.getTime() - right.capturedAt.getTime(),
    );
  let peak: Prisma.Decimal | null = null;
  let maxDrawdown = new Prisma.Decimal(0);

  for (const snapshot of sorted) {
    const totalAssetKrw = new Prisma.Decimal(snapshot.totalAssetKrw);
    if (peak === null || totalAssetKrw.gt(peak)) {
      peak = totalAssetKrw;
    }

    if (!peak || peak.lte(0)) {
      continue;
    }

    const drawdown = peak.sub(totalAssetKrw).div(peak).mul(100);
    if (drawdown.gt(maxDrawdown)) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown;
}

export function calculateReachedReturnAt(
  snapshots: readonly Pick<
    EquityPoint,
    'returnRate' | 'capturedAt' | 'createdAt'
  >[],
  targetReturnRate: Prisma.Decimal,
  fallbackCapturedAt: Date,
): Date {
  const reached = snapshots
    .slice()
    .sort(
      (left, right) =>
        left.capturedAt.getTime() - right.capturedAt.getTime() ||
        (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0),
    )
    .find((snapshot) =>
      new Prisma.Decimal(snapshot.returnRate).gte(targetReturnRate),
    );

  return reached?.capturedAt ?? fallbackCapturedAt;
}

function appendCurrentPoint(
  history: readonly EquityPoint[],
  currentPoint: EquityPoint,
): EquityPoint[] {
  const alreadyCaptured = history.some(
    (snapshot) =>
      snapshot.capturedAt.getTime() === currentPoint.capturedAt.getTime(),
  );

  return alreadyCaptured ? [...history] : [...history, currentPoint];
}

function formatDecimal(value: Prisma.Decimal, scale: number) {
  return value.toFixed(scale);
}

function floorToFiveMinuteBucket(date: Date): Date {
  return new Date(Math.floor(date.getTime() / (5 * 60_000)) * 5 * 60_000);
}
