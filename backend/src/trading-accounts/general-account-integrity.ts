import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CurrencyCode,
  Prisma,
  TradingAccountMode,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW } from './general-account.policy';

/**
 * Structural integrity of a GENERAL account's financial shape (작업 6).
 *
 * A general account has no SeasonParticipant, so the season scope probes in
 * trading-account-financial-integrity.ts do not apply. What must hold instead
 * is a fixed, small shape:
 *
 *   mode = general, no participant attached, initialCapitalKrw = 10,000,000
 *   exactly one KRW wallet + exactly one USD wallet, both scoped to the
 *   account and both with seasonParticipantId = NULL
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
  'order' | 'position' | 'quote'
>;

export type GeneralAccountIntegrityTarget = {
  id: string;
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
      seasonParticipantId: true,
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
    if (wallet.seasonParticipantId !== null) {
      throwGeneralAccountIntegrity(
        account.id,
        'general wallet carries a season participant link',
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
      seasonParticipantId: true,
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
    grant.seasonParticipantId !== null ||
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
 * Row-scope half of the check: every wallet and ledger row that belongs to
 * this account must be purely account-scoped.
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
  const walletWithParticipant = await prisma.cashWallet.findFirst({
    where: {
      tradingAccountId: accountId,
      seasonParticipantId: { not: null },
    },
    select: { id: true },
  });
  if (walletWithParticipant) {
    throwGeneralAccountIntegrity(
      accountId,
      'a wallet of this general account carries a season participant link',
    );
  }

  const ledgerWithParticipant = await prisma.walletTransaction.findFirst({
    where: {
      tradingAccountId: accountId,
      seasonParticipantId: { not: null },
    },
    select: { id: true },
  });
  if (ledgerWithParticipant) {
    throwGeneralAccountIntegrity(
      accountId,
      'a ledger row of this general account carries a season participant link',
    );
  }

  // A ledger row whose WALLET belongs elsewhere is corruption the per-row
  // check above cannot see.
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

/** General trading rows are account-only and must never carry a participant. */
export async function assertGeneralAccountTradingRowsIntegrity(
  prisma: GeneralTradingRowsClient,
  accountId: string,
): Promise<void> {
  const [order, position, quote] = await Promise.all([
    prisma.order.findFirst({
      where: {
        tradingAccountId: accountId,
        OR: [
          { seasonParticipantId: { not: null } },
          // Every general order is durable-quote backed. Missing or foreign
          // quote scope is corruption, not a row that may be shown normally.
          { quoteId: null },
          { quote: { is: { tradingAccountId: null } } },
          {
            quote: {
              is: { tradingAccountId: { not: accountId } },
            },
          },
          { quote: { is: { seasonParticipantId: { not: null } } } },
        ],
      },
      select: { id: true },
    }),
    prisma.position.findFirst({
      where: {
        tradingAccountId: accountId,
        seasonParticipantId: { not: null },
      },
      select: { id: true },
    }),
    prisma.quote.findFirst({
      where: {
        tradingAccountId: accountId,
        OR: [
          { seasonParticipantId: { not: null } },
          // Also look from the quote side so moving an Order's accountId does
          // not make the damaged row silently disappear from its origin.
          {
            orders: {
              some: {
                OR: [
                  { tradingAccountId: null },
                  { tradingAccountId: { not: accountId } },
                  { seasonParticipantId: { not: null } },
                ],
              },
            },
          },
        ],
      },
      select: { id: true },
    }),
  ]);
  if (order || position || quote) {
    throwGeneralAccountIntegrity(
      accountId,
      'a general order, position, or quote has participant pollution or mismatched durable-quote scope',
    );
  }
}
