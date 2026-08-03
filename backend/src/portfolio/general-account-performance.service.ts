import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  SnapshotReason,
  TradingAccountMode,
  WalletTransactionReferenceType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertGeneralAccountFinancialIntegrity,
  throwGeneralAccountIntegrity,
  type GeneralAccountIntegrityTarget,
  type VerifiedGeneralAccountWallets,
} from '../trading-accounts/general-account-integrity';
import {
  GeneralExternalFundingService,
  type GeneralExternalFundingSummary,
} from './general-external-funding.service';
import {
  advanceGeneralPerformance,
  assertGeneralPerformanceStateConsistent,
  buildExternalFundingBoundary,
  buildGeneralPerformanceOrigin,
  generalPerformanceErrorCodes,
  GeneralPerformanceError,
  MONEY_SCALE,
  RETURN_RATE_SCALE,
  TWR_FACTOR_SCALE,
  type GeneralPerformanceAdvance,
  type GeneralPerformanceState,
} from './general-performance.policy';
import { PortfolioValuationService } from './portfolio-valuation.service';
import type { PortfolioValuationResult } from './portfolio-valuation.policy';

/**
 * General-mode performance: valuation + external-funding boundaries + TWR
 * (작업 7).
 *
 * Deliberately small and general-mode ONLY. Season performance keeps its
 * existing initial-capital return and none of this code runs for it.
 *
 * Reads never write. `resolveLivePerformance` is used by GET endpoints and
 * creates no EquitySnapshot, DailyPortfolioSnapshot, wallet, or claim — it
 * advances the stored factor in memory only.
 */

/** The performance origin reasons; exactly one must exist per account. */
export const GENERAL_PERFORMANCE_ORIGIN_REASONS = [
  SnapshotReason.general_account_open,
  SnapshotReason.performance_baseline,
] as const;

const PERFORMANCE_SNAPSHOT_SELECT = {
  id: true,
  seasonParticipantId: true,
  tradingAccountId: true,
  totalAssetKrw: true,
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
} satisfies Prisma.EquitySnapshotSelect;

type PerformanceSnapshotRow = Prisma.EquitySnapshotGetPayload<{
  select: typeof PERFORMANCE_SNAPSHOT_SELECT;
}>;

type PerformanceClient = Prisma.TransactionClient | PrismaService;

export type GeneralLivePerformance = {
  valuation: PortfolioValuationResult;
  funding: GeneralExternalFundingSummary;
  /** Stored state the live numbers were advanced from. */
  latestSnapshot: PerformanceSnapshotRow;
  advance: GeneralPerformanceAdvance;
};

export type GeneralSnapshotWriteValues = {
  tradingAccountId: string;
  totalAssetKrw: string;
  returnRate: string;
  krwCash: string;
  usdCashKrw: string;
  domesticStockValueKrw: string;
  usStockValueKrw: string;
  cryptoValueKrw: string;
  cumulativeExternalFundingKrw: string;
  investmentPnlKrw: string;
  timeWeightedReturnFactor: string;
};

