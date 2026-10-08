import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  SnapshotReason,
  TradingAccountMode,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import {
  GeneralAccountPerformanceService,
  toGeneralPerformanceHttpException,
} from './general-account-performance.service';
import {
  assertGeneralDailyHistoryRows,
  assertGeneralEquityHistoryRows,
  assertGeneralHistoryBoundaryPairs,
} from './general-history-integrity';
import {
  compareGeneralSnapshotOrder,
  MONEY_SCALE,
  RETURN_RATE_SCALE,
} from './general-performance.policy';
import { PortfolioValuationError } from './portfolio-valuation.policy';
import { PortfolioValuationService } from './portfolio-valuation.service';
import { createApiError } from '../common/api-error';
import {
  assertSeasonRankingScope,
  SEASON_RANKING_SCOPE_SELECT,
} from '../ranking/season-ranking-scope';
import {
  buildAdminPartialFailureDiagnostic,
  getAdminDiagnosticRequestId,
  isAdminDiagnosticRequest,
  setAdminDiagnosticContext,
  preserveAdminFailureCause,
  safeAdminDiagnosticLog,
} from '../common/admin-diagnostics';

/**
 * Account-scoped portfolio + equity history (작업 7).
 *
 * The legacy `/api/v1/portfolio` and `/api/v1/portfolio/equity` endpoints are
 * untouched: same current-season selection, same response shape, same range
 * meaning. These routes address an account explicitly instead.
 *
 * RETURN-RATE MEANING IS NEVER IMPLICIT. Every summary and every history point
 * carries `returnRateMethod`:
 *   - `time_weighted` for general accounts (TWR; external funding is neutral)
 *   - `initial_capital` for season accounts (the existing simple ratio)
 * They are different numbers and are never presented as the same thing.
 *
 * GET never writes: no account, wallet, grant, claim, EquitySnapshot,
 * DailyPortfolioSnapshot, or Position is created here.
 */

export type TradingAccountEquityQuery = {
  range?: string;
  granularity?: string;
};

type EquityRange = '1d' | '7d' | '30d' | '90d' | '180d' | '360d' | 'all';

type EquityHistoryPoint = {
  futuresUnrealizedPnlUsd: string | null;
  futuresUnrealizedPnlKrw: string | null;
  time: string;
  snapshotDate?: string;
  totalAssetKrw: string;
  returnRate: string;
  returnRateMethod: 'time_weighted' | 'initial_capital';
  cumulativeExternalFundingKrw: string | null;
  investmentPnlKrw: string | null;
  snapshotReason: SnapshotReason;
  externalFundingAmountKrw: string | null;
};

const ZERO_MONEY = '0.00000000';

/**
 * Price/FX unavailability is a normal transient condition and keeps the
 * existing success-envelope `sectionErrors` treatment. Structural integrity
 * failures do NOT — they are surfaced as structured 500s, because rendering a
 * corrupted account as "temporarily unavailable" hides real damage.
 */
const VALUATION_SECTION_ERROR_CODES = new Set([
  'FUTURES_MARK_UNAVAILABLE',
  'FUTURES_MARK_STALE',
  'FX_RATE_UNAVAILABLE',
  'FX_RATE_STALE',
  'ASSET_PRICE_UNAVAILABLE',
  'ASSET_PRICE_STALE',
]);

@Injectable()
export class TradingAccountPortfolioService {
  private readonly logger = new Logger(TradingAccountPortfolioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: TradingAccountAccessService,
    private readonly performanceService: GeneralAccountPerformanceService,
    private readonly valuationService: PortfolioValuationService,
  ) {}

  async getPortfolio(userId: string | undefined, accountId: string) {
    const owner = this.requireUserId(userId);
    setAdminDiagnosticContext({ failureStage: 'account_ownership_lookup' });
    const account = await this.resolveOwnedAccount(owner, accountId);
    setAdminDiagnosticContext({
      failureStage:
        account.mode === TradingAccountMode.general
          ? 'general_portfolio_transaction'
          : 'portfolio_valuation_read',
    });

    return account.mode === TradingAccountMode.general
      ? this.readGeneralConsistently(owner, account.id, (tx, locked, now) =>
          this.getGeneralPortfolio(locked, tx, now),
        )
      : this.getSeasonPortfolio(account);
  }

