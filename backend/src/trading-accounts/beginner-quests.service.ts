import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type {
  CurrencyCode,
  WalletScope,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountAccessService } from './trading-account-access.service';

/**
 * Beginner quest progress, DERIVED read-only from committed financial rows.
 *
 * There is no quest table and nothing here writes: a quest step is complete
 * exactly when the account's own ledger proves the practice happened. That is
 * why app restarts, other devices, account switches and lost responses all
 * converge on the same answer, and why a retried command (one committed row)
 * can never count twice. The step catalogue and the teaching copy live in the
 * client; the server only answers "which practice steps are proven".
 *
 * QUEST 01 practice steps, in teaching order:
 *  1. a standalone KRW → USD FX (Securities KRW debit, Securities USD credit);
 *  2. a standalone USD transfer Securities USD → Crypto Spot USD executed
 *     strictly after the first proven FX.
 * A composite FX+transfer command records both legs at one instant; it is
 * excluded from both steps because the quest asks for each practice on its
 * own. Quotes, failed or rolled-back commands leave no rows, so they cannot
 * count. Balances are never used as evidence.
 */

export const BEGINNER_QUEST_01_ID = 'common-01-trading-funds';
export const BEGINNER_QUEST_01_FX_STEP = 'fx_krw_to_usd';
export const BEGINNER_QUEST_01_TRANSFER_STEP =
  'transfer_securities_usd_to_crypto_spot_usd';

type QuestStatus = 'not_started' | 'in_progress' | 'completed';

type QuestStepView = {
  stepId: string;
  completed: boolean;
  completedAt: string | null;
  /** ExchangeTransaction.id or WalletTransfer.id that proves the step. */
  referenceId: string | null;
};

type QuestProgressView = {
  questId: string;
  status: QuestStatus;
  completedStepCount: number;
  totalStepCount: number;
  steps: QuestStepView[];
};

type BeginnerQuestsResponse = {
  success: true;
  data: { tradingAccountId: string; quests: QuestProgressView[] };
};

type Evidence = { id: string; executedAt: Date };

type LedgerLegRule = {
  txType: WalletTransactionType;
  direction: WalletTransactionDirection;
  currencyCode: CurrencyCode;
  walletScope: WalletScope;
};

const FX_LEGS: LedgerLegRule[] = [
  {
    txType: 'exchange_source',
    direction: 'debit',
    currencyCode: 'KRW',
    walletScope: 'securities',
  },
  {
    txType: 'exchange_target',
    direction: 'credit',
    currencyCode: 'USD',
    walletScope: 'securities',
  },
];

const TRANSFER_LEGS: LedgerLegRule[] = [
  {
    txType: 'wallet_transfer',
    direction: 'debit',
    currencyCode: 'USD',
    walletScope: 'securities',
  },
  {
    txType: 'wallet_transfer',
    direction: 'credit',
    currencyCode: 'USD',
    walletScope: 'crypto_spot',
  },
];

const EVIDENCE_ORDER = [{ executedAt: 'asc' as const }, { id: 'asc' as const }];

