import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CurrencyCode,
  Prisma,
  TradingAccountMode,
  WalletTransactionReferenceType,
  WalletTransactionType,
  FxExecuteRequestStatus,
  QuoteType,
} from '../generated/prisma/client';
import { GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW } from './general-account.policy';

/**
 * Structural integrity of a GENERAL account's financial shape (작업 6).
 *
 * A general account has no SeasonParticipant. Its financial data is owned by
 * TradingAccount and must have a fixed, small shape:
 *
 *   mode = general, no participant attached, initialCapitalKrw = 10,000,000
 *   exactly one KRW wallet + exactly one USD wallet, both scoped to the account
 *   exactly one initial_grant / general_account_open ledger row for
 *   amount 10,000,000, on the KRW wallet, referencing the account
 *
 * DELIBERATELY NOT CHECKED: the CURRENT balance. A used account legitimately
 * holds less than 10,000,000 KRW (trades, FX) or more (ad rewards); equating
 * balance with the grant would flag every normal account.
 *
 * This is a read-only probe. It NEVER repairs, re-grants, tops up, creates a
 * wallet, or rewrites an amount — a corrupted account fails closed with 500
 * GENERAL_ACCOUNT_INTEGRITY and is left for an operator (see
 * `pnpm trading-accounts:audit-general`). Automatic financial correction of
 * damaged data is far more dangerous than an error response.
 */

export const GENERAL_ACCOUNT_INTEGRITY_ERROR_CODE = 'GENERAL_ACCOUNT_INTEGRITY';

type GeneralIntegrityClient = Pick<
  Prisma.TransactionClient,
  'cashWallet' | 'walletTransaction'
>;

type GeneralTradingRowsClient = Pick<
  Prisma.TransactionClient,
  'order' | 'quote'
>;

type GeneralFxRowsClient = Pick<
  Prisma.TransactionClient,
  'exchangeTransaction' | 'fxExecuteRequest' | 'quote' | 'walletTransaction'
>;

export type GeneralAccountIntegrityTarget = {
  id: string;
  /** Present on every ownership-resolved account; optional for legacy helpers. */
  userId?: string;
  mode: TradingAccountMode;
  initialCapitalKrw: Prisma.Decimal;
  seasonParticipant: { id: string } | null;
};

export type VerifiedGeneralAccountWallets = {
  krwWalletId: string;
  usdWalletId: string;
  initialGrantId: string;
};

