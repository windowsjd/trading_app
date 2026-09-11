import { HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/**
 * Account-scoped read integrity probes.
 *
 * Account-scoped list endpoints filter rows by the row's own non-null
 * tradingAccountId. These probes additionally reject direct child rows whose
 * linked parent belongs to another account. They never infer ownership from a
 * SeasonParticipant or repair data in a request.
 */

type IntegrityClient = Pick<
  Prisma.TransactionClient,
  'walletTransaction' | 'fxExecuteRequest' | 'order'
>;

export type AccountScopeTarget = {
  tradingAccountId: string;
};

function throwScopeMismatch(model: string, code: string): never {
  throw new HttpException(
    {
      success: false,
      error: {
        code,
        message: `${model} rows disagree on canonical trading-account ownership; investigate before reading account-scoped data.`,
      },
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Direct ledger/request relationships used by account-scoped wallet, ledger,
 * and FX history endpoints.
 */
export async function assertAccountFinancialScopeIntegrity(
  prisma: IntegrityClient,
  target: AccountScopeTarget,
): Promise<void> {
  const walletDisagreement = await prisma.walletTransaction.findFirst({
    where: {
      tradingAccountId: target.tradingAccountId,
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

  const exchangeDisagreement = await prisma.fxExecuteRequest.findFirst({
    where: {
      tradingAccountId: target.tradingAccountId,
      exchangeTransaction: {
        is: { tradingAccountId: { not: target.tradingAccountId } },
      },
    },
    select: { id: true },
  });
  if (exchangeDisagreement) {
    throwScopeMismatch(
      'FX execute request (exchange link)',
      'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    );
  }
}

/**
 * Order rows. Used by the account-scoped order list/detail endpoints so
 * cross-account quote relationships never masquerade as an empty account.
 */
export async function assertAccountOrderScopeIntegrity(
  prisma: IntegrityClient,
  target: AccountScopeTarget,
): Promise<void> {
  if (
    await prisma.order.findFirst({
      where: {
        tradingAccountId: target.tradingAccountId,
        quote: {
          is: { tradingAccountId: { not: target.tradingAccountId } },
        },
      },
      select: { id: true },
    })
  ) {
    throwScopeMismatch('order quote link', 'TRADING_ACCOUNT_SCOPE_MISMATCH');
  }
}
