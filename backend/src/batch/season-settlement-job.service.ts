import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
  SnapshotReason,
  TradingAccountMode,
  TradingAccountStatus,
} from '../generated/prisma/client';
import {
  formatDecimalScale,
  formatMoneyScale8,
  returnRateScale,
} from '../fx/fx-decimal-policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  requireParticipantTradingAccountIdForSnapshot,
  requireSeasonSnapshotParticipantId,
  seasonSnapshotWhere,
} from '../portfolio/season-snapshot-scope';
import {
  assignSequentialRanks,
  compareRankingRows,
} from '../ranking/ranking-calculation.policy';
import {
  calculateMaxDrawdown,
  calculateReachedReturnAt,
} from '../ranking/ranking-refresh.service';
import {
  assertRankingSourceSnapshotScopes,
  buildRankingParticipantScopes,
  RANKING_PARTICIPANT_SCOPE_SELECT,
  rankingSourceScopeErrorCodes,
} from '../ranking/ranking-source-scope';
import {
  assertSeasonRankingScopes,
  resolveSeasonRankingAccountScopes,
  SEASON_RANKING_SCOPE_SELECT,
} from '../ranking/season-ranking-scope';
import { lockSeasonForWriteOrThrow } from '../ranking/season-write-lock';
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
  seasonId: string;
  userId: string;
  totalFillCount: number;
  /** Verified into a non-null scope by `buildRankingParticipantScopes`. */
  tradingAccountId: string | null;
  tradingAccount: {
    id: string;
    mode: TradingAccountMode;
    userId: string;
  } | null;
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
  seasonId: string;
  seasonParticipantId: string;
  tradingAccountId: string | null;
  rank: number;
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  maxDrawdown: Prisma.Decimal;
  totalFillCount: number;
  reachedReturnAt: Date | null;
  seasonParticipant: {
    id: string;
    seasonId: string;
    userId: string;
    tradingAccountId: string | null;
    tradingAccount: {
      id: string;
      mode: TradingAccountMode;
      userId: string;
    } | null;
  };
};

/**
 * The confirmed result one participant must end the settlement with, taken
 * from the final ranking row that produced it (작업 8 보완 §A-2). Both paths
 * supply it: freshly computed rows carry formatted strings, reused rows carry
 * `Prisma.Decimal`s, and the comparison is decimal-valued either way.
 */
type SettlementFinalResultExpectation = {
  seasonParticipantId: string;
  rank: number;
  totalAssetKrw: Prisma.Decimal | string;
  returnRate: Prisma.Decimal | string;
  maxDrawdown: Prisma.Decimal | string;
  totalFillCount: number;
};

/**
 * Every participant of the season being settled, WHATEVER its status.
 *
 * Final RANKING is still eligible-only (active/finished/rewarded). Account
 * CLOSURE is not: when a season becomes `settled`, every trading account that
 * belonged to it stops being a live account, including an excluded
 * participant's. Leaving one open would mean a settled season still has an
 * account that reads as tradable (작업 8 §14.2).
 */