@Injectable()
export class GeneralAccountPerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly valuationService: PortfolioValuationService,
    private readonly externalFundingService: GeneralExternalFundingService,
  ) {}

  // ------------------------------------------------------------- origin

  /**
   * The origin snapshot written in the SAME transaction as a new general
   * account. Nothing has been earned yet, so the factor is exactly 1.
   */
  buildOriginSnapshotData(input: {
    tradingAccountId: string;
    initialFundingKrw: Prisma.Decimal | string;
    openedAt: Date;
  }): Prisma.EquitySnapshotUncheckedCreateInput {
    const origin = buildGeneralPerformanceOrigin(input.initialFundingKrw);

    return {
      seasonParticipantId: null,
      tradingAccountId: input.tradingAccountId,
      totalAssetKrw: origin.totalAssetKrw.toFixed(MONEY_SCALE),
      returnRate: origin.returnRate.toFixed(RETURN_RATE_SCALE),
      krwCash: origin.totalAssetKrw.toFixed(MONEY_SCALE),
      usdCashKrw: '0',
      domesticStockValueKrw: '0',
      usStockValueKrw: '0',
      cryptoValueKrw: '0',
      snapshotReason: SnapshotReason.general_account_open,
      cumulativeExternalFundingKrw:
        origin.cumulativeExternalFundingKrw.toFixed(MONEY_SCALE),
      investmentPnlKrw: origin.investmentPnlKrw.toFixed(MONEY_SCALE),
      timeWeightedReturnFactor:
        origin.timeWeightedReturnFactor.toFixed(TWR_FACTOR_SCALE),
      // The opening grant IS an external funding event; recording it as the
      // account's own reference makes the boundary partial unique cover it,
      // so a second origin can never be inserted.
      externalFundingAmountKrw: origin.totalAssetKrw.toFixed(MONEY_SCALE),
      externalFundingReferenceType:
        WalletTransactionReferenceType.general_account_open,
      externalFundingReferenceId: input.tradingAccountId,
      capturedAt: input.openedAt,
    };
  }

  // ------------------------------------------------------------- reads

  /**
   * Latest performance snapshot, in a DETERMINISTIC order.
   *
   * The tie-breakers matter: an external-funding before/after pair is written
   * with the SAME capturedAt inside one transaction, so ordering by
   * capturedAt alone could return `before` and make the next advance
   * double-count the inflow. createdAt then id makes the winner unambiguous.
   */
  async findLatestPerformanceSnapshot(
    tradingAccountId: string,
    client: PerformanceClient = this.prisma,
  ): Promise<PerformanceSnapshotRow | null> {
    return client.equitySnapshot.findFirst({
      where: { tradingAccountId },
      orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: PERFORMANCE_SNAPSHOT_SELECT,
    });
  }

  /**
   * Loads and validates the account's stored performance state. Throws
   * GENERAL_PERFORMANCE_NOT_INITIALIZED when the account predates 작업 7 and
   * has no origin — never fabricates one, because guessing a baseline
   * silently rewrites the user's return history.
   */
  async requirePerformanceState(
    tradingAccountId: string,
    client: PerformanceClient = this.prisma,
  ): Promise<{
    snapshot: PerformanceSnapshotRow;
    state: GeneralPerformanceState;
  }> {
    const [origins, latest] = await Promise.all([
      client.equitySnapshot.count({
        where: {
          tradingAccountId,
          snapshotReason: { in: [...GENERAL_PERFORMANCE_ORIGIN_REASONS] },
        },
      }),
      this.findLatestPerformanceSnapshot(tradingAccountId, client),
    ]);

    if (origins === 0 || !latest) {
      this.throwPerformance(
        generalPerformanceErrorCodes.GENERAL_PERFORMANCE_NOT_INITIALIZED,
        'General account has no performance origin snapshot. Run "pnpm trading-accounts:backfill-general-performance --apply" before reading performance.',
      );
    }
    if (origins > 1) {
      this.throwPerformance(
        generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
        'General account has more than one performance origin snapshot.',
      );
    }

    if (latest.seasonParticipantId !== null) {
      this.throwPerformance(
        generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
        'General performance snapshot carries a season participant link.',
      );
    }

    // A committed state can never end on an unpaired `before`: the payout
    // transaction writes before + credit + ledger + claim + after atomically.
    // Seeing one means a partial write escaped, so continuing from it would
    // compound the error.
    if (latest.snapshotReason === SnapshotReason.external_funding_before) {
      this.throwPerformance(
        generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
        'Latest general performance snapshot is an unpaired external-funding "before" row.',
      );
    }

    const state = this.assertSnapshotConsistent(latest);

    return { snapshot: latest, state };
  }

  /**
   * Live performance for a GET: current valuation advanced from the stored
   * factor. Writes nothing.
   */
  async resolveLivePerformance(input: {
    account: GeneralAccountIntegrityTarget;
    valuationAt?: Date;
    client?: PerformanceClient;
  }): Promise<GeneralLivePerformance> {
    const client = input.client ?? this.prisma;
    const valuationAt = input.valuationAt ?? new Date();

    const wallets = await this.assertGeneralAccountReady(input.account, client);
    const { snapshot, state } = await this.requirePerformanceState(
      input.account.id,
      client,
    );
    const funding = await this.externalFundingService.summarize(
      input.account.id,
      wallets.krwWalletId,
      client,
    );
    const valuation =
      await this.valuationService.calculateTradingAccountValuation(
        input.account.id,
        valuationAt,
        'home_live_valuation',
        client,
      );

    const advance = advanceGeneralPerformance({
      previous: state,
      currentTotalAssetKrw: valuation.totalAssetKrw,
      cumulativeExternalFundingKrw: funding.cumulativeExternalFundingKrw,
    });

    return { valuation, funding, latestSnapshot: snapshot, advance };
  }

  // ------------------------------------------------------------- writes

  /**
   * The ordinary (no external funding) snapshot values for a scheduled or
   * daily capture. The caller persists them inside its own transaction.
   */
  async buildOrdinarySnapshotValues(input: {
    account: GeneralAccountIntegrityTarget;
    valuationAt: Date;
    client: PerformanceClient;
  }): Promise<{
    values: GeneralSnapshotWriteValues;
    valuation: PortfolioValuationResult;
  }> {
    const live = await this.resolveLivePerformance({
      account: input.account,
      valuationAt: input.valuationAt,
      client: input.client,
    });

    return {
      valuation: live.valuation,
      values: this.toWriteValues(
        input.account.id,
        live.valuation,
        live.advance,
      ),
    };
  }

  /**
   * The before/after pair bracketing an external virtual-funding inflow.
   *
   * BEFORE captures every bit of market performance up to the instant of the
   * credit. AFTER adds ONLY the money: same investment PnL, same factor, same
   * return rate. That is what makes an ad reward performance-neutral.
   */
  async buildExternalFundingSnapshots(input: {
    account: GeneralAccountIntegrityTarget;
    wallets: VerifiedGeneralAccountWallets;
    externalFundingAmountKrw: Prisma.Decimal | string;
    referenceType: WalletTransactionReferenceType;
    referenceId: string;
    capturedAt: Date;
    client: PerformanceClient;
  }): Promise<{
    before: Prisma.EquitySnapshotUncheckedCreateInput;
    after: Prisma.EquitySnapshotUncheckedCreateInput;
    afterState: GeneralPerformanceAdvance;
  }> {
    const { state } = await this.requirePerformanceState(
      input.account.id,
      input.client,
    );
    const fundingBefore = await this.externalFundingService.summarize(
      input.account.id,
      input.wallets.krwWalletId,
      input.client,
    );
    const valuation =
      await this.valuationService.calculateTradingAccountValuation(
        input.account.id,
        input.capturedAt,
        'home_live_valuation',
        input.client,
      );

    const { before, after } = buildExternalFundingBoundary({
      previous: state,
      totalAssetBeforeKrw: valuation.totalAssetKrw,
      cumulativeExternalFundingBeforeKrw:
        fundingBefore.cumulativeExternalFundingKrw,
      externalFundingAmountKrw: input.externalFundingAmountKrw,
    });

    const amountText = new Prisma.Decimal(
      input.externalFundingAmountKrw,
    ).toFixed(MONEY_SCALE);

    return {
      before: this.toBoundarySnapshotData({
        accountId: input.account.id,
        valuation,
        advance: before,
        reason: SnapshotReason.external_funding_before,
        amountText,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        capturedAt: input.capturedAt,
      }),
      after: this.toBoundarySnapshotData({
        accountId: input.account.id,
        valuation,
        advance: after,
        reason: SnapshotReason.external_funding_after,
        amountText,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        capturedAt: input.capturedAt,
        // The AFTER row's cash reflects the credited money.
        krwCashOverride: new Prisma.Decimal(valuation.krwCash)
          .add(input.externalFundingAmountKrw)
          .toFixed(MONEY_SCALE),
      }),
      afterState: after,
    };
  }

  // ------------------------------------------------------------ helpers

  /**
   * Full general-account financial structure + the trading-disabled
   * invariant. General trading is not activated in this release, so any
   * Order/Position/Exchange/FxExecuteRequest on a general account means data
   * arrived through a path that is not supposed to exist — valuing it as if
   * it were normal would produce a confidently wrong number.
   */
  async assertGeneralAccountReady(
    account: GeneralAccountIntegrityTarget,
    client: PerformanceClient = this.prisma,
  ): Promise<VerifiedGeneralAccountWallets> {
    if (account.mode !== TradingAccountMode.general) {
      throwGeneralAccountIntegrity(account.id, 'account mode is not general');
    }

    const wallets = await assertGeneralAccountFinancialIntegrity(
      client,
      account,
    );

    const [orders, positions, exchanges, fxRequests] = await Promise.all([
      client.order.count({ where: { tradingAccountId: account.id } }),
      client.position.count({ where: { tradingAccountId: account.id } }),
      client.exchangeTransaction.count({
        where: { tradingAccountId: account.id },
      }),
      client.fxExecuteRequest.count({
        where: { tradingAccountId: account.id },
      }),
    ]);

    if (orders > 0 || positions > 0 || exchanges > 0 || fxRequests > 0) {
      throwGeneralAccountIntegrity(
        account.id,
        `general trading is not enabled in this release but the account has orders=${orders}, positions=${positions}, exchanges=${exchanges}, fxRequests=${fxRequests}`,
      );
    }

    return wallets;
  }

  private assertSnapshotConsistent(
    snapshot: PerformanceSnapshotRow,
  ): GeneralPerformanceState {
    return assertGeneralPerformanceStateConsistent(
      {
        totalAssetKrw: snapshot.totalAssetKrw,
        cumulativeExternalFundingKrw: snapshot.cumulativeExternalFundingKrw,
        investmentPnlKrw: snapshot.investmentPnlKrw,
        timeWeightedReturnFactor: snapshot.timeWeightedReturnFactor,
        returnRate: snapshot.returnRate,
      },
      `General performance snapshot ${snapshot.id}`,
    );
  }

  private toWriteValues(
    tradingAccountId: string,
    valuation: PortfolioValuationResult,
    advance: GeneralPerformanceAdvance,
  ): GeneralSnapshotWriteValues {
    return {
      tradingAccountId,
      totalAssetKrw: advance.totalAssetKrw.toFixed(MONEY_SCALE),
      returnRate: advance.returnRate.toFixed(RETURN_RATE_SCALE),
      krwCash: valuation.krwCash,
      usdCashKrw: valuation.usdCashKrw,
      domesticStockValueKrw: valuation.domesticStockValueKrw,
      usStockValueKrw: valuation.usStockValueKrw,
      cryptoValueKrw: valuation.cryptoValueKrw,
      cumulativeExternalFundingKrw:
        advance.cumulativeExternalFundingKrw.toFixed(MONEY_SCALE),
      investmentPnlKrw: advance.investmentPnlKrw.toFixed(MONEY_SCALE),
      timeWeightedReturnFactor:
        advance.timeWeightedReturnFactor.toFixed(TWR_FACTOR_SCALE),
    };
  }

  private toBoundarySnapshotData(input: {
    accountId: string;
    valuation: PortfolioValuationResult;
    advance: GeneralPerformanceAdvance;
    reason: SnapshotReason;
    amountText: string;
    referenceType: WalletTransactionReferenceType;
    referenceId: string;
    capturedAt: Date;
    krwCashOverride?: string;
  }): Prisma.EquitySnapshotUncheckedCreateInput {
    return {
      seasonParticipantId: null,
      tradingAccountId: input.accountId,
      totalAssetKrw: input.advance.totalAssetKrw.toFixed(MONEY_SCALE),
      returnRate: input.advance.returnRate.toFixed(RETURN_RATE_SCALE),
      krwCash: input.krwCashOverride ?? input.valuation.krwCash,
      usdCashKrw: input.valuation.usdCashKrw,
      domesticStockValueKrw: input.valuation.domesticStockValueKrw,
      usStockValueKrw: input.valuation.usStockValueKrw,
      cryptoValueKrw: input.valuation.cryptoValueKrw,
      snapshotReason: input.reason,
      cumulativeExternalFundingKrw:
        input.advance.cumulativeExternalFundingKrw.toFixed(MONEY_SCALE),
      investmentPnlKrw: input.advance.investmentPnlKrw.toFixed(MONEY_SCALE),
      timeWeightedReturnFactor:
        input.advance.timeWeightedReturnFactor.toFixed(TWR_FACTOR_SCALE),
      externalFundingAmountKrw: input.amountText,
      externalFundingReferenceType: input.referenceType,
      externalFundingReferenceId: input.referenceId,
      capturedAt: input.capturedAt,
    };
  }

  private throwPerformance(code: string, message: string): never {
    throw new HttpException(
      { success: false, error: { code, message } },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

/** Maps the pure policy's error into the API's structured 500 envelope. */
export function toGeneralPerformanceHttpException(
  error: unknown,
): HttpException | null {
  if (!(error instanceof GeneralPerformanceError)) {
    return null;
  }

  return new HttpException(
    { success: false, error: { code: error.code, message: error.message } },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
