import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  SnapshotReason,
  TradingAccountMode,
  TradingAccountStatus,
} from '../generated/prisma/client';
import {
  GeneralAccountPerformanceService,
  type GeneralSnapshotWriteValues,
} from '../portfolio/general-account-performance.service';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import { PrismaService } from '../prisma/prisma.service';
import { BatchService } from './batch.service';
import {
  GENERAL_DAILY_SNAPSHOT_JOB_NAME,
  GeneralDailySnapshotJobAccountError,
  GeneralDailySnapshotJobErrorCode,
  GeneralDailySnapshotJobInput,
  GeneralDailySnapshotJobRequestPayload,
  GeneralDailySnapshotJobResult,
  GeneralDailySnapshotJobRunResponse,
} from './general-daily-snapshot-job.types';

/**
 * Daily portfolio snapshot for GENERAL-mode accounts (작업 7 보완 5).
 *
 * This is deliberately NOT a new scheduler. It is a BatchService job like every
 * other one: same `batch_job_runs` row, same (jobName, idempotencyKey) unique,
 * same dry-run flag, same `pnpm admin:run-batch-job` entry point, same
 * YYYY-MM-DD → UTC-midnight `snapshotDate` parsing as the season job. No new
 * timezone rule, no market calendar, no distributed lock, no message queue.
 *
 * WHY IT IS A SEPARATE JOB FROM THE SEASON ONE
 * -------------------------------------------
 * The season job is season-scoped: it takes a required `seasonId`, walks
 * SeasonParticipants, and writes participant-keyed rows with an
 * initial-capital return. A general account has no season and no participant,
 * its subject is the TradingAccount, and its returnRate is a TWR percent that
 * only exists alongside factor / cumulative external funding / investment PnL
 * columns. Bolting that onto the season job would have meant a job whose
 * required parameter is meaningless for half its input. The season job's
 * behaviour and API contract are untouched here.
 *
 * ACCOUNT SELECTION
 *   active    → included
 *   suspended → included (a suspended account still HOLDS value; freezing its
 *               chart would misrepresent it as flat rather than frozen)
 *   closed    → excluded, and never written to in any way
 *
 * ATOMICITY
 * Each account gets ONE transaction that writes the scheduled EquitySnapshot
 * and the DailyPortfolioSnapshot together. The daily row is written SECOND so
 * that when a concurrent run has already claimed (tradingAccountId,
 * snapshotDate), the unique violation aborts this transaction and takes its
 * EquitySnapshot down with it — the loser leaves nothing behind.
 *
 * CONCURRENCY WITH AD PAYOUTS (작업 6·7 보완 2)
 * -------------------------------------------
 * The ad-reward payout locks the TradingAccount row `FOR UPDATE` before it
 * credits the wallet and writes its before/after boundary. This job takes the
 * SAME lock, first thing inside each account's transaction, so the two are
 * strictly serialised per account. Only two orderings remain possible:
 *
 *   daily first  → the daily row captures the pre-payout state, and the payout
 *                  then brackets it with its own boundary pair;
 *   payout first → the daily row captures the post-payout state, whose
 *                  cumulative external funding already includes the reward.
 *
 * Neither produces the mixed state this work removes (post-payout wallet with
 * pre-payout funding sum), where the reward would be recorded as investment
 * profit in a snapshot that lives forever. No global lock and no all-accounts
 * transaction: one account at a time, exactly as the payout does.
 */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const GENERAL_ACCOUNT_SELECT = {
  id: true,
  userId: true,
  mode: true,
  status: true,
  initialCapitalKrw: true,
  seasonParticipant: { select: { id: true } },
} satisfies Prisma.TradingAccountSelect;

type GeneralAccountRow = Prisma.TradingAccountGetPayload<{
  select: typeof GENERAL_ACCOUNT_SELECT;
}>;

/** Structural codes that mean "damaged", not "market data is late". */
const INTEGRITY_ERROR_CODES = new Set<GeneralDailySnapshotJobErrorCode>([
  'GENERAL_ACCOUNT_INTEGRITY',
  'GENERAL_PERFORMANCE_NOT_INITIALIZED',
  'GENERAL_PERFORMANCE_INTEGRITY',
  'GENERAL_PERFORMANCE_DISCONTINUITY',
  'AD_REWARD_CLAIM_INTEGRITY',
]);