  async getEquity(
    userId: string | undefined,
    accountId: string,
    query: TradingAccountEquityQuery = {},
  ) {
    const owner = this.requireUserId(userId);
    const account = await this.resolveOwnedAccount(owner, accountId);
    const range = this.parseRange(query.range);
    if (query.granularity !== undefined && query.granularity !== 'daily') {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'INVALID_GRANULARITY',
            message: 'granularity must be daily when supplied.',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const daily = query.granularity === 'daily';

    if (account.mode !== TradingAccountMode.general) {
      const endAt =
        account.seasonParticipant?.season.status === 'settled'
          ? account.seasonParticipant.season.endAt
          : undefined;
      const historyAt = endAt ?? new Date();
      return this.buildEquityResponse(
        account,
        range,
        daily
          ? await this.findDailyPoints(this.prisma, account, range, historyAt)
          : await this.findEquityPointsForSeason(
              account.id,
              this.resolveSince(range, account.openedAt, +historyAt),
              endAt,
            ),
        daily,
      );
    }

    return this.readGeneralConsistently(
      owner,
      account.id,
      async (tx, locked, now) => {
        // An account with no origin must not read as an empty history: that
        // looks like "nothing happened yet" when the truth is "performance was
        // never initialized". The continuity check comes with it (작업 7 보완 2)
        // — a history whose latest state already disagrees with the ledger is
        // not a chart to render, it is damage to report.
        await this.performanceService.requireContinuousPerformanceState({
          account: locked,
          client: tx,
        });

        const since = this.resolveSince(range, locked.openedAt, now.getTime());
        const points = daily
          ? await this.findDailyPoints(tx, locked, range, now)
          : range === '1d'
            ? await this.findGeneralEquityPoints(tx, locked.id, since)
            : ((await this.findGeneralDailyPoints(tx, locked.id, since)) ??
              (await this.findGeneralEquityPoints(tx, locked.id, since)));

        return this.buildEquityResponse(locked, range, points, daily);
      },
    );
  }

  private buildEquityResponse(
    account: Pick<OwnedTradingAccount, 'id' | 'mode'>,
    range: EquityRange,
    points: EquityHistoryPoint[],
    daily = false,
  ) {
    return {
      success: true as const,
      data: {
        tradingAccountId: account.id,
        mode: account.mode,
        state:
          points.length === 0 ? ('empty' as const) : ('available' as const),
        range,
        ...(daily ? { granularity: 'daily' as const } : {}),
        returnRateMethod: this.returnRateMethod(account.mode),
        points,
      },
    };
  }

  /**
   * THE consistent-read wrapper for every general-account GET
   * (작업 6·7 보완 1).
   *
   * WHY A TRANSACTION IS NOT OPTIONAL HERE
   * --------------------------------------
   * A general portfolio answer is assembled from six independent reads: the
   * latest performance snapshot, the external-funding ledger, the KRW and USD
   * wallets, positions, and the price/FX snapshots. Each ran in its own
   * implicit transaction, so an ad payout committing mid-request could be
   * observed by SOME of them:
   *
   *     snapshot: pre-payout · ledger: pre-payout · wallet: POST-payout
   *
   * TWR is `factor × currentTotal / previousTotal` measured against cumulative
   * external funding. With a post-payout wallet and a pre-payout funding sum,
   * the reward lands entirely in `investmentPnlKrw` — the app tells the user
   * that watching an advert earned them money. RepeatableRead makes all six
   * reads see one committed instant, so the reward is either fully visible
   * (with its funding boundary) or not visible at all.
   *
   * WHAT THIS TRANSACTION MUST NOT DO
   * ---------------------------------
   * It is a READ. It takes no row lock, writes nothing, creates no snapshot,
   * wallet, ledger row, or claim, repairs nothing, and makes no network call —
   * valuation reads only stored price/FX snapshots, so it is safe to hold open.
   */
  private async readGeneralConsistently<T>(
    userId: string,
    accountId: string,
    handler: (
      tx: Prisma.TransactionClient,
      account: OwnedTradingAccount,
      now: Date,
    ) => Promise<T>,
  ): Promise<T> {
    // ONE clock for the whole request. Re-calling `new Date()` inside would
    // let the valuation instant and the history range drift apart.
    const now = new Date();

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Re-read under the snapshot: the pre-transaction copy answered
          // 401/404 and chose the mode branch, but the row that gets valued
          // must come from the same consistent view as everything else.
          const account = await this.accessService.getOwnedAccountOrThrow(
            userId,
            accountId,
            tx,
          );

          return await handler(tx, account, now);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      throw this.rethrowStructuralError(error);
    }
  }

