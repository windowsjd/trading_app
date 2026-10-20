import { publicSeasonWhere } from '../seasons/season-availability.policy';
import type { FuturesValuationComponents } from '../portfolio/portfolio-valuation.policy';
import { futuresSnapshotValues } from '../portfolio/futures-snapshot-values';
import { FuturesSeasonSettlementService } from '../futures/futures-season-settlement.service';
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
  throwRankingSourceScope,
} from '../ranking/ranking-source-scope';
import {
  assertSeasonRankingScopes,
  resolveSeasonRankingAccountScopes,
  SEASON_RANKING_SCOPE_SELECT,
} from '../ranking/season-ranking-scope';
import { lockSeasonForWriteOrThrow } from '../ranking/season-write-lock';
import {
  evaluateFinalQualification,
  minRecognizedTurnoverKrwAtMoneyScale,
  readSeasonTradingActivity,
  resolveSeasonFinalQualificationCriteria,
  type SeasonFinalQualificationCriteria,
} from '../ranking/season-final-qualification';
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
/**
 * Budget of the final write (one transaction under the season row lock, a few
 * statements per participant). Prisma's default interactive-transaction
 * timeout is 5 s: measured on loopback PostgreSQL, a 10,000-participant season
 * held the lock until exactly that limit and every retry rolled back the same
 * way, so the season could never settle (docs/season-final-ranking-eligibility.md
 * §10). The season is `ended` (no trading), so a long ceiling only bounds a
 * write that is stuck; it changes neither what is written nor its atomicity.
 */
const FINAL_SETTLEMENT_WRITE_TIMEOUT_MS = 10 * 60_000;
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
  finalQualified: boolean | null;
  tradingAccountId: string;
  tradingAccount: {
    id: string;
    mode: TradingAccountMode;
    userId: string;
  };
};

type SettlementSeason = {
  id: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
  initialCapitalKrw: Prisma.Decimal;
  finalRankingMinTradedInstruments: number | null;
  finalRankingMinTurnoverRatio: Prisma.Decimal | null;
};

/**
 * The eligibility one participant ends the settlement with: written beside the
 * participant's final financial result, and the authority a replay of a
 * settled season is checked against (docs/season-final-ranking-eligibility.md).
 */
type FinalQualificationEvidence = {
  qualified: boolean;
  tradedInstrumentCount: number;
  recognizedTurnoverKrw: string;
};

type EquityHistoryPoint = {
  totalAssetKrw: Prisma.Decimal;
  returnRate: Prisma.Decimal;
  capturedAt: Date;
  createdAt?: Date | null;
};

type FinalValuation = Partial<FuturesValuationComponents> & {
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
  /** Eligibility seasons only: the verdict that admitted this row. */
  qualification?: FinalQualificationEvidence;
};

type ExistingFinalRankingRow = {
  id: string;
  seasonId: string;
  seasonParticipantId: string;
  tradingAccountId: string;
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
    tradingAccountId: string;
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
  /** First settlement of an eligibility season only. */
  qualification?: FinalQualificationEvidence;
};

/**
 * A participant valued at endAt that did not meet the season's eligibility
 * rule: its financial result is final like everyone else's, but it holds no
 * final rank, tier or ranking row.
 */
type SettlementUnrankedExpectation = {
  seasonParticipantId: string;
  totalAssetKrw: string;
  returnRate: string;
  maxDrawdown: string;
  qualification: FinalQualificationEvidence;
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
  finalQualified: boolean | null;
  tradingAccountId: string;
  tradingAccount: {
    id: string;
    mode: TradingAccountMode;
    status: TradingAccountStatus;
    userId: string;
    closedAt: Date | null;
    seasonParticipant: { id: string } | null;
  };
};

