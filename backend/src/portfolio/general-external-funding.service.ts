import { Injectable } from '@nestjs/common';
import {
  AdRewardClaimStatus,
  CurrencyCode,
  Prisma,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { throwGeneralAccountIntegrity } from '../trading-accounts/general-account-integrity';

/**
 * Cumulative EXTERNAL virtual funding of a general account (작업 7).
 *
 * "External funding" is money that entered the account from outside trading.
 * It is deliberately an ALLOW-LIST of exactly two ledger shapes, never an
 * inference:
 *
 *   initial_grant + general_account_open  → the one-time 10,000,000 KRW
 *   ad_reward     + ad_reward_claim       → a granted rewarded-ad claim
 *
 * Everything else is NOT external funding, even though some of it is also a
 * credit: `exchange_target` (FX leg), `order_sell` (trading proceeds),
 * `settlement`, `adjustment`, and any `manual_adjustment` are all either
 * internal movement or unclassified. Counting one of them as funding would
 * silently deflate the user's investment PnL; counting a genuine inflow as
 * profit would inflate it. When an operator-adjustment writer eventually
 * exists it must be added here EXPLICITLY.
 *
 * Every row is validated before it is summed. A ledger that disagrees with
 * its claim is not partially counted and not skipped — it fails closed, so a
 * corrupted account can never produce a plausible-looking return.
 *
 * All arithmetic is Prisma.Decimal; no value passes through a JS number.
 */

type ExternalFundingClient = Pick<
  Prisma.TransactionClient,
  'walletTransaction' | 'adRewardClaim' | 'cashWallet'
>;

export type GeneralExternalFundingSummary = {
  /** The one-time account-open grant (0 only if the account is corrupt). */
  initialFundingKrw: Prisma.Decimal;
  /** Sum of granted ad rewards. */
  cumulativeAdRewardKrw: Prisma.Decimal;
  /** initialFundingKrw + cumulativeAdRewardKrw. */
  cumulativeExternalFundingKrw: Prisma.Decimal;
};

@Injectable()
export class GeneralExternalFundingService {
  constructor(private readonly prisma: PrismaService) {}

  async summarize(
    accountId: string,
    krwWalletId: string,
    client: ExternalFundingClient | PrismaService = this.prisma,
  ): Promise<GeneralExternalFundingSummary> {
    const rows = await client.walletTransaction.findMany({
      where: {
        tradingAccountId: accountId,
        txType: {
          in: [
            WalletTransactionType.initial_grant,
            WalletTransactionType.ad_reward,
          ],
        },
      },
      select: {
        id: true,
        walletId: true,
        seasonParticipantId: true,
        currencyCode: true,
        direction: true,
        txType: true,
        referenceType: true,
        referenceId: true,
        amount: true,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

    let initialFundingKrw = new Prisma.Decimal(0);
    let cumulativeAdRewardKrw = new Prisma.Decimal(0);
    let initialGrantCount = 0;
    const adRewardRows: typeof rows = [];

    for (const row of rows) {
      // Shape common to BOTH external funding kinds. Anything off here means
      // the ledger was written by something that is not the general-account
      // path, so no amount from it may be trusted.
      if (
        row.walletId !== krwWalletId ||
        row.seasonParticipantId !== null ||
        row.currencyCode !== CurrencyCode.KRW ||
        row.direction !== WalletTransactionDirection.credit
      ) {
        throwGeneralAccountIntegrity(
          accountId,
          `external funding ledger row ${row.id} has an unexpected wallet, participant link, currency, or direction`,
        );
      }
      if (row.amount.lte(0)) {
        throwGeneralAccountIntegrity(
          accountId,
          `external funding ledger row ${row.id} has a non-positive amount`,
        );
      }

      if (row.txType === WalletTransactionType.initial_grant) {
        if (
          row.referenceType !==
            WalletTransactionReferenceType.general_account_open ||
          row.referenceId !== accountId
        ) {
          throwGeneralAccountIntegrity(
            accountId,
            `initial grant ledger row ${row.id} has an unexpected reference`,
          );
        }
        initialGrantCount += 1;
        initialFundingKrw = initialFundingKrw.add(row.amount);
        continue;
      }

      if (
        row.referenceType !== WalletTransactionReferenceType.ad_reward_claim ||
        !row.referenceId
      ) {
        throwGeneralAccountIntegrity(
          accountId,
          `ad reward ledger row ${row.id} has an unexpected reference`,
        );
      }
      adRewardRows.push(row);
    }

    if (initialGrantCount !== 1) {
      throwGeneralAccountIntegrity(
        accountId,
        `expected exactly one initial grant ledger row, found ${initialGrantCount}`,
      );
    }

    if (adRewardRows.length > 0) {
      // Each ad_reward row must be backed by a GRANTED claim that points back
      // at it with the same amount — the 1:1 link the payout transaction
      // creates. A one-sided link means either a lost claim update or a
      // fabricated ledger row; both are fail-closed.
      const claims = await client.adRewardClaim.findMany({
        where: { id: { in: adRewardRows.map((row) => row.referenceId!) } },
        select: {
          id: true,
          status: true,
          tradingAccountId: true,
          rewardAmountKrw: true,
          walletTransactionId: true,
        },
      });
      const claimsById = new Map(claims.map((claim) => [claim.id, claim]));

      for (const row of adRewardRows) {
        const claim = claimsById.get(row.referenceId!);
        if (!claim) {
          throwGeneralAccountIntegrity(
            accountId,
            `ad reward ledger row ${row.id} has no matching claim`,
          );
        }
        if (
          claim.tradingAccountId !== accountId ||
          claim.status !== AdRewardClaimStatus.granted ||
          claim.walletTransactionId !== row.id ||
          !claim.rewardAmountKrw.equals(row.amount)
        ) {
          throwGeneralAccountIntegrity(
            accountId,
            `ad reward claim ${claim.id} and ledger row ${row.id} disagree`,
          );
        }
        cumulativeAdRewardKrw = cumulativeAdRewardKrw.add(row.amount);
      }
    }

    return {
      initialFundingKrw,
      cumulativeAdRewardKrw,
      cumulativeExternalFundingKrw: initialFundingKrw.add(
        cumulativeAdRewardKrw,
      ),
    };
  }
}
