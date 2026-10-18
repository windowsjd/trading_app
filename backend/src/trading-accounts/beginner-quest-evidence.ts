import type {
  Prisma,
  CurrencyCode,
  WalletScope,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
  AssetType,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export type QuestClient = PrismaService | Prisma.TransactionClient;
export const BEGINNER_QUEST_01_ID = 'common-01-exchange';
export const BEGINNER_QUEST_02_ID = 'common-02-transfer';
export const BEGINNER_QUEST_01_FX_STEP = 'fx_krw_to_usd';
export const BEGINNER_QUEST_02_TRANSFER_STEP =
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

export type Evidence = { id: string; executedAt: Date };

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

/** What a beginner account may START now (B차, 2026-10-18). The server's only
 * learning authority; cancellation and risk reduction never need one. */
export type BeginnerLearningPermissions = {
  exchange: boolean;
  transfer: boolean;
  /** The composite FX + transfer command (the app does not use it). */
  fxTransfer: boolean;
  cryptoMarketBuy: boolean;
  spotProtection: boolean;
  cryptoLimitBuy: boolean;
  krStockMarketBuy: boolean;
  usStockMarketBuy: boolean;
  /** Also requires leverage > 1 per command (the quest's own evidence). */
  futuresLongOpen: boolean;
  futuresShortOpen: boolean;
  /** Every quest complete: the account's ordinary trading. */
  allTrading: boolean;
};

export type BeginnerQuestCompletion = Record<
  | 'exchange'
  | 'transfer'
  | 'marketBuy'
  | 'protection'
  | 'marketSell'
  | 'limitBuy'
  | 'krStock'
  | 'usStock'
  | 'futuresLong'
  | 'futuresShort',
  boolean
>;

/**
 * Staged learning access: a quest's practice is open only while it is the
 * current step, and everything opens once all ten quests are complete.
 * - QUEST 01–06 run in order. A crypto market BUY stays open through QUEST 04
 *   and 05 so a practice holding can be bought again (TP/SL needs one, and so
 *   does the market SELL); the limit BUY opens at QUEST 06.
 * - QUEST 07–10 are independent once QUEST 06 is complete; each opens only its
 *   own market BUY or Futures open until it is complete. A second open in a
 *   quest's direction waits until the open position is closed.
 * - Exchange is always open and transfers after QUEST 01: they fund later
 *   practice and create no market exposure.
 */
export function beginnerLearningPermissions(
  done: BeginnerQuestCompletion,
  open: { long: boolean; short: boolean },
): BeginnerLearningPermissions {
  // QUEST 06's evidence exists only after QUEST 01–05 (each reads the last).
  const foundation = done.limitBuy;
  const all =
    foundation &&
    done.krStock &&
    done.usStock &&
    done.futuresLong &&
    done.futuresShort;
  return {
    exchange: true,
    transfer: done.exchange,
    fxTransfer: foundation,
    cryptoMarketBuy: all || (done.transfer && !done.marketSell),
    spotProtection: all || (done.marketBuy && !done.protection),
    cryptoLimitBuy: all || (done.marketSell && !done.limitBuy),
    krStockMarketBuy: all || (foundation && !done.krStock),
    usStockMarketBuy: all || (foundation && !done.usStock),
    futuresLongOpen: all || (foundation && !done.futuresLong && !open.long),
    futuresShortOpen: all || (foundation && !done.futuresShort && !open.short),
    allTrading: all,
  };
}

/** Read-only evidence reader, also used inside the existing financial fences. */
export class BeginnerQuestEvidence {
  constructor(private readonly prisma: QuestClient) {}

  async read(accountId: string) {
    const fx = await this.firstProvenFx(accountId);
    const transfer = fx ? await this.firstProvenTransfer(accountId, fx) : null;
    const acknowledgements = transfer
      ? await this.prisma.beginnerQuestAcknowledgement.findMany({
          where: { tradingAccountId: accountId },
        })
      : [];
    const buyReview = acknowledgements.find(
      (row) => row.stepId === 'holdings_reviewed',
    );
    const buy = transfer
      ? await this.filledOrder(
          accountId,
          transfer,
          'crypto',
          'buy',
          buyReview?.orderId,
        )
      : null;
    const holdings =
      buy &&
      buyReview &&
      buyReview.orderId === buy.id &&
      buyReview.acknowledgedAt > buy.executedAt
        ? { id: buy.id, executedAt: buyReview.acknowledgedAt }
        : null;
    // QUEST 04: the first TP/SL registration on the practiced asset after the
    // holdings review — a whole-position OCO group with both legs (the
    // original practice; earlier completions keep their evidence) or an
    // independent stop-loss or take-profit setting (one is enough; its
    // registration, not a trigger, is the evidence).
    const protectionRow =
      holdings && buy
        ? await this.prisma.protectionGroup.findFirst({
            where: {
              tradingAccountId: accountId,
              domain: 'spot',
              assetId: buy.assetId,
              position: {
                is: { tradingAccountId: accountId, assetId: buy.assetId },
              },
              parentOrderId: null,
              activatedAt: { gt: holdings.executedAt },
              AND: [
                {
                  legs: {
                    some: { kind: 'take_profit', triggerPrice: { gt: 0 } },
                  },
                },
                {
                  legs: {
                    some: { kind: 'stop_loss', triggerPrice: { gt: 0 } },
                  },
                },
              ],
            },
            orderBy: [{ activatedAt: 'asc' }, { id: 'asc' }],
            select: { id: true, activatedAt: true },
          })
        : null;
    const settingRow =
      holdings && buy
        ? await this.prisma.conditionalSellOrder.findFirst({
            where: {
              tradingAccountId: accountId,
              assetId: buy.assetId,
              kind: { in: ['stop_loss', 'take_profit'] },
              position: {
                is: { tradingAccountId: accountId, assetId: buy.assetId },
              },
              createdAt: { gt: holdings.executedAt },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, createdAt: true },
          })
        : null;
    const protection =
      [
        protectionRow?.activatedAt
          ? { id: protectionRow.id, executedAt: protectionRow.activatedAt }
          : null,
        settingRow
          ? { id: settingRow.id, executedAt: settingRow.createdAt }
          : null,
      ]
        .filter((row): row is Evidence => row !== null)
        .sort(
          (a, b) =>
            a.executedAt.getTime() - b.executedAt.getTime() ||
            a.id.localeCompare(b.id),
        )[0] ?? null;
    const sell = protection
      ? await this.filledOrder(accountId, protection, 'crypto', 'sell')
      : null;
    const limitReview = acknowledgements.find(
      (row) => row.stepId === 'limit_result_reviewed',
    );
    const limit = sell
      ? await this.limitOrder(accountId, sell, limitReview?.orderId)
      : null;
    const limitResult =
      limit &&
      limitReview &&
      limitReview.orderId === limit.id &&
      this.limitResolvedAt(limit) &&
      limitReview.acknowledgedAt > this.limitResolvedAt(limit)!
        ? { id: limit.id, executedAt: limitReview.acknowledgedAt }
        : null;
    const [kr, us, long, short] = limitResult
      ? await Promise.all([
          this.filledOrder(accountId, limitResult, 'domestic_stock', 'buy'),
          this.filledOrder(accountId, limitResult, 'us_stock', 'buy'),
          this.futuresLifetime(accountId, limitResult, 'long'),
          this.futuresLifetime(accountId, limitResult, 'short'),
        ])
      : [null, null, null, null];
    const done: BeginnerQuestCompletion = {
      exchange: !!fx,
      transfer: !!transfer,
      marketBuy: !!holdings,
      protection: !!protection,
      marketSell: !!sell,
      limitBuy: !!limitResult,
      krStock: !!kr,
      usStock: !!us,
      futuresLong: !!long?.close,
      futuresShort: !!short?.close,
    };
    // Open Futures directions matter only while a Futures quest is pending.
    const pendingFutures =
      done.limitBuy && (!done.futuresLong || !done.futuresShort);
    const openDirections = pendingFutures
      ? await this.prisma.futuresPosition.findMany({
          where: { tradingAccountId: accountId, status: 'open' },
          distinct: ['direction'],
          select: { direction: true },
        })
      : [];
    return {
      tradingAccountId: accountId,
      practice: {
        spotAssetId: buy?.assetId ?? null,
        limitAssetId: limit?.assetId ?? null,
        longPositionId: long?.open.positionId ?? null,
        shortPositionId: short?.open.positionId ?? null,
      },
      quests: [
        this.quest(BEGINNER_QUEST_01_ID, [
          this.step(BEGINNER_QUEST_01_FX_STEP, fx),
        ]),
        this.quest(BEGINNER_QUEST_02_ID, [
          this.step(BEGINNER_QUEST_02_TRANSFER_STEP, transfer),
        ]),
        this.quest('common-03-market-buy', [
          this.step('market_buy_filled', buy),
          this.step('holdings_reviewed', holdings),
        ]),
        this.quest('common-04-protection', [
          this.step('tp_sl_registered', protection),
        ]),
        this.quest('common-05-market-sell', [
          this.step('market_sell_filled', sell),
        ]),
        this.quest('common-06-limit-buy', [
          this.step(
            'limit_buy_registered',
            limit ? { id: limit.id, executedAt: limit.submittedAt } : null,
          ),
          this.step('limit_result_reviewed', limitResult),
        ]),
        this.quest('market-kr-stock', [this.step('kr_stock_buy_filled', kr)]),
        this.quest('market-us-stock', [this.step('us_stock_buy_filled', us)]),
        this.quest('market-futures-long', [
          this.step('long_opened', long?.open ?? null),
          this.step('long_closed', long?.close ?? null),
        ]),
        this.quest('market-futures-short', [
          this.step('short_opened', short?.open ?? null),
          this.step('short_closed', short?.close ?? null),
        ]),
      ],
      // Legacy contract, frozen: deployed apps compare these six keys with
      // their own derivation from `quests` and reject any other value. The
      // server no longer enforces them (`allTrading` here = QUEST 06).
      learningAccess: {
        exchange: true,
        transfer: !!fx,
        cryptoMarketBuy: !!transfer,
        spotProtection: !!holdings,
        cryptoLimitBuy: !!sell,
        allTrading: !!limitResult,
      },
      learningPermissions: beginnerLearningPermissions(done, {
        long: openDirections.some((row) => row.direction === 'long'),
        short: openDirections.some((row) => row.direction === 'short'),
      }),
    };
  }

  /** Only committed fills, including terminal ERS partial fills, never quotes.
   * Orders submitted automatically by a TP/SL protection or a SELL setting
   * are not the user's own practice. */
  async filledOrder(
    accountId: string,
    after: Evidence,
    assetType: AssetType,
    side: 'buy' | 'sell',
    id?: string,
  ) {
    const row = await this.prisma.order.findFirst({
      where: {
        ...(id ? { id } : {}),
        tradingAccountId: accountId,
        asset: { assetType },
        orderType: 'market',
        side,
        status: 'executed',
        executedAt: { gt: after.executedAt },
        protectionChild: { is: null },
        conditionalSell: { is: null },
        OR: [
          { executedQuantity: { gt: 0 } },
          { executedQuantity: null, quantity: { gt: 0 } },
        ],
      },
      orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, executedAt: true, assetId: true },
    });
    return row?.executedAt ? { ...row, executedAt: row.executedAt } : null;
  }

  async limitOrder(accountId: string, after: Evidence, id?: string) {
    return this.prisma.order.findFirst({
      where: {
        ...(id ? { id } : {}),
        tradingAccountId: accountId,
        asset: { assetType: 'crypto' },
        side: 'buy',
        orderType: 'limit',
        submittedAt: { gt: after.executedAt },
        limitPrice: { gt: 0 },
        quantity: { gt: 0 },
        reservedAmount: { gt: 0 },
        reservationFeeRate: { not: null },
        protectionChild: { is: null },
        OR: [
          { status: 'submitted' },
          { status: 'executed', executedAt: { not: null } },
          {
            status: 'canceled',
            cancelReason: 'user_canceled',
            canceledAt: { not: null },
          },
        ],
      },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        assetId: true,
        submittedAt: true,
        status: true,
        executedAt: true,
        quantity: true,
        executedQuantity: true,
        canceledAt: true,
        cancelReason: true,
        reservationReleasedAt: true,
      },
    });
  }

  limitResolvedAt(
    order: NonNullable<
      Awaited<ReturnType<BeginnerQuestEvidence['limitOrder']>>
    >,
  ) {
    if (!order.reservationReleasedAt) return null;
    if (
      order.status === 'executed' &&
      (order.executedQuantity ?? order.quantity).gt(0)
    )
      return order.executedAt;
    if (order.status === 'canceled' && order.cancelReason === 'user_canceled')
      return order.canceledAt;
    return null;
  }

  private async futuresLifetime(
    accountId: string,
    after: Evidence,
    direction: 'long' | 'short',
  ) {
    // Prefer a completed lifetime; an older unclosed practice cannot hide a later success.
    const openings = await this.prisma.futuresExecution.findMany({
      where: {
        tradingAccountId: accountId,
        direction,
        operation: 'open',
        leverage: { gt: 1 },
        quantity: { gt: 0 },
        executedAt: { gt: after.executedAt },
        position: {
          is: {
            tradingAccountId: accountId,
            direction,
            liquidationClose: { is: null },
            seasonClose: { is: null },
          },
        },
      },
      orderBy: EVIDENCE_ORDER,
      select: { id: true, positionId: true, executedAt: true },
    });
    for (const open of openings) {
      const close = await this.prisma.futuresExecution.findFirst({
        where: {
          tradingAccountId: accountId,
          positionId: open.positionId,
          direction,
          operation: { in: ['close', 'reduce'] },
          positionQuantityAfter: 0,
          quantity: { gt: 0 },
          executedAt: { gt: open.executedAt },
          executeRequest: { is: { tradingAccountId: accountId } },
          protectionChild: { is: null },
          position: {
            is: {
              status: 'closed',
              quantity: 0,
              liquidationClose: { is: null },
              seasonClose: { is: null },
            },
          },
        },
        orderBy: EVIDENCE_ORDER,
        select: { id: true, executedAt: true },
      });
      if (close) return { open, close };
    }
    return openings[0] ? { open: openings[0], close: null } : null;
  }

  private quest(questId: string, steps: QuestStepView[]): QuestProgressView {
    const completedStepCount = steps.filter((step) => step.completed).length;
    return {
      questId,
      status:
        completedStepCount === 0
          ? 'not_started'
          : completedStepCount === steps.length
            ? 'completed'
            : 'in_progress',
      completedStepCount,
      totalStepCount: steps.length,
      steps,
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
}