@Injectable()
export class GeneralDailySnapshotJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
    private readonly performanceService: GeneralAccountPerformanceService,
  ) {}

  async run(
    input: GeneralDailySnapshotJobInput,
  ): Promise<GeneralDailySnapshotJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: GeneralDailySnapshotJobRequestPayload = {
      snapshotDate: this.parseOptionalText(input.snapshotDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      GeneralDailySnapshotJobRequestPayload,
      GeneralDailySnapshotJobResult
    >({
      jobName: GENERAL_DAILY_SNAPSHOT_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ startedAt }) =>
        this.runGeneralSnapshotJob(input, dryRun, startedAt),
    });
  }

  private async runGeneralSnapshotJob(
    input: GeneralDailySnapshotJobInput,
    dryRun: boolean,
    capturedAt: Date,
  ): Promise<GeneralDailySnapshotJobResult> {
    const { text: snapshotDateText, date: snapshotDate } =
      this.parseSnapshotDate(input.snapshotDate);

    const [accounts, excludedClosed] = await Promise.all([
      this.prisma.tradingAccount.findMany({
        where: {
          mode: TradingAccountMode.general,
          status: {
            in: [TradingAccountStatus.active, TradingAccountStatus.suspended],
          },
        },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
        select: GENERAL_ACCOUNT_SELECT,
      }),
      this.prisma.tradingAccount.count({
        where: {
          mode: TradingAccountMode.general,
          status: TradingAccountStatus.closed,
        },
      }),
    ]);

    const result: GeneralDailySnapshotJobResult = {
      snapshotDate: snapshotDateText,
      dryRun,
      accounts: {
        total: accounts.length,
        created: 0,
        wouldCreate: 0,
        existing: 0,
        failed: 0,
        integrityFailed: 0,
        valuationFailed: 0,
        excludedClosed,
        skippedClosedDuringRun: 0,
      },
      createdSnapshotIds: [],
      createdEquitySnapshotIds: [],
      errors: [],
    };

    for (const account of accounts) {
      await this.processAccount({
        account,
        snapshotDate,
        capturedAt,
        dryRun,
        result,
      });
    }

    return result;
  }

  private async processAccount(input: {
    account: GeneralAccountRow;
    snapshotDate: Date;
    capturedAt: Date;
    dryRun: boolean;
    result: GeneralDailySnapshotJobResult;
  }): Promise<void> {
    const { account, result } = input;

    const existing = await this.prisma.dailyPortfolioSnapshot.findUnique({
      where: {
        tradingAccountId_snapshotDate: {
          tradingAccountId: account.id,
          snapshotDate: input.snapshotDate,
        },
      },
      select: { id: true },
    });
    if (existing) {
      result.accounts.existing += 1;
      return;
    }

    if (input.dryRun) {
      // Dry run still runs the FULL performance computation, because "how many
      // accounts would this job actually be able to snapshot" is the only
      // useful answer — but it opens no transaction and writes nothing.
      try {
        await this.performanceService.buildOrdinarySnapshotValues({
          account,
          valuationAt: input.capturedAt,
          client: this.prisma,
        });
        result.accounts.wouldCreate += 1;
      } catch (error) {
        this.recordAccountError(result, account, error);
      }
      return;
    }

    try {
      const written = await this.prisma.$transaction(async (tx) => {
        // ---- 1) SERIALIZATION POINT: the same row lock the ad payout takes.
        const locked = await this.lockGeneralAccount(tx, account.id);
        if (!locked) {
          return { skippedClosed: true as const };
        }

        // ---- 2) Re-checked from the LOCKED row, not from the list read at
        // the top of the run. An account can be closed, suspended, or
        // re-scoped between the two, and a snapshot written for a closed
        // account is permanent damage.
        const reloaded = await tx.tradingAccount.findFirst({
          where: { id: account.id, mode: TradingAccountMode.general },
          select: GENERAL_ACCOUNT_SELECT,
        });
        if (
          !reloaded ||
          reloaded.status === TradingAccountStatus.closed ||
          reloaded.seasonParticipant !== null
        ) {
          return { skippedClosed: true as const };
        }

        // ---- 3) capturedAt is decided AFTER the lock, per account.
        // The batch's startedAt could be far in the past by the time this
        // account's turn arrives — earlier accounts take time, and this one may
        // have waited behind an ad payout. Stamping every account with the run
        // clock would date a valuation to an instant its wallets never held.
        const capturedAt = new Date();

        // Computed INSIDE the transaction so the values written are the ones
        // read from a single consistent snapshot of wallets, ledger, and
        // performance state — and, under the lock, one the payout cannot move.
        const { values, valuation } =
          await this.performanceService.buildOrdinarySnapshotValues({
            account: reloaded,
            valuationAt: capturedAt,
            client: tx,
          });

        const equity = await tx.equitySnapshot.create({
          data: {
            seasonParticipantId: null,
            tradingAccountId: account.id,
            totalAssetKrw: values.totalAssetKrw,
            returnRate: values.returnRate,
            krwCash: values.krwCash,
            usdCashKrw: values.usdCashKrw,
            domesticStockValueKrw: values.domesticStockValueKrw,
            usStockValueKrw: values.usStockValueKrw,
            cryptoValueKrw: values.cryptoValueKrw,
            snapshotReason: SnapshotReason.scheduled,
            cumulativeExternalFundingKrw: values.cumulativeExternalFundingKrw,
            investmentPnlKrw: values.investmentPnlKrw,
            timeWeightedReturnFactor: values.timeWeightedReturnFactor,
            // A scheduled capture is NOT an external-funding boundary; the
            // reference columns stay null so it can never collide with a real
            // boundary pair on the partial unique.
            externalFundingAmountKrw: null,
            externalFundingReferenceType: null,
            externalFundingReferenceId: null,
            capturedAt,
          },
          select: { id: true },
        });

        // SECOND on purpose: this is the row carrying the (account, date)
        // unique, so a concurrent winner aborts the whole transaction here and
        // the EquitySnapshot above rolls back with it.
        const daily = await tx.dailyPortfolioSnapshot.create({
          data: this.buildDailyData({
            accountId: account.id,
            values,
            valuation,
            snapshotDate: input.snapshotDate,
            // The SAME capturedAt as the EquitySnapshot beside it: two rows
            // describing one valuation instant never disagree about when.
            capturedAt,
          }),
          select: { id: true },
        });

        return { equityId: equity.id, dailyId: daily.id };
      });

      if ('skippedClosed' in written) {
        // Counted with the accounts excluded up front. The account was live
        // when the run listed it and closed before its turn; that is a normal
        // race, not a failure, and it must leave NO snapshot behind.
        result.accounts.excludedClosed += 1;
        result.accounts.skippedClosedDuringRun += 1;
        return;
      }

      result.accounts.created += 1;
      result.createdEquitySnapshotIds.push(written.equityId);
      result.createdSnapshotIds.push(written.dailyId);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        // A concurrent run committed this (account, date) first. Nothing of
        // this attempt survives, which is exactly the intended outcome.
        result.accounts.existing += 1;
        return;
      }

      this.recordAccountError(result, account, error);
    }
  }

  /**
   * The SAME lock the ad-reward payout takes: `trading_accounts` row, pinned to
   * `mode = 'general'`, `FOR UPDATE`. Returns null when the row no longer
   * matches, so the caller skips the account instead of writing to it.
   *
   * Only ONE account is ever locked at a time, and only for the duration of its
   * own transaction — never a global or all-accounts lock.
   */
  private async lockGeneralAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
  ): Promise<{ id: string; status: TradingAccountStatus } | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; status: TradingAccountStatus }>
    >`
      SELECT "id", "status"
      FROM "trading_accounts"
      WHERE "id" = ${accountId}
        AND "mode" = 'general'
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  private buildDailyData(input: {
    accountId: string;
    values: GeneralSnapshotWriteValues;
    valuation: {
      assetValueKrw: string;
      realizedPnlKrw: string;
      unrealizedPnlKrw: string;
    };
    snapshotDate: Date;
    capturedAt: Date;
  }): Prisma.DailyPortfolioSnapshotUncheckedCreateInput {
    return {
      // A general daily row has no participant, ever. The season job's rows
      // are untouched by this writer.
      seasonParticipantId: null,
      tradingAccountId: input.accountId,
      snapshotDate: input.snapshotDate,
      totalAssetKrw: input.values.totalAssetKrw,
      // TWR percent, matching the scheduled EquitySnapshot written beside it.
      returnRate: input.values.returnRate,
      krwCash: input.values.krwCash,
      usdCashKrw: input.values.usdCashKrw,
      assetValueKrw: input.valuation.assetValueKrw,
      realizedPnlKrw: input.valuation.realizedPnlKrw,
      unrealizedPnlKrw: input.valuation.unrealizedPnlKrw,
      cumulativeExternalFundingKrw: input.values.cumulativeExternalFundingKrw,
      investmentPnlKrw: input.values.investmentPnlKrw,
      timeWeightedReturnFactor: input.values.timeWeightedReturnFactor,
      capturedAt: input.capturedAt,
    };
  }

  /**
   * One account's failure never aborts the run — same rule as the season daily
   * job. The account is counted, its reason is recorded, and NO partial
   * snapshot is written for it: a damaged or unvaluable account must not get a
   * plausible-looking 0 KRW row.
   */
  private recordAccountError(
    result: GeneralDailySnapshotJobResult,
    account: GeneralAccountRow,
    error: unknown,
  ): void {
    const code = this.toAccountErrorCode(error);
    result.accounts.failed += 1;
    if (INTEGRITY_ERROR_CODES.has(code)) {
      result.accounts.integrityFailed += 1;
    } else {
      result.accounts.valuationFailed += 1;
    }

    result.errors.push({
      tradingAccountId: account.id,
      userId: account.userId,
      code,
      message: this.toErrorMessage(error),
    } satisfies GeneralDailySnapshotJobAccountError);
  }

  private toAccountErrorCode(error: unknown): GeneralDailySnapshotJobErrorCode {
    if (error instanceof PortfolioValuationError) {
      if (
        error.code === 'FX_RATE_UNAVAILABLE' ||
        error.code === 'FX_RATE_STALE' ||
        error.code === 'ASSET_PRICE_UNAVAILABLE'
      ) {
        return error.code;
      }
      return 'VALUATION_UNAVAILABLE';
    }

    const structured = this.readStructuredErrorCode(error);
    if (structured && INTEGRITY_ERROR_CODES.has(structured)) {
      return structured;
    }

    return 'VALUATION_UNAVAILABLE';
  }

  private readStructuredErrorCode(
    error: unknown,
  ): GeneralDailySnapshotJobErrorCode | null {
    if (!(error instanceof HttpException)) {
      return null;
    }

    const response = error.getResponse();
    if (
      typeof response !== 'object' ||
      response === null ||
      !('error' in response) ||
      typeof response.error !== 'object' ||
      response.error === null ||
      !('code' in response.error)
    ) {
      return null;
    }

    const code = response.error.code;
    return typeof code === 'string'
      ? (code as GeneralDailySnapshotJobErrorCode)
      : null;
  }

  private toErrorMessage(error: unknown): string {
    const structured = this.readStructuredErrorMessage(error);
    if (structured) {
      return structured;
    }
    if (error instanceof Error && error.message.trim() !== '') {
      return error.message;
    }
    return 'General account daily snapshot could not be generated.';
  }

  private readStructuredErrorMessage(error: unknown): string | null {
    if (!(error instanceof HttpException)) {
      return null;
    }

    const response = error.getResponse();
    if (
      typeof response !== 'object' ||
      response === null ||
      !('error' in response) ||
      typeof response.error !== 'object' ||
      response.error === null ||
      !('message' in response.error)
    ) {
      return null;
    }

    const message = response.error.message;
    return typeof message === 'string' && message.trim() !== ''
      ? message
      : null;
  }

  private resolveIdempotencyKey(input: GeneralDailySnapshotJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    // The default business key is the date, so two concurrent scheduled runs
    // for the same day collide on the batch_job_runs unique before either
    // touches a snapshot.
    return `${GENERAL_DAILY_SNAPSHOT_JOB_NAME}:${
      this.parseOptionalText(input.snapshotDate) ?? 'missing-snapshot-date'
    }`;
  }

  /** Identical parsing and timezone meaning as the season daily job. */
  private parseSnapshotDate(value: string | undefined): {
    text: string;
    date: Date;
  } {
    const text = this.parseRequiredText(value, 'snapshotDate');
    if (!DATE_ONLY_PATTERN.test(text)) {
      this.throwJobError('snapshotDate must be YYYY-MM-DD.');
    }

    const date = new Date(`${text}T00:00:00.000Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== text
    ) {
      this.throwJobError('snapshotDate must be YYYY-MM-DD.');
    }

    return { text, date };
  }

  private parseRequiredText(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwJobError(`${fieldName} is required.`);
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

  private throwJobError(message: string): never {
    throw new HttpException(
      { success: false, error: { code: 'BAD_REQUEST', message } },
      HttpStatus.BAD_REQUEST,
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
