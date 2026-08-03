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
  pickLatestSnapshot,
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

/**
 * How many snapshots may legitimately share one account's newest capturedAt.
 * A boundary pair is 2; anything near this bound is data corruption.
 */
export const LATEST_SNAPSHOT_CANDIDATE_LIMIT = 32;

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
   * Latest performance snapshot, resolved in TWO bounded steps instead of one
   * ORDER BY (작업 7 보완 1).
   *
   * The previous `capturedAt desc, createdAt desc, id desc` was not
   * deterministic for the case it was written for: the external-funding pair is
   * created inside ONE transaction, so `before` and `after` routinely share
   * both capturedAt AND createdAt, and a random UUIDv4 then decided which of
   * them was "latest". When `before` won, the account read as an unpaired
   * boundary (500 GENERAL_PERFORMANCE_INTEGRITY) even though the payout had
   * committed perfectly.
   *
   * So the maximum capturedAt is resolved first, and only the rows AT that
   * instant — two in the worst realistic case — are loaded and ranked by
   * `snapshotPhaseRank`, which says outright that `after` is the committed end
   * state of an instant. No history is loaded into memory, and no ordering
   * meaning is read out of a UUID.
   */
  async findLatestPerformanceSnapshot(
    tradingAccountId: string,
    client: PerformanceClient = this.prisma,
  ): Promise<PerformanceSnapshotRow | null> {
    const newest = await client.equitySnapshot.findFirst({
      where: { tradingAccountId },
      orderBy: { capturedAt: 'desc' },
      select: { capturedAt: true },
    });
    if (!newest) {
      return null;
    }

    const candidates = await client.equitySnapshot.findMany({
      where: { tradingAccountId, capturedAt: newest.capturedAt },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LATEST_SNAPSHOT_CANDIDATE_LIMIT + 1,
      select: PERFORMANCE_SNAPSHOT_SELECT,
    });

    if (candidates.length > LATEST_SNAPSHOT_CANDIDATE_LIMIT) {
      // One instant legitimately holds an origin, an ordinary capture, or a
      // boundary pair. Dozens means something wrote in bulk with a shared
      // timestamp, and picking a "latest" out of a truncated page would be a
      // guess. Fail closed rather than rank an incomplete candidate set.
      this.throwPerformance(
        generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
        `More than ${LATEST_SNAPSHOT_CANDIDATE_LIMIT} performance snapshots share the newest capturedAt; the latest state cannot be determined.`,
      );
    }

    return pickLatestSnapshot(candidates);
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
   * The stored state an ordinary TWR advance may CONTINUE from: structurally
   * verified account + verified performance origin + a latest snapshot whose
   * cumulative external funding still matches the ledger (작업 7 보완 2).
   *
   * THE INVARIANT AND WHY IT IS NOT OPTIONAL
   * ----------------------------------------
   * An ordinary advance is `factor × currentTotal / previousTotal`. It assumes
   * every KRW between the two totals was earned. That assumption only holds
   * while no external funding arrived since the snapshot it advances from.
   *
   * Before this check, an ad payout whose ledger + wallet credit committed but
   * whose `after` boundary went missing left exactly that state: the ledger sum
   * had grown, the latest snapshot had not, and the very next portfolio read
   * silently reported the reward as INVESTMENT PROFIT. That is a wrong number
   * presented confidently, which is worse than an error — so the two sums must
   * agree or nothing advances.
   */
  async requireContinuousPerformanceState(input: {
    account: GeneralAccountIntegrityTarget;
    client?: PerformanceClient;
  }): Promise<{
    wallets: VerifiedGeneralAccountWallets;
    snapshot: PerformanceSnapshotRow;
    state: GeneralPerformanceState;
    funding: GeneralExternalFundingSummary;
  }> {
    const client = input.client ?? this.prisma;
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

    this.assertExternalFundingContinuity(
      snapshot.cumulativeExternalFundingKrw,
      funding.cumulativeExternalFundingKrw,
      `Latest general performance snapshot ${snapshot.id}`,
    );

    return { wallets, snapshot, state, funding };
  }

  /**
   * The one place the "no funding arrived behind performance's back" rule is
   * stated. Reported as GENERAL_PERFORMANCE_INTEGRITY on purpose: it is the
   * existing code for "stored performance state cannot be trusted", and a new
   * error code would only fragment the contract clients already handle.
   */
  assertExternalFundingContinuity(
    snapshotCumulativeKrw: Prisma.Decimal | null,
    ledgerCumulativeKrw: Prisma.Decimal,
    label: string,
  ): void {
    if (
      snapshotCumulativeKrw === null ||
      !snapshotCumulativeKrw
        .toDecimalPlaces(MONEY_SCALE)
        .equals(ledgerCumulativeKrw.toDecimalPlaces(MONEY_SCALE))
    ) {
      this.throwPerformance(
        generalPerformanceErrorCodes.GENERAL_PERFORMANCE_INTEGRITY,
        `${label} records cumulative external funding ${snapshotCumulativeKrw?.toFixed(MONEY_SCALE) ?? 'null'} but the verified external-funding ledger totals ${ledgerCumulativeKrw.toFixed(MONEY_SCALE)}. An external-funding boundary is missing, so the difference must not be advanced as investment performance.`,
      );
    }
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

    const { snapshot, state, funding } =
      await this.requireContinuousPerformanceState({
        account: input.account,
        client,
      });
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
    const { snapshot, state } = await this.requirePerformanceState(
      input.account.id,
      input.client,
    );
    const fundingBefore = await this.externalFundingService.summarize(
      input.account.id,
      input.wallets.krwWalletId,
      input.client,
    );

    // Inside the payout transaction the NEW ledger row does not exist yet, so
    // the stored state must still match the pre-payout ledger exactly. If it
    // does not, an earlier inflow is already unaccounted for and bracketing a
    // second one on top would bury the first (작업 7 보완 2).
    this.assertExternalFundingContinuity(
      snapshot.cumulativeExternalFundingKrw,
      fundingBefore.cumulativeExternalFundingKrw,
      `Latest general performance snapshot ${snapshot.id}`,
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

  /**
   * The other half of the continuity invariant, asserted INSIDE the payout
   * transaction once the ledger row and the `after` row both exist: the
   * committed boundary must equal the committed ledger (작업 7 보완 2 항목 7).
   *
   * Running it before COMMIT is what makes it useful — a mismatch rolls the
   * credit, the ledger row, the claim, and both boundary rows back together
   * instead of leaving the account in the exact state this work removes.
   */
  async assertExternalFundingSettled(input: {
    accountId: string;
    krwWalletId: string;
    expectedCumulativeKrw: Prisma.Decimal;
    client: PerformanceClient;
  }): Promise<void> {
    const funding = await this.externalFundingService.summarize(
      input.accountId,
      input.krwWalletId,
      input.client,
    );

    this.assertExternalFundingContinuity(
      input.expectedCumulativeKrw,
      funding.cumulativeExternalFundingKrw,
      `Committed external-funding "after" boundary of account ${input.accountId}`,
    );
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