@Injectable()
export class SeasonSettlementJobService {
  private readonly logger = new Logger(SeasonSettlementJobService.name);

  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
    private readonly portfolioValuationService?: PortfolioValuationService,
    private readonly futuresFinal: FuturesSeasonSettlementService = new FuturesSeasonSettlementService(
      prisma,
    ),
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
    // NULL = the season has no eligibility rule: everyone eligible is ranked.
    const criteria = resolveSeasonFinalQualificationCriteria(season);
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
      criteria,
    });

    // Without an eligibility rule an empty season keeps its existing refusal.
    // Under a rule, "nobody to rank" is a normal final result: the season is
    // still settled — every linked account closed, any open Futures position
    // (e.g. an excluded participant's) finally settled — with an empty final
    // ranking and no verdict or snapshot for anyone who was not ranked.
    if (participants.length === 0 && !criteria) {
      this.failWithResult(
        HttpStatus.BAD_REQUEST,
        'NO_SETTLEMENT_PARTICIPANTS',
        'No eligible participants are available for settlement.',
        result,
      );
    }

    // Before any work, dry runs included: never a second final set (KST policy).
    await this.assertNoFinalRankingOnOtherDate(
      this.prisma,
      seasonId,
      settlementDate,
    );
    const existingFinalRankings = await this.findExistingFinalRankingRows(
      this.prisma,
      seasonId,
      settlementDate,
    );

    // §A-5: a settled season's results are already fixed. Anything other than
    // "a complete final ranking is present" is a data-integrity fault, NEVER a
    // reason to compute a new one. With an eligibility rule, "complete" means
    // every eligible participant carries its confirmed eligibility and the
    // ranking covers exactly the qualified ones (possibly none).
    if (season.status === SeasonStatus.settled) {
      this.assertSettledSeasonFinalResultsPresent({
        seasonId,
        settlementDateText,
        participants,
        existingFinalRankings,
        qualificationApplied: criteria !== null,
      });
    }

    // An eligibility season's final result is written only by the settlement
    // that confirms eligibility, atomically with `settled`. A final row or a
    // confirmed eligibility on an `ended` season came from somewhere else.
    if (criteria && season.status === SeasonStatus.ended) {
      this.assertNoFinalResultsBeforeQualification({
        seasonId,
        participants,
        existingFinalRankings,
      });
    }

    if (
      existingFinalRankings.length > 0 ||
      (criteria && season.status === SeasonStatus.settled)
    ) {
      await this.futuresFinal.assertNoOpen(seasonId);
      return this.handleExistingFinalRankings({
        season,
        settlementDate,
        settlementDateText,
        participants,
        existingFinalRankings,
        qualificationApplied: criteria !== null,
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

    // Eligibility is judged BEFORE the Futures final exit, the first step that
    // commits money (per-account transactions, not rolled back by a later
    // failure). Missing or contradictory eligibility evidence therefore stops
    // the settlement while every position, wallet and ledger is untouched;
    // failures after this point keep the existing resumable exit policy.
    // The verdict cannot drift before the final write: it reads only fills in
    // [startAt, endAt), which are closed once the season is `ended` (every
    // command re-checks the season under its lock), plus FX evidence that is
    // pinned per fill. A Season final exit is never a `futures_executions` row,
    // and a changed participant set still fails closed under the season lock.
    const qualification = criteria
      ? await this.evaluateFinalQualifications({
          season,
          criteria,
          participantScopes,
        })
      : null;

    const finalFuturesProjections = await this.futuresFinal.settleSeason(
      seasonId,
      dryRun,
    );
    const finalValuations = await this.calculateFinalValuations({
      participants,
      participantScopes,
      settlementAt: season.endAt,
      settlementDate,
      finalFuturesProjections: dryRun ? finalFuturesProjections : undefined,
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

    // Every valued participant has a verdict; only the qualified are ranked.
    const isRanked = (valuation: FinalValuation) =>
      !qualification ||
      qualification.get(valuation.seasonParticipantId)?.qualified === true;
    const finalRows = this.buildFinalRankingRows(
      finalValuations.filter(isRanked),
    ).map((row) => ({
      ...row,
      qualification: qualification?.get(row.seasonParticipantId),
    }));
    const unrankedValuations = finalValuations.filter(
      (valuation) => !isRanked(valuation),
    );
    result.participants.snapshotted = finalValuations.length;
    result.participants.missingSnapshots = Math.max(
      participants.length - finalValuations.length,
      0,
    );
    result.finalRankings.wouldCreate = finalRows.length;
    result.finalSnapshots.wouldCreate = finalValuations.length;
    result.finalTiers.wouldAssign = finalRows.length;
    if (qualification) {
      result.finalQualification.evaluated = qualification.size;
      result.finalQualification.qualified = finalRows.length;
      result.finalQualification.notQualified = unrankedValuations.length;
    }
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
      where: { seasonId },
    });
    result.seasonAccounts.wouldClose = result.seasonAccounts.linked;

    if (dryRun) {
      return result;
    }

    const writeResult = await this.createFinalSettlementAtomically({
      seasonId,
      settlementDate,
      capturedAt,
      qualificationApplied: criteria !== null,
      fresh: {
        finalRows,
        unranked: unrankedValuations.map((valuation) => ({
          valuation,
          qualification: qualification!.get(valuation.seasonParticipantId)!,
        })),
      },
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
      participants.length === 0
        ? 'Season settlement completed with no participant eligible for the final ranking, so the final ranking is empty. Every linked season account was closed.'
        : finalRows.length === 0
          ? 'Season settlement completed; no participant met the final ranking eligibility criteria, so the final ranking is empty. Every account was valued and closed.'
          : 'Season settlement completed through final ranking, final tier assignment, and season account closure. Rewards remain pending.';

    return result;
  }

  private async findSeasonOrThrow(seasonId: string): Promise<SettlementSeason> {
    const season = await this.prisma.season.findUnique({
      where: {
        ...publicSeasonWhere(),
        id: seasonId,
      },
      select: {
        id: true,
        status: true,
        startAt: true,
        endAt: true,
        initialCapitalKrw: true,
        finalRankingMinTradedInstruments: true,
        finalRankingMinTurnoverRatio: true,
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
    qualificationApplied: boolean;
  }): void {
    const fail = (detail: string): never =>
      this.throwJobError(
        HttpStatus.CONFLICT,
        'FINAL_RESULTS_INTEGRITY',
        `Season ${input.seasonId} is already settled but ${detail}. A settled season's final result is never recomputed from current wallets or prices; investigate and restore the final ranking instead of re-running settlement.`,
      );

    if (input.qualificationApplied) {
      const unconfirmed = input.participants.filter(
        (participant) => !hasVerdict(participant),
      );
      if (unconfirmed.length > 0) {
        fail(
          `has ${unconfirmed.length} eligible participant(s) without a confirmed final ranking eligibility (first: ${unconfirmed[0].id})`,
        );
      }
    }

    // Who the final ranking must cover: every eligible participant or, under an
    // eligibility rule, exactly the ones settlement confirmed as qualified —
    // possibly none, in which case an empty final ranking IS the result.
    const expected = input.qualificationApplied
      ? input.participants.filter(
          (participant) => participant.finalQualified === true,
        )
      : input.participants;

    if (input.existingFinalRankings.length === 0 && expected.length > 0) {
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

    const missing = expected.filter(
      (participant) => !rankedParticipantIds.has(participant.id),
    );
    if (missing.length > 0) {
      fail(
        `has ${missing.length} ${input.qualificationApplied ? 'qualified' : 'eligible'} participant(s) with no final ranking row (first: ${missing[0].id})`,
      );
    }

    const expectedIds = new Set(expected.map((participant) => participant.id));
    const extra = input.existingFinalRankings.filter(
      (row) => !expectedIds.has(row.seasonParticipantId),
    );
    if (extra.length > 0) {
      fail(
        `has ${extra.length} final ranking row(s) whose participant is no longer eligible${input.qualificationApplied ? ' or did not qualify' : ''} (first: ${extra[0].seasonParticipantId})`,
      );
    }
  }

  /**
   * An eligibility season is still `ended`: nothing may have published a final
   * rank or confirmed an eligibility yet. Final rows written by an operator
   * correction or a ranking script before settlement would bypass the rule, and
   * a stored verdict without `settled` is a half-applied settlement.
   */
  private assertNoFinalResultsBeforeQualification(input: {
    seasonId: string;
    participants: readonly SettlementParticipant[];
    existingFinalRankings: readonly ExistingFinalRankingRow[];
  }): void {
    const confirmed = input.participants.filter((participant) =>
      hasVerdict(participant),
    );
    if (input.existingFinalRankings.length === 0 && confirmed.length === 0) {
      return;
    }

    this.throwJobError(
      HttpStatus.CONFLICT,
      'FINAL_RESULTS_INTEGRITY',
      `Season ${input.seasonId} has an eligibility rule and is not settled, but already holds ${input.existingFinalRankings.length} final ranking row(s) and ${confirmed.length} confirmed eligibility verdict(s). Its final result is written only by the settlement that confirms eligibility; investigate instead of reusing them.`,
    );
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
    const [
      openLimitOrderCount,
      reservedWalletCount,
      reservedPositionCount,
      activeProtectionCount,
      openFuturesEntryCount,
      liveConditionalBuyCount,
      liveConditionalSellCount,
      liveFuturesConditionalEntryCount,
      liveFuturesTpSlCount,
    ] = await Promise.all([
      client.order.count({
        where: {
          status: OrderStatus.submitted,
          orderType: OrderType.limit,
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
      client.cashWallet.count({
        where: {
          tradingAccount: { seasonParticipant: { seasonId } },
          reservedAmount: { gt: 0 },
        },
      }),
      client.position.count({
        where: {
          tradingAccount: { seasonParticipant: { seasonId } },
          reservedQuantity: { gt: 0 },
        },
      }),
      client.protectionGroup.count({
        where: {
          status: { in: ['holding', 'active'] },
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
      client.futuresLimitOrder.count({
        where: {
          status: 'submitted',
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
      // Reservation-free watches still must not outlive the final result.
      client.conditionalBuyOrder.count({
        where: {
          status: { in: ['watching', 'triggered'] },
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
      client.conditionalSellOrder.count({
        where: {
          status: { in: ['watching', 'triggered'] },
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
      client.futuresConditionalEntry.count({
        where: {
          status: { in: ['watching', 'triggered'] },
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
      client.futuresTpSlSetting.count({
        where: {
          status: { in: ['watching', 'triggered'] },
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
    ]);

    if (
      openLimitOrderCount > 0 ||
      reservedWalletCount > 0 ||
      reservedPositionCount > 0 ||
      activeProtectionCount > 0 ||
      openFuturesEntryCount > 0 ||
      liveConditionalBuyCount > 0 ||
      liveConditionalSellCount > 0 ||
      liveFuturesConditionalEntryCount > 0 ||
      liveFuturesTpSlCount > 0
    ) {
      this.logger.error(
        JSON.stringify({
          event: 'season_settlement_blocked_open_limit_reservations',
          seasonId,
          openLimitOrderCount,
          reservedWalletCount,
          reservedPositionCount,
          activeProtectionCount,
          openFuturesEntryCount,
          liveConditionalBuyCount,
          liveConditionalSellCount,
          liveFuturesConditionalEntryCount,
          liveFuturesTpSlCount,
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
        finalQualified: true,
      },
    });
  }

  /**
   * One verdict per participant account, measured from the season's own fills
   * at Season.endAt. Integrity faults in the trading or FX evidence propagate
   * as their structured 500s: a participant is never marked "not qualified"
   * because its evidence could not be read.
   */
  private async evaluateFinalQualifications(input: {
    season: SettlementSeason;
    criteria: SeasonFinalQualificationCriteria;
    participantScopes: ReadonlyMap<string, string>;
  }): Promise<Map<string, FinalQualificationEvidence>> {
    const activity = await readSeasonTradingActivity(this.prisma, {
      season: input.season,
      tradingAccountIds: [...input.participantScopes.values()],
    });
    const verdicts = new Map<string, FinalQualificationEvidence>();

    for (const [participantId, tradingAccountId] of input.participantScopes) {
      const evaluation = evaluateFinalQualification(
        input.criteria,
        activity.get(tradingAccountId)!,
      );
      verdicts.set(participantId, {
        qualified: evaluation.qualified,
        tradedInstrumentCount: evaluation.tradedInstrumentCount,
        recognizedTurnoverKrw: formatMoneyScale8(
          evaluation.recognizedTurnoverKrw,
        ),
      });
    }

    return verdicts;
  }

  private async calculateFinalValuations(input: {
    participants: readonly SettlementParticipant[];
    participantScopes: ReadonlyMap<string, string>;
    settlementAt: Date;
    settlementDate: Date;
    finalFuturesProjections?: Map<string, Prisma.Decimal>;
  }): Promise<FinalValuation[]> {
    if (!this.portfolioValuationService) {
      return this.calculateFinalValuationsFromDailySnapshots(input);
    }

    const finalValuations: FinalValuation[] = [];
    const sourceReads = {
      client: this.prisma,
      valuationAtMs: +input.settlementAt,
      workflow: 'season_settlement' as const,
      assetPrices: new Map(),
    };

    for (const participant of input.participants) {
      const valuation =
        await this.portfolioValuationService.calculateTradingAccountValuation(
          participant.tradingAccountId,
          input.settlementAt,
          'season_settlement',
          this.prisma,
          sourceReads,
          input.finalFuturesProjections?.get(participant.tradingAccountId),
        );
      if (valuation.seasonParticipantId !== participant.id) {
        throw new Error(
          `Trading account ${participant.tradingAccountId} is not owned by settlement participant ${participant.id}.`,
        );
      }
      const history = await this.findEquityHistory(
        participant.id,
        input.participantScopes,
        input.settlementAt,
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
        ...futuresSnapshotValues(valuation),
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
        capturedAt: { lte: input.settlementAt },
        tradingAccountId: {
          in: [...input.participantScopes.values()],
        },
        tradingAccount: {
          seasonParticipant: {
            id: {
              in: input.participants.map((participant) => participant.id),
            },
          },
        },
      },
      select: {
        id: true,
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
      },
    });

    assertRankingSourceSnapshotScopes({
      kind: 'daily portfolio snapshot',
      rows: snapshots,
      participantScopes: input.participantScopes,
    });
    const seenAccountIds = new Set<string>();
    for (const snapshot of snapshots) {
      if (seenAccountIds.has(snapshot.tradingAccountId)) {
        throwRankingSourceScope(
          rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
          `Settlement snapshot input contains more than one row for account ${snapshot.tradingAccountId} on the settlement date.`,
        );
      }
      seenAccountIds.add(snapshot.tradingAccountId);
    }

    const fillCountByParticipant = new Map(
      input.participants.map((participant) => [
        participant.id,
        participant.totalFillCount,
      ]),
    );
    const participantByAccount = new Map(
      input.participants.map((participant) => [
        participant.tradingAccountId,
        participant,
      ]),
    );

    return snapshots.map((snapshot) => {
      const point = {
        totalAssetKrw: snapshot.totalAssetKrw,
        returnRate: snapshot.returnRate,
        capturedAt: snapshot.capturedAt,
        createdAt: snapshot.createdAt,
      };
      const participant = participantByAccount.get(snapshot.tradingAccountId)!;
      const seasonParticipantId = participant.id;

      return {
        seasonParticipantId,
        userId: participant.userId,
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
    endAt: Date,
  ): Promise<EquityHistoryPoint[]> {
    const rows = await this.prisma.equitySnapshot.findMany({
      where: {
        tradingAccountId: participantScopes.get(seasonParticipantId)!,
        capturedAt: { lte: endAt },
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
   *   participant/account link verification → eligible-set re-check of the
   *   pre-computed results (TC-D01) → settlement EquitySnapshot for EVERY
   *   valued participant → final SeasonRanking for the ranked ones
   *   (participant target + measured account) → participant final results and
   *   eligibility verdicts → participant status transitions → season account
   *   closure → Season.status = settled
   *
   * Under an eligibility rule the ranked participants are the qualified ones
   * (possibly none). A participant that did not qualify still has its final
   * valuation, settlement snapshot, status transition and account closure —
   * eligibility decides ranking, never financial settlement.
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
    qualificationApplied: boolean;
    /** A first settlement. Absent = replay of an existing final result. */
    fresh?: {
      finalRows: readonly FinalRankingRow[];
      unranked: ReadonlyArray<{
        valuation: FinalValuation;
        qualification: FinalQualificationEvidence;
      }>;
    };
  }): Promise<{
    createdFinalSnapshotIds: string[];
    updatedFinalSnapshotIds: string[];
    createdFinalRankingIds: string[];
    assignedFinalTierParticipantIds: string[];
    seasonUpdated: boolean;
    closedTradingAccountIds: string[];
    finishedParticipantIds: string[];
  }> {
    return this.runFinalWrite(async (tx) => {
      // 1) SERIALIZATION POINT (작업 8 §13.3). Ranking refresh and the daily
      //    ranking job take the same lock, so neither can rewrite this season's
      //    rows while the final result is being fixed.
      const season = await lockSeasonForWriteOrThrow(tx, input.seasonId);
      this.assertSeasonStatusAllowed(season.status);

      // 2) Preconditions re-verified under the lock, not merely before it.
      await this.assertNoOpenLimitReservations(input.seasonId, tx);
      await this.futuresFinal.assertNoOpen(input.seasonId, tx);

      // 3) EVERY participant of this season and its account, whatever status.
      const accountParticipants = await this.findSettlementAccountParticipants(
        tx,
        input.seasonId,
      );
      this.assertSettlementAccountLinks(input.seasonId, accountParticipants);

      // Re-checked under the lock: a run for another date may have written
      // final rows without settling the season since the pre-lock check.
      await this.assertNoFinalRankingOnOtherDate(
        tx,
        input.seasonId,
        input.settlementDate,
      );
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
      const settled = season.status === SeasonStatus.settled;

      // §A-5 again, now under the lock: the pre-lock check read a status that
      // another settlement run may have advanced to `settled` since. (Under an
      // eligibility rule an empty final ranking can be the confirmed result;
      // the replay below verifies that against the stored verdicts.)
      if (settled && existingRows.length === 0 && !input.qualificationApplied) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'FINAL_RESULTS_INTEGRITY',
          `Season ${input.seasonId} became settled with no final ranking rows for this settlementDate; a settled season never receives a newly computed final ranking.`,
        );
      }

      if (existingRows.length > 0 || (input.qualificationApplied && settled)) {
        if (input.qualificationApplied && !settled) {
          this.throwJobError(
            HttpStatus.CONFLICT,
            'FINAL_RESULTS_INTEGRITY',
            `Season ${input.seasonId} is not settled but holds final ranking rows; under an eligibility rule only the settlement that confirms eligibility writes them.`,
          );
        }

        // Idempotent replay. The existing rows are re-verified rather than
        // trusted: assigning participant results from a mis-scoped final
        // ranking would hand one account another's placement (작업 8 §14.5).
        assertSeasonRankingScopes(existingRows);
        this.assertExistingFinalRankingSetCovers(
          input.seasonId,
          existingRows,
          input.qualificationApplied
            ? this.confirmedQualifiedParticipants(
                input.seasonId,
                eligibleAccountParticipants,
              )
            : eligibleAccountParticipants,
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
          qualificationApplied: input.qualificationApplied,
          unranked: [],
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

      const fresh = input.fresh;
      const evaluatedParticipantIds = fresh
        ? [
            ...fresh.finalRows.map((row) => row.seasonParticipantId),
            ...fresh.unranked.map(
              ({ valuation }) => valuation.seasonParticipantId,
            ),
          ]
        : [];
      // Under an eligibility rule nobody to rank is a valid first result; the
      // eligible-set check below still requires that nobody became rankable.
      if (
        !fresh ||
        (evaluatedParticipantIds.length === 0 && !input.qualificationApplied)
      ) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'FINAL_RANKINGS_NOT_FOUND',
          'Final rankings disappeared before settlement status update.',
        );
      }

      if (input.qualificationApplied) {
        const confirmed = accountParticipants.filter((participant) =>
          hasVerdict(participant),
        );
        if (confirmed.length > 0) {
          this.throwJobError(
            HttpStatus.CONFLICT,
            'FINAL_RESULTS_INTEGRITY',
            `Season ${input.seasonId} is not settled but ${confirmed.length} participant(s) already carry a confirmed eligibility verdict (first: ${confirmed[0].id}); a first settlement never overwrites one.`,
          );
        }
      }

      // TC-D01: every result was valued and judged BEFORE this lock.
      this.assertFinalRowsMatchEligibleParticipants(
        input.seasonId,
        evaluatedParticipantIds,
        eligibleAccountParticipants,
      );

      // Resolved for ALL valued participants up front; a broken link aborts the
      // settlement rather than producing a partial final result.
      const rankingScopes = await resolveSeasonRankingAccountScopes(tx, {
        seasonId: input.seasonId,
        seasonParticipantIds: evaluatedParticipantIds,
      });

      const createdFinalSnapshotIds: string[] = [];
      const updatedFinalSnapshotIds: string[] = [];
      const createdFinalRankingIds: string[] = [];
      const assignedFinalTierParticipantIds: string[] = [];
      const writeSnapshot = async (
        seasonParticipantId: string,
        valuation: FinalValuation,
      ) => {
        const tradingAccountId =
          rankingScopes.get(seasonParticipantId)!.tradingAccountId;
        const snapshot = await this.writeSettlementSnapshot(tx, {
          tradingAccountId,
          valuation,
          capturedAt: input.capturedAt,
        });
        (snapshot.created
          ? createdFinalSnapshotIds
          : updatedFinalSnapshotIds
        ).push(snapshot.id);
        return tradingAccountId;
      };

      for (const row of fresh.finalRows) {
        const tradingAccountId = await writeSnapshot(
          row.seasonParticipantId,
          row,
        );

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
            ...this.qualificationData(row.qualification),
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
            // SeasonRanking intentionally records its participant target and
            // the canonical account used for its financial measurements.
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

      // Did not qualify: the same final financial result, no rank/tier/row.
      // currentRank is cleared too, so no reader shows the provisional rank
      // of a finished season as if it were a standing.
      for (const { valuation, qualification } of fresh.unranked) {
        await writeSnapshot(valuation.seasonParticipantId, valuation);
        await tx.seasonParticipant.update({
          where: {
            id: valuation.seasonParticipantId,
          },
          data: {
            totalAssetKrw: valuation.totalAssetKrw,
            totalReturnRate: valuation.returnRate,
            maxDrawdown: valuation.maxDrawdown,
            finalRank: null,
            finalTier: null,
            currentRank: null,
            ...this.qualificationData(qualification),
          },
          select: {
            id: true,
          },
        });
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
        expectedParticipants: fresh.finalRows.length,
        accountParticipants,
        finalRankingRows: fresh.finalRows,
        qualificationApplied: input.qualificationApplied,
        unranked: fresh.unranked.map(({ valuation, qualification }) => ({
          seasonParticipantId: valuation.seasonParticipantId,
          totalAssetKrw: valuation.totalAssetKrw,
          returnRate: valuation.returnRate,
          maxDrawdown: valuation.maxDrawdown,
          qualification,
        })),
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

  /** The final write's one interactive transaction, with its own budget. */
  private runFinalWrite<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work, {
      timeout: FINAL_SETTLEMENT_WRITE_TIMEOUT_MS,
    });
  }

  /**
   * The settlement EquitySnapshot of one valued participant — ranked or not.
   * It is the preserved final financial evidence (allocation included) the
   * settled portfolio reads back.
   */
  private async writeSettlementSnapshot(
    tx: Prisma.TransactionClient,
    input: {
      tradingAccountId: string;
      valuation: FinalValuation;
      capturedAt: Date;
    },
  ): Promise<{ id: string; created: boolean }> {
    const existingSnapshot = await tx.equitySnapshot.findFirst({
      where: {
        tradingAccountId: input.tradingAccountId,
        snapshotReason: SnapshotReason.settlement,
      },
      orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        tradingAccountId: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
      },
    });
    const valuation = input.valuation;
    const snapshotData = {
      totalAssetKrw: valuation.totalAssetKrw,
      returnRate: valuation.returnRate,
      krwCash: valuation.krwCash,
      usdCashKrw: valuation.usdCashKrw,
      domesticStockValueKrw: valuation.domesticStockValueKrw,
      usStockValueKrw: valuation.usStockValueKrw,
      cryptoValueKrw: valuation.cryptoValueKrw,
      ...futuresSnapshotValues(valuation),
      capturedAt: input.capturedAt,
    };

    if (existingSnapshot) {
      // The existing update-in-place policy is kept, but its SCOPE is
      // verified first: overwriting a row that belongs to another account,
      // or quietly filling a null scope through a routine settlement,
      // would launder damage the snapshot repair exists to surface.
      this.assertSettlementSnapshotScope(
        existingSnapshot,
        input.tradingAccountId,
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
      return { id: existingSnapshot.id, created: false };
    }

    const createdSnapshot = await tx.equitySnapshot.create({
      data: {
        tradingAccountId: input.tradingAccountId,
        ...snapshotData,
        snapshotReason: SnapshotReason.settlement,
      },
      select: {
        id: true,
      },
    });
    return { id: createdSnapshot.id, created: true };
  }

  /** The participant columns of an eligibility verdict; none without a rule. */
  private qualificationData(qualification?: FinalQualificationEvidence) {
    return qualification
      ? {
          finalQualified: qualification.qualified,
          finalTradedInstrumentCount: qualification.tradedInstrumentCount,
          finalRecognizedTurnoverKrw: qualification.recognizedTurnoverKrw,
        }
      : {};
  }

  /**
   * Under an eligibility rule, the participants a settled season's final
   * ranking must cover: those settlement confirmed as qualified. Every eligible
   * participant must carry a verdict — a missing one is damage, not "unranked".
   */
  private confirmedQualifiedParticipants(
    seasonId: string,
    eligibleParticipants: readonly SettlementAccountParticipant[],
  ): SettlementAccountParticipant[] {
    const unconfirmed = eligibleParticipants.filter(
      (participant) => !hasVerdict(participant),
    );
    if (unconfirmed.length > 0) {
      this.throwJobError(
        HttpStatus.CONFLICT,
        'FINAL_RESULTS_INTEGRITY',
        `Season ${seasonId} is settled but ${unconfirmed.length} eligible participant(s) carry no confirmed eligibility verdict (first: ${unconfirmed[0].id}).`,
      );
    }

    return eligibleParticipants.filter(
      (participant) => participant.finalQualified === true,
    );
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
        finalQualified: true,
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
        `Settlement snapshot ${snapshot.id} has no canonical trading account scope. Settlement never repairs ownership as a side effect.`,
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
    qualificationApplied: boolean;
    dryRun: boolean;
    result: SeasonSettlementJobResult;
  }): Promise<SeasonSettlementJobResult> {
    // Under an eligibility rule the ranking covers the confirmed qualified
    // participants only (verified for settled seasons before this point).
    const expectedRanked = input.qualificationApplied
      ? input.participants.filter(
          (participant) => participant.finalQualified === true,
        ).length
      : input.participants.length;
    if (input.qualificationApplied) {
      input.result.finalQualification.evaluated = input.participants.filter(
        (participant) => hasVerdict(participant),
      ).length;
      input.result.finalQualification.qualified = expectedRanked;
      input.result.finalQualification.notQualified = input.participants.filter(
        (participant) => participant.finalQualified === false,
      ).length;
    }
    input.result.participants.snapshotted = input.existingFinalRankings.length;
    input.result.participants.missingSnapshots = Math.max(
      expectedRanked - input.existingFinalRankings.length,
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
        input.existingFinalRankings.length === 0
          ? 'Season is already settled with an empty final ranking because no participant met the eligibility criteria; dry-run made no change.'
          : 'Final rankings already exist; dry-run did not assign tiers or update season status.';
      return input.result;
    }

    const writeResult = await this.createFinalSettlementAtomically({
      seasonId: input.season.id,
      settlementDate: input.settlementDate,
      capturedAt: new Date(),
      qualificationApplied: input.qualificationApplied,
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

  /**
   * A season has ONE final ranking. New ones are dated with the Korea date of
   * `Season.endAt`; a season ranked or settled earlier under another date
   * (such as the UTC date used before the KST ranking-date policy) keeps that
   * date. A run for a different date must never add a second final set beside
   * it, so it fails closed and names the existing date to rerun with.
   */
  private async assertNoFinalRankingOnOtherDate(
    client: PrismaService | Prisma.TransactionClient,
    seasonId: string,
    settlementDate: Date,
  ): Promise<void> {
    const other = await client.seasonRanking.findFirst({
      where: {
        seasonId,
        rankType: FINAL_RANK_TYPE,
        rankingDate: { not: settlementDate },
      },
      orderBy: [{ rankingDate: 'asc' }],
      select: { rankingDate: true },
    });
    if (other) {
      const existingDate = this.formatDateOnly(other.rankingDate);
      this.throwJobError(
        HttpStatus.CONFLICT,
        'FINAL_RANKING_DATE_MISMATCH',
        `Season ${seasonId} already has a final ranking for rankingDate ${existingDate}; settlementDate ${this.formatDateOnly(settlementDate)} would create a second one. Run settlement with settlementDate ${existingDate}.`,
      );
    }
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
   * TC-D01: freshly computed final rows must cover EXACTLY the participants
   * that are eligible under the season lock.
   *
   * Valuation runs before the lock so it does not block trading for its whole
   * duration. An exclusion that commits in between shrinks the competing set,
   * and with it every rank below the excluded participant and every tier
   * cutoff. Publishing the rows would rank an excluded participant (or leave
   * an eligible one unranked). Nothing has been written yet, so the settlement
   * stops with a retryable conflict and the next run values the current set:
   * a scheduled run retries on its next tick (new key per tick), a manual run
   * is re-run with a new idempotency key like any failed batch job.
   */
  private assertFinalRowsMatchEligibleParticipants(
    seasonId: string,
    valuedParticipantIds: readonly string[],
    eligibleParticipants: readonly SettlementAccountParticipant[],
  ): void {
    // Ranked AND unranked (did not qualify) results: under an eligibility rule
    // a valued participant without a rank is expected, a missing one is not.
    const rankedIds = new Set(valuedParticipantIds);
    const eligibleIds = new Set(
      eligibleParticipants.map((participant) => participant.id),
    );
    const noLongerEligible = valuedParticipantIds.filter(
      (participantId) => !eligibleIds.has(participantId),
    );
    const unranked = eligibleParticipants.filter(
      (participant) => !rankedIds.has(participant.id),
    );

    if (
      rankedIds.size === valuedParticipantIds.length &&
      noLongerEligible.length === 0 &&
      unranked.length === 0
    ) {
      return;
    }

    this.logger.warn(
      JSON.stringify({
        event: 'season_settlement_participants_changed',
        seasonId,
        rankedCount: valuedParticipantIds.length,
        eligibleCount: eligibleParticipants.length,
        noLongerEligibleCount: noLongerEligible.length,
        unrankedCount: unranked.length,
        recovery:
          're-run settlement; it values the participant set as it stands now',
      }),
    );
    this.throwJobError(
      HttpStatus.CONFLICT,
      'SETTLEMENT_PARTICIPANTS_CHANGED',
      `Season ${seasonId} participants changed after final valuation (${noLongerEligible.length} no longer eligible, ${unranked.length} unranked); nothing was settled. Re-run settlement to value the current participant set.`,
    );
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
        finalQualified: true,
        finalTradedInstrumentCount: true,
        finalRecognizedTurnoverKrw: true,
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
      if (row.qualification) {
        mismatches.push(
          ...this.qualificationMismatches(participant, row.qualification),
        );
      }

      if (mismatches.length > 0) {
        fail(row.seasonParticipantId, mismatches.join(', '));
      }
    }
  }

  /**
   * The participants that did NOT qualify are verified as strictly as the
   * ranked ones: the final financial result they were valued at, the verdict
   * that excluded them from the ranking, and no rank, tier or standing.
   */
  private async assertUnrankedParticipantResults(
    tx: Prisma.TransactionClient,
    input: {
      seasonId: string;
      unranked: readonly SettlementUnrankedExpectation[];
    },
  ): Promise<void> {
    if (input.unranked.length === 0) {
      return;
    }

    const stored = await tx.seasonParticipant.findMany({
      where: {
        seasonId: input.seasonId,
        id: { in: input.unranked.map((row) => row.seasonParticipantId) },
      },
      select: {
        id: true,
        totalAssetKrw: true,
        totalReturnRate: true,
        maxDrawdown: true,
        currentRank: true,
        finalRank: true,
        finalTier: true,
        finalQualified: true,
        finalTradedInstrumentCount: true,
        finalRecognizedTurnoverKrw: true,
      },
    });
    const storedById = new Map(stored.map((row) => [row.id, row]));

    for (const row of input.unranked) {
      const participant = storedById.get(row.seasonParticipantId);
      const mismatches = participant
        ? [
            ...(decimalEquals(participant.totalAssetKrw, row.totalAssetKrw)
              ? []
              : [`totalAssetKrw=${participant.totalAssetKrw.toString()}`]),
            ...(decimalEquals(participant.totalReturnRate, row.returnRate)
              ? []
              : [`totalReturnRate=${participant.totalReturnRate.toString()}`]),
            ...(decimalEquals(participant.maxDrawdown, row.maxDrawdown)
              ? []
              : [`maxDrawdown=${participant.maxDrawdown.toString()}`]),
            ...(participant.currentRank === null &&
            participant.finalRank === null &&
            participant.finalTier === null
              ? []
              : ['a rank or tier although it did not qualify']),
            ...this.qualificationMismatches(participant, row.qualification),
          ]
        : ['no participant row'];

      if (mismatches.length > 0) {
        this.throwJobError(
          HttpStatus.CONFLICT,
          'FINAL_RESULTS_INTEGRITY',
          `Season participant ${row.seasonParticipantId} would be settled unranked with ${mismatches.join(', ')}. The whole settlement is rolled back.`,
        );
      }
    }
  }

  private qualificationMismatches(
    participant: {
      finalQualified: boolean | null;
      finalTradedInstrumentCount: number | null;
      finalRecognizedTurnoverKrw: Prisma.Decimal | null;
    },
    expected: FinalQualificationEvidence,
  ): string[] {
    const mismatches: string[] = [];
    if (participant.finalQualified !== expected.qualified) {
      mismatches.push(
        `finalQualified=${String(participant.finalQualified)} vs verdict ${String(expected.qualified)}`,
      );
    }
    if (
      participant.finalTradedInstrumentCount !== expected.tradedInstrumentCount
    ) {
      mismatches.push(
        `finalTradedInstrumentCount=${participant.finalTradedInstrumentCount ?? 'null'} vs ${expected.tradedInstrumentCount}`,
      );
    }
    if (
      !decimalEquals(
        participant.finalRecognizedTurnoverKrw,
        expected.recognizedTurnoverKrw,
      )
    ) {
      mismatches.push(
        `finalRecognizedTurnoverKrw=${participant.finalRecognizedTurnoverKrw?.toString() ?? 'null'} vs ${expected.recognizedTurnoverKrw}`,
      );
    }
    return mismatches;
  }

  private async transitionSeasonToSettledIfReady(
    tx: Prisma.TransactionClient,
    input: {
      seasonId: string;
      settlementDate: Date;
      expectedParticipants: number;
      accountParticipants: readonly SettlementAccountParticipant[];
      finalRankingRows: readonly SettlementFinalResultExpectation[];
      qualificationApplied: boolean;
      unranked: readonly SettlementUnrankedExpectation[];
    },
  ): Promise<boolean> {
    await this.assertParticipantResultsMatchFinalRanking(tx, {
      seasonId: input.seasonId,
      finalRankingRows: input.finalRankingRows,
    });
    await this.assertUnrankedParticipantResults(tx, {
      seasonId: input.seasonId,
      unranked: input.unranked,
    });

    const accountIds = input.accountParticipants
      .map((participant) => participant.tradingAccountId)
      .filter((id): id is string => id !== null);
    const eligibleWhere = {
      seasonId: input.seasonId,
      participantStatus: {
        in: [...SETTLEMENT_PARTICIPANT_STATUSES],
      },
    };

    const [
      finalRankingCount,
      missingFinalResultCount,
      liveAccountCount,
      unconfirmedQualificationCount,
      qualifiedCount,
    ] = await Promise.all([
      tx.seasonRanking.count({
        where: {
          seasonId: input.seasonId,
          rankType: FINAL_RANK_TYPE,
          rankingDate: input.settlementDate,
        },
      }),
      // Every participant that must be ranked holds a rank and a tier: all
      // eligible ones, or under an eligibility rule the qualified ones.
      tx.seasonParticipant.count({
        where: {
          ...eligibleWhere,
          ...(input.qualificationApplied ? { finalQualified: true } : {}),
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
      // Under an eligibility rule: no eligible participant without a verdict,
      // and exactly one final row per qualified participant.
      input.qualificationApplied
        ? tx.seasonParticipant.count({
            where: { ...eligibleWhere, finalQualified: null },
          })
        : Promise.resolve(0),
      input.qualificationApplied
        ? tx.seasonParticipant.count({
            where: { ...eligibleWhere, finalQualified: true },
          })
        : Promise.resolve(input.expectedParticipants),
    ]);

    if (
      finalRankingCount !== input.expectedParticipants ||
      missingFinalResultCount !== 0 ||
      unconfirmedQualificationCount !== 0 ||
      qualifiedCount !== input.expectedParticipants
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
    criteria: SeasonFinalQualificationCriteria | null;
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
      finalQualification: {
        applied: input.criteria !== null,
        minTradedInstrumentCount:
          input.criteria?.minTradedInstrumentCount ?? null,
        minRecognizedTurnoverKrw: input.criteria
          ? minRecognizedTurnoverKrwAtMoneyScale(input.criteria).toFixed(8)
          : null,
        evaluated: 0,
        qualified: 0,
        notQualified: 0,
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

/** A stored eligibility verdict; anything but a boolean is "no verdict". */
function hasVerdict(participant: { finalQualified?: boolean | null }): boolean {
  return typeof participant.finalQualified === 'boolean';
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
  // An ordinary observation exactly at endAt is part of the competition.
  // Keep it, then append the actual final cash/equity after forced exits/fees.
  // Retry with committed final rankings bypasses recomputation entirely.
  return [...history, currentPoint];
}