  // ------------------------------------------------------------- general

  private async getGeneralPortfolio(
    account: OwnedTradingAccount,
    client: Prisma.TransactionClient,
    valuationAt: Date,
  ) {
    try {
      const live = await this.performanceService.resolveLivePerformance({
        account,
        valuationAt,
        client,
      });

      return {
        success: true as const,
        data: {
          tradingAccountId: account.id,
          mode: account.mode,
          status: account.status,
          state: 'available' as const,
          summary: {
            totalAssetKrw: live.advance.totalAssetKrw.toFixed(MONEY_SCALE),
            cumulativeExternalFundingKrw:
              live.funding.cumulativeExternalFundingKrw.toFixed(MONEY_SCALE),
            initialFundingKrw:
              live.funding.initialFundingKrw.toFixed(MONEY_SCALE),
            cumulativeAdRewardKrw:
              live.funding.cumulativeAdRewardKrw.toFixed(MONEY_SCALE),
            investmentPnlKrw:
              live.advance.investmentPnlKrw.toFixed(MONEY_SCALE),
            returnRate: live.advance.returnRate.toFixed(RETURN_RATE_SCALE),
            returnRateMethod: 'time_weighted' as const,
            krwCash: live.valuation.krwCash,
            usdCashKrw: live.valuation.usdCashKrw,
            assetValueKrw: live.valuation.assetValueKrw,
            realizedPnlKrw: live.valuation.realizedPnlKrw,
            unrealizedPnlKrw: live.valuation.unrealizedPnlKrw,
            futuresUnrealizedPnlUsd:
              live.valuation.futuresUnrealizedPnlUsd ?? '0.00000000',
            futuresUnrealizedPnlKrw:
              live.valuation.futuresUnrealizedPnlKrw ?? '0.00000000',
            valuedAt: live.valuation.valuationAt.toISOString(),
          },
          allocation: this.buildAllocation(live.valuation),
          sectionErrors: [],
        },
      };
    } catch (error) {
      const sectionError = this.toSectionError(error);
      if (!sectionError) {
        throw this.rethrowStructuralError(error);
      }
      const diagnostic = this.buildValuationDiagnostic(
        error,
        sectionError.code,
        account,
      );
      const diagnosticSectionError = diagnostic
        ? { ...sectionError, diagnostic }
        : sectionError;

      return {
        success: true as const,
        data: {
          tradingAccountId: account.id,
          mode: account.mode,
          status: account.status,
          state: 'unavailable' as const,
          summary: null,
          allocation: {
            state: 'unavailable' as const,
            cashKrwValue: ZERO_MONEY,
            domesticStockValueKrw: ZERO_MONEY,
            usStockValueKrw: ZERO_MONEY,
            cryptoValueKrw: ZERO_MONEY,
            reason: diagnosticSectionError.code,
            message: diagnosticSectionError.message,
          },
          sectionErrors: [diagnosticSectionError],
          reason: diagnosticSectionError.code,
          message: diagnosticSectionError.message,
        },
      };
    }
  }

  // -------------------------------------------------------------- season

  /**
   * Season accounts keep their EXISTING valuation and initial-capital return;
   * this route only re-addresses them by accountId. The external-funding
   * fields are explicitly null rather than zero — a season account has no
   * external-funding concept at all, and 0 would read as "none received".
   */
  private async getSeasonPortfolio(account: OwnedTradingAccount) {
    if (!account.seasonParticipant) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'TRADING_ACCOUNT_INTEGRITY',
            message: 'Season account has no participant.',
          },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (account.seasonParticipant.season.status === 'settled') {
      return this.getSettledPortfolio(account);
    }

