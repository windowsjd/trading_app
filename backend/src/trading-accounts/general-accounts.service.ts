import { zeroCryptoCashWalletData } from '../wallets/canonical-cash-wallets';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CurrencyCode,
  Prisma,
  TradingAccountMode,
  TradingAccountStatus,
  type WalletScope,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertGeneralAccountFinancialIntegrity } from './general-account-integrity';
import { assertBeginnerModeEnabled } from './account-mode-policy';
import {
  GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
  GENERAL_ACCOUNT_INITIAL_USD_BALANCE,
  GENERAL_ACCOUNT_ZERO_AMOUNT,
} from './general-account.policy';

/**
 * Explicit general/beginner entry, each with its own owner partial unique index.
 * Retries converge on one account per mode, four canonical wallets and one
 * 10,000,000 KRW grant. Beginner entry additionally requires development opt-in.
 *
 * Everything the first call writes lives in a SINGLE transaction: if any
 * step fails, the account, wallets, grant and TWR origin roll back together —
 * a half-opened account can never be observed.
 *
 * NOT done here, on purpose:
 *  - no DailyPortfolioSnapshot (the daily job owns these),
 *  - no SeasonParticipant,
 *  - no re-grant, top-up, or repair of an existing/damaged account,
 *  - no reactivation of a suspended or closed general account.
 */

const ACCOUNT_SELECT = {
  id: true,
  userId: true,
  mode: true,
  status: true,
  initialCapitalKrw: true,
  openedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  seasonParticipant: { select: { id: true } },
} satisfies Prisma.TradingAccountSelect;

type GeneralAccountRecord = Prisma.TradingAccountGetPayload<{
  select: typeof ACCOUNT_SELECT;
}>;

type GeneralWalletView = {
  /** Returned for beginner's four-wallet response; general response is unchanged. */
  walletScope?: WalletScope;
  currencyCode: CurrencyCode;
  balanceAmount: string;
  reservedAmount: string;
  availableAmount: string;
  updatedAt: string;
};

export type OpenGeneralAccountResponse = {
  success: true;
  data: {
    /** true only for the call that actually created the account. */
    created: boolean;
    account: {
      id: string;
      mode: TradingAccountMode;
      status: TradingAccountStatus;
      initialCapitalKrw: string;
      openedAt: string;
      closedAt: string | null;
      createdAt: string;
      updatedAt: string;
      /** Always null: a general account is never linked to a season. */
      season: null;
    };
    wallets: GeneralWalletView[];
  };
};

@Injectable()
export class GeneralAccountsService {
  private readonly logger = new Logger(GeneralAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly performanceService: GeneralAccountPerformanceService,
  ) {}

  async openGeneralAccount(
    userId: string | undefined,
  ): Promise<OpenGeneralAccountResponse> {
    return this.openStandaloneAccount(userId, TradingAccountMode.general);
  }

  async openBeginnerAccount(
    userId: string | undefined,
  ): Promise<OpenGeneralAccountResponse> {
    this.requireUserId(userId);
    assertBeginnerModeEnabled(TradingAccountMode.beginner);
    return this.openStandaloneAccount(userId, TradingAccountMode.beginner);
  }

  private async openStandaloneAccount(
    userId: string | undefined,
    mode: 'general' | 'beginner',
  ): Promise<OpenGeneralAccountResponse> {
    const ownerId = this.requireUserId(userId);

    const existing = await this.findGeneralAccount(ownerId, mode);
    if (existing) {
      return this.buildReplayResponse(existing);
    }

    try {
      const created = await this.createGeneralAccountInTransaction(
        ownerId,
        mode,
      );
      this.logger.log(
        JSON.stringify({
          event: `${mode}_account_opened`,
          tradingAccountId: created.id,
        }),
      );
      return this.buildResponse(created, true);
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      // A concurrent request won the partial unique index. Never surface that
      // as a 500: re-read the winner's account and replay it, so both callers
      // see the same single account, wallets, and grant.
      const raced = await this.findGeneralAccount(ownerId, mode);
      if (!raced) {
        throw error;
      }
      return this.buildReplayResponse(raced);
    }
  }

