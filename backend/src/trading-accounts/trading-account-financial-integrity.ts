import { HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/**
 * Account-scoped read integrity probes (작업 5 보완 2/작업 5).
 *
 * Account-scoped list endpoints filter rows by the row's OWN
 * tradingAccountId. Before returning, these probes reject rows whose retained
 * participant metadata disagrees with that canonical account scope.
 *
 *  - mismatch → FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH /
 *    TRADING_ACCOUNT_SCOPE_MISMATCH (never auto-corrected)
 *
 * The canonical schema makes tradingAccountId non-null. Pre-migration null
 * discovery/backfill belongs to the explicit repair CLIs; runtime reads do
 * not execute compatibility SQL or infer ownership from a participant.
 * General accounts have no participant, so these probes are skipped and a
 * genuinely empty account stays a normal empty response.
 */

type IntegrityClient = Pick<
  Prisma.TransactionClient,
  | 'cashWallet'
  | 'walletTransaction'
  | 'exchangeTransaction'
  | 'fxExecuteRequest'
  | 'order'
  | 'position'
  | 'quote'
>;

export type SeasonAccountScopeTarget = {
  tradingAccountId: string;
  /** Null for general accounts — probes are skipped entirely. */
  seasonParticipantId: string | null;
};

function throwScopeMismatch(model: string, code: string): never {
  throw new HttpException(
    {
      success: false,
      error: {
        code,
        message: `Participant has ${model} rows scoped to a different trading account; investigate before reading account-scoped data.`,
      },
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Financial models (cash_wallets, wallet_transactions,
 * exchange_transactions, fx_execute_requests). Used by the account-scoped
 * wallet, ledger, and FX history endpoints.
 */
export async function assertSeasonAccountFinancialScopeIntegrity(
  prisma: IntegrityClient,
  target: SeasonAccountScopeTarget,
): Promise<void> {
  if (!target.seasonParticipantId) {
    return;
  }

  const models = [
    {
      name: 'cash wallet',
      delegate: prisma.cashWallet,
    },
    {
      name: 'wallet transaction',
      delegate: prisma.walletTransaction,
    },
    {
      name: 'exchange transaction',
      delegate: prisma.exchangeTransaction,
    },
    {
      name: 'FX execute request',
      delegate: prisma.fxExecuteRequest,
    },
  ] as const;

  for (const model of models) {
    const delegate = model.delegate as unknown as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    };

    if (
      await delegate.findFirst({
        where: {
          seasonParticipantId: target.seasonParticipantId,
          tradingAccountId: { not: target.tradingAccountId },
        },
        select: { id: true },
      })
    ) {
      throwScopeMismatch(
        model.name,
        'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
      );
    }
  }

  // Ledger rows must also agree with THEIR WALLET's scope: a transaction
  // whose wallet points at a different (non-null) account is corruption the
  // per-row checks above cannot see.
  const walletDisagreement = await prisma.walletTransaction.findFirst({
    where: {
      seasonParticipantId: target.seasonParticipantId,
      wallet: {
        tradingAccountId: { not: target.tradingAccountId },
      },
    },
    select: { id: true },
  });
  if (walletDisagreement) {
    throwScopeMismatch(
      'wallet transaction (wallet link)',
      'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    );
  }
}

/**
 * Order rows. Used by the account-scoped order list/detail endpoints so a
 * participant's unscoped orders never masquerade as an empty account.
 */
export async function assertSeasonAccountOrderScopeIntegrity(
  prisma: IntegrityClient,
  target: SeasonAccountScopeTarget,
): Promise<void> {
  if (!target.seasonParticipantId) {
    return;
  }

  if (
    await prisma.order.findFirst({
      where: {
        seasonParticipantId: target.seasonParticipantId,
        tradingAccountId: { not: target.tradingAccountId },
      },
      select: { id: true },
    })
  ) {
    throwScopeMismatch('order', 'TRADING_ACCOUNT_SCOPE_MISMATCH');
  }
}

/**
 * Position rows. Used by the account-scoped position list endpoint.
 */
export async function assertSeasonAccountPositionScopeIntegrity(
  prisma: IntegrityClient,
  target: SeasonAccountScopeTarget,
): Promise<void> {
  if (!target.seasonParticipantId) {
    return;
  }

  if (
    await prisma.position.findFirst({
      where: {
        seasonParticipantId: target.seasonParticipantId,
        tradingAccountId: { not: target.tradingAccountId },
      },
      select: { id: true },
    })
  ) {
    throwScopeMismatch('position', 'TRADING_ACCOUNT_SCOPE_MISMATCH');
  }
}
