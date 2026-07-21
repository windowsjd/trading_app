import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
  SnapshotReason,
} from '../generated/prisma/client';
import {
  formatDecimalScale,
  formatMoneyScale8,
  returnRateScale,
} from '../fx/fx-decimal-policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assignSequentialRanks,
  compareRankingRows,
} from '../ranking/ranking-calculation.policy';
import {
  calculateMaxDrawdown,
  calculateReachedReturnAt,
} from '../ranking/ranking-refresh.service';
import { BatchService } from './batch.service';
import {
  SEASON_SETTLEMENT_JOB_NAME,
  SeasonSettlementJobInput,
  SeasonSettlementJobRequestPayload,
  SeasonSettlementJobResult,
  SeasonSettlementJobRunResponse,
  SeasonSettlementJobTopRank,
} from './season-settlement-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOP_RANKS_LIMIT = 10;
const FINAL_RANK_TYPE = SeasonRankingType.final;
const SETTLEMENT_PARTICIPANT_STATUSES: readonly ParticipantStatus[] = [
  ParticipantStatus.active,
  ParticipantStatus.finished,
  ParticipantStatus.rewarded,
];
const FINAL_TIER_CUTOFF_RULES = [
  { tier: 'master', cumulativeRatio: 0.04 },
  { tier: 'diamond', cumulativeRatio: 0.11 },
  { tier: 'platinum', cumulativeRatio: 0.23 },
  { tier: 'gold', cumulativeRatio: 0.4 },
  { tier: 'silver', cumulativeRatio: 0.7 },
  { tier: 'bronze', cumulativeRatio: 1 },
] as const;

type SettlementParticipant = {
  id: string;
  userId: string;
  totalFillCount: number;
};

type SettlementSeason = {
  id: string;
  status: SeasonStatus;
  endAt: Date;
};

type EquityHistoryPoint = {
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  capturedAt: Date;
  createdAt?: Date | null;
};

type FinalValuation = {
  seasonParticipantId: string;
  userId: string;
  totalAssetKrw: string;
  returnRate: string;
  krwCash: string;
  usdCashKrw: string;
  domesticStockValueKrw: string;
  usStockValueKrw: string;
  cryptoValueKrw: string;
  maxDrawdown: string;
  totalFillCount: number;
  reachedReturnAt: Date;
};

type FinalRankingRow = FinalValuation & {
  rank: number;
  finalTier: string;
};

type ExistingFinalRankingRow = {
  id: string;
  seasonParticipantId: string;
  rank: number;
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  maxDrawdown: Prisma.Decimal;
  totalFillCount: number;
  reachedReturnAt: Date | null;
  seasonParticipant: {
    userId: string;
  };
};

