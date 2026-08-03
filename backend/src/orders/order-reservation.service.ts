import { HttpException, Injectable } from '@nestjs/common';
import { CurrencyCode, Prisma } from '../generated/prisma/client';
import {
  releaseReservedCash,
  reserveAvailableCash,
} from '../wallets/cash-wallet-atomic';
import { diagnoseCashWalletMutationFailure } from '../wallets/cash-wallet-failure-diagnosis';
import { assertCashWalletTradingAccountScope } from '../wallets/cash-wallet-scope';
import {
  limitOrderErrorCodes,
  limitOrderErrorHttpStatus,
  type LimitOrderErrorCode,
} from './limit-order-error-policy';

type ReservationTransactionClient = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | 'cashWallet'
>;

/**
 * Cash reservation primitives for limit-buy orders. All mutations are the
 * single-statement atomic guards from cash-wallet-atomic; this service adds
 * wallet lookup and error classification. It never touches balanceAmount:
 * reserving/releasing only moves the reservedAmount fence.
 */
@Injectable()
export class OrderReservationService {
  /**
   * Reserves cash for a new limit-buy order inside the caller's
   * transaction. Fails with INSUFFICIENT_AVAILABLE_BALANCE when
   * balance - reserved cannot cover the amount (verified atomically in the
   * UPDATE itself, so two concurrent orders can never double-book the same
   * available cash). Returns the wallet id for downstream bookkeeping.
   */
  async reserveForLimitBuy(
    tx: ReservationTransactionClient,
    input: {
      seasonParticipantId: string;
      /** VERIFIED trading account id (participant link). */
      tradingAccountId: string;
      currencyCode: CurrencyCode;
      /** Canonical scale-8 decimal string, > 0. */
      amount: string;
    },
  ): Promise<{ walletId: string }> {
    const wallet = await tx.cashWallet.findUnique({
      where: {
        seasonParticipantId_currencyCode: {
          seasonParticipantId: input.seasonParticipantId,
          currencyCode: input.currencyCode,
        },
      },
      select: { id: true, seasonParticipantId: true, tradingAccountId: true },
    });

    if (!wallet) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
        'Cash wallet was not found.',
      );
    }

    // Null/mismatched wallet scope fails closed (500 repair-required or
    // mismatch) BEFORE any reservation; the account id also rides in the
    // atomic UPDATE's WHERE below.
    assertCashWalletTradingAccountScope(wallet, {
      seasonParticipantId: input.seasonParticipantId,
      tradingAccountId: input.tradingAccountId,
    });

    const reservedCount = await reserveAvailableCash(tx, {
      walletId: wallet.id,
      seasonParticipantId: input.seasonParticipantId,
      tradingAccountId: input.tradingAccountId,
      currencyCode: input.currencyCode,
      amount: input.amount,
    });

    if (reservedCount !== 1) {
      await this.throwReservationFailure(tx, {
        walletId: wallet.id,
        seasonParticipantId: input.seasonParticipantId,
        tradingAccountId: input.tradingAccountId,
        currencyCode: input.currencyCode,
        amount: input.amount,
      });
    }

    return { walletId: wallet.id };
  }

  /**
   * Releases a submitted order's reservation inside the caller's
   * transaction. The caller must hold the order row lock and flip the order
   * out of `submitted` in the same transaction — that pairing is what makes
   * a release happen at most once per order. A failed guard here means the
   * wallet no longer holds the order's reservation: an invariant breach,
   * reported as ORDER_RESERVATION_INCONSISTENT.
   */
  async releaseLimitBuyReservation(
    tx: ReservationTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string;
      /** VERIFIED trading account id (order/wallet verified scope). */
      tradingAccountId: string;
      currencyCode: CurrencyCode;
      /** Canonical scale-8 decimal string, > 0. */
      amount: string;
    },
  ): Promise<void> {
    const releasedCount = await releaseReservedCash(tx, input);
    if (releasedCount !== 1) {
      // 작업 5 보완 3: a failed release used to be reported as a flat
      // reservation inconsistency, which hid wallet-scope corruption behind a
      // business error. Diagnose first — a null/mismatched scope throws its
      // own structured 500 and rolls the whole cancel back untouched.
      const reason = await diagnoseCashWalletMutationFailure(tx, {
        walletId: input.walletId,
        expected: {
          seasonParticipantId: input.seasonParticipantId,
          tradingAccountId: input.tradingAccountId,
          currencyCode: input.currencyCode,
        },
        requires: { reserved: input.amount },
      });

      this.throwLimitOrderError(
        reason === 'conflict'
          ? limitOrderErrorCodes.ORDER_RESERVATION_CONFLICT
          : limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
        reason === 'conflict'
          ? 'Reservation release failed due to a concurrent wallet update.'
          : 'Wallet reservation does not cover the order reservation.',
      );
    }
  }

  private async throwReservationFailure(
    tx: ReservationTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string;
      tradingAccountId: string;
      currencyCode: CurrencyCode;
      amount: string;
    },
  ): Promise<never> {
    const reason = await diagnoseCashWalletMutationFailure(tx, {
      walletId: input.walletId,
      expected: {
        seasonParticipantId: input.seasonParticipantId,
        tradingAccountId: input.tradingAccountId,
        currencyCode: input.currencyCode,
      },
      requires: { available: input.amount },
    });

    if (reason === 'wallet_not_found') {
      this.throwLimitOrderError(
        limitOrderErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
        'Cash wallet was not found.',
      );
    }

    if (reason !== 'conflict') {
      this.throwLimitOrderError(
        limitOrderErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
        'Available cash balance is insufficient for the reservation.',
      );
    }

    this.throwLimitOrderError(
      limitOrderErrorCodes.ORDER_RESERVATION_CONFLICT,
      'Cash reservation failed due to a concurrent wallet update.',
    );
  }

  private throwLimitOrderError(
    code: LimitOrderErrorCode,
    message: string,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      limitOrderErrorHttpStatus[code],
    );
  }
}