type SettlementAccountParticipant = {
  id: string;
  userId: string;
  participantStatus: ParticipantStatus;
  tradingAccountId: string | null;
  tradingAccount: {
    id: string;
    mode: TradingAccountMode;
    status: TradingAccountStatus;
    userId: string;
    closedAt: Date | null;
    seasonParticipant: { id: string } | null;
  } | null;
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

    // §A-5: a settled season's results are already fixed. Anything other than
    // "a complete final ranking is present" is a data-integrity fault, NEVER a
    // reason to compute a new one.
    if (season.status === SeasonStatus.settled) {
      this.assertSettledSeasonFinalResultsPresent({
        seasonId,
        settlementDateText,
        participants,
        existingFinalRankings,
      });
    }

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

    // Verified participant → season account map, built ONCE from the list the
    // job already loaded (작업 8 보완 §A-1). No per-participant account lookup.
    const participantScopes = buildRankingParticipantScopes(
      seasonId,
      participants,
    );

    const finalValuations = await this.calculateFinalValuations({
      participants,
      participantScopes,
      settlementAt: season.endAt,
      settlementDate,
    }).catch((error) => {
      // A scope fault is not a transient valuation outage: collapsing it into
      // 503 FINAL_VALUATION_FAILED would tell the operator to retry a job that
      // can only ever fail until the repair scripts run.
      if (this.isRankingSourceScopeError(error)) {
        throw error;
      }

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

    // Season-wide, not eligible-only: settlement closes excluded participants'
    // accounts too (작업 8 §14.2).
    result.seasonAccounts.linked = await this.prisma.seasonParticipant.count({
      where: { seasonId, tradingAccountId: { not: null } },
    });
    result.seasonAccounts.wouldClose = result.seasonAccounts.linked;

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
    result.closedTradingAccountIds = writeResult.closedTradingAccountIds;
    result.finishedParticipantIds = writeResult.finishedParticipantIds;
    result.seasonAccounts.linked = writeResult.closedTradingAccountIds.length;
    result.seasonAccounts.closed = writeResult.closedTradingAccountIds.length;
    result.season.updated = writeResult.seasonUpdated;
    result.message =
      'Season settlement completed through final ranking, final tier assignment, and season account closure. Rewards remain pending.';

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
   * §A-5: what a `settled` season is allowed to be missing — nothing.
   *
   * `ended` + no final ranking is a first settlement, and `ended` + a final
   * ranking is a verified reuse. `settled` is different in kind: the result has
   * already been published, accounts are closed, and tiers may already be
   * assigned. Re-deriving a final valuation from TODAY's wallets and prices
   * would silently replace a published leaderboard with a different one, so a
   * settled season that cannot show its complete final ranking stops here
   * instead of manufacturing a replacement.
   *
   * Deliberately NOT auto-repaired: a settled season missing final rows means
   * either the settlement transaction was partially rolled back or the rows
   * were deleted, and neither is something a routine job re-derives.
   */
  private assertSettledSeasonFinalResultsPresent(input: {
    seasonId: string;
    settlementDateText: string;
    participants: readonly SettlementParticipant[];
    existingFinalRankings: readonly ExistingFinalRankingRow[];
  }): void {
    const fail = (detail: string): never =>
      this.throwJobError(
        HttpStatus.CONFLICT,
        'FINAL_RESULTS_INTEGRITY',
        `Season ${input.seasonId} is already settled but ${detail}. A settled season's final result is never recomputed from current wallets or prices; investigate and restore the final ranking instead of re-running settlement.`,
      );

    if (input.existingFinalRankings.length === 0) {
      fail(
        `has no final ranking rows for rankingDate ${input.settlementDateText}`,
      );
    }

    const rankedParticipantIds = new Set(
      input.existingFinalRankings.map((row) => row.seasonParticipantId),
    );
    if (rankedParticipantIds.size !== input.existingFinalRankings.length) {
      fail('has duplicate final ranking rows for the same participant');
    }

    const missing = input.participants.filter(
      (participant) => !rankedParticipantIds.has(participant.id),
    );
    if (missing.length > 0) {
      fail(
        `has ${missing.length} eligible participant(s) with no final ranking row (first: ${missing[0].id})`,
      );
    }

    const eligibleIds = new Set(
      input.participants.map((participant) => participant.id),
    );
    const extra = input.existingFinalRankings.filter(
      (row) => !eligibleIds.has(row.seasonParticipantId),
    );
    if (extra.length > 0) {
      fail(
        `has ${extra.length} final ranking row(s) whose participant is no longer eligible (first: ${extra[0].seasonParticipantId})`,
      );
    }
  }

  /** True for the structured ranking-INPUT scope faults raised by §A-1. */
  private isRankingSourceScopeError(error: unknown): boolean {
    if (!(error instanceof HttpException)) {
      return false;
    }

    const body = error.getResponse();
    const code =
      typeof body === 'object' && body !== null
        ? ((body as { error?: { code?: unknown } }).error?.code ?? null)
        : null;

    return (
      typeof code === 'string' &&
      (Object.values(rankingSourceScopeErrorCodes) as string[]).includes(code)
    );
  }

  /**
   * Settlement precondition: no submitted limit order, reserved wallet cash,
   * or reserved position quantity may remain for the season. Open
   * reservations mean assets are still fenced off and final valuations would
   * be settled against an unfinished order book — the season-lifecycle
   * cleanup (which cancels open limit orders of ended seasons on every tick)
   * must run first. Fails closed with a structured operational log.
   */
  private async assertNoOpenLimitReservations(
    seasonId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const [openLimitOrderCount, reservedWalletCount, reservedPositionCount] =
      await Promise.all([
        client.order.count({
          where: {
            status: OrderStatus.submitted,
            orderType: OrderType.limit,
            seasonParticipant: { seasonId },
          },
        }),
        client.cashWallet.count({
          where: {
            seasonParticipant: { seasonId },
            reservedAmount: { gt: 0 },
          },
        }),
        client.position.count({
          where: {
            seasonParticipant: { seasonId },
            reservedQuantity: { gt: 0 },
          },
        }),
      ]);

    if (
      openLimitOrderCount > 0 ||
      reservedWalletCount > 0 ||
      reservedPositionCount > 0
    ) {
      this.logger.error(
        JSON.stringify({
          event: 'season_settlement_blocked_open_limit_reservations',
          seasonId,
          openLimitOrderCount,
          reservedWalletCount,
          reservedPositionCount,
          recovery:
            'run season lifecycle transition cleanup to cancel open limit orders and release reservations, then retry settlement',
        }),
      );
      this.throwJobError(
        HttpStatus.CONFLICT,
        'OPEN_LIMIT_ORDER_RESERVATIONS',
        'Season settlement is blocked while submitted limit orders or reservations remain.',
      );
    }
  }

  /**
   * Eligible participants AND their account scope in ONE query (작업 8 보완 §A-1).
   *
   * Settlement's own valuation inputs — equity history and the daily-snapshot
   * fallback — are measured against this map, exactly like the daily ranking
   * job's inputs are. The account id is never looked up per participant.
   */
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
        ...RANKING_PARTICIPANT_SCOPE_SELECT,
        totalFillCount: true,
      },
    });
  }

  private async calculateFinalValuations(input: {
    participants: readonly SettlementParticipant[];
    participantScopes: ReadonlyMap<string, string>;
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
      const history = await this.findEquityHistory(
        participant.id,
        input.participantScopes,
      );
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

  /**
   * Daily-snapshot settlement fallback.
   *
   * Every row is scope-verified before ANY of it is valued (작업 8 보완 §A-1).
   * A mis-scoped row is not skipped: dropping one participant's snapshot both
   * removes them from the final ranking and shifts every rank below them, and
   * a season row carrying general-mode TWR columns would contribute a return
   * rate that is not the season's initial-capital return at all.
   */
  private async calculateFinalValuationsFromDailySnapshots(input: {
    participants: readonly SettlementParticipant[];
    participantScopes: ReadonlyMap<string, string>;
    settlementAt: Date;
    settlementDate: Date;
  }): Promise<FinalValuation[]> {
    const snapshots = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: {
        snapshotDate: input.settlementDate,
        // Season-only: general-mode daily rows must never reach settlement.
        ...seasonSnapshotWhere,
        seasonParticipant: {
          id: {
            in: input.participants.map((participant) => participant.id),
          },
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
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

    assertRankingSourceSnapshotScopes({
      kind: 'daily portfolio snapshot',
      rows: snapshots,
      participantScopes: input.participantScopes,
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
      const seasonParticipantId = requireSeasonSnapshotParticipantId(
        snapshot.seasonParticipantId,
      );

      return {
        seasonParticipantId,
        userId: snapshot.seasonParticipant?.userId ?? '',
        totalAssetKrw: formatMoneyScale8(snapshot.totalAssetKrw),
        returnRate: formatDecimalScale(snapshot.returnRate, returnRateScale),
        krwCash: formatMoneyScale8(snapshot.krwCash ?? '0'),
        usdCashKrw: formatMoneyScale8(snapshot.usdCashKrw ?? '0'),
        domesticStockValueKrw: formatMoneyScale8(snapshot.assetValueKrw ?? '0'),
        usStockValueKrw: '0.00000000',
        cryptoValueKrw: '0.00000000',
        maxDrawdown: formatDecimalScale(calculateMaxDrawdown([point]), 8),
        totalFillCount: fillCountByParticipant.get(seasonParticipantId) ?? 0,
        reachedReturnAt: snapshot.capturedAt ?? input.settlementAt,
      };
    });
  }

  /**
   * Max-drawdown / reached-return history for ONE participant, scope-verified
   * before use (작업 8 보완 §A-1).
   *
   * The same reasoning as the daily ranking job applies with more force here,
   * because these numbers become FINAL: silently excluding a mis-scoped low
   * point LOWERS this participant's max drawdown, which is tie-break #2, and
   * can permanently promote them over a competitor.
   */
  private async findEquityHistory(
    seasonParticipantId: string,
    participantScopes: ReadonlyMap<string, string>,
  ): Promise<EquityHistoryPoint[]> {
    const rows = await this.prisma.equitySnapshot.findMany({
      where: {
        seasonParticipantId,
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        seasonParticipantId: true,
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

  /**
   * THE settlement write. One transaction, one season row lock, and either
   * everything below commits or none of it does (작업 8 §14):
   *
   *   season row FOR UPDATE → status re-check → reservation re-check →
   *   participant/account link verification → settlement EquitySnapshot →
   *   final SeasonRanking (account dual-write) → participant final results →
   *   participant status transitions → season account closure →
   *   Season.status = settled
   *
   * WHY THE PRE-TRANSACTION CHECKS ARE REPEATED HERE
   * -----------------------------------------------
   * `assertNoOpenLimitReservations` and the status check ran against state read
   * BEFORE the lock. In between, a limit order could have been submitted and
   * cash re-reserved, and settling then would value accounts against an
   * unfinished order book. Under the season row lock the answers are stable.
   */
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
    closedTradingAccountIds: string[];
    finishedParticipantIds: string[];
  }> {
    return this.prisma.$transaction(async (tx) => {
      // 1) SERIALIZATION POINT (작업 8 §13.3). Ranking refresh and the daily
      //    ranking job take the same lock, so neither can rewrite this season's
      //    rows while the final result is being fixed.
      const season = await lockSeasonForWriteOrThrow(tx, input.seasonId);
      this.assertSeasonStatusAllowed(season.status);

      // 2) Preconditions re-verified under the lock, not merely before it.
      await this.assertNoOpenLimitReservations(input.seasonId, tx);

      // 3) EVERY participant of this season and its account, whatever status.
      const accountParticipants = await this.findSettlementAccountParticipants(
        tx,
        input.seasonId,
      );
      this.assertSettlementAccountLinks(input.seasonId, accountParticipants);

      const existingRows = await this.findExistingFinalRankingRows(
        tx,
        input.seasonId,
        input.settlementDate,
      );
      const eligibleAccountParticipants = accountParticipants.filter(
        (participant) =>
          SETTLEMENT_PARTICIPANT_STATUSES.includes(
            participant.participantStatus,
          ),
      );

      // §A-5 again, now under the lock: the pre-lock check read a status that
      // another settlement run may have advanced to `settled` since.
      if (season.status === SeasonStatus.settled && existingRows.length === 0) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'FINAL_RESULTS_INTEGRITY',
          `Season ${input.seasonId} became settled with no final ranking rows for this settlementDate; a settled season never receives a newly computed final ranking.`,
        );
      }

      if (existingRows.length > 0) {
        // Idempotent replay. The existing rows are re-verified rather than
        // trusted: assigning participant results from a mis-scoped final
        // ranking would hand one account another's placement (작업 8 §14.5).
        assertSeasonRankingScopes(existingRows);
        this.assertExistingFinalRankingSetCovers(
          input.seasonId,
          existingRows,
          eligibleAccountParticipants,
        );

        const assigned = await this.assignFinalResultsForExistingRows(
          tx,
          input.seasonId,
          existingRows,
        );
        const finishedParticipantIds = await this.finishActiveParticipants(
          tx,
          input.seasonId,
        );
        const closedTradingAccountIds = await this.closeSeasonTradingAccounts(
          tx,
          { season, participants: accountParticipants },
        );
        const seasonUpdated = await this.transitionSeasonToSettledIfReady(tx, {
          seasonId: input.seasonId,
          settlementDate: input.settlementDate,
          expectedParticipants: existingRows.length,
          accountParticipants,
          finalRankingRows: existingRows,
        });

        return {
          createdFinalSnapshotIds: [],
          updatedFinalSnapshotIds: [],
          createdFinalRankingIds: [],
          assignedFinalTierParticipantIds: assigned,
          seasonUpdated,
          closedTradingAccountIds,
          finishedParticipantIds,
        };
      }

      if (input.finalRows.length === 0) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'FINAL_RANKINGS_NOT_FOUND',
          'Final rankings disappeared before settlement status update.',
        );
      }

      // Resolved for ALL ranked participants up front; a broken link aborts the
      // settlement rather than producing a partial final ranking.
      const rankingScopes = await resolveSeasonRankingAccountScopes(tx, {
        seasonId: input.seasonId,
        seasonParticipantIds: input.finalRows.map(
          (row) => row.seasonParticipantId,
        ),
      });

      const createdFinalSnapshotIds: string[] = [];
      const updatedFinalSnapshotIds: string[] = [];
      const createdFinalRankingIds: string[] = [];
      const assignedFinalTierParticipantIds: string[] = [];

      for (const row of input.finalRows) {
        const tradingAccountId = rankingScopes.get(
          row.seasonParticipantId,
        )!.tradingAccountId;

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
            tradingAccountId: true,
            cumulativeExternalFundingKrw: true,
            investmentPnlKrw: true,
            timeWeightedReturnFactor: true,
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
          // The existing update-in-place policy is kept, but its SCOPE is
          // verified first: overwriting a row that belongs to another account,
          // or quietly filling a null scope through a routine settlement,
          // would launder damage the snapshot repair exists to surface.
          this.assertSettlementSnapshotScope(
            existingSnapshot,
            tradingAccountId,
          );

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
              // 작업 7 dual-write.
              tradingAccountId:
                await requireParticipantTradingAccountIdForSnapshot(
                  tx,
                  row.seasonParticipantId,
                ),
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
            // 작업 8 dual-write.
            tradingAccountId,
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

      const finishedParticipantIds = await this.finishActiveParticipants(
        tx,
        input.seasonId,
      );
      const closedTradingAccountIds = await this.closeSeasonTradingAccounts(
        tx,
        { season, participants: accountParticipants },
      );
      const seasonUpdated = await this.transitionSeasonToSettledIfReady(tx, {
        seasonId: input.seasonId,
        settlementDate: input.settlementDate,
        expectedParticipants: input.finalRows.length,
        accountParticipants,
        finalRankingRows: input.finalRows,
      });

      return {
        createdFinalSnapshotIds,
        updatedFinalSnapshotIds,
        createdFinalRankingIds,
        assignedFinalTierParticipantIds,
        seasonUpdated,
        closedTradingAccountIds,
        finishedParticipantIds,
      };
    });
  }

  // ------------------------------------------- season account lifecycle

  private async findSettlementAccountParticipants(
    tx: Prisma.TransactionClient,
    seasonId: string,
  ): Promise<SettlementAccountParticipant[]> {
    return tx.seasonParticipant.findMany({
      where: { seasonId },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        participantStatus: true,
        tradingAccountId: true,
        tradingAccount: {
          select: {
            id: true,
            mode: true,
            status: true,
            userId: true,
            closedAt: true,
            seasonParticipant: { select: { id: true } },
          },
        },
      },
    });
  }

  /**
   * Settlement closes accounts, so it must know EXACTLY which accounts belong
   * to this season before it changes any of them. One unresolvable participant
   * aborts the whole settlement — closing "most" of a season's accounts and
   * marking it settled is precisely the half-finished state §14.2 forbids.
   */
  private assertSettlementAccountLinks(
    seasonId: string,
    participants: readonly SettlementAccountParticipant[],
  ): void {
    for (const participant of participants) {
      const fail = (reason: string): never =>
        this.throwJobError(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'SETTLEMENT_ACCOUNT_LINK_INTEGRITY',
          `Season ${seasonId} cannot be settled: participant ${participant.id} ${reason}. Run "pnpm trading-accounts:repair-links --apply" and investigate; settlement never guesses an account.`,
        );

      if (!participant.tradingAccountId || !participant.tradingAccount) {
        fail('has no trading account link');
        continue;
      }

      const account = participant.tradingAccount;
      if (account.mode !== TradingAccountMode.season) {
        fail(`is linked to a "${account.mode}" account (${account.id})`);
      }
      if (account.userId !== participant.userId) {
        fail(`is linked to account ${account.id}, owned by a different user`);
      }
      if (account.seasonParticipant?.id !== participant.id) {
        fail(
          `is linked to account ${account.id}, which points back at participant ${account.seasonParticipant?.id ?? 'none'}`,
        );
      }
    }
  }

  /**
   * `active` → `finished`. Nothing else moves: `finished` and `rewarded` are
   * already terminal, `excluded` stays excluded (settlement never rehabilitates
   * a removed participant), and `registered` is left ALONE on purpose.
   *
   * A `registered` participant at settlement time is an anomaly — the join flow
   * activates on entry — and silently promoting it to `finished` would assert
   * it competed. It keeps its status, receives no final rank or tier, and is
   * logged; its ACCOUNT is still closed with the rest of the season
   * (작업 8 §14.3).
   */
  private async finishActiveParticipants(
    tx: Prisma.TransactionClient,
    seasonId: string,
  ): Promise<string[]> {
    const active = await tx.seasonParticipant.findMany({
      where: { seasonId, participantStatus: ParticipantStatus.active },
      select: { id: true },
    });

    if (active.length > 0) {
      await tx.seasonParticipant.updateMany({
        where: { seasonId, participantStatus: ParticipantStatus.active },
        data: { participantStatus: ParticipantStatus.finished },
      });
    }

    const registered = await tx.seasonParticipant.count({
      where: { seasonId, participantStatus: ParticipantStatus.registered },
    });
    if (registered > 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'season_settlement_registered_participants_left_as_is',
          seasonId,
          registeredParticipantCount: registered,
          policy:
            'registered participants are not promoted to finished and receive no final rank or tier; their season accounts are still closed',
        }),
      );
    }

    return active.map((participant) => participant.id);
  }

  /**
   * Closes every season account linked to this season.
   *
   * closedAt = COALESCE(existing closedAt, Season.endAt). The season stopped
   * being tradable at `endAt`; a settlement job that runs three days late must
   * not make the accounts look like they were live until then. An account that
   * already carries an earlier closedAt keeps it.
   *
   * `mode: season` is pinned in every WHERE, so a general account can never be
   * touched by settlement, and no account is ever re-activated: status is only
   * ever written as `closed`.
   */
  private async closeSeasonTradingAccounts(
    tx: Prisma.TransactionClient,
    input: {
      season: { id: string; endAt: Date };
      participants: readonly SettlementAccountParticipant[];
    },
  ): Promise<string[]> {
    const accountIds = input.participants
      .map((participant) => participant.tradingAccountId)
      .filter((id): id is string => id !== null);

    if (accountIds.length === 0) {
      return [];
    }

    // Never-closed accounts: close them and stamp the season's end.
    await tx.tradingAccount.updateMany({
      where: {
        id: { in: accountIds },
        mode: TradingAccountMode.season,
        closedAt: null,
      },
      data: {
        status: TradingAccountStatus.closed,
        closedAt: input.season.endAt,
      },
    });

    // Already carry a closedAt but are not marked closed: preserve the earlier
    // timestamp, only fix the status.
    await tx.tradingAccount.updateMany({
      where: {
        id: { in: accountIds },
        mode: TradingAccountMode.season,
        closedAt: { not: null },
        status: { not: TradingAccountStatus.closed },
      },
      data: { status: TradingAccountStatus.closed },
    });

    // Fail closed rather than leave a settled season holding a live account.
    const unclosed = await tx.tradingAccount.count({
      where: {
        id: { in: accountIds },
        OR: [
          { status: { not: TradingAccountStatus.closed } },
          { closedAt: null },
        ],
      },
    });
    if (unclosed > 0) {
      this.throwJobError(
        HttpStatus.CONFLICT,
        'SEASON_ACCOUNT_CLOSE_INCOMPLETE',
        `${unclosed} season trading account(s) could not be closed; the whole settlement is rolled back rather than leaving a settled season with live accounts.`,
      );
    }

    return accountIds;
  }

  /**
   * A settlement snapshot that already exists must belong to the same account
   * the final ranking is being written for.
   */
  private assertSettlementSnapshotScope(
    snapshot: {
      id: string;
      tradingAccountId: string | null;
      cumulativeExternalFundingKrw: Prisma.Decimal | null;
      investmentPnlKrw: Prisma.Decimal | null;
      timeWeightedReturnFactor: Prisma.Decimal | null;
    },
    expectedTradingAccountId: string,
  ): void {
    if (snapshot.tradingAccountId === null) {
      this.throwJobError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'SETTLEMENT_SNAPSHOT_SCOPE_REPAIR_REQUIRED',
        `Settlement snapshot ${snapshot.id} has no trading account scope. Run "pnpm trading-accounts:repair-snapshot-scope --apply" first; settlement never fills it in as a side effect.`,
      );
    }
    if (snapshot.tradingAccountId !== expectedTradingAccountId) {
      this.throwJobError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'SETTLEMENT_SNAPSHOT_SCOPE_MISMATCH',
        `Settlement snapshot ${snapshot.id} is scoped to account ${snapshot.tradingAccountId} but its participant is linked to ${expectedTradingAccountId}; it is never overwritten.`,
      );
    }
    if (
      snapshot.cumulativeExternalFundingKrw !== null ||
      snapshot.investmentPnlKrw !== null ||
      snapshot.timeWeightedReturnFactor !== null
    ) {
      this.throwJobError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'SETTLEMENT_SNAPSHOT_SCOPE_MISMATCH',
        `Settlement snapshot ${snapshot.id} carries general-mode performance columns; a season settlement snapshot never does.`,
      );
    }
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

    // Verified even on the dry-run path, so an operator planning a settlement
    // sees the damage instead of a clean-looking preview (작업 8 §11).
    assertSeasonRankingScopes(input.existingFinalRankings);

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
    input.result.closedTradingAccountIds = writeResult.closedTradingAccountIds;
    input.result.finishedParticipantIds = writeResult.finishedParticipantIds;
    input.result.seasonAccounts.linked =
      writeResult.closedTradingAccountIds.length;
    input.result.seasonAccounts.closed =
      writeResult.closedTradingAccountIds.length;
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
        ...SEASON_RANKING_SCOPE_SELECT,
        id: true,
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
        seasonParticipant: {
          select: {
            ...SEASON_RANKING_SCOPE_SELECT.seasonParticipant.select,
            userId: true,
          },
        },
      },
    });
  }

  /**
   * §A-2: the final ranking set must COVER the eligible participants exactly.
   *
   * `handleExistingFinalRankings` only compared counts read before the lock, so
   * a set with one duplicate participant and one missing participant had the
   * right length and passed. Reusing it would then leave the missing
   * participant with no final result at all while the season flipped to
   * settled — the exact half-finished state settlement exists to prevent.
   */
  private assertExistingFinalRankingSetCovers(
    seasonId: string,
    existingRows: readonly ExistingFinalRankingRow[],
    eligibleParticipants: readonly SettlementAccountParticipant[],
  ): void {
    const fail = (detail: string): never =>
      this.throwJobError(
        HttpStatus.CONFLICT,
        'FINAL_RESULTS_INTEGRITY',
        `Season ${seasonId} cannot reuse its existing final ranking: ${detail}. Settlement never completes a partially-covered final ranking.`,
      );

    const rankedIds = new Set(
      existingRows.map((row) => row.seasonParticipantId),
    );
    if (rankedIds.size !== existingRows.length) {
      fail('the same participant occupies more than one final ranking row');
    }

    const eligibleIds = new Set(
      eligibleParticipants.map((participant) => participant.id),
    );
    const missing = eligibleParticipants.filter(
      (participant) => !rankedIds.has(participant.id),
    );
    if (missing.length > 0) {
      fail(
        `${missing.length} eligible participant(s) have no final ranking row (first: ${missing[0].id})`,
      );
    }

    const extra = existingRows.filter(
      (row) => !eligibleIds.has(row.seasonParticipantId),
    );
    if (extra.length > 0) {
      fail(
        `${extra.length} final ranking row(s) belong to a participant that is not eligible for settlement (first: ${extra[0].seasonParticipantId})`,
      );
    }
  }

  /**
   * §A-2: when an existing final ranking is REUSED, that ranking row is the
   * authority for the participant's confirmed result — not just for its rank.
   *
   * Previously only `finalRank`, `finalTier`, and `currentRank` were aligned,
   * so a participant could be settled carrying a `totalAssetKrw`,
   * `totalReturnRate`, `maxDrawdown`, or `totalFillCount` left over from the
   * last live refresh while the leaderboard published different numbers. Users
   * saw one figure on their own record card and another on the ranking, both
   * "final", with nothing in the data saying which was right.
   *
   * Writing all six from the ranking row is idempotent: a replay of an already
   * consistent season writes the values it already has.
   */
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
          totalAssetKrw: row.totalAssetKrw,
          totalReturnRate: row.returnRate,
          maxDrawdown: row.maxDrawdown,
          totalFillCount: row.totalFillCount,
          finalRank: row.rank,
          finalTier,
          currentRank: row.rank,
        },
      });
      assignedParticipantIds.push(row.seasonParticipantId);
    }

    return assignedParticipantIds;
  }

  /**
   * §A-2 final gate: the numbers a participant will be settled with must EQUAL
   * the final ranking row they came from, re-read from the database inside this
   * transaction rather than assumed from what was just written.
   *
   * Both settlement paths land here — the freshly computed one and the reuse
   * one — so "some fields match and some do not" can never be reported as a
   * completed settlement. Any disagreement throws, which rolls back the
   * participant updates, the account closures, and the status transition
   * together.
   */
  private async assertParticipantResultsMatchFinalRanking(
    tx: Prisma.TransactionClient,
    input: {
      seasonId: string;
      finalRankingRows: readonly SettlementFinalResultExpectation[];
    },
  ): Promise<void> {
    if (input.finalRankingRows.length === 0) {
      return;
    }

    const stored = await tx.seasonParticipant.findMany({
      where: {
        seasonId: input.seasonId,
        id: {
          in: input.finalRankingRows.map((row) => row.seasonParticipantId),
        },
      },
      select: {
        id: true,
        totalAssetKrw: true,
        totalReturnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        currentRank: true,
        finalRank: true,
        finalTier: true,
      },
    });
    const storedById = new Map(stored.map((row) => [row.id, row]));

    const fail = (participantId: string, detail: string): never =>
      this.throwJobError(
        HttpStatus.CONFLICT,
        'FINAL_RESULTS_INTEGRITY',
        `Season participant ${participantId} would be settled with ${detail}. The whole settlement is rolled back rather than publishing a result the final ranking contradicts.`,
      );

    for (const row of input.finalRankingRows) {
      const participant = storedById.get(row.seasonParticipantId);
      if (!participant) {
        fail(
          row.seasonParticipantId,
          'no participant row for its final ranking',
        );
        continue;
      }

      const expectedTier = this.assignFinalTier(
        row.rank,
        input.finalRankingRows.length,
      );
      const mismatches: string[] = [];

      if (!decimalEquals(participant.totalAssetKrw, row.totalAssetKrw)) {
        mismatches.push(
          `totalAssetKrw=${participant.totalAssetKrw.toString()} vs ranking ${row.totalAssetKrw.toString()}`,
        );
      }
      if (!decimalEquals(participant.totalReturnRate, row.returnRate)) {
        mismatches.push(
          `totalReturnRate=${participant.totalReturnRate.toString()} vs ranking ${row.returnRate.toString()}`,
        );
      }
      if (!decimalEquals(participant.maxDrawdown, row.maxDrawdown)) {
        mismatches.push(
          `maxDrawdown=${participant.maxDrawdown.toString()} vs ranking ${row.maxDrawdown.toString()}`,
        );
      }
      if (participant.totalFillCount !== row.totalFillCount) {
        mismatches.push(
          `totalFillCount=${participant.totalFillCount} vs ranking ${row.totalFillCount}`,
        );
      }
      if (participant.currentRank !== row.rank) {
        mismatches.push(
          `currentRank=${participant.currentRank ?? 'null'} vs ranking ${row.rank}`,
        );
      }
      if (participant.finalRank !== row.rank) {
        mismatches.push(
          `finalRank=${participant.finalRank ?? 'null'} vs ranking ${row.rank}`,
        );
      }
      if (participant.finalTier !== expectedTier) {
        mismatches.push(
          `finalTier=${participant.finalTier ?? 'null'} vs policy "${expectedTier}"`,
        );
      }

      if (mismatches.length > 0) {
        fail(row.seasonParticipantId, mismatches.join(', '));
      }
    }
  }

  private async transitionSeasonToSettledIfReady(
    tx: Prisma.TransactionClient,
    input: {
      seasonId: string;
      settlementDate: Date;
      expectedParticipants: number;
      accountParticipants: readonly SettlementAccountParticipant[];
      finalRankingRows: readonly SettlementFinalResultExpectation[];
    },
  ): Promise<boolean> {
    await this.assertParticipantResultsMatchFinalRanking(tx, {
      seasonId: input.seasonId,
      finalRankingRows: input.finalRankingRows,
    });

    const accountIds = input.accountParticipants
      .map((participant) => participant.tradingAccountId)
      .filter((id): id is string => id !== null);

    const [finalRankingCount, missingFinalResultCount, liveAccountCount] =
      await Promise.all([
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
        // §15: a settled season must have NO active/suspended linked account
        // and no linked account without a closedAt.
        accountIds.length === 0
          ? Promise.resolve(0)
          : tx.tradingAccount.count({
              where: {
                id: { in: accountIds },
                OR: [
                  { status: { not: TradingAccountStatus.closed } },
                  { closedAt: null },
                ],
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

    if (liveAccountCount !== 0) {
      this.throwJobError(
        HttpStatus.CONFLICT,
        'SEASON_ACCOUNT_CLOSE_INCOMPLETE',
        `${liveAccountCount} linked season trading account(s) are still open; a season is never marked settled while one of its accounts reads as live.`,
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
      seasonAccounts: {
        linked: 0,
        closed: 0,
        wouldClose: 0,
      },
      createdFinalSnapshotIds: [],
      updatedFinalSnapshotIds: [],
      createdFinalRankingIds: [],
      assignedFinalTierParticipantIds: [],
      closedTradingAccountIds: [],
      finishedParticipantIds: [],
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

/**
 * Value equality, not representation equality: `"1000"`, `"1000.00000000"` and
 * `Decimal(1000)` are the same settled amount, and a scale difference between
 * the participant column and the ranking column must not read as a mismatch.
 */
function decimalEquals(
  left: Prisma.Decimal | string | null,
  right: Prisma.Decimal | string,
): boolean {
  if (left === null) {
    return false;
  }

  return new Prisma.Decimal(left).equals(new Prisma.Decimal(right));
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