@Injectable()
export class SeasonSettlementJobService {
  private readonly logger = new Logger(SeasonSettlementJobService.name);

  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService?: PortfolioValuationService,
  ) {}

  async run(
    input: SeasonSettlementJobInput,
  ): Promise<SeasonSettlementJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: SeasonSettlementJobRequestPayload = {
      seasonId: this.parseOptionalText(input.seasonId) ?? null,
      settlementDate: this.parseOptionalText(input.settlementDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      SeasonSettlementJobRequestPayload,
      SeasonSettlementJobResult
    >({
      jobName: SEASON_SETTLEMENT_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ startedAt }) =>
        this.runSeasonSettlementJob(input, dryRun, startedAt),
    });
  }

  private async runSeasonSettlementJob(
    input: SeasonSettlementJobInput,
    dryRun: boolean,
    capturedAt: Date,
  ): Promise<SeasonSettlementJobResult> {
    const seasonId = this.parseRequiredText(input.seasonId, 'seasonId');
    const { text: settlementDateText, date: settlementDate } =
      this.parseSettlementDate(input.settlementDate);
    const season = await this.findSeasonOrThrow(seasonId);

    this.assertSeasonStatusAllowed(season.status);
    await this.assertNoOpenLimitReservations(seasonId);

    const participants = await this.findEligibleParticipants(seasonId);
    const result = this.createBaseResult({
      seasonId,
      settlementDate: settlementDateText,
      dryRun,
      previousStatus: season.status,
      participantsTotal: participants.length,
      snapshotted: 0,
      missingSnapshots: participants.length,
    });

    if (participants.length === 0) {
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        'NO_SETTLEMENT_PARTICIPANTS',
        'No eligible participants are available for settlement.',
        result,
      );
    }

    const existingFinalRankings = await this.findExistingFinalRankingRows(
      this.prisma,
      seasonId,
      settlementDate,
    );

    if (existingFinalRankings.length > 0) {
      return this.handleExistingFinalRankings({
        season,
        settlementDate,
        settlementDateText,
        participants,
        existingFinalRankings,
        dryRun,
        result,
      });
    }

    const finalValuations = await this.calculateFinalValuations({
      participants,
      settlementAt: season.endAt,
      settlementDate,
    }).catch((error) => {
      this.failWithResult(
        HttpStatus.SERVICE_UNAVAILABLE,
        'FINAL_VALUATION_FAILED',
        error instanceof Error
          ? error.message
          : 'Final valuation failed before settlement.',
        result,
      );
    });

    const finalRows = this.buildFinalRankingRows(finalValuations);
    result.participants.snapshotted = finalValuations.length;
    result.participants.missingSnapshots = Math.max(
      participants.length - finalValuations.length,
      0,
    );
    result.finalRankings.wouldCreate = finalRows.length;
    result.finalSnapshots.wouldCreate = finalValuations.length;
    result.finalTiers.wouldAssign = finalRows.length;
    result.topRanks = finalRows
      .slice(0, TOP_RANKS_LIMIT)
      .map((row) => this.formatFinalRankingRow(row));

    if (result.participants.missingSnapshots > 0) {
      const code = this.portfolioValuationService
        ? 'MISSING_FINAL_VALUATIONS'
        : finalValuations.length === 0
          ? 'NO_FINAL_SNAPSHOTS_AVAILABLE'
          : 'MISSING_FINAL_SNAPSHOTS';
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        code,
        this.portfolioValuationService
          ? 'Some eligible participants do not have final valuations.'
          : 'Some eligible participants do not have daily portfolio snapshots for settlementDate.',
        result,
      );
    }

    if (dryRun) {
      return result;
    }

    const writeResult = await this.createFinalSettlementAtomically({
      seasonId,
      settlementDate,
      capturedAt,
      finalRows,
    });

    result.finalSnapshots.created = writeResult.createdFinalSnapshotIds.length;
    result.finalSnapshots.updated = writeResult.updatedFinalSnapshotIds.length;
    result.finalRankings.created = writeResult.createdFinalRankingIds.length;
    result.finalTiers.assigned =
      writeResult.assignedFinalTierParticipantIds.length;
    result.createdFinalSnapshotIds = writeResult.createdFinalSnapshotIds;
    result.updatedFinalSnapshotIds = writeResult.updatedFinalSnapshotIds;
    result.createdFinalRankingIds = writeResult.createdFinalRankingIds;
    result.assignedFinalTierParticipantIds =
      writeResult.assignedFinalTierParticipantIds;
    result.season.updated = writeResult.seasonUpdated;
    result.message =
      'Season settlement completed through final ranking and final tier assignment. Rewards remain pending.';

    return result;
  }

  private async findSeasonOrThrow(seasonId: string): Promise<SettlementSeason> {
    const season = await this.prisma.season.findUnique({
      where: {
        id: seasonId,
      },
      select: {
        id: true,
        status: true,
        endAt: true,
      },
    });

    if (!season) {
      this.throwJobError(
        HttpStatus.NOT_FOUND,
        'SEASON_NOT_FOUND',
        'Season not found.',
      );
    }

    return season;
  }

  private assertSeasonStatusAllowed(status: SeasonStatus) {
    if (status === SeasonStatus.ended || status === SeasonStatus.settled) {
      return;
    }

    if (status === SeasonStatus.active) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'SEASON_STATUS_NOT_ALLOWED',
        'Season settlement job requires an ended season.',
      );
    }

    this.throwJobError(
      HttpStatus.BAD_REQUEST,
      'SEASON_STATUS_NOT_ALLOWED',
      `Season settlement job does not support ${status} seasons.`,
    );
  }

  /**
   * Settlement precondition: no submitted limit-buy order and no wallet
   * with a non-zero reservation may remain for the season. Open
   * reservations mean cash is still fenced off and final valuations would
   * be settled against an unfinished order book — the season-lifecycle
   * cleanup (which cancels open limit buys of ended seasons on every tick)
   * must run first. Fails closed with a structured operational log.
   */
  private async assertNoOpenLimitReservations(seasonId: string) {
    const [openLimitBuyOrderCount, reservedWalletCount] = await Promise.all([
      this.prisma.order.count({
        where: {
          status: OrderStatus.submitted,
          orderType: OrderType.limit,
          side: OrderSide.buy,
          seasonParticipant: { seasonId },
        },
      }),
      this.prisma.cashWallet.count({
        where: {
          seasonParticipant: { seasonId },
          reservedAmount: { gt: 0 },
        },
      }),
    ]);

    if (openLimitBuyOrderCount > 0 || reservedWalletCount > 0) {
      this.logger.error(
        JSON.stringify({
          event: 'season_settlement_blocked_open_limit_reservations',
          seasonId,
          openLimitBuyOrderCount,
          reservedWalletCount,
          recovery:
            'run season lifecycle transition cleanup to cancel open limit buys and release reservations, then retry settlement',
        }),
      );
      this.throwJobError(
        HttpStatus.CONFLICT,
        'OPEN_LIMIT_ORDER_RESERVATIONS',
        'Season settlement is blocked while submitted limit-buy orders or cash reservations remain.',
      );
    }
  }

  private async findEligibleParticipants(
    seasonId: string,
  ): Promise<SettlementParticipant[]> {
    return this.prisma.seasonParticipant.findMany({
      where: {
        seasonId,
        participantStatus: {
          in: [...SETTLEMENT_PARTICIPANT_STATUSES],
        },
      },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        totalFillCount: true,
      },
    });
  }

  private async calculateFinalValuations(input: {
    participants: readonly SettlementParticipant[];
    settlementAt: Date;
    settlementDate: Date;
  }): Promise<FinalValuation[]> {
    if (!this.portfolioValuationService) {
      return this.calculateFinalValuationsFromDailySnapshots(input);
    }

    const finalValuations: FinalValuation[] = [];

    for (const participant of input.participants) {
      const valuation =
        await this.portfolioValuationService.calculateSeasonParticipantValuation(
          participant.id,
          input.settlementAt,
          'season_settlement',
        );
      const history = await this.findEquityHistory(participant.id);
      const currentPoint = {
        totalAssetKrw: new Prisma.Decimal(valuation.totalAssetKrw),
        returnRate: new Prisma.Decimal(valuation.returnRate),
        capturedAt: input.settlementAt,
        createdAt: input.settlementAt,
      };
      const mergedHistory = appendCurrentPoint(history, currentPoint);
      const returnRate = new Prisma.Decimal(valuation.returnRate);

      finalValuations.push({
        seasonParticipantId: participant.id,
        userId: participant.userId,
        totalAssetKrw: valuation.totalAssetKrw,
        returnRate: valuation.returnRate,
        krwCash: valuation.krwCash,
        usdCashKrw: valuation.usdCashKrw,
        domesticStockValueKrw: valuation.domesticStockValueKrw,
        usStockValueKrw: valuation.usStockValueKrw,
        cryptoValueKrw: valuation.cryptoValueKrw,
        maxDrawdown: formatDecimalScale(
          calculateMaxDrawdown(mergedHistory),
          returnRateScale,
        ),
        totalFillCount: participant.totalFillCount,
        reachedReturnAt: calculateReachedReturnAt(
          mergedHistory,
          returnRate,
          input.settlementAt,
        ),
      });
    }

    return finalValuations;
  }

  private async calculateFinalValuationsFromDailySnapshots(input: {
    participants: readonly SettlementParticipant[];
    settlementAt: Date;
    settlementDate: Date;
  }): Promise<FinalValuation[]> {
    const snapshots = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate: input.settlementDate,
        seasonParticipant: {
          id: {
            in: input.participants.map((participant) => participant.id),
          },
        },
      },
      select: {
        seasonParticipantId: true,
        totalAssetKrw: true,
        returnRate: true,
        krwCash: true,
        usdCashKrw: true,
        assetValueKrw: true,
        capturedAt: true,
        createdAt: true,
        seasonParticipant: {
          select: {
            userId: true,
          },
        },
      },
    });
    const fillCountByParticipant = new Map(
      input.participants.map((participant) => [
        participant.id,
        participant.totalFillCount,
      ]),
    );

    return snapshots.map((snapshot) => {
      const point = {
        totalAssetKrw: snapshot.totalAssetKrw,
        returnRate: snapshot.returnRate,
        capturedAt: snapshot.capturedAt,
        createdAt: snapshot.createdAt,
      };

      return {
        seasonParticipantId: snapshot.seasonParticipantId,
        userId: snapshot.seasonParticipant.userId,
        totalAssetKrw: formatMoneyScale8(snapshot.totalAssetKrw),
        returnRate: formatDecimalScale(snapshot.returnRate, returnRateScale),
        krwCash: formatMoneyScale8(snapshot.krwCash ?? '0'),
        usdCashKrw: formatMoneyScale8(snapshot.usdCashKrw ?? '0'),
        domesticStockValueKrw: formatMoneyScale8(snapshot.assetValueKrw ?? '0'),
        usStockValueKrw: '0.00000000',
        cryptoValueKrw: '0.00000000',
        maxDrawdown: formatDecimalScale(calculateMaxDrawdown([point]), 8),
        totalFillCount:
          fillCountByParticipant.get(snapshot.seasonParticipantId) ?? 0,
        reachedReturnAt: snapshot.capturedAt ?? input.settlementAt,
      };
    });
  }

  private async findEquityHistory(
    seasonParticipantId: string,
  ): Promise<EquityHistoryPoint[]> {
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

  private buildFinalRankingRows(
    finalValuations: readonly FinalValuation[],
  ): FinalRankingRow[] {
    const ranked = assignSequentialRanks(
      finalValuations
        .map((valuation) => ({
          ...valuation,
          reachedReturnAt: valuation.reachedReturnAt,
        }))
        .toSorted(compareRankingRows),
    );

    return ranked.map((row) => ({
      ...row,
      finalTier: this.assignFinalTier(row.rank, ranked.length),
    }));
  }

  private async createFinalSettlementAtomically(input: {
    seasonId: string;
    settlementDate: Date;
    capturedAt: Date;
    finalRows: readonly FinalRankingRow[];
  }): Promise<{
    createdFinalSnapshotIds: string[];
    updatedFinalSnapshotIds: string[];
    createdFinalRankingIds: string[];
    assignedFinalTierParticipantIds: string[];
    seasonUpdated: boolean;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const existingRows = await this.findExistingFinalRankingRows(
        tx,
        input.seasonId,
        input.settlementDate,
      );

      if (existingRows.length > 0) {
        const assigned = await this.assignFinalResultsForExistingRows(
          tx,
          input.seasonId,
          existingRows,
        );
        const seasonUpdated = await this.transitionSeasonToSettledIfReady(tx, {
          seasonId: input.seasonId,
          settlementDate: input.settlementDate,
          expectedParticipants: existingRows.length,
        });

        return {
          createdFinalSnapshotIds: [],
          updatedFinalSnapshotIds: [],
          createdFinalRankingIds: [],
          assignedFinalTierParticipantIds: assigned,
          seasonUpdated,
        };
      }

      if (input.finalRows.length === 0) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'FINAL_RANKINGS_NOT_FOUND',
          'Final rankings disappeared before settlement status update.',
        );
      }

      const createdFinalSnapshotIds: string[] = [];
      const updatedFinalSnapshotIds: string[] = [];
      const createdFinalRankingIds: string[] = [];
      const assignedFinalTierParticipantIds: string[] = [];

      for (const row of input.finalRows) {
        const existingSnapshot = await tx.equitySnapshot.findFirst({
          where: {
            seasonParticipantId: row.seasonParticipantId,
            snapshotReason: SnapshotReason.settlement,
          },
          orderBy: [
            { capturedAt: 'desc' },
            { createdAt: 'desc' },
            { id: 'asc' },
          ],
          select: {
            id: true,
          },
        });
        const snapshotData = {
          totalAssetKrw: row.totalAssetKrw,
          returnRate: row.returnRate,
          krwCash: row.krwCash,
          usdCashKrw: row.usdCashKrw,
          domesticStockValueKrw: row.domesticStockValueKrw,
          usStockValueKrw: row.usStockValueKrw,
          cryptoValueKrw: row.cryptoValueKrw,
          capturedAt: input.capturedAt,
        };

        if (existingSnapshot) {
          await tx.equitySnapshot.update({
            where: {
              id: existingSnapshot.id,
            },
            data: snapshotData,
            select: {
              id: true,
            },
          });
          updatedFinalSnapshotIds.push(existingSnapshot.id);
        } else {
          const createdSnapshot = await tx.equitySnapshot.create({
            data: {
              seasonParticipantId: row.seasonParticipantId,
              ...snapshotData,
              snapshotReason: SnapshotReason.settlement,
            },
            select: {
              id: true,
            },
          });
          createdFinalSnapshotIds.push(createdSnapshot.id);
        }

        await tx.seasonParticipant.update({
          where: {
            id: row.seasonParticipantId,
          },
          data: {
            totalAssetKrw: row.totalAssetKrw,
            totalReturnRate: row.returnRate,
            maxDrawdown: row.maxDrawdown,
            finalRank: row.rank,
            finalTier: row.finalTier,
            currentRank: row.rank,
          },
          select: {
            id: true,
          },
        });
        assignedFinalTierParticipantIds.push(row.seasonParticipantId);

        const createdRanking = await tx.seasonRanking.create({
          data: {
            seasonId: input.seasonId,
            seasonParticipantId: row.seasonParticipantId,
            rankType: FINAL_RANK_TYPE,
            rank: row.rank,
            totalAssetKrw: row.totalAssetKrw,
            returnRate: row.returnRate,
            maxDrawdown: row.maxDrawdown,
            totalFillCount: row.totalFillCount,
            reachedReturnAt: row.reachedReturnAt,
            rankingDate: input.settlementDate,
            capturedAt: input.capturedAt,
          },
          select: {
            id: true,
          },
        });
        createdFinalRankingIds.push(createdRanking.id);
      }

      const seasonUpdated = await this.transitionSeasonToSettledIfReady(tx, {
        seasonId: input.seasonId,
        settlementDate: input.settlementDate,
        expectedParticipants: input.finalRows.length,
      });

      return {
        createdFinalSnapshotIds,
        updatedFinalSnapshotIds,
        createdFinalRankingIds,
        assignedFinalTierParticipantIds,
        seasonUpdated,
      };
    });
  }

  private async handleExistingFinalRankings(input: {
    season: SettlementSeason;
    settlementDate: Date;
    settlementDateText: string;
    participants: readonly SettlementParticipant[];
    existingFinalRankings: readonly ExistingFinalRankingRow[];
    dryRun: boolean;
    result: SeasonSettlementJobResult;
  }): Promise<SeasonSettlementJobResult> {
    input.result.participants.snapshotted = input.existingFinalRankings.length;
    input.result.participants.missingSnapshots = Math.max(
      input.participants.length - input.existingFinalRankings.length,
      0,
    );
    input.result.finalRankings.existing = input.existingFinalRankings.length;
    input.result.finalRankings.skipped = input.existingFinalRankings.length;
    input.result.topRanks = input.existingFinalRankings
      .slice(0, TOP_RANKS_LIMIT)
      .map((row) => this.formatExistingRankingRow(row));

    if (input.result.participants.missingSnapshots > 0) {
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        'MISSING_FINAL_RANKINGS',
        'Some eligible participants do not have final ranking rows.',
        input.result,
      );
    }

    if (input.dryRun) {
      input.result.message =
        'Final rankings already exist; dry-run did not assign tiers or update season status.';
      return input.result;
    }

    const writeResult = await this.createFinalSettlementAtomically({
      seasonId: input.season.id,
      settlementDate: input.settlementDate,
      capturedAt: new Date(),
      finalRows: [],
    });

    input.result.finalTiers.assigned =
      writeResult.assignedFinalTierParticipantIds.length;
    input.result.assignedFinalTierParticipantIds =
      writeResult.assignedFinalTierParticipantIds;
    input.result.season.updated = writeResult.seasonUpdated;
    input.result.message =
      input.season.status === SeasonStatus.settled
        ? 'Season is already settled; existing final rankings and tiers are preserved.'
        : 'Existing final rankings were reused; final tiers were assigned before settling.';

    return input.result;
  }

  private async findExistingFinalRankingRows(
    client: PrismaService | Prisma.TransactionClient,
    seasonId: string,
    settlementDate: Date,
  ): Promise<ExistingFinalRankingRow[]> {
    return client.seasonRanking.findMany({
      where: {
        seasonId,
        rankType: FINAL_RANK_TYPE,
        rankingDate: settlementDate,
      },
      orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
      select: {
        id: true,
        seasonParticipantId: true,
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
        seasonParticipant: {
          select: {
            userId: true,
          },
        },
      },
    });
  }

  private async assignFinalResultsForExistingRows(
    tx: Prisma.TransactionClient,
    seasonId: string,
    existingRows: readonly ExistingFinalRankingRow[],
  ): Promise<string[]> {
    const assignedParticipantIds: string[] = [];

    for (const row of existingRows) {
      const finalTier = this.assignFinalTier(row.rank, existingRows.length);
      await tx.seasonParticipant.updateMany({
        where: {
          id: row.seasonParticipantId,
          seasonId,
        },
        data: {
          finalRank: row.rank,
          finalTier,
          currentRank: row.rank,
        },
      });
      assignedParticipantIds.push(row.seasonParticipantId);
    }

    return assignedParticipantIds;
  }

  private async transitionSeasonToSettledIfReady(
    tx: Prisma.TransactionClient,
    input: {
      seasonId: string;
      settlementDate: Date;
      expectedParticipants: number;
    },
  ): Promise<boolean> {
    const [finalRankingCount, missingFinalResultCount] = await Promise.all([
      tx.seasonRanking.count({
        where: {
          seasonId: input.seasonId,
          rankType: FINAL_RANK_TYPE,
          rankingDate: input.settlementDate,
        },
      }),
      tx.seasonParticipant.count({
        where: {
          seasonId: input.seasonId,
          participantStatus: {
            in: [...SETTLEMENT_PARTICIPANT_STATUSES],
          },
          OR: [{ finalRank: null }, { finalTier: null }],
        },
      }),
    ]);

    if (
      finalRankingCount !== input.expectedParticipants ||
      missingFinalResultCount !== 0
    ) {
      this.throwJobError(
        HttpStatus.CONFLICT,
        'FINAL_RESULTS_NOT_READY',
        'Final rankings and final tiers must be ready before settled status.',
      );
    }

    const updated = await tx.season.updateMany({
      where: {
        id: input.seasonId,
        status: {
          in: [SeasonStatus.ended, SeasonStatus.settled],
        },
      },
      data: {
        status: SeasonStatus.settled,
      },
    });

    return updated.count === 1;
  }

  private assignFinalTier(rank: number, totalParticipants: number): string {
    for (const rule of FINAL_TIER_CUTOFF_RULES) {
      if (rank <= Math.ceil(totalParticipants * rule.cumulativeRatio)) {
        return rule.tier;
      }
    }

    return 'bronze';
  }

  private formatFinalRankingRow(
    row: FinalRankingRow,
  ): SeasonSettlementJobTopRank {
    return {
      seasonParticipantId: row.seasonParticipantId,
      userId: row.userId,
      rank: row.rank,
      totalAssetKrw: row.totalAssetKrw,
      returnRate: row.returnRate,
      maxDrawdown: row.maxDrawdown,
      totalFillCount: row.totalFillCount,
      reachedReturnAt: row.reachedReturnAt.toISOString(),
    };
  }

  private formatExistingRankingRow(
    input: ExistingFinalRankingRow,
  ): SeasonSettlementJobTopRank {
    return {
      seasonParticipantId: input.seasonParticipantId,
      userId: input.seasonParticipant.userId,
      rank: input.rank,
      totalAssetKrw: formatMoneyScale8(input.totalAssetKrw),
      returnRate: formatDecimalScale(input.returnRate, returnRateScale),
      maxDrawdown: formatDecimalScale(input.maxDrawdown, returnRateScale),
      totalFillCount: input.totalFillCount,
      reachedReturnAt: input.reachedReturnAt?.toISOString() ?? null,
    };
  }

  private createBaseResult(input: {
    seasonId: string;
    settlementDate: string;
    dryRun: boolean;
    previousStatus: SeasonStatus;
    participantsTotal: number;
    snapshotted: number;
    missingSnapshots: number;
  }): SeasonSettlementJobResult {
    return {
      seasonId: input.seasonId,
      settlementDate: input.settlementDate,
      dryRun: input.dryRun,
      season: {
        previousStatus: input.previousStatus,
        nextStatus: SeasonStatus.settled,
        updated: false,
      },
      participants: {
        total: input.participantsTotal,
        snapshotted: input.snapshotted,
        missingSnapshots: input.missingSnapshots,
      },
      finalSnapshots: {
        wouldCreate: 0,
        created: 0,
        updated: 0,
        existing: 0,
      },
      finalRankings: {
        wouldCreate: 0,
        created: 0,
        existing: 0,
        skipped: 0,
      },
      finalTiers: {
        wouldAssign: 0,
        assigned: 0,
        existing: 0,
        skipped: 0,
      },
      createdFinalSnapshotIds: [],
      updatedFinalSnapshotIds: [],
      createdFinalRankingIds: [],
      assignedFinalTierParticipantIds: [],
      topRanks: [],
      errors: [],
    };
  }

  private resolveIdempotencyKey(input: SeasonSettlementJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    return `${SEASON_SETTLEMENT_JOB_NAME}:${this.toBusinessKeySegment(
      input.seasonId,
      'missing-season-id',
    )}:${this.toBusinessKeySegment(
      input.settlementDate,
      'missing-settlement-date',
    )}`;
  }

  private parseSettlementDate(value: string | undefined): {
    text: string;
    date: Date;
  } {
    const text = this.parseRequiredText(value, 'settlementDate');
    if (!DATE_ONLY_PATTERN.test(text)) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'settlementDate must be YYYY-MM-DD.',
      );
    }

    const date = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || this.formatDateOnly(date) !== text) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'settlementDate must be YYYY-MM-DD.',
      );
    }

    return {
      text,
      date,
    };
  }

  private parseRequiredText(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        `${fieldName} is required.`,
      );
    }

    return value.trim();
  }

  private parseOptionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const text = value.trim();
    return text === '' ? undefined : text;
  }

  private toBusinessKeySegment(value: unknown, fallback: string): string {
    return this.parseOptionalText(value) ?? fallback;
  }

  private formatDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private failWithResult(
    status: HttpStatus,
    code: string,
    message: string,
    result: SeasonSettlementJobResult,
  ): never {
    result.reason = code;
    result.message = message;
    result.errors.push({
      code,
      message,
    });

    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
        data: {
          resultPayloadJson: result,
        },
      },
      status,
    );
  }

  private throwJobError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      status,
    );
  }
}

function appendCurrentPoint(
  history: readonly EquityHistoryPoint[],
  currentPoint: EquityHistoryPoint,
): EquityHistoryPoint[] {
  const withoutExistingFinalAtSameTime = history.filter(
    (snapshot) =>
      snapshot.capturedAt.getTime() !== currentPoint.capturedAt.getTime(),
  );

  return [...withoutExistingFinalAtSameTime, currentPoint];
}
