import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
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
  compareGeneralSnapshotOrder,
  MONEY_SCALE,
  RETURN_RATE_SCALE,
} from './general-performance.policy';
import { PortfolioValuationError } from './portfolio-valuation.policy';
import { PortfolioValuationService } from './portfolio-valuation.service';

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
};

type EquityRange = '1d' | '7d' | '30d' | 'all';

const ZERO_MONEY = '0.00000000';

/**
 * Price/FX unavailability is a normal transient condition and keeps the
 * existing success-envelope `sectionErrors` treatment. Structural integrity
 * failures do NOT — they are surfaced as structured 500s, because rendering a
 * corrupted account as "temporarily unavailable" hides real damage.
 */
const VALUATION_SECTION_ERROR_CODES = new Set([
  'FX_RATE_UNAVAILABLE',
  'FX_RATE_STALE',
  'ASSET_PRICE_UNAVAILABLE',
  'ASSET_PRICE_STALE',
]);

@Injectable()
export class TradingAccountPortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: TradingAccountAccessService,
    private readonly performanceService: GeneralAccountPerformanceService,
    private readonly valuationService: PortfolioValuationService,
  ) {}

  async getPortfolio(userId: string | undefined, accountId: string) {
    const account = await this.resolveOwnedAccount(userId, accountId);

    return account.mode === TradingAccountMode.general
      ? this.getGeneralPortfolio(account)
      : this.getSeasonPortfolio(account);
  }

  async getEquity(
    userId: string | undefined,
    accountId: string,
    query: TradingAccountEquityQuery = {},
  ) {
    const account = await this.resolveOwnedAccount(userId, accountId);
    const range = this.parseRange(query.range);

    if (account.mode === TradingAccountMode.general) {
      // An account with no origin must not read as an empty history: that
      // looks like "nothing happened yet" when the truth is "performance was
      // never initialized". The continuity check comes with it (작업 7 보완 2)
      // — a history whose latest state already disagrees with the ledger is
      // not a chart to render, it is damage to report.
      try {
        await this.performanceService.requireContinuousPerformanceState({
          account,
        });
      } catch (error) {
        throw this.rethrowStructuralError(error);
      }
    }

    const since = this.resolveSince(range, account.openedAt);
    const points =
      range === '1d'
        ? await this.findEquityPoints(account.id, since)
        : ((await this.findDailyPoints(account.id, since)) ??
          (await this.findEquityPoints(account.id, since)));

    return {
      success: true as const,
      data: {
        tradingAccountId: account.id,
        mode: account.mode,
        state:
          points.length === 0 ? ('empty' as const) : ('available' as const),
        range,
        returnRateMethod: this.returnRateMethod(account.mode),
        points,
      },
    };
  }

  // ------------------------------------------------------------- general

  private async getGeneralPortfolio(account: OwnedTradingAccount) {
    try {
      const live = await this.performanceService.resolveLivePerformance({
        account,
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
            reason: sectionError.code,
            message: sectionError.message,
          },
          sectionErrors: [sectionError],
          reason: sectionError.code,
          message: sectionError.message,
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

    try {
      const valuation =
        await this.valuationService.calculateSeasonParticipantValuation(
          account.seasonParticipant.id,
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
            reason: sectionError.code,
            message: sectionError.message,
          },
          sectionErrors: [sectionError],
          reason: sectionError.code,
          message: sectionError.message,
        },
      };
    }
  }

  // ------------------------------------------------------------- helpers

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

  private async findEquityPoints(tradingAccountId: string, since: Date) {
    const rows = await this.prisma.equitySnapshot.findMany({
      where: { tradingAccountId, capturedAt: { gte: since } },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        seasonParticipantId: true,
        totalAssetKrw: true,
        returnRate: true,
        snapshotReason: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        externalFundingAmountKrw: true,
        capturedAt: true,
        createdAt: true,
      },
    });

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
      returnRate: row.returnRate.toFixed(RETURN_RATE_SCALE),
      returnRateMethod:
        row.seasonParticipantId === null
          ? ('time_weighted' as const)
          : ('initial_capital' as const),
      cumulativeExternalFundingKrw:
        row.cumulativeExternalFundingKrw?.toFixed(MONEY_SCALE) ?? null,
      investmentPnlKrw: row.investmentPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      snapshotReason: row.snapshotReason,
      externalFundingAmountKrw:
        row.externalFundingAmountKrw?.toFixed(MONEY_SCALE) ?? null,
    }));
  }

  /** Returns null (not []) when there are no daily rows, so the caller can
   * fall back to EquitySnapshot instead of showing an empty chart. */
  private async findDailyPoints(tradingAccountId: string, since: Date) {
    const rows = await this.prisma.dailyPortfolioSnapshot.findMany({
      where: { tradingAccountId, capturedAt: { gte: since } },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        seasonParticipantId: true,
        totalAssetKrw: true,
        returnRate: true,
        cumulativeExternalFundingKrw: true,
        investmentPnlKrw: true,
        capturedAt: true,
      },
    });

    if (rows.length === 0) {
      return null;
    }

    return rows.map((row) => ({
      time: row.capturedAt.toISOString(),
      totalAssetKrw: row.totalAssetKrw.toFixed(MONEY_SCALE),
      returnRate: row.returnRate.toFixed(RETURN_RATE_SCALE),
      returnRateMethod:
        row.seasonParticipantId === null
          ? ('time_weighted' as const)
          : ('initial_capital' as const),
      cumulativeExternalFundingKrw:
        row.cumulativeExternalFundingKrw?.toFixed(MONEY_SCALE) ?? null,
      investmentPnlKrw: row.investmentPnlKrw?.toFixed(MONEY_SCALE) ?? null,
      snapshotReason: SnapshotReason.scheduled,
      externalFundingAmountKrw: null,
    }));
  }

  private returnRateMethod(mode: TradingAccountMode) {
    return mode === TradingAccountMode.general
      ? ('time_weighted' as const)
      : ('initial_capital' as const);
  }

  private resolveSince(range: EquityRange, openedAt: Date): Date {
    const now = Date.now();
    switch (range) {
      case '1d':
        return new Date(now - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now - 30 * 24 * 60 * 60 * 1000);
      case 'all':
      default:
        // For a general account "all" means everything since it opened.
        return openedAt;
    }
  }

  private parseRange(value: string | undefined): EquityRange {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '' || text === '1d') return '1d';
    if (text === '7d' || text === '30d' || text === 'all') {
      return text;
    }

    throw new HttpException(
      {
        success: false,
        error: {
          code: 'INVALID_RANGE',
          message: 'range must be one of 1d, 7d, 30d, all.',
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

  /**
   * GENERAL_ACCOUNT_INTEGRITY, GENERAL_PERFORMANCE_*, AD_REWARD_CLAIM_INTEGRITY
   * and snapshot scope mismatches must never be flattened into a success
   * envelope — they are server-side damage, not a temporary data gap.
   */
  private rethrowStructuralError(error: unknown): unknown {
    return toGeneralPerformanceHttpException(error) ?? error;
  }

  private async resolveOwnedAccount(
    userId: string | undefined,
    accountId: string,
  ): Promise<OwnedTradingAccount> {
    if (!userId) {
      throw new HttpException(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Unknown and foreign accountIds are the SAME 404. Reads are allowed for
    // active, suspended, and closed accounts alike.
    return this.accessService.getOwnedAccountOrThrow(
      userId,
      typeof accountId === 'string' ? accountId.trim() : accountId,
    );
  }
}