    try {
      const valuation =
        await this.valuationService.calculateTradingAccountValuation(
          account.id,
          new Date(),
          'home_live_valuation',
        );

      return {
        success: true as const,
        data: {
          tradingAccountId: account.id,
          mode: account.mode,
          status: account.status,
          state: 'available' as const,
          summary: {
            totalAssetKrw: valuation.totalAssetKrw,
            cumulativeExternalFundingKrw: null,
            initialFundingKrw: account.initialCapitalKrw.toFixed(MONEY_SCALE),
            cumulativeAdRewardKrw: null,
            investmentPnlKrw: null,
            returnRate: valuation.returnRate,
            returnRateMethod: 'initial_capital' as const,
            krwCash: valuation.krwCash,
            usdCashKrw: valuation.usdCashKrw,
            assetValueKrw: valuation.assetValueKrw,
            realizedPnlKrw: valuation.realizedPnlKrw,
            unrealizedPnlKrw: valuation.unrealizedPnlKrw,
            futuresUnrealizedPnlUsd:
              valuation.futuresUnrealizedPnlUsd ?? '0.00000000',
            futuresUnrealizedPnlKrw:
              valuation.futuresUnrealizedPnlKrw ?? '0.00000000',
            valuedAt: valuation.valuationAt.toISOString(),
          },
          allocation: this.buildAllocation(valuation),
          sectionErrors: [],
        },
      };
    } catch (error) {
      const sectionError = this.toSectionError(error);
      if (!sectionError) {
        throw this.rethrowStructuralError(error);
      }
      const diagnostic = this.buildValuationDiagnostic(
        error,
        sectionError.code,
        account,
      );
      const diagnosticSectionError = diagnostic
        ? { ...sectionError, diagnostic }
        : sectionError;

      return {
        success: true as const,
        data: {
          tradingAccountId: account.id,
          mode: account.mode,
          status: account.status,
          state: 'unavailable' as const,
          summary: null,
          allocation: {
            state: 'unavailable' as const,
            cashKrwValue: ZERO_MONEY,
            domesticStockValueKrw: ZERO_MONEY,
            usStockValueKrw: ZERO_MONEY,
            cryptoValueKrw: ZERO_MONEY,
            reason: diagnosticSectionError.code,
            message: diagnosticSectionError.message,
          },
          sectionErrors: [diagnosticSectionError],
          reason: diagnosticSectionError.code,
          message: diagnosticSectionError.message,
        },
      };
    }
  }

  // ------------------------------------------------------------- helpers

  /** Final totals are immutable ranking evidence, never a current-price read.
   * Old settlement rows did not preserve realized/unrealized breakdowns: keep
   * the live summary absent rather than manufacture those historical values. */
  private async getSettledPortfolio(account: OwnedTradingAccount) {
    const participant = account.seasonParticipant!;
    const ranking = await this.prisma.seasonRanking.findFirst({
      where: {
        seasonId: participant.season.id,
        seasonParticipantId: participant.id,
        tradingAccountId: account.id,
        rankType: 'final',
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        ...SEASON_RANKING_SCOPE_SELECT,
        id: true,
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
        capturedAt: true,
        seasonParticipant: {
          select: {
            ...SEASON_RANKING_SCOPE_SELECT.seasonParticipant.select,
            finalTier: true,
          },
        },
      },
    });
    if (ranking) assertSeasonRankingScope(ranking);
    const snapshot = ranking
      ? await this.prisma.equitySnapshot.findFirst({
          where: {
            tradingAccountId: account.id,
            snapshotReason: 'settlement',
            capturedAt: ranking.capturedAt,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        })
      : null;
    if (
      snapshot &&
      ranking &&
      (!snapshot.totalAssetKrw.eq(ranking.totalAssetKrw) ||
        !snapshot.returnRate.eq(ranking.returnRate) ||
        snapshot.cumulativeExternalFundingKrw !== null ||
        snapshot.timeWeightedReturnFactor !== null)
    ) {
      setAdminDiagnosticContext({
        domain: 'PORTFOLIO',
        operation: 'SETTLED_PORTFOLIO_READ',
        failureStage: 'final_evidence_consistency',
        entities: {
          tradingAccountId: account.id,
          seasonId: participant.season.id,
        },
        evidence: {
          result: 'ranking_snapshot_mismatch',
          rankingId: ranking.id,
          snapshotId: snapshot.id,
        },
        nextInvestigation: [
          'backend/src/batch/season-settlement-job.service.ts',
        ],
      });
      throw createApiError(
        'TRADING_ACCOUNT_INTEGRITY',
        'Stored final portfolio evidence could not be verified.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const allocationAvailable =
      snapshot &&
      [
        snapshot.krwCash,
        snapshot.usdCashKrw,
        snapshot.domesticStockValueKrw,
        snapshot.usStockValueKrw,
        snapshot.cryptoValueKrw,
      ].every((v) => v !== null);
    const reason = ranking
      ? 'FINAL_ALLOCATION_UNAVAILABLE'
      : 'FINAL_RANKING_UNAVAILABLE';
    const diagnosticContext = {
      domain: 'PORTFOLIO',
      operation: 'SETTLED_PORTFOLIO_READ',
      failureStage: 'final_evidence_read',
      entities: {
        tradingAccountId: account.id,
        seasonId: participant.season.id,
        seasonParticipantId: participant.id,
      },
      evidence: {
        result: 'final_evidence_missing',
        finalRankingAvailable: !!ranking,
        settlementSnapshotAvailable: !!snapshot,
      },
      nextInvestigation: ['backend/src/batch/season-settlement-job.service.ts'],
    };
    const sectionErrors = !ranking
      ? [
          {
            section: 'finalResult',
            code: 'FINAL_RANKING_UNAVAILABLE',
            message: 'The stored final ranking is unavailable.',
            diagnostic: buildAdminPartialFailureDiagnostic(
              null,
              'FINAL_RANKING_UNAVAILABLE',
              diagnosticContext,
            ),
          },
        ]
      : !allocationAvailable
        ? [
            {
              section: 'allocation',
              code: 'FINAL_ALLOCATION_UNAVAILABLE',
              message: 'The stored final allocation is unavailable.',
              diagnostic: buildAdminPartialFailureDiagnostic(
                null,
                'FINAL_ALLOCATION_UNAVAILABLE',
                diagnosticContext,
              ),
            },
          ]
        : [];
    return {
      success: true as const,
      data: {
        tradingAccountId: account.id,
        mode: account.mode,
        status: account.status,
        state: ranking ? ('available' as const) : ('unavailable' as const),
        summary: null,
        finalResult: ranking
          ? {
              state: 'available' as const,
              resultSource: 'season_rankings' as const,
              totalAssetKrw: ranking.totalAssetKrw.toFixed(8),
              returnRate: ranking.returnRate.toFixed(8),
              returnRateMethod: 'initial_capital' as const,
              maxDrawdown: ranking.maxDrawdown.toFixed(8),
              totalFillCount: ranking.totalFillCount,
              reachedReturnAt: ranking.reachedReturnAt?.toISOString() ?? null,
              rank: ranking.rank,
              tier: ranking.seasonParticipant.finalTier,
              endAt: participant.season.endAt.toISOString(),
              capturedAt: ranking.capturedAt.toISOString(),
            }
          : { state: 'unavailable' as const, reason },
        allocation: allocationAvailable
          ? {
              state: 'available' as const,
              cashKrwValue: snapshot.krwCash
                .add(snapshot.usdCashKrw)
                .toFixed(8),
              domesticStockValueKrw: snapshot.domesticStockValueKrw.toFixed(8),
              usStockValueKrw: snapshot.usStockValueKrw.toFixed(8),
              cryptoValueKrw: snapshot.cryptoValueKrw.toFixed(8),
            }
          : {
              state: 'unavailable' as const,
              cashKrwValue: ZERO_MONEY,
              domesticStockValueKrw: ZERO_MONEY,
              usStockValueKrw: ZERO_MONEY,
              cryptoValueKrw: ZERO_MONEY,
              reason,
            },
        sectionErrors,
      },
    };
  }

  /** Explicit daily read: job date is authoritative, even for late captures.
   * Never substitute intraday/funding-boundary rows for missing daily history. */
  private async findDailyPoints(
    client: Prisma.TransactionClient,
    account: OwnedTradingAccount,
    range: EquityRange,
    now: Date,
  ): Promise<EquityHistoryPoint[]> {
    const dateKey = (date: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
    const end = new Date(`${dateKey(now)}T00:00:00.000Z`);
    const days = range === 'all' ? 0 : Number.parseInt(range, 10);
    const start =
      range === 'all'
        ? new Date(`${dateKey(account.openedAt)}T00:00:00.000Z`)
        : new Date(end.getTime() - (days - 1) * 86_400_000);
    const rows = await client.dailyPortfolioSnapshot.findMany({
      where: {
        tradingAccountId: account.id,
        snapshotDate: { gte: start, lte: end },
        ...(account.seasonParticipant?.season.status === 'settled'
          ? {
              capturedAt: { lte: account.seasonParticipant.season.endAt },
            }
          : {}),
      },
      orderBy: { snapshotDate: 'asc' },
      select: {
        id: true,
        tradingAccountId: true,
        snapshotDate: true,
        capturedAt: true,
        totalAssetKrw: true,
        futuresUnrealizedPnlUsd: true,
        futuresUnrealizedPnlKrw: true,
        returnRate: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
      },
    });
    if (account.mode === TradingAccountMode.general) {
      assertGeneralDailyHistoryRows(account.id, rows);
    }
    const dates = new Set<string>();
    for (const row of rows) {
      const date = row.snapshotDate.toISOString().slice(0, 10);
      if (row.tradingAccountId !== account.id || dates.has(date)) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'TRADING_ACCOUNT_INTEGRITY',
              message: 'Daily history scope or date is inconsistent.',
            },
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      dates.add(date);
    }
    return rows.map((row) => ({
      time: row.capturedAt.toISOString(),
      snapshotDate: row.snapshotDate.toISOString().slice(0, 10),
      totalAssetKrw: row.totalAssetKrw.toFixed(MONEY_SCALE),
      futuresUnrealizedPnlUsd:
        row.futuresUnrealizedPnlUsd?.toFixed(MONEY_SCALE) ?? null,
      futuresUnrealizedPnlKrw:
        row.futuresUnrealizedPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      returnRate: row.returnRate.toFixed(RETURN_RATE_SCALE),
      returnRateMethod: this.returnRateMethod(account.mode),
      cumulativeExternalFundingKrw:
        row.cumulativeExternalFundingKrw?.toFixed(MONEY_SCALE) ?? null,
      investmentPnlKrw: row.investmentPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      snapshotReason: SnapshotReason.scheduled,
      externalFundingAmountKrw: null,
    }));
  }

  private buildAllocation(valuation: {
    krwCash: string;
    usdCashKrw: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  }) {
    return {
      state: 'available' as const,
      // Reserved cash is NOT subtracted: it is still owned, merely not
      // spendable. Same rule as the legacy portfolio.
      cashKrwValue: new Prisma.Decimal(valuation.krwCash)
        .add(valuation.usdCashKrw)
        .toFixed(MONEY_SCALE),
      domesticStockValueKrw: valuation.domesticStockValueKrw,
      usStockValueKrw: valuation.usStockValueKrw,
      cryptoValueKrw: valuation.cryptoValueKrw,
    };
  }

  /**
   * General equity history: every returned row is verified before ANY of it is
   * serialised (작업 6·7 보완 3). A damaged row is never emitted with `null`
   * performance fields as though that were a legitimate data point.
   */
  private async findGeneralEquityPoints(
    client: Prisma.TransactionClient,
    tradingAccountId: string,
    since: Date,
  ): Promise<EquityHistoryPoint[]> {
    const rows = await client.equitySnapshot.findMany({
      where: { tradingAccountId, capturedAt: { gte: since } },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        tradingAccountId: true,
        totalAssetKrw: true,
        futuresUnrealizedPnlUsd: true,
        futuresUnrealizedPnlKrw: true,
        returnRate: true,
        snapshotReason: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
        externalFundingAmountKrw: true,
        externalFundingReferenceType: true,
        externalFundingReferenceId: true,
        capturedAt: true,
        createdAt: true,
      },
    });

    assertGeneralEquityHistoryRows(tradingAccountId, rows);
    // ONE batched claim/ledger lookup for the whole page — not one per point.
    await assertGeneralHistoryBoundaryPairs(client, tradingAccountId, rows);

    // SQL cannot express the boundary phase order, and it is not safe to let
    // createdAt/UUID decide it: a before/after pair is written in one
    // transaction and routinely shares both (작업 7 보완 1). The page just
    // fetched is re-ordered by the same total order the latest-state resolver
    // uses, so history always reads before → after. Ordinary rows share one
    // rank and keep exactly the ordering they had.
    rows.sort(compareGeneralSnapshotOrder);

    return rows.map((row) => ({
      time: row.capturedAt.toISOString(),
      totalAssetKrw: row.totalAssetKrw.toFixed(MONEY_SCALE),
      futuresUnrealizedPnlUsd:
        row.futuresUnrealizedPnlUsd?.toFixed(MONEY_SCALE) ?? null,
      futuresUnrealizedPnlKrw:
        row.futuresUnrealizedPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      returnRate: row.returnRate.toFixed(RETURN_RATE_SCALE),
      returnRateMethod: 'time_weighted' as const,
      // Non-null by assertGeneralEquityHistoryRows: a general history point
      // never serialises a damaged column as `null`.
      cumulativeExternalFundingKrw:
        row.cumulativeExternalFundingKrw!.toFixed(MONEY_SCALE),
      investmentPnlKrw: row.investmentPnlKrw!.toFixed(MONEY_SCALE),
      snapshotReason: row.snapshotReason,
      externalFundingAmountKrw:
        row.externalFundingAmountKrw?.toFixed(MONEY_SCALE) ?? null,
    }));
  }

  /** Returns null (not []) when there are no daily rows, so the caller can
   * fall back to EquitySnapshot instead of showing an empty chart. */
  private async findGeneralDailyPoints(
    client: Prisma.TransactionClient,
    tradingAccountId: string,
    since: Date,
  ): Promise<EquityHistoryPoint[] | null> {
    const rows = await client.dailyPortfolioSnapshot.findMany({
      where: { tradingAccountId, capturedAt: { gte: since } },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        tradingAccountId: true,
        totalAssetKrw: true,
        futuresUnrealizedPnlUsd: true,
        futuresUnrealizedPnlKrw: true,
        returnRate: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        timeWeightedReturnFactor: true,
        capturedAt: true,
      },
    });

    if (rows.length === 0) {
      return null;
    }

    assertGeneralDailyHistoryRows(tradingAccountId, rows);

    return rows.map((row) => ({
      time: row.capturedAt.toISOString(),
      totalAssetKrw: row.totalAssetKrw.toFixed(MONEY_SCALE),
      futuresUnrealizedPnlUsd:
        row.futuresUnrealizedPnlUsd?.toFixed(MONEY_SCALE) ?? null,
      futuresUnrealizedPnlKrw:
        row.futuresUnrealizedPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      returnRate: row.returnRate.toFixed(RETURN_RATE_SCALE),
      returnRateMethod: 'time_weighted' as const,
      cumulativeExternalFundingKrw:
        row.cumulativeExternalFundingKrw!.toFixed(MONEY_SCALE),
      investmentPnlKrw: row.investmentPnlKrw!.toFixed(MONEY_SCALE),
      snapshotReason: SnapshotReason.scheduled,
      externalFundingAmountKrw: null,
    }));
  }

  /**
   * Season history is UNCHANGED by this work: same query, same shape, same
   * `initial_capital` meaning, no transaction and no general integrity checks
   * (a season row legitimately has null general performance columns).
   */
  private async findEquityPointsForSeason(
    tradingAccountId: string,
    since: Date,
    endAt?: Date,
  ): Promise<EquityHistoryPoint[]> {
    const rows = await this.prisma.equitySnapshot.findMany({
      where: {
        tradingAccountId,
        capturedAt: { gte: since },
        ...(endAt
          ? {
              OR: [
                { capturedAt: { lte: endAt } },
                { snapshotReason: SnapshotReason.settlement },
              ],
            }
          : {}),
      },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        tradingAccountId: true,
        totalAssetKrw: true,
        futuresUnrealizedPnlUsd: true,
        futuresUnrealizedPnlKrw: true,
        returnRate: true,
        snapshotReason: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        externalFundingAmountKrw: true,
        capturedAt: true,
        createdAt: true,
      },
    });

    rows.sort(compareGeneralSnapshotOrder);

    return rows.map((row) => ({
      time: row.capturedAt.toISOString(),
      totalAssetKrw: row.totalAssetKrw.toFixed(MONEY_SCALE),
      futuresUnrealizedPnlUsd:
        row.futuresUnrealizedPnlUsd?.toFixed(MONEY_SCALE) ?? null,
      futuresUnrealizedPnlKrw:
        row.futuresUnrealizedPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      returnRate: row.returnRate.toFixed(RETURN_RATE_SCALE),
      returnRateMethod: 'initial_capital' as const,
      cumulativeExternalFundingKrw:
        row.cumulativeExternalFundingKrw?.toFixed(MONEY_SCALE) ?? null,
      investmentPnlKrw: row.investmentPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      snapshotReason: row.snapshotReason,
      externalFundingAmountKrw:
        row.externalFundingAmountKrw?.toFixed(MONEY_SCALE) ?? null,
    }));
  }

  private returnRateMethod(mode: TradingAccountMode) {
    return mode === TradingAccountMode.general
      ? ('time_weighted' as const)
      : ('initial_capital' as const);
  }

  /** `now` is passed in, never read here: one request, one clock. */
  private resolveSince(range: EquityRange, openedAt: Date, now: number): Date {
    switch (range) {
      case '1d':
        return new Date(now - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case '30d':
      case '90d':
      case '180d':
      case '360d':
        return new Date(now - Number.parseInt(range, 10) * 86_400_000);
      case 'all':
      default:
        // For a general account "all" means everything since it opened.
        return openedAt;
    }
  }

  private parseRange(value: string | undefined): EquityRange {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '' || text === '1d') return '1d';
    if (
      text === '7d' ||
      text === '30d' ||
      text === '90d' ||
      text === '180d' ||
      text === '360d' ||
      text === 'all'
    ) {
      return text;
    }

    throw new HttpException(
      {
        success: false,
        error: {
          code: 'INVALID_RANGE',
          message: 'range must be one of 1d, 7d, 30d, 90d, 180d, 360d, all.',
        },
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  private toSectionError(
    error: unknown,
  ): { code: string; message: string } | null {
    if (
      error instanceof PortfolioValuationError &&
      VALUATION_SECTION_ERROR_CODES.has(error.code)
    ) {
      return { code: error.code, message: error.message };
    }

    return null;
  }

  private buildValuationDiagnostic(
    error: unknown,
    code: string,
    account: OwnedTradingAccount,
  ) {
    if (isAdminDiagnosticRequest()) {
      this.logger.warn(
        safeAdminDiagnosticLog({
          event: 'portfolio_partial_valuation_failed',
          requestId: getAdminDiagnosticRequestId(),
          code,
          failureStage:
            error instanceof PortfolioValuationError
              ? error.diagnosticContext?.failureStage
              : undefined,
          entities: {
            userId: account.userId,
            tradingAccountId: account.id,
            seasonId: account.seasonParticipant?.season.id,
            seasonParticipantId: account.seasonParticipant?.id,
            ...(error instanceof PortfolioValuationError
              ? error.diagnosticContext?.entities
              : {}),
          },
        }),
      );
    }
    return buildAdminPartialFailureDiagnostic(error, code, {
      domain: 'PORTFOLIO',
      operation: 'PORTFOLIO_VALUATION',
      failureStage:
        error instanceof PortfolioValuationError
          ? (error.diagnosticContext?.failureStage ?? 'portfolio_valuation')
          : 'portfolio_valuation',
      entities: {
        userId: account.userId,
        tradingAccountId: account.id,
        seasonId: account.seasonParticipant?.season.id,
        seasonParticipantId: account.seasonParticipant?.id,
        ...(error instanceof PortfolioValuationError
          ? error.diagnosticContext?.entities
          : {}),
      },
      evidence:
        error instanceof PortfolioValuationError
          ? error.diagnosticContext?.evidence
          : undefined,
      nextInvestigation: [
        'backend/src/portfolio/portfolio-valuation.service.ts',
        'backend/src/portfolio/portfolio-valuation.policy.ts',
      ],
    });
  }

  /**
   * GENERAL_ACCOUNT_INTEGRITY, GENERAL_PERFORMANCE_*, AD_REWARD_CLAIM_INTEGRITY
   * and snapshot scope mismatches must never be flattened into a success
   * envelope — they are server-side damage, not a temporary data gap.
   */
  private rethrowStructuralError(error: unknown): unknown {
    const generalFailure = toGeneralPerformanceHttpException(error);
    if (generalFailure) return generalFailure;
    // Keep the domain code so clients can distinguish structural faults from
    // transport errors. Price/FX unavailability was handled above.
    if (error instanceof PortfolioValuationError) {
      setAdminDiagnosticContext({
        failureStage:
          error.diagnosticContext?.failureStage ??
          'portfolio_valuation_validation',
        evidence: error.diagnosticContext?.evidence,
      });
      return preserveAdminFailureCause(
        new HttpException(
          {
            success: false,
            error: {
              code: error.code,
              message: 'Portfolio data could not be safely valued.',
            },
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
        error,
      );
    }
    return error;
  }

  private requireUserId(userId: string | undefined): string {
    if (!userId) {
      throw new HttpException(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    return userId;
  }

  private async resolveOwnedAccount(
    userId: string,
    accountId: string,
  ): Promise<OwnedTradingAccount> {
    // Unknown and foreign accountIds are the SAME 404. Reads are allowed for
    // active, suspended, and closed accounts alike.
    return this.accessService.getOwnedAccountOrThrow(
      userId,
      typeof accountId === 'string' ? accountId.trim() : accountId,
    );
  }
}
