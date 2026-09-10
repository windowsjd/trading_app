import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

/**
 * Account-scoped read integrity probes (작업 5 보완 2/작업 5).
 *
 * Account-scoped list endpoints filter rows by the row's OWN
 * tradingAccountId. A season participant whose historical rows were left
 * with a null (or mismatched) scope would therefore produce a perfectly
 * normal-looking EMPTY response while real assets/history exist. That
 * silent omission is worse than an error: before returning, these probes
 * check the participant's rows for scope anomalies and fail closed with a
 * structured 500 when any exist.
 *
 *  - null scope   → FINANCIAL_SCOPE_REPAIR_REQUIRED (run the matching
 *    repair script: trading-accounts:repair-financial-scope or
 *    trading-accounts:repair-trading-scope)
 *  - non-null mismatch → FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH /
 *    TRADING_ACCOUNT_SCOPE_MISMATCH (never auto-corrected)
 *
 * General accounts have no participant, so the probes are skipped and a
 * genuinely empty account stays a normal empty response. Every check is an
 * indexed existence query (findFirst / select id) — never a full scan or an
 * in-memory sweep of the tables.
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
  | '$queryRaw'
>;

export type SeasonAccountScopeTarget = {
  tradingAccountId: string;
  /** Null for general accounts — probes are skipped entirely. */
  seasonParticipantId: string | null;
};

async function hasLegacyNullScope(
  prisma: IntegrityClient,
  tableName: string,
  participantId: string,
): Promise<boolean> {
  // Compatibility probe only. The canonical Prisma schema is non-null, but
  // this explicit SQL keeps deploy-boundary legacy rows detectable until the
  // compatibility layer is removed in the follow-up task.
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT "id"
      FROM ${Prisma.raw(tableName)}
      WHERE "season_participant_id" = ${participantId}
        AND "trading_account_id" IS NULL
      LIMIT 1
    `,
  );
  return rows.length > 0;
}

function throwRepairRequired(model: string): never {
  throw new HttpException(
    {
      success: false,
      error: {
        code: 'FINANCIAL_SCOPE_REPAIR_REQUIRED',
        message: `Participant has ${model} rows without trading-account scope; run the trading-accounts repair scripts before reading account-scoped data.`,
      },
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

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
    { name: 'cash wallet', tableName: 'cash_wallets', delegate: prisma.cashWallet },
    { name: 'wallet transaction', tableName: 'wallet_transactions', delegate: prisma.walletTransaction },
    { name: 'exchange transaction', tableName: 'exchange_transactions', delegate: prisma.exchangeTransaction },
    { name: 'FX execute request', tableName: 'fx_execute_requests', delegate: prisma.fxExecuteRequest },
  ] as const;

  for (const model of models) {
    const delegate = model.delegate as unknown as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    };

    if (await hasLegacyNullScope(prisma, model.tableName, target.seasonParticipantId)) {
      throwRepairRequired(model.name);
    }
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

  if (await hasLegacyNullScope(prisma, 'orders', target.seasonParticipantId)) {
    throwRepairRequired('order');
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

  if (await hasLegacyNullScope(prisma, 'positions', target.seasonParticipantId)) {
    throwRepairRequired('position');
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
