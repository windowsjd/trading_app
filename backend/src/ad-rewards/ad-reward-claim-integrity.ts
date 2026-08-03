import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AdRewardClaimStatus,
  CurrencyCode,
  Prisma,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { isAdRewardLimitErrorCode } from './ad-reward-error-policy';

/**
 * Integrity of a STORED ad-reward claim before it is replayed (작업 6 보완 3).
 *
 * A replay tells the caller "your reward was already paid". Before saying
 * that, the server has to be sure it actually was: previously a granted claim
 * whose ledger link was missing replayed as
 * `{ duplicate: true, walletBalanceAfter: null }` — a success response for a
 * payout that may never have landed.
 *
 * These checks are READ-ONLY. Nothing is repaired, re-granted, or relinked; a
 * violation is 500 AD_REWARD_CLAIM_INTEGRITY and an operator investigates.
 */

export type StoredClaimForIntegrity = {
  id: string;
  userId: string;
  tradingAccountId: string;
  status: AdRewardClaimStatus;
  rewardAmountKrw: Prisma.Decimal;
  grantedAt: Date | null;
  rejectedAt: Date | null;
  failureCode: string | null;
  failureReason: string | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  responsePayloadJson: Prisma.JsonValue | null;
  walletTransactionId: string | null;
  walletTransaction: {
    id: string;
    tradingAccountId: string | null;
    seasonParticipantId: string | null;
    walletId: string;
    currencyCode: CurrencyCode;
    direction: WalletTransactionDirection;
    txType: WalletTransactionType;
    referenceType: WalletTransactionReferenceType;
    referenceId: string | null;
    amount: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
    wallet: {
      id: string;
      tradingAccountId: string | null;
      seasonParticipantId: string | null;
      currencyCode: CurrencyCode;
    };
  } | null;
};

export function throwAdRewardClaimIntegrity(
  claimId: string,
  reason: string,
): never {
  throw new HttpException(
    {
      success: false,
      error: {
        code: 'AD_REWARD_CLAIM_INTEGRITY',
        message: `Ad reward claim ${claimId} is inconsistent with its ledger (${reason}). It is never auto-repaired; run "pnpm trading-accounts:audit-general".`,
      },
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * A GRANTED claim must be fully backed by exactly the ledger row it names, on
 * the account's own general KRW wallet.
 */
export function assertGrantedClaimIntegrity(
  claim: StoredClaimForIntegrity,
  expectedKrwWalletId: string,
): NonNullable<StoredClaimForIntegrity['walletTransaction']> {
  if (!claim.grantedAt) {
    throwAdRewardClaimIntegrity(claim.id, 'granted claim has no grantedAt');
  }
  if (!claim.walletTransactionId || !claim.walletTransaction) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'granted claim has no linked wallet transaction',
    );
  }

  const ledger = claim.walletTransaction;
  if (ledger.id !== claim.walletTransactionId) {
    throwAdRewardClaimIntegrity(claim.id, 'linked ledger row id mismatch');
  }
  if (ledger.tradingAccountId !== claim.tradingAccountId) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'ledger row belongs to a different trading account',
    );
  }
  if (ledger.seasonParticipantId !== null) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'ledger row carries a season participant link',
    );
  }
  if (ledger.walletId !== expectedKrwWalletId) {
    throwAdRewardClaimIntegrity(
      claim.id,
      "ledger row is not on the account's general KRW wallet",
    );
  }
  if (ledger.currencyCode !== CurrencyCode.KRW) {
    throwAdRewardClaimIntegrity(claim.id, 'ledger row currency is not KRW');
  }
  if (ledger.direction !== WalletTransactionDirection.credit) {
    throwAdRewardClaimIntegrity(claim.id, 'ledger row is not a credit');
  }
  if (ledger.txType !== WalletTransactionType.ad_reward) {
    throwAdRewardClaimIntegrity(claim.id, 'ledger row txType is not ad_reward');
  }
  if (
    ledger.referenceType !== WalletTransactionReferenceType.ad_reward_claim ||
    ledger.referenceId !== claim.id
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'ledger row does not reference this claim',
    );
  }
  if (!ledger.amount.equals(claim.rewardAmountKrw)) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'ledger amount does not equal the claim reward amount',
    );
  }
  if (
    ledger.wallet.tradingAccountId !== claim.tradingAccountId ||
    ledger.wallet.seasonParticipantId !== null ||
    ledger.wallet.currencyCode !== CurrencyCode.KRW
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      "the ledger row's wallet is not this account's general KRW wallet",
    );
  }

  return ledger;
}

/** A KEYED claim (작업 6 보완 1) must carry its full command-idempotency state. */
export function assertKeyedClaimIntegrity(
  claim: StoredClaimForIntegrity,
): void {
  if (!claim.idempotencyKey) {
    return;
  }
  if (!claim.requestHash) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'keyed claim has no stored request hash',
    );
  }
  if (claim.responsePayloadJson === null) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'keyed claim has no stored response payload',
    );
  }
}

/**
 * A REJECTED claim must have refused cleanly: a recorded limit reason, no
 * ledger link, and therefore no money moved.
 */
export function assertRejectedClaimIntegrity(
  claim: StoredClaimForIntegrity,
): void {
  if (!claim.rejectedAt) {
    throwAdRewardClaimIntegrity(claim.id, 'rejected claim has no rejectedAt');
  }
  if (claim.walletTransactionId || claim.walletTransaction) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'rejected claim is linked to a ledger row',
    );
  }
  if (!isAdRewardLimitErrorCode(claim.failureCode)) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'rejected claim has no recognised limit failure code',
    );
  }
}

/**
 * `pending` / `verified` / `failed` cannot be a COMMITTED end state in the
 * synchronous payout flow — the transaction either commits `granted`/
 * `rejected` or rolls back entirely. Finding one means a partial write
 * escaped, so it must never be replayed as a success.
 */
export function assertReplayableClaimStatus(
  claim: StoredClaimForIntegrity,
): void {
  if (
    claim.status !== AdRewardClaimStatus.granted &&
    claim.status !== AdRewardClaimStatus.rejected
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `claim is stuck in the non-terminal status "${claim.status}"; the synchronous payout flow only ever commits granted or rejected`,
    );
  }
}
