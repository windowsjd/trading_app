import { HttpException, Injectable } from '@nestjs/common';
import { CurrencyCode, Prisma } from '../generated/prisma/client';
import {
  releaseReservedCash,
  reserveAvailableCash,
} from '../wallets/cash-wallet-atomic';
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
      select: { id: true },
    });

    if (!wallet) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
        'Cash wallet was not found.',
      );
    }

    const reservedCount = await reserveAvailableCash(tx, {
      walletId: wallet.id,
      seasonParticipantId: input.seasonParticipantId,
      currencyCode: input.currencyCode,
      amount: input.amount,
    });

    if (reservedCount !== 1) {
      await this.throwReservationFailure(tx, {
        walletId: wallet.id,
        seasonParticipantId: input.seasonParticipantId,
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
      currencyCode: CurrencyCode;
      /** Canonical scale-8 decimal string, > 0. */
      amount: string;
    },
  ): Promise<void> {
    const releasedCount = await releaseReservedCash(tx, input);
    if (releasedCount !== 1) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
        'Wallet reservation does not cover the order reservation.',
      );
    }
  }

  private async throwReservationFailure(
    tx: ReservationTransactionClient,
    input: {
      walletId: string;
      seasonParticipantId: string;
      currencyCode: CurrencyCode;
      amount: string;
    },
  ): Promise<never> {
    const wallet = await tx.cashWallet.findFirst({
      where: {
        id: input.walletId,
        seasonParticipantId: input.seasonParticipantId,
        currencyCode: input.currencyCode,
      },
      select: {
        balanceAmount: true,
        reservedAmount: true,
      },
    });

    if (!wallet) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
        'Cash wallet was not found.',
      );
    }

    if (
      wallet.balanceAmount
        .sub(wallet.reservedAmount)
        .lt(new Prisma.Decimal(input.amount))
    ) {
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