@Injectable()
export class BeginnerQuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly performance: GeneralAccountPerformanceService,
  ) {}

  async getQuestProgress(
    userId: string | undefined,
    accountId: string,
  ): Promise<BeginnerQuestsResponse> {
    if (!userId) {
      this.fail(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized');
    }
    // Ownership first: a foreign or unknown account is 404 like every read.
    const account = await this.access.getOwnedAccountOrThrow(
      userId,
      typeof accountId === 'string' ? accountId.trim() : accountId,
    );
    if (account.mode !== 'beginner') {
      this.fail(
        HttpStatus.CONFLICT,
        'BEGINNER_QUEST_ACCOUNT_ONLY',
        'Quests are available only for beginner accounts.',
      );
    }
    // Same integrity gate as the account's FX/wallet reads: damaged financial
    // rows fail closed instead of being read as progress. Reads stay available
    // when beginner mode is switched off, like every owned-account read.
    await this.performance.assertGeneralAccountReady(account);

    const fx = await this.firstProvenFx(account.id);
    const transfer = fx ? await this.firstProvenTransfer(account.id, fx) : null;
    const steps = [
      this.step(BEGINNER_QUEST_01_FX_STEP, fx),
      this.step(BEGINNER_QUEST_01_TRANSFER_STEP, transfer),
    ];
    const completedStepCount = steps.filter((step) => step.completed).length;

    return {
      success: true,
      data: {
        tradingAccountId: account.id,
        quests: [
          {
            questId: BEGINNER_QUEST_01_ID,
            status:
              completedStepCount === 0
                ? 'not_started'
                : completedStepCount === steps.length
                  ? 'completed'
                  : 'in_progress',
            completedStepCount,
            totalStepCount: steps.length,
            steps,
          },
        ],
      },
    };
  }

  private async firstProvenFx(accountId: string): Promise<Evidence | null> {
    const candidates = await this.prisma.exchangeTransaction.findMany({
      where: {
        tradingAccountId: accountId,
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        // Composite FX+transfer legs are not a standalone FX practice.
        walletTransferExecuteRequest: { is: null },
        fxExecuteRequests: {
          some: {
            tradingAccountId: accountId,
            status: 'succeeded',
          },
        },
      },
      orderBy: EVIDENCE_ORDER,
      select: { id: true, executedAt: true },
    });
    return this.firstWithLedgerLegs(
      accountId,
      'exchange_transaction',
      candidates,
      FX_LEGS,
    );
  }

  private async firstProvenTransfer(
    accountId: string,
    fx: Evidence,
  ): Promise<Evidence | null> {
    const candidates = await this.prisma.walletTransfer.findMany({
      where: {
        tradingAccountId: accountId,
        currencyCode: 'USD',
        compositeCommand: { is: null },
        executedAt: { gt: fx.executedAt },
        sourceWallet: {
          is: {
            tradingAccountId: accountId,
            walletScope: 'securities',
            currencyCode: 'USD',
          },
        },
        destinationWallet: {
          is: {
            tradingAccountId: accountId,
            walletScope: 'crypto_spot',
            currencyCode: 'USD',
          },
        },
      },
      orderBy: EVIDENCE_ORDER,
      select: { id: true, executedAt: true },
    });
    return this.firstWithLedgerLegs(
      accountId,
      'wallet_transfer',
      candidates,
      TRANSFER_LEGS,
    );
  }

  /** A row counts only with exactly its committed ledger legs on this account. */
  private async firstWithLedgerLegs(
    accountId: string,
    referenceType: WalletTransactionReferenceType,
    candidates: Evidence[],
    rules: LedgerLegRule[],
  ): Promise<Evidence | null> {
    if (candidates.length === 0) return null;
    const legs = await this.prisma.walletTransaction.findMany({
      where: {
        tradingAccountId: accountId,
        referenceType,
        referenceId: { in: candidates.map((row) => row.id) },
      },
      select: {
        referenceId: true,
        txType: true,
        direction: true,
        currencyCode: true,
        wallet: {
          select: {
            tradingAccountId: true,
            walletScope: true,
            currencyCode: true,
          },
        },
      },
    });
    return (
      candidates.find((candidate) => {
        const own = legs.filter((leg) => leg.referenceId === candidate.id);
        return (
          own.length === rules.length &&
          rules.every(
            (rule) =>
              own.filter(
                (leg) =>
                  leg.txType === rule.txType &&
                  leg.direction === rule.direction &&
                  leg.currencyCode === rule.currencyCode &&
                  leg.wallet.tradingAccountId === accountId &&
                  leg.wallet.walletScope === rule.walletScope &&
                  leg.wallet.currencyCode === rule.currencyCode,
              ).length === 1,
          )
        );
      }) ?? null
    );
  }

  private step(stepId: string, evidence: Evidence | null): QuestStepView {
    return {
      stepId,
      completed: evidence !== null,
      completedAt: evidence?.executedAt.toISOString() ?? null,
      referenceId: evidence?.id ?? null,
    };
  }

  private fail(status: HttpStatus, code: string, message: string): never {
    throw new HttpException(
      { success: false, error: { code, message } },
      status,
    );
  }
}
