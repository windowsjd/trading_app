import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CurrencyCode,
  Prisma,
  TradingAccountMode,
  TradingAccountStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertGeneralAccountIntegrity } from './general-account-integrity';
import {
  GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
  GENERAL_ACCOUNT_INITIAL_USD_BALANCE,
  GENERAL_ACCOUNT_ZERO_AMOUNT,
} from './general-account.policy';

/**
 * General-mode account entry (작업 6).
 *
 * `POST /api/v1/trading-accounts/general` is the ONLY way a general account
 * comes into existence. It is idempotent by the account's own partial unique
 * index (`trading_accounts_general_owner_unique`, one general row per user),
 * so re-requests, concurrent requests, and network retries all converge on
 * ONE account, ONE KRW wallet, ONE USD wallet, and ONE 10,000,000 KRW
 * initial-grant ledger row.
 *
 * Everything the first call writes lives in a SINGLE transaction: if any
 * step fails, the account, both wallets, and the grant roll back together —
 * a half-opened account can never be observed.
 *
 * NOT done here, on purpose:
 *  - no EquitySnapshot / DailyPortfolioSnapshot (작업 7 scope),
 *  - no SeasonParticipant (a general account has none, ever),
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

  constructor(private readonly prisma: PrismaService) {}

  async openGeneralAccount(
    userId: string | undefined,
  ): Promise<OpenGeneralAccountResponse> {
    const ownerId = this.requireUserId(userId);

    const existing = await this.findGeneralAccount(ownerId);
    if (existing) {
      return this.buildReplayResponse(existing);
    }

    try {
      const created = await this.createGeneralAccountInTransaction(ownerId);
      this.logger.log(
        JSON.stringify({
          event: 'general_account_opened',
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
      const raced = await this.findGeneralAccount(ownerId);
      if (!raced) {
        throw error;
      }
      return this.buildReplayResponse(raced);
    }
  }

  private async createGeneralAccountInTransaction(
    userId: string,
  ): Promise<GeneralAccountRecord> {
    return this.prisma.$transaction(async (tx) => {
      const openedAt = new Date();

      const account = await tx.tradingAccount.create({
        data: {
          userId,
          mode: TradingAccountMode.general,
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
          seasonParticipantId: null,
          tradingAccountId: account.id,
          currencyCode: CurrencyCode.KRW,
          balanceAmount: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
          reservedAmount: GENERAL_ACCOUNT_ZERO_AMOUNT,
        },
        select: { id: true },
      });

      await tx.cashWallet.create({
        data: {
          seasonParticipantId: null,
          tradingAccountId: account.id,
          currencyCode: CurrencyCode.USD,
          balanceAmount: GENERAL_ACCOUNT_INITIAL_USD_BALANCE,
          reservedAmount: GENERAL_ACCOUNT_ZERO_AMOUNT,
        },
        select: { id: true },
      });

      // The one-time 10,000,000 KRW grant. referenceType/referenceId make it
      // unique per account through the partial unique index, so even a
      // pathological double-write cannot double-grant.
      await tx.walletTransaction.create({
        data: {
          seasonParticipantId: null,
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
    await assertGeneralAccountIntegrity(this.prisma, account);
    return this.buildResponse(account, false);
  }

  private async buildResponse(
    account: GeneralAccountRecord,
    created: boolean,
  ): Promise<OpenGeneralAccountResponse> {
    const wallets = await this.prisma.cashWallet.findMany({
      where: { tradingAccountId: account.id },
      orderBy: { currencyCode: 'asc' },
      select: {
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

  private findGeneralAccount(userId: string) {
    return this.prisma.tradingAccount.findFirst({
      where: { userId, mode: TradingAccountMode.general },
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
