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
import {
  assertRankingSourceSnapshotScopes,
  buildRankingParticipantScopes,
  RANKING_PARTICIPANT_SCOPE_SELECT,
} from './ranking-source-scope';
import {
  assertSeasonRankingScopes,
  resolveSeasonRankingAccountScopes,
  SEASON_RANKING_SCOPE_SELECT,
} from './season-ranking-scope';
import { lockSeasonForWrite } from './season-write-lock';
import { isCurrentRankingSuperseded } from './current-ranking-generation';

type RankableParticipant = {
  id: string;
  seasonId: string;
  userId: string;
  initialCapitalKrw: Prisma.Decimal;
  totalFillCount: number;
  tradingAccountId: string;
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
type RefreshRequest = {
  capturedAt: Date;
  useCurrentTime: boolean;
  createEquitySnapshots: boolean;
};
type RefreshResult =
  | { skipped: false; rankingsCreated: number; rankingDate: string }
  | {
      skipped: true;
      reason: 'season_not_active' | 'stale_generation' | 'participants_changed';
    };
type RunningRefresh = {
  pending: RefreshRequest | null;
  promise: Promise<RefreshResult>;
};
const RANKABLE_PARTICIPANT_STATUSES: readonly ParticipantStatus[] = [
  ParticipantStatus.active,
  ParticipantStatus.finished,
  ParticipantStatus.rewarded,
];

@Injectable()
export class RankingRefreshService {
  private readonly logger = new Logger(RankingRefreshService.name);
  private readonly runningSeasonRefreshes = new Map<string, RunningRefresh>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService: PortfolioValuationService,
  ) {}

  async refreshCurrentRankingAfterParticipantChange(
    seasonId: string,
    seasonParticipantId: string,
    capturedAt?: Date,
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
  ): Promise<RefreshResult> {
    const request: RefreshRequest = {
      capturedAt: options.capturedAt ?? new Date(),
      useCurrentTime: options.capturedAt === undefined,
      createEquitySnapshots: options.createEquitySnapshots === true,
    };
    const lockKey = options.lockKey ?? `season:${seasonId}`;
    const running = this.runningSeasonRefreshes.get(lockKey);
    if (running) {
      const previous = running.pending;
      const next =
        previous && previous.capturedAt > request.capturedAt
          ? previous
          : request;
      running.pending = {
        ...next,
        createEquitySnapshots:
          request.createEquitySnapshots ||
          previous?.createEquitySnapshots === true,
      };
      return running.promise;
    }

    const state = { pending: request } as RunningRefresh;
    this.runningSeasonRefreshes.set(lockKey, state);
    state.promise = this.drainRefreshes(seasonId, lockKey, state);
    return state.promise;
  }

  private async drainRefreshes(
    seasonId: string,
    lockKey: string,
    state: RunningRefresh,
  ): Promise<RefreshResult> {
    let result: RefreshResult | undefined;
    let failure: Error | undefined;
    // A trigger arriving during calculation gets a trailing calculation, even
    // if the first one fails. No transaction is held while waiting/calculating.
    try {
      while (state.pending) {
        const request = state.pending;
        state.pending = null;
        try {
          result = await this.calculateAndReplace(
            seasonId,
            request.useCurrentTime ? new Date() : request.capturedAt,
            request.createEquitySnapshots,
          );
          failure = undefined;
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (failure !== undefined) throw failure;
      return result!;
    } finally {
      // Remove synchronously with the final pending check: a later trigger
      // must not attach to an already drained promise and disappear.
      this.runningSeasonRefreshes.delete(lockKey);
    }
  }

  private async calculateAndReplace(
    seasonId: string,
    capturedAt: Date,
    createEquitySnapshots: boolean,
  ): Promise<RefreshResult> {
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

      // Verified participant → season account map, built ONCE (작업 8 §9.4).
      // Every equity row read below is measured against it.
      const participantScopes = buildRankingParticipantScopes(
        seasonId,
        participants,
      );

      const valuations: CurrentRankingValuation[] = [];
      for (const participant of participants) {
        const tradingAccountId = participantScopes.get(participant.id)!;
        const valuation =
          await this.portfolioValuationService.calculateTradingAccountValuation(
            tradingAccountId,
            capturedAt,
            'live_portfolio_valuation',
          );
        if (valuation.seasonParticipantId !== participant.id) {
          throw new Error(
            `Trading account ${tradingAccountId} is not owned by ranking participant ${participant.id}.`,
          );
        }
        const history = await this.findEquityHistory(
          participant.id,
          participantScopes,
        );
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

  /**
   * Participants AND their account scope in one query — the account id is never
   * looked up per row (작업 8 §9.4).
   */
  private async findRankableParticipants(seasonId: string) {
    return this.prisma.seasonParticipant.findMany({
      where: {
        seasonId,
        participantStatus: {
          in: [...RANKABLE_PARTICIPANT_STATUSES],
        },
      },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      select: {
        ...RANKING_PARTICIPANT_SCOPE_SELECT,
        initialCapitalKrw: true,
        totalFillCount: true,
      },
    });
  }

  /**
   * Max-drawdown / reached-return history for ONE participant.
   *
   * Every row is scope-checked before it is used. A mis-scoped row is not
   * dropped: silently excluding a low point would LOWER this participant's max
   * drawdown, which is tie-break #2 and can move them up the leaderboard
   * (작업 8 §9.2).
   */
  private async findEquityHistory(
    seasonParticipantId: string,
    participantScopes: ReadonlyMap<string, string>,
  ): Promise<EquityPoint[]> {
    const rows = await this.prisma.equitySnapshot.findMany({
      where: {
        tradingAccountId: participantScopes.get(seasonParticipantId)!,
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        tradingAccountId: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
        totalAssetKrw: true,
        returnRate: true,
        capturedAt: true,
        createdAt: true,
      },
    });

    assertRankingSourceSnapshotScopes({
      kind: 'equity snapshot',
      rows,
      participantScopes,
    });

    return rows;
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
    const ranksByParticipant = new Map(
      rows.map((row) => [row.seasonParticipantId, row.rank]),
    );

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        // SERIALIZATION POINT (작업 8 §13.1). The status check before the
        // transaction was a read of state that settlement may have changed since.
        // Holding the season row means settlement either finished before this
        // write started (and the re-check below stops it) or waits until it ends.
        const season = await lockSeasonForWrite(tx, input.seasonId);
        if (
          !season ||
          season.status !== SeasonStatus.active ||
          input.capturedAt.getTime() < season.startAt.getTime() ||
          input.capturedAt.getTime() >= season.endAt.getTime()
        ) {
          // A settled/ended season's results are final. Writing daily rows now
          // would resurrect a leaderboard that has already been closed out.
          return {
            wrote: false as const,
            reason: 'season_not_active' as const,
          };
        }

        // 작업 8 보완 §A-3: VERIFY THE SET THIS REFRESH IS ABOUT TO DESTROY.
        //
        // The refresh policy is delete-then-recreate, and the recreate always
        // produces correctly scoped rows. That combination silently LAUNDERS
        // damage: a row left with a null scope by an old writer, or one pointing
        // at the wrong account, disappears on the next five-minute tick and comes
        // back looking healthy. The repair script then reports nothing to fix,
        // and the deploy-boundary damage it exists to count is gone — along with
        // any chance of learning which accounts were affected.
        //
        // So the existing set is read and verified BEFORE anything is deleted and
        // before any participant's `currentRank` is touched. A damaged set stops
        // the refresh with the same structured code the readers use; an operator
        // repairs it, and only then does routine refreshing resume.
        const existingRankings = await tx.seasonRanking.findMany({
          where: {
            seasonId: input.seasonId,
            rankType: CURRENT_RANK_TYPE,
            rankingDate: input.rankingDate,
          },
          select: {
            ...SEASON_RANKING_SCOPE_SELECT,
            id: true,
          },
        });
        assertSeasonRankingScopes(existingRankings);

        // The lock serializes publication, not the preceding calculations. This
        // check must precede EVERY write, including participant/equity updates.
        if (
          await isCurrentRankingSuperseded(tx, {
            seasonId: input.seasonId,
            capturedAt: input.capturedAt,
          })
        ) {
          return { wrote: false as const, reason: 'stale_generation' as const };
        }

        // An empty generation has no ranking row to carry capturedAt. Recheck
        // membership so a calculation from before exclusion cannot resurrect it.
        const currentParticipants = await tx.seasonParticipant.findMany({
          where: {
            seasonId: input.seasonId,
            participantStatus: { in: [...RANKABLE_PARTICIPANT_STATUSES] },
          },
          select: { id: true },
        });
        if (
          currentParticipants.length !== rows.length ||
          currentParticipants.some((row) => !ranksByParticipant.has(row.id))
        ) {
          return {
            wrote: false as const,
            reason: 'participants_changed' as const,
          };
        }

        if (input.createEquitySnapshots) {
          const bucketStart = floorToFiveMinuteBucket(input.capturedAt);
          const bucketEnd = new Date(bucketStart.getTime() + 5 * 60_000);
          for (const valuation of input.valuations) {
            const existing = await tx.equitySnapshot.findFirst({
              where: {
                tradingAccountId: valuation.participant.tradingAccountId,
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
                tradingAccountId: valuation.participant.tradingAccountId,
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
          await tx.seasonParticipant.update({
            where: {
              id: valuation.participant.id,
            },
            data: {
              totalAssetKrw: valuation.totalAssetKrw,
              totalReturnRate: valuation.returnRate,
              maxDrawdown: valuation.maxDrawdown,
              currentRank:
                ranksByParticipant.get(valuation.participant.id) ?? null,
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

        // Resolved for ALL rows before any insert (작업 8 §8): a participant with
        // a broken account link aborts the whole refresh rather than leaving a
        // leaderboard that is missing one competitor.
        const scopes = await resolveSeasonRankingAccountScopes(tx, {
          seasonId: input.seasonId,
          seasonParticipantIds: rows.map((row) => row.seasonParticipantId),
        });

        for (const row of rows) {
          await tx.seasonRanking.create({
            data: {
              seasonId: input.seasonId,
              seasonParticipantId: row.seasonParticipantId,
              tradingAccountId: scopes.get(row.seasonParticipantId)!
                .tradingAccountId,
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

        return { wrote: true as const };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    if (!outcome.wrote) {
      this.logger.warn(
        `Current ranking refresh for season ${input.seasonId} was skipped: ${outcome.reason}.`,
      );
      return { skipped: true as const, reason: outcome.reason };
    }

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
