import { Prisma } from '../generated/prisma/client';

/**
 * Atomic cash-wallet mutations that respect the limit-buy reservation layer.
 *
 * Every ordinary cash debit must satisfy, in ONE SQL statement,
 *   balance_amount - reserved_amount >= amount
 * so reserved cash can never be spent — even under concurrency. Prisma's
 * typed `where` cannot compare two columns, so these guards are expressed as
 * parameterized raw UPDATEs (tagged-template `$executeRaw`, never string
 * concatenation). All functions return the affected-row count: 1 means the
 * guard held and the mutation applied; 0 means it must be treated as a
 * failed debit/reservation (callers decide the error code).
 *
 * updated_at is bumped manually because @updatedAt only applies to Prisma
 * model mutations, not raw SQL.
 */

type AtomicCashClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export type CashWalletAmountInput = {
  walletId: string;
  seasonParticipantId: string;
  /** CurrencyCode enum value (KRW | USD). */
  currencyCode: string;
  /** Canonical positive decimal string (scale 8). Never a JS number. */
  amount: string;
};

/**
 * Ordinary cash debit: decrements balance only when the AVAILABLE balance
 * (balance - reserved) covers the amount. Used by market-buy execution and
 * FX source debits; reserved cash is invisible to these paths.
 */
export async function debitAvailableCash(
  client: AtomicCashClient,
  input: CashWalletAmountInput,
): Promise<number> {
  return client.$executeRaw`
    UPDATE "cash_wallets"
    SET "balance_amount" = "balance_amount" - ${input.amount}::numeric,
        "updated_at" = NOW()
    WHERE "id" = ${input.walletId}
      AND "season_participant_id" = ${input.seasonParticipantId}
      AND "currency_code" = ${input.currencyCode}::"CurrencyCode"
      AND "balance_amount" - "reserved_amount" >= ${input.amount}::numeric
  `;
}

/**
 * Limit-buy reservation: locks cash by increasing reserved_amount only when
 * the available balance covers the new reservation. balance_amount is never
 * touched — a reservation is a spending restriction, not a debit.
 */
export async function reserveAvailableCash(
  client: AtomicCashClient,
  input: CashWalletAmountInput,
): Promise<number> {
  return client.$executeRaw`
    UPDATE "cash_wallets"
    SET "reserved_amount" = "reserved_amount" + ${input.amount}::numeric,
        "updated_at" = NOW()
    WHERE "id" = ${input.walletId}
      AND "season_participant_id" = ${input.seasonParticipantId}
      AND "currency_code" = ${input.currencyCode}::"CurrencyCode"
      AND "balance_amount" - "reserved_amount" >= ${input.amount}::numeric
  `;
}

/**
 * Reservation release (cancel / lifecycle cleanup): decreases
 * reserved_amount by exactly the order's reservation. The guard
 * (reserved >= amount) plus the callers' order-row locking make a release
 * apply at most once per order; balance_amount is never touched.
 */
export async function releaseReservedCash(
  client: AtomicCashClient,
  input: CashWalletAmountInput,
): Promise<number> {
  return client.$executeRaw`
    UPDATE "cash_wallets"
    SET "reserved_amount" = "reserved_amount" - ${input.amount}::numeric,
        "updated_at" = NOW()
    WHERE "id" = ${input.walletId}
      AND "season_participant_id" = ${input.seasonParticipantId}
      AND "currency_code" = ${input.currencyCode}::"CurrencyCode"
      AND "reserved_amount" >= ${input.amount}::numeric
  `;
}

/**
 * Limit-buy fill settlement: debit the actual event-price cost while releasing
 * the order's entire limit-price reservation in one guarded statement.
 * The post-update balance must still cover every other open reservation.
 */
export async function settleLimitBuyReservedCash(
  client: AtomicCashClient,
  input: Omit<CashWalletAmountInput, 'amount'> & {
    actualDebit: string;
    orderReservation: string;
  },
): Promise<number> {
  return client.$executeRaw`
    UPDATE "cash_wallets"
    SET "balance_amount" = "balance_amount" - ${input.actualDebit}::numeric,
        "reserved_amount" = "reserved_amount" - ${input.orderReservation}::numeric,
        "updated_at" = clock_timestamp()
    WHERE "id" = ${input.walletId}
      AND "season_participant_id" = ${input.seasonParticipantId}
      AND "currency_code" = ${input.currencyCode}::"CurrencyCode"
      AND "reserved_amount" >= ${input.orderReservation}::numeric
      AND "balance_amount" >= ${input.actualDebit}::numeric
      AND "balance_amount" - ${input.actualDebit}::numeric
          >= "reserved_amount" - ${input.orderReservation}::numeric
  `;
}