  private async createGeneralAccountInTransaction(
    userId: string,
    mode: 'general' | 'beginner',
  ): Promise<GeneralAccountRecord> {
    return this.prisma.$transaction(async (tx) => {
      const openedAt = new Date();

      const account = await tx.tradingAccount.create({
        data: {
          userId,
          mode,
          status: TradingAccountStatus.active,
          initialCapitalKrw: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
          openedAt,
          closedAt: null,
        },
        select: { id: true },
      });

      // General wallets carry NO season participant — the scope is purely the
      // trading account.
      const krwWallet = await tx.cashWallet.create({
        data: {
          walletScope: 'securities',
          tradingAccountId: account.id,
          currencyCode: CurrencyCode.KRW,
          balanceAmount: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
          reservedAmount: GENERAL_ACCOUNT_ZERO_AMOUNT,
        },
        select: { id: true },
      });

      await tx.cashWallet.create({
        data: {
          walletScope: 'securities',
          tradingAccountId: account.id,
          currencyCode: CurrencyCode.USD,
          balanceAmount: GENERAL_ACCOUNT_INITIAL_USD_BALANCE,
          reservedAmount: GENERAL_ACCOUNT_ZERO_AMOUNT,
        },
        select: { id: true },
      });

      for (const data of zeroCryptoCashWalletData(account.id)) {
        await tx.cashWallet.create({ data });
      }

      // The one-time 10,000,000 KRW grant. referenceType/referenceId make it
      // unique per account through the partial unique index, so even a
      // pathological double-write cannot double-grant.
      await tx.walletTransaction.create({
        data: {
          tradingAccountId: account.id,
          walletId: krwWallet.id,
          currencyCode: CurrencyCode.KRW,
          direction: WalletTransactionDirection.credit,
          txType: WalletTransactionType.initial_grant,
          referenceType: WalletTransactionReferenceType.general_account_open,
          referenceId: account.id,
          amount: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
          balanceAfter: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
          occurredAt: openedAt,
        },
        select: { id: true },
      });

      // The performance ORIGIN (작업 7). It lives in this same transaction so
      // a general account can never exist without the baseline every later
      // TWR advance is measured from — and so a failure here rolls the
      // account, all wallets, and the grant back with it.
      await tx.equitySnapshot.create({
        data: this.performanceService.buildOriginSnapshotData({
          tradingAccountId: account.id,
          initialFundingKrw: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
          openedAt,
        }),
        select: { id: true },
      });

      const persisted = await tx.tradingAccount.findUnique({
        where: { id: account.id },
        select: ACCOUNT_SELECT,
      });
      if (!persisted) {
        throw new HttpException(
          this.errorBody(
            'GENERAL_ACCOUNT_INTEGRITY',
            'Created general account could not be read back.',
          ),
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      return persisted;
    });
  }

  /**
   * Replay path for an account that already exists. The structural integrity
   * check runs FIRST: a damaged account is reported, never silently
   * re-granted or "healed" by re-calling POST.
   */
  private async buildReplayResponse(
    account: GeneralAccountRecord,
  ): Promise<OpenGeneralAccountResponse> {
    await assertGeneralAccountFinancialIntegrity(this.prisma, account);
    if (account.mode === 'beginner') {
      await this.performanceService.requireContinuousPerformanceState({
        account,
        client: this.prisma,
      });
    }
    return this.buildResponse(account, false);
  }

  private async buildResponse(
    account: GeneralAccountRecord,
    created: boolean,
  ): Promise<OpenGeneralAccountResponse> {
    const wallets = await this.prisma.cashWallet.findMany({
      where: {
        ...(account.mode === 'general'
          ? { walletScope: 'securities' as const }
          : {}),
        tradingAccountId: account.id,
      },
      orderBy: { currencyCode: 'asc' },
      select: {
        walletScope: true,
        currencyCode: true,
        balanceAmount: true,
        reservedAmount: true,
        updatedAt: true,
      },
    });

    return {
      success: true,
      data: {
        created,
        account: {
          id: account.id,
          mode: account.mode,
          status: account.status,
          initialCapitalKrw: account.initialCapitalKrw.toFixed(8),
          openedAt: account.openedAt.toISOString(),
          closedAt: account.closedAt?.toISOString() ?? null,
          createdAt: account.createdAt.toISOString(),
          updatedAt: account.updatedAt.toISOString(),
          season: null,
        },
        wallets: wallets.map((wallet) => ({
          ...(account.mode === 'beginner'
            ? { walletScope: wallet.walletScope }
            : {}),
          currencyCode: wallet.currencyCode,
          balanceAmount: wallet.balanceAmount.toFixed(8),
          reservedAmount: wallet.reservedAmount.toFixed(8),
          availableAmount: wallet.balanceAmount
            .sub(wallet.reservedAmount)
            .toFixed(8),
          updatedAt: wallet.updatedAt.toISOString(),
        })),
      },
    };
  }

  private findGeneralAccount(userId: string, mode: 'general' | 'beginner') {
    return this.prisma.tradingAccount.findFirst({
      where: { userId, mode },
      select: ACCOUNT_SELECT,
    });
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private requireUserId(userId: string | undefined): string {
    if (!userId) {
      throw new HttpException(
        this.errorBody('UNAUTHORIZED', 'Unauthorized'),
        HttpStatus.UNAUTHORIZED,
      );
    }
    return userId;
  }

  private errorBody(code: string, message: string) {
    return { success: false, error: { code, message } };
  }
}