export function throwGeneralAccountIntegrity(
  accountId: string,
  reason: string,
): never {
  throw new HttpException(
    {
      success: false,
      error: {
        code: GENERAL_ACCOUNT_INTEGRITY_ERROR_CODE,
        message: `General account data is inconsistent (${reason}). It is never auto-repaired or re-granted; run "pnpm trading-accounts:audit-general" and fix it deliberately.`,
      },
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Full structural check of an existing general account. Used by the
 * (idempotent) open endpoint before replaying an account and by the ad-reward
 * grant path before crediting anything.
 */
export async function assertGeneralAccountFoundationIntegrity(
  prisma: GeneralIntegrityClient,
  account: GeneralAccountIntegrityTarget,
): Promise<VerifiedGeneralAccountWallets> {
  if (account.mode !== TradingAccountMode.general) {
    throwGeneralAccountIntegrity(account.id, 'account mode is not general');
  }

  if (account.seasonParticipant) {
    throwGeneralAccountIntegrity(
      account.id,
      'general account has a season participant attached',
    );
  }

  if (
    !account.initialCapitalKrw.equals(
      new Prisma.Decimal(GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW),
    )
  ) {
    throwGeneralAccountIntegrity(
      account.id,
      'initialCapitalKrw is not the 10,000,000 KRW one-time grant',
    );
  }

  const wallets = await prisma.cashWallet.findMany({
    where: { tradingAccountId: account.id },
    select: {
      id: true,
      currencyCode: true,
      tradingAccountId: true,
    },
    orderBy: [{ currencyCode: 'asc' }, { id: 'asc' }],
  });

  const krwWallets = wallets.filter(
    (wallet) => wallet.currencyCode === CurrencyCode.KRW,
  );
  const usdWallets = wallets.filter(
    (wallet) => wallet.currencyCode === CurrencyCode.USD,
  );

  if (krwWallets.length === 0 || usdWallets.length === 0) {
    throwGeneralAccountIntegrity(account.id, 'KRW or USD wallet is missing');
  }
  if (krwWallets.length > 1 || usdWallets.length > 1 || wallets.length !== 2) {
    throwGeneralAccountIntegrity(
      account.id,
      'duplicate or unexpected wallets exist for the account',
    );
  }

  for (const wallet of wallets) {
    if (wallet.tradingAccountId !== account.id) {
      throwGeneralAccountIntegrity(
        account.id,
        'wallet trading-account scope does not match the account',
      );
    }
  }

  const krwWallet = krwWallets[0];
  const usdWallet = usdWallets[0];

  const grants = await prisma.walletTransaction.findMany({
    where: {
      tradingAccountId: account.id,
      referenceType: WalletTransactionReferenceType.general_account_open,
    },
    select: {
      id: true,
      walletId: true,
      tradingAccountId: true,
      currencyCode: true,
      direction: true,
      txType: true,
      referenceId: true,
      amount: true,
      balanceAfter: true,
    },
    orderBy: { id: 'asc' },
  });

  if (grants.length === 0) {
    throwGeneralAccountIntegrity(
      account.id,
      'initial grant ledger row is missing',
    );
  }
  if (grants.length > 1) {
    // The partial unique index makes this unreachable while the index exists;
    // checked anyway so a dropped index cannot silently double-grant.
    throwGeneralAccountIntegrity(
      account.id,
      'more than one initial grant ledger row exists',
    );
  }

  const grant = grants[0];
  if (grant.referenceId !== account.id) {
    throwGeneralAccountIntegrity(
      account.id,
      'initial grant ledger row references a different account',
    );
  }
  if (grant.walletId !== krwWallet.id) {
    throwGeneralAccountIntegrity(
      account.id,
      'initial grant ledger row is not on the KRW wallet',
    );
  }
  if (
    grant.currencyCode !== CurrencyCode.KRW ||
    grant.txType !== WalletTransactionType.initial_grant
  ) {
    throwGeneralAccountIntegrity(
      account.id,
      'initial grant ledger row has an unexpected shape',
    );
  }
  if (
    !grant.amount.equals(
      new Prisma.Decimal(GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW),
    )
  ) {
    throwGeneralAccountIntegrity(
      account.id,
      'initial grant ledger amount is not 10,000,000 KRW',
    );
  }

  return {
    krwWalletId: krwWallet.id,
    usdWalletId: usdWallet.id,
    initialGrantId: grant.id,
  };
}

/**
 * Row-scope half of the check: every ledger row must point to a wallet owned
 * by the same account.
 *
 * 작업 6 보완 2 renamed this from "…Unscoped" because it is only HALF the
 * story — on its own it happily passes an account whose USD wallet or initial
 * grant is missing entirely. Callers should use
 * `assertGeneralAccountFinancialIntegrity`, which runs both halves.
 */
export async function assertGeneralAccountFinancialRowsIntegrity(
  prisma: GeneralIntegrityClient,
  accountId: string,
): Promise<void> {
  const ledgerWalletDisagreement = await prisma.walletTransaction.findFirst({
    where: {
      tradingAccountId: accountId,
      wallet: { tradingAccountId: { not: accountId } },
    },
    select: { id: true },
  });
  if (ledgerWalletDisagreement) {
    throwGeneralAccountIntegrity(
      accountId,
      'a ledger row points at a wallet of a different trading account',
    );
  }
}

/**
 * THE entry point for every general-account financial read and write
 * (작업 6 보완 2): account shape + both wallets + the initial grant + every
 * row's scope.
 *
 * Before this existed, the wallet/ledger GETs and the ad-reward eligibility
 * check only ran the row-scope half, so an account whose USD wallet or
 * initial-grant ledger row had vanished answered 200 with a perfectly
 * normal-looking payload. Structural absence is exactly the kind of damage a
 * read must not present as normal.
 *
 * Read-only: it never creates, repairs, or re-grants anything.
 */
export async function assertGeneralAccountFinancialIntegrity(
  prisma: GeneralIntegrityClient,
  account: GeneralAccountIntegrityTarget,
): Promise<VerifiedGeneralAccountWallets> {
  const wallets = await assertGeneralAccountFoundationIntegrity(
    prisma,
    account,
  );
  await assertGeneralAccountFinancialRowsIntegrity(prisma, account.id);
  return wallets;
}

/** General trading rows and their durable quotes must share one account. */
export async function assertGeneralAccountTradingRowsIntegrity(
  prisma: GeneralTradingRowsClient,
  accountId: string,
): Promise<void> {
  const [order, quote] = await Promise.all([
    prisma.order.findFirst({
      where: {
        tradingAccountId: accountId,
        OR: [
          // Every general order is durable-quote backed. Missing or foreign
          // quote scope is corruption, not a row that may be shown normally.
          { quoteId: null },
          {
            quote: {
              is: { tradingAccountId: { not: accountId } },
            },
          },
        ],
      },
      select: { id: true },
    }),
    prisma.quote.findFirst({
      where: {
        tradingAccountId: accountId,
        // Also look from the quote side so moving an Order's accountId does
        // not make the damaged row silently disappear from its origin.
        orders: {
          some: {
            tradingAccountId: { not: accountId },
          },
        },
      },
      select: { id: true },
    }),
  ]);
  if (order || quote) {
    throwGeneralAccountIntegrity(
      accountId,
      'a general order and its durable quote have mismatched account scope',
    );
  }
}

/**
 * Runtime invariants of account-scoped general FX. This is deliberately the
 * same small shape reported by audit-general: quotes, commands, exchanges and
 * their two ledger rows all belong to one account.
 */
export async function assertGeneralAccountFxRowsIntegrity(
  prisma: GeneralFxRowsClient,
  accountId: string,
  expectedUserId?: string,
): Promise<void> {
  const [exchange, request, quote] = await Promise.all([
    prisma.exchangeTransaction.findFirst({
      where: {
        tradingAccountId: accountId,
        fxExecuteRequests: {
          some: {
            OR: [
              { tradingAccountId: { not: accountId } },
              ...(expectedUserId ? [{ userId: { not: expectedUserId } }] : []),
            ],
          },
        },
      },
      select: { id: true },
    }),
    prisma.fxExecuteRequest.findFirst({
      where: {
        tradingAccountId: accountId,
        OR: [
          { status: { not: FxExecuteRequestStatus.succeeded } },
          { exchangeTransactionId: null },
          ...(expectedUserId ? [{ userId: { not: expectedUserId } }] : []),
          {
            exchangeTransaction: {
              is: {
                tradingAccountId: { not: accountId },
              },
            },
          },
        ],
      },
      select: { id: true },
    }),
    expectedUserId
      ? prisma.quote.findFirst({
          where: {
            tradingAccountId: accountId,
            quoteType: QuoteType.fx,
            userId: { not: expectedUserId },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  if (exchange || request || quote) {
    throwGeneralAccountIntegrity(
      accountId,
      'a general FX quote, command, or exchange has mismatched account scope',
    );
  }

  const exchanges = await prisma.exchangeTransaction.findMany({
    where: { tradingAccountId: accountId },
    select: {
      id: true,
      fromCurrency: true,
      toCurrency: true,
      fxExecuteRequests: {
        select: {
          id: true,
          status: true,
          tradingAccountId: true,
        },
      },
    },
  });
  if (exchanges.length === 0) {
    return;
  }

  const exchangeById = new Map(exchanges.map((row) => [row.id, row]));
  const ledgers = await prisma.walletTransaction.findMany({
    where: {
      referenceType: WalletTransactionReferenceType.exchange_transaction,
      referenceId: { in: exchanges.map((row) => row.id) },
    },
    select: {
      id: true,
      referenceId: true,
      tradingAccountId: true,
      currencyCode: true,
      direction: true,
      txType: true,
      wallet: { select: { tradingAccountId: true } },
    },
  });

  for (const exchange of exchanges) {
    if (
      exchange.fxExecuteRequests.length !== 1 ||
      exchange.fxExecuteRequests[0]?.status !==
        FxExecuteRequestStatus.succeeded ||
      exchange.fxExecuteRequests[0]?.tradingAccountId !== accountId
    ) {
      throwGeneralAccountIntegrity(
        accountId,
        `general exchange ${exchange.id} does not have exactly one succeeded account-scoped execute request`,
      );
    }
    const linked = ledgers.filter((row) => row.referenceId === exchange.id);
    const source = linked.filter(
      (row) => row.txType === WalletTransactionType.exchange_source,
    );
    const target = linked.filter(
      (row) => row.txType === WalletTransactionType.exchange_target,
    );
    if (
      linked.length !== 2 ||
      source.length !== 1 ||
      target.length !== 1 ||
      source[0].direction !== 'debit' ||
      source[0].currencyCode !== exchange.fromCurrency ||
      target[0].direction !== 'credit' ||
      target[0].currencyCode !== exchange.toCurrency
    ) {
      throwGeneralAccountIntegrity(
        accountId,
        `general exchange ${exchange.id} does not have exactly one valid source and target ledger row`,
      );
    }
  }

  const pollutedLedger = ledgers.find(
    (row) =>
      !row.referenceId ||
      !exchangeById.has(row.referenceId) ||
      row.tradingAccountId !== accountId ||
      row.wallet.tradingAccountId !== accountId,
  );
  if (pollutedLedger) {
    throwGeneralAccountIntegrity(
      accountId,
      `general exchange ledger ${pollutedLedger.id} has account-scope pollution`,
    );
  }
}
