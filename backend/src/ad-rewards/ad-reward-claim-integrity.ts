import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AdRewardClaimStatus,
  CurrencyCode,
  Prisma,
  SnapshotReason,
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

// ------------------------------------------------- external-funding boundary

type BoundaryClient = Pick<Prisma.TransactionClient, 'equitySnapshot'>;

const BOUNDARY_SELECT = {
  id: true,
  seasonParticipantId: true,
  tradingAccountId: true,
  snapshotReason: true,
  totalAssetKrw: true,
  returnRate: true,
  cumulativeExternalFundingKrw: true,
  investmentPnlKrw: true,
  timeWeightedReturnFactor: true,
  externalFundingAmountKrw: true,
  externalFundingReferenceType: true,
} satisfies Prisma.EquitySnapshotSelect;

type BoundaryRow = Prisma.EquitySnapshotGetPayload<{
  select: typeof BOUNDARY_SELECT;
}>;

/**
 * A KEYED granted claim must own a complete, neutral external-funding boundary
 * pair (작업 7 보완 2).
 *
 * Command idempotency (작업 6 보완 1) and the boundary pair (작업 7) shipped in
 * the SAME commit, so every keyed granted claim was written by a payout
 * transaction that also wrote both rows. A keyed claim without them is a
 * partial write, and replaying it as a success would confirm a payout whose
 * performance boundary never landed — the next TWR advance would then count the
 * reward as investment profit.
 *
 * UNKEYED claims predate all of this. No pair is expected, none is fabricated,
 * and none is guessed: those accounts are handled by the explicit
 * `performance_baseline` backfill instead.
 */
export async function assertKeyedGrantedClaimBoundaryIntegrity(
  client: BoundaryClient,
  claim: StoredClaimForIntegrity,
): Promise<void> {
  if (!claim.idempotencyKey) {
    return;
  }

  const rows = await client.equitySnapshot.findMany({
    // Matched by reference id ALONE so a row that points at this claim under
    // the wrong reference type is caught rather than silently excluded.
    where: { externalFundingReferenceId: claim.id },
    select: BOUNDARY_SELECT,
    orderBy: { id: 'asc' },
  });

  const before = rows.filter(
    (row) => row.snapshotReason === SnapshotReason.external_funding_before,
  );
  const after = rows.filter(
    (row) => row.snapshotReason === SnapshotReason.external_funding_after,
  );
  const other = rows.length - before.length - after.length;

  if (before.length !== 1 || after.length !== 1 || other !== 0) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `keyed granted claim must own exactly one external-funding before/after pair but has before=${before.length}, after=${after.length}, other=${other}`,
    );
  }

  const beforeRow = before[0];
  const afterRow = after[0];

  for (const [phase, row] of [
    ['before', beforeRow],
    ['after', afterRow],
  ] as const) {
    assertBoundaryRowShape(claim, phase, row);
  }

  const reward = claim.rewardAmountKrw;
  if (
    !beforeRow.timeWeightedReturnFactor!.equals(
      afterRow.timeWeightedReturnFactor!,
    )
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'external-funding boundary changed the time-weighted return factor; an inflow is not performance',
    );
  }
  if (!beforeRow.returnRate.equals(afterRow.returnRate)) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'external-funding boundary changed the return rate; an inflow is not performance',
    );
  }
  if (!beforeRow.investmentPnlKrw!.equals(afterRow.investmentPnlKrw!)) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'external-funding boundary changed investment PnL; an inflow is not a gain',
    );
  }
  if (!afterRow.totalAssetKrw.equals(beforeRow.totalAssetKrw.add(reward))) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'external-funding "after" total asset is not "before" plus the reward amount',
    );
  }
  if (
    !afterRow.cumulativeExternalFundingKrw!.equals(
      beforeRow.cumulativeExternalFundingKrw!.add(reward),
    )
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'external-funding "after" cumulative funding is not "before" plus the reward amount',
    );
  }
}

function assertBoundaryRowShape(
  claim: StoredClaimForIntegrity,
  phase: 'before' | 'after',
  row: BoundaryRow,
): void {
  if (row.tradingAccountId !== claim.tradingAccountId) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `external-funding ${phase} snapshot belongs to a different trading account`,
    );
  }
  if (row.seasonParticipantId !== null) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `external-funding ${phase} snapshot carries a season participant link`,
    );
  }
  if (
    row.externalFundingReferenceType !==
    WalletTransactionReferenceType.ad_reward_claim
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `external-funding ${phase} snapshot does not reference an ad_reward_claim`,
    );
  }
  if (
    row.externalFundingAmountKrw === null ||
    !row.externalFundingAmountKrw.equals(claim.rewardAmountKrw)
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `external-funding ${phase} snapshot amount does not equal the claim reward amount`,
    );
  }
  if (
    row.cumulativeExternalFundingKrw === null ||
    row.investmentPnlKrw === null ||
    row.timeWeightedReturnFactor === null
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `external-funding ${phase} snapshot is missing general performance values`,
    );
  }
}

// ------------------------------------------------------- stored response

/**
 * `responsePayloadJson` is the canonical first result, written inside the
 * payout transaction. It is USED, not merely stored: every replay verifies the
 * live ledger still agrees with what the caller was originally told. A stored
 * payload that has drifted from the ledger means one of the two was rewritten
 * after the fact, which is exactly the situation a "duplicate: true" success
 * must not paper over.
 */
export function assertStoredGrantedResponse(
  claim: StoredClaimForIntegrity,
  ledgerBalanceAfter: string,
): void {
  const data = readStoredResponseData(claim);
  if (!data) {
    return;
  }

  const storedClaimId = readString(data.claimId);
  if (storedClaimId !== null && storedClaimId !== claim.id) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'stored response payload names a different claim',
    );
  }

  const storedBalance = readString(data.walletBalanceAfter);
  if (storedBalance !== null && storedBalance !== ledgerBalanceAfter) {
    throwAdRewardClaimIntegrity(
      claim.id,
      `stored response payload balance ${storedBalance} disagrees with the ledger balance ${ledgerBalanceAfter}`,
    );
  }

  const storedGrantedAt = readString(data.grantedAt);
  if (
    storedGrantedAt !== null &&
    storedGrantedAt !== claim.grantedAt?.toISOString()
  ) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'stored response payload grantedAt disagrees with the claim',
    );
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The refusal payload must still name the failure the claim was rejected with. */
export function assertStoredRejectedResponse(
  claim: StoredClaimForIntegrity,
): void {
  const payload = claim.responsePayloadJson;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return;
  }

  const code = (payload as Record<string, unknown>).code;
  if (typeof code === 'string' && code !== claim.failureCode) {
    throwAdRewardClaimIntegrity(
      claim.id,
      'stored refusal payload names a different failure code than the claim',
    );
  }
}

function readStoredResponseData(
  claim: StoredClaimForIntegrity,
): Record<string, unknown> | null {
  const payload = claim.responsePayloadJson;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const data = (payload as Record<string, unknown>).data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  return data as Record<string, unknown>;
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
