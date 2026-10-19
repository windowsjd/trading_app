import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AdRewardClaimStatus,
  AdRewardPurpose,
  CurrencyCode,
  Prisma,
  TradingAccountMode,
  TradingAccountStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
  type WalletScope,
} from '../generated/prisma/client';
import { createApiError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { MONEY_SCALE } from '../portfolio/general-performance.policy';
import { throwGeneralAccountIntegrity } from '../trading-accounts/general-account-integrity';
import { GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW } from '../trading-accounts/general-account.policy';
import {
  readGeneralAccountResetBlockers,
  type GeneralAccountResetBlocker,
} from '../trading-accounts/general-account-reset-blockers';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import {
  parseAdRewardCommand,
  type AdRewardCommandBody,
} from './ad-reward-command';
import { throwAdRewardClaimIntegrity } from './ad-reward-claim-integrity';
import {
  adRewardErrorCodes,
  throwAdRewardError,
} from './ad-reward-error-policy';
import { readAdRewardConfig } from './ad-reward.config';
import {
  AD_REWARD_VERIFICATION_REGISTRY,
  AdRewardVerificationRegistry,
  buildAdRewardProofFingerprint,
  buildGeneralAccountResetRequestHash,
  type AdRewardVerificationSuccess,
} from './ad-reward-verifier';

/**
 * General-account reset (2026-10-20) — one verified ad completion restarts a
 * general account at 10,000,000 KRW without deleting anything.
 *
 * WHAT A RESET IS
 *   The same account (id, owner, opening grant, every past order, fill, FX,
 *   transfer and ledger row) moves its four wallets to Securities KRW
 *   10,000,000 and every USD wallet 0 through `account_reset` ledger rows that
 *   reference one GeneralAccountReset row, re-bases spot Position realized PnL
 *   to 0 (the values it held are kept on the reset row), and opens a new
 *   performance epoch with a `general_account_reset` EquitySnapshot: total =
 *   principal = 10,000,000, PnL 0, factor 1. Return, PnL, principal and the
 *   history chart are read from the latest epoch on
 *   (GeneralExternalFundingService).
 *
 * WHAT IT IS NOT
 *   Not a re-grant of the opening 10,000,000 (no initial_grant row, and the
 *   opening grant's row is untouched), not account re-creation, not an
 *   automatic bankruptcy reset, and not a liquidation: anything held or
 *   pending blocks it (general-account-reset-blockers.ts).
 *
 * AD COMPLETION
 *   The completion is verified server-side for purpose `account_reset` and
 *   consumed as an AdRewardClaim with that purpose. (provider, providerEventId)
 *   is unique across BOTH purposes, so one completion redeems one command;
 *   the (account, idempotencyKey) unique replays a retried reset. A refused
 *   reset (blocked, inactive, damaged) writes nothing and does not consume
 *   the completion. With no verifier registered — production today — every
 *   reset is 503 AD_REWARD_PROVIDER_UNAVAILABLE.
 *
 * ATOMICITY AND ORDER
 *   One transaction takes the account row lock that every order, fill, FX,
 *   transfer, Futures, conditional, ad payout and daily-snapshot path takes,
 *   re-checks everything, then writes claim → reset → ledger/wallets →
 *   positions → epoch origin → claim granted (+ stored response), and finally
 *   re-reads the continuous performance state it just created. Any failure
 *   rolls every row back.
 */

const STORED_RESET_CLAIM_SELECT = {
  id: true,
  userId: true,
  tradingAccountId: true,
  purpose: true,
  status: true,
  grantedAt: true,
  walletTransactionId: true,
  requestHash: true,
  responsePayloadJson: true,
  generalAccountReset: {
    select: {
      id: true,
      tradingAccountId: true,
      userId: true,
      sequence: true,
      resetAt: true,
    },
  },
} satisfies Prisma.AdRewardClaimSelect;

type StoredResetClaim = Prisma.AdRewardClaimGetPayload<{
  select: typeof STORED_RESET_CLAIM_SELECT;
}>;

/** Canonical wallet order and each wallet's reset target. */
const RESET_WALLET_TARGETS: ReadonlyArray<{
  walletScope: WalletScope;
  currencyCode: CurrencyCode;
  target: string;
}> = [
  {
    walletScope: 'securities',
    currencyCode: CurrencyCode.KRW,
    target: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
  },
  {
    walletScope: 'securities',
    currencyCode: CurrencyCode.USD,
    target: '0',
  },
  {
    walletScope: 'crypto_spot',
    currencyCode: CurrencyCode.USD,
    target: '0',
  },
  {
    walletScope: 'crypto_futures',
    currencyCode: CurrencyCode.USD,
    target: '0',
  },
];

const RESET_UNAVAILABLE_CODE = 'GENERAL_ACCOUNT_RESET_UNAVAILABLE';
const RESET_UNAVAILABLE_MESSAGE =
  'The account reset is temporarily unavailable. Try again shortly.';

/** 503: the ended epoch cannot be valued now (USD cash without a current rate). */
function throwResetUnavailable(): never {
  throw createApiError(
    RESET_UNAVAILABLE_CODE,
    RESET_UNAVAILABLE_MESSAGE,
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

export type ResetWalletView = {
  walletScope: WalletScope;
  currencyCode: CurrencyCode;
  balanceAmount: string;
};

export type GeneralAccountResetResponse = {
  success: true;
  data: {
    /** true on the call that reset the account; false on a replay. */
    reset: boolean;
    duplicate: boolean;
    resetId: string;
    claimId: string;
    sequence: number;
    resetAt: string;
    totalAssetKrw: string;
    wallets: ResetWalletView[];
  };
};

type ResetOutcome = {
  kind: 'reset' | 'replayed';
  payload: GeneralAccountResetResponse;
};

@Injectable()
export class GeneralAccountResetService {
  private readonly logger = new Logger(GeneralAccountResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: TradingAccountAccessService,
    @Inject(AD_REWARD_VERIFICATION_REGISTRY)
    private readonly registry: AdRewardVerificationRegistry,
    private readonly performanceService: GeneralAccountPerformanceService,
    private readonly valuationService: PortfolioValuationService,
  ) {}

  // ---------------------------------------------------------------- read

  /**
   * Advisory only (a GET writes nothing). Structure first: a damaged account
   * is a structured 500 whether or not ads are switched on. `blockers` is
   * always listed so the app can say what to close before showing an ad.
   */
  async getEligibility(userId: string | undefined, accountId: string) {
    const account = await this.resolveGeneralAccount(userId, accountId);
    const { blockers, valuable, lastResetAt, resetCount } =
      await this.preCheck(account);
    const config = readAdRewardConfig();
    const reason = !config.enabled
      ? adRewardErrorCodes.AD_REWARD_DISABLED
      : !this.registry.resolve(config.provider)
        ? adRewardErrorCodes.AD_REWARD_PROVIDER_UNAVAILABLE
        : account.status !== TradingAccountStatus.active
          ? adRewardErrorCodes.TRADING_ACCOUNT_NOT_ACTIVE
          : blockers.length > 0
            ? adRewardErrorCodes.GENERAL_ACCOUNT_RESET_BLOCKED
            : !valuable
              ? RESET_UNAVAILABLE_CODE
              : null;

    return {
      success: true as const,
      data: {
        tradingAccountId: account.id,
        enabled: config.enabled,
        provider: config.enabled ? config.provider : null,
        eligible: reason === null,
        reason,
        blockers,
        targetKrwBalance: new Prisma.Decimal(
          GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
        ).toFixed(MONEY_SCALE),
        resetCount,
        lastResetAt: lastResetAt?.toISOString() ?? null,
      },
    };
  }

  /**
   * Everything checked before an ad verification is spent, on ONE
   * RepeatableRead snapshot (as the portfolio reads), so this account's own
   * top-up or reset committing in between cannot look like damage: structure
   * and performance continuity (a damaged account is a structured 500), the
   * blockers, and — with nothing blocking — whether the ended epoch can be
   * valued now (USD cash needs a current rate). Reads only: no lock, no
   * write; the reset transaction checks all of it again under the lock.
   */
  private async preCheck(account: OwnedTradingAccount): Promise<{
    blockers: GeneralAccountResetBlocker[];
    valuable: boolean;
    lastResetAt: Date | null;
    resetCount: number;
  }> {
    const at = new Date();
    return this.prisma.$transaction(
      async (tx) => {
        await this.performanceService.requireContinuousPerformanceState({
          account,
          client: tx,
        });
        const blockers = await readGeneralAccountResetBlockers(tx, account.id);
        const valuable =
          blockers.length > 0 ||
          (await this.valueClosingEpoch(account.id, at, tx)) !== null;
        const lastReset = await tx.generalAccountReset.findFirst({
          where: { tradingAccountId: account.id },
          orderBy: { sequence: 'desc' },
          select: { resetAt: true },
        });
        const resetCount = await tx.generalAccountReset.count({
          where: { tradingAccountId: account.id },
        });
        return {
          blockers,
          valuable,
          lastResetAt: lastReset?.resetAt ?? null,
          resetCount,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  // ------------------------------------------------------------- command

  async reset(
    userId: string | undefined,
    accountId: string,
    body: AdRewardCommandBody = {},
  ): Promise<GeneralAccountResetResponse> {
    const account = await this.resolveGeneralAccount(userId, accountId);
    const request = parseAdRewardCommand(body);
    const proofFingerprint = buildAdRewardProofFingerprint(request.proof);
    const requestHash = buildGeneralAccountResetRequestHash({
      provider: request.provider,
      proofFingerprint,
    });

    // A committed reset owes its caller the first answer, whatever changed
    // since (status, feature switch, adapter) — same rule as the top-up.
    const keyed = await this.findKeyedClaim(
      account.id,
      request.idempotencyKey,
      this.prisma,
    );
    if (keyed) {
      return this.resolveStoredReset({
        claim: keyed,
        account,
        matchedBy: 'command_key',
        requestHash,
      }).payload;
    }

    // ---- from here on this is a NEW command ----
    if (account.status !== TradingAccountStatus.active) {
      throwAdRewardError(
        adRewardErrorCodes.TRADING_ACCOUNT_NOT_ACTIVE,
        'Trading account is not active.',
      );
    }
    const config = readAdRewardConfig();
    if (!config.enabled) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_DISABLED,
        'Ad rewards are disabled.',
      );
    }
    if (request.provider !== config.provider) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_PROVIDER_UNAVAILABLE,
        'Requested ad provider is not the configured provider.',
      );
    }
    const verifier = this.registry.resolve(request.provider);
    if (!verifier) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_PROVIDER_UNAVAILABLE,
        'No verification adapter is registered for this ad provider.',
      );
    }

    // Refuse before verifying: a blocked or damaged account, or one whose
    // ended epoch cannot be valued right now, never spends a verification.
    // Re-checked under the lock below.
    const pre = await this.preCheck(account);
    this.assertNotBlocked(pre.blockers);
    if (!pre.valuable) throwResetUnavailable();

    const verification = await verifier.verify({
      provider: request.provider,
      proof: request.proof,
      expectedUserId: account.userId,
      expectedTradingAccountId: account.id,
      expectedPurpose: AdRewardPurpose.account_reset,
    });
    if (
      !verification.ok ||
      verification.purpose !== AdRewardPurpose.account_reset
    ) {
      // Nothing is written; an event issued for a top-up never resets.
      this.logger.warn(
        JSON.stringify({
          event: 'general_account_reset_verification_failed',
          tradingAccountId: account.id,
          provider: request.provider,
          reasonCode: verification.ok
            ? 'PURPOSE_MISMATCH'
            : verification.reasonCode,
        }),
      );
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_VERIFICATION_FAILED,
        'Ad completion could not be verified.',
      );
    }

    const outcome = await this.runResetTransaction({
      account,
      verification,
      proofFingerprint,
      idempotencyKey: request.idempotencyKey,
      requestHash,
    });
    const committed = outcome.payload;
    if (outcome.kind === 'reset') {
      const { resetId, sequence } = committed.data;
      this.logger.log(
        JSON.stringify({
          event: 'general_account_reset_committed',
          tradingAccountId: account.id,
          resetId,
          sequence,
        }),
      );
    }
    return committed;
  }

  private async runResetTransaction(input: {
    account: OwnedTradingAccount;
    verification: AdRewardVerificationSuccess;
    proofFingerprint: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<ResetOutcome> {
    const { account, verification } = input;
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The account fence every money-moving path of this account takes.
        const lockedRows = await tx.$queryRaw<
          Array<{
            id: string;
            status: TradingAccountStatus;
            mode: TradingAccountMode;
          }>
        >`
          SELECT "id", "status", "mode"
          FROM "trading_accounts"
          WHERE "id" = ${account.id}
            AND "user_id" = ${account.userId}
          FOR UPDATE
        `;
        const locked = lockedRows[0];
        if (!locked || locked.status !== TradingAccountStatus.active) {
          throwAdRewardError(
            adRewardErrorCodes.TRADING_ACCOUNT_NOT_ACTIVE,
            'Trading account is not active.',
          );
        }
        if (locked.mode !== TradingAccountMode.general) {
          throwAdRewardError(
            adRewardErrorCodes.AD_REWARD_GENERAL_ACCOUNT_ONLY,
            'Ad rewards are only available for general-mode accounts.',
          );
        }

        // A concurrent identical command may have won while this one waited.
        const racedKeyed = await this.findKeyedClaim(
          account.id,
          input.idempotencyKey,
          tx,
        );
        if (racedKeyed) {
          return this.resolveStoredReset({
            claim: racedKeyed,
            account,
            matchedBy: 'command_key',
            requestHash: input.requestHash,
          });
        }
        const existingEvent = await tx.adRewardClaim.findUnique({
          where: {
            provider_providerEventId: {
              provider: verification.provider,
              providerEventId: verification.providerEventId,
            },
          },
          select: STORED_RESET_CLAIM_SELECT,
        });
        if (existingEvent) {
          return this.resolveStoredReset({
            claim: existingEvent,
            account,
            matchedBy: 'provider_event',
            requestHash: input.requestHash,
          });
        }

        // The reset must start from a trustworthy state: full structure,
        // trading/FX row scope, and a latest snapshot that matches the
        // verified funding ledger of the current epoch.
        const { snapshot, funding } =
          await this.performanceService.requireContinuousPerformanceState({
            account,
            client: tx,
          });
        this.assertNotBlocked(
          await readGeneralAccountResetBlockers(tx, account.id),
        );

        // Strictly after every stored state of the ended epoch, so the new
        // origin is the latest snapshot even across a backward clock step.
        const resetAt = new Date(
          Math.max(Date.now(), snapshot.capturedAt.getTime() + 1),
        );

        const closing = await this.valueClosingEpoch(account.id, resetAt, tx);
        if (closing === null) throwResetUnavailable();
        const closingPnl = closing.sub(funding.cumulativeExternalFundingKrw);

        const wallets = await tx.cashWallet.findMany({
          where: { tradingAccountId: account.id },
          select: {
            id: true,
            walletScope: true,
            currencyCode: true,
            balanceAmount: true,
            reservedAmount: true,
          },
        });
        const plan = RESET_WALLET_TARGETS.map((spec) => {
          const matches = wallets.filter(
            (wallet) =>
              wallet.walletScope === spec.walletScope &&
              wallet.currencyCode === spec.currencyCode,
          );
          if (matches.length !== 1) {
            throwGeneralAccountIntegrity(
              account.id,
              'a canonical wallet is missing or duplicated at reset',
            );
          }
          return {
            ...spec,
            wallet: matches[0],
            targetAmount: new Prisma.Decimal(spec.target),
          };
        });

        const positions = await tx.position.findMany({
          where: {
            tradingAccountId: account.id,
            OR: [{ realizedPnl: { not: 0 } }, { realizedPnlKrw: { not: 0 } }],
          },
          select: {
            id: true,
            assetId: true,
            quantity: true,
            reservedQuantity: true,
            realizedPnl: true,
            realizedPnlKrw: true,
          },
          orderBy: { id: 'asc' },
        });

        const previous = await tx.generalAccountReset.findFirst({
          where: { tradingAccountId: account.id },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const sequence = (previous?.sequence ?? 0) + 1;

        const claim = await tx.adRewardClaim.create({
          data: {
            userId: account.userId,
            tradingAccountId: account.id,
            provider: verification.provider,
            providerEventId: verification.providerEventId,
            purpose: AdRewardPurpose.account_reset,
            status: AdRewardClaimStatus.verified,
            // A reset pays nothing by itself (SQL CHECK).
            rewardAmountKrw: '0',
            verificationFingerprint: input.proofFingerprint,
            verificationMetadataJson: {
              occurredAt: verification.occurredAt.toISOString(),
              ...(verification.metadata ?? {}),
            } as Prisma.InputJsonValue,
            requestedAt: resetAt,
            verifiedAt: resetAt,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          },
          select: { id: true },
        });

        const reset = await tx.generalAccountReset.create({
          data: {
            tradingAccountId: account.id,
            userId: account.userId,
            adRewardClaimId: claim.id,
            sequence,
            resetAt,
            targetKrwBalance: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
            lifetimeExternalFundingKrw:
              funding.lifetimeExternalFundingKrw.toFixed(MONEY_SCALE),
            closingTotalAssetKrw: closing.toFixed(MONEY_SCALE),
            closingExternalFundingKrw:
              funding.cumulativeExternalFundingKrw.toFixed(MONEY_SCALE),
            closingInvestmentPnlKrw: closingPnl.toFixed(MONEY_SCALE),
            walletsBeforeJson: plan.map((step) => ({
              walletId: step.wallet.id,
              walletScope: step.walletScope,
              currencyCode: step.currencyCode,
              balanceAmount: step.wallet.balanceAmount.toFixed(MONEY_SCALE),
              targetAmount: step.targetAmount.toFixed(MONEY_SCALE),
            })),
            positionsRebasedJson: positions.map((position) => ({
              positionId: position.id,
              assetId: position.assetId,
              realizedPnl: position.realizedPnl.toFixed(MONEY_SCALE),
              realizedPnlKrw: position.realizedPnlKrw.toFixed(MONEY_SCALE),
            })),
          },
          select: { id: true },
        });

        // Each wallet moves to its target with ONE ledger row, guarded by the
        // balance it was just read with and zero reservations.
        for (const step of plan) {
          const before = step.wallet.balanceAmount;
          if (before.equals(step.targetAmount)) continue;
          const moved = await tx.cashWallet.updateMany({
            where: {
              id: step.wallet.id,
              tradingAccountId: account.id,
              walletScope: step.walletScope,
              currencyCode: step.currencyCode,
              balanceAmount: before,
              reservedAmount: 0,
            },
            data: { balanceAmount: step.targetAmount },
          });
          if (moved.count !== 1) {
            throwGeneralAccountIntegrity(
              account.id,
              'a wallet changed while the reset held the account lock',
            );
          }
          await tx.walletTransaction.create({
            data: {
              tradingAccountId: account.id,
              walletId: step.wallet.id,
              currencyCode: step.currencyCode,
              direction: step.targetAmount.gt(before)
                ? WalletTransactionDirection.credit
                : WalletTransactionDirection.debit,
              txType: WalletTransactionType.account_reset,
              referenceType:
                WalletTransactionReferenceType.general_account_reset,
              referenceId: reset.id,
              amount: step.targetAmount.sub(before).abs(),
              balanceAfter: step.targetAmount,
              occurredAt: resetAt,
            },
            select: { id: true },
          });
        }

        // Realized PnL of an emptied holding is the ended epoch's result: the
        // aggregate row is reused by the next buy, so it starts at 0 again.
        if (positions.length > 0) {
          if (
            positions.some(
              (position) =>
                !position.quantity.isZero() ||
                !position.reservedQuantity.isZero(),
            )
          ) {
            throwGeneralAccountIntegrity(
              account.id,
              'a held position reached the reset after the blocker check',
            );
          }
          const rebased = await tx.position.updateMany({
            where: {
              id: { in: positions.map((position) => position.id) },
              tradingAccountId: account.id,
              quantity: 0,
              reservedQuantity: 0,
            },
            data: { realizedPnl: 0, realizedPnlKrw: 0 },
          });
          if (rebased.count !== positions.length) {
            throwGeneralAccountIntegrity(
              account.id,
              'a position changed while the reset held the account lock',
            );
          }
        }

        await tx.equitySnapshot.create({
          data: this.performanceService.buildResetOriginSnapshotData({
            tradingAccountId: account.id,
            resetId: reset.id,
            targetKrwBalance: GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
            resetAt,
          }),
          select: { id: true },
        });

        const payload: GeneralAccountResetResponse = {
          success: true,
          data: {
            reset: true,
            duplicate: false,
            resetId: reset.id,
            claimId: claim.id,
            sequence,
            resetAt: resetAt.toISOString(),
            totalAssetKrw: new Prisma.Decimal(
              GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW,
            ).toFixed(MONEY_SCALE),
            wallets: plan.map((step) => ({
              walletScope: step.walletScope,
              currencyCode: step.currencyCode,
              balanceAmount: step.targetAmount.toFixed(MONEY_SCALE),
            })),
          },
        };
        await tx.adRewardClaim.update({
          where: { id: claim.id },
          data: {
            status: AdRewardClaimStatus.granted,
            grantedAt: resetAt,
            responsePayloadJson: payload as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        // The state just written must already read as a continuous epoch:
        // principal = target, latest snapshot = the new origin.
        const settled =
          await this.performanceService.requireContinuousPerformanceState({
            account,
            client: tx,
          });
        if (
          settled.funding.epoch.resetId !== reset.id ||
          !settled.funding.cumulativeExternalFundingKrw.equals(
            new Prisma.Decimal(GENERAL_ACCOUNT_INITIAL_CAPITAL_KRW),
          )
        ) {
          throwGeneralAccountIntegrity(
            account.id,
            'the reset did not settle into a new performance epoch',
          );
        }

        return { kind: 'reset', payload };
      });
    } catch (caught) {
      if (!isUniqueConstraintError(caught)) {
        throw caught;
      }
      // A concurrent command with the same key or the same ad event won the
      // unique index: answer exactly as the winner did, on its own axis.
      const racedKeyed = await this.findKeyedClaim(
        account.id,
        input.idempotencyKey,
        this.prisma,
      );
      if (racedKeyed) {
        return this.resolveStoredReset({
          claim: racedKeyed,
          account,
          matchedBy: 'command_key',
          requestHash: input.requestHash,
        });
      }
      const raced = await this.prisma.adRewardClaim.findUnique({
        where: {
          provider_providerEventId: {
            provider: verification.provider,
            providerEventId: verification.providerEventId,
          },
        },
        select: STORED_RESET_CLAIM_SELECT,
      });
      if (!raced) throw caught;
      return this.resolveStoredReset({
        claim: raced,
        account,
        matchedBy: 'provider_event',
        requestHash: input.requestHash,
      });
    }
  }

  /**
   * The ended epoch's total, valued at the reset instant, or null when it
   * cannot be valued now. Nothing is held at this point, so this is cash (FX
   * only when a USD wallet is non-zero). A missing or stale FX rate refuses
   * the reset rather than recording a guess.
   */
  private async valueClosingEpoch(
    accountId: string,
    resetAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal | null> {
    try {
      const valuation =
        await this.valuationService.calculateTradingAccountValuation(
          accountId,
          resetAt,
          'home_live_valuation',
          tx,
        );
      return new Prisma.Decimal(valuation.totalAssetKrw);
    } catch (caught) {
      if (
        caught instanceof PortfolioValuationError &&
        [
          'FX_RATE_UNAVAILABLE',
          'FX_RATE_STALE',
          'ASSET_PRICE_UNAVAILABLE',
        ].includes(caught.code)
      ) {
        return null;
      }
      throw caught;
    }
  }

  /**
   * THE replay validator of a stored reset command. Never re-verifies,
   * never moves money, never repairs; a damaged record is a structured 500,
   * never a `duplicate: true` success.
   */
  private resolveStoredReset(input: {
    claim: StoredResetClaim;
    account: OwnedTradingAccount;
    matchedBy: 'command_key' | 'provider_event';
    requestHash: string;
  }): ResetOutcome {
    const { claim, account } = input;
    if (
      claim.userId !== account.userId ||
      claim.tradingAccountId !== account.id
    ) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_EVENT_ALREADY_USED,
        'This ad completion event has already been used.',
      );
    }
    if (
      input.matchedBy === 'command_key' &&
      (claim.requestHash !== input.requestHash ||
        claim.purpose !== AdRewardPurpose.account_reset)
    ) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_IDEMPOTENCY_CONFLICT,
        'Same idempotencyKey was used with a different ad reward claim request.',
      );
    }
    if (claim.purpose !== AdRewardPurpose.account_reset) {
      // The completion already paid a top-up: one event, one command.
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_EVENT_ALREADY_USED,
        'This ad completion event has already been used.',
      );
    }

    const reset = claim.generalAccountReset;
    if (
      claim.status !== AdRewardClaimStatus.granted ||
      !claim.grantedAt ||
      claim.walletTransactionId !== null ||
      !reset ||
      reset.tradingAccountId !== account.id ||
      reset.userId !== account.userId ||
      reset.resetAt.getTime() !== claim.grantedAt.getTime()
    ) {
      throwAdRewardClaimIntegrity(
        claim.id,
        'reset claim is not a granted claim of exactly one reset of this account',
      );
    }

    const stored = readStoredResetPayload(claim.responsePayloadJson);
    if (
      !stored ||
      stored.resetId !== reset.id ||
      stored.claimId !== claim.id ||
      stored.sequence !== reset.sequence ||
      stored.resetAt !== reset.resetAt.toISOString()
    ) {
      throwAdRewardClaimIntegrity(
        claim.id,
        'stored reset response disagrees with its reset record',
      );
    }

    return {
      kind: 'replayed',
      payload: {
        success: true,
        data: { ...stored, reset: false, duplicate: true },
      },
    };
  }

  // ------------------------------------------------------------ helpers

  private findKeyedClaim(
    tradingAccountId: string,
    idempotencyKey: string,
    client: Prisma.TransactionClient | PrismaService,
  ) {
    return client.adRewardClaim.findUnique({
      where: {
        tradingAccountId_idempotencyKey: { tradingAccountId, idempotencyKey },
      },
      select: STORED_RESET_CLAIM_SELECT,
    });
  }

  private assertNotBlocked(blockers: GeneralAccountResetBlocker[]): void {
    if (blockers.length > 0) {
      throwAdRewardError(
        adRewardErrorCodes.GENERAL_ACCOUNT_RESET_BLOCKED,
        'Close holdings, positions and open orders before resetting the account.',
      );
    }
  }

  private async resolveGeneralAccount(
    userId: string | undefined,
    accountId: string,
  ): Promise<OwnedTradingAccount> {
    if (!userId) {
      throw createApiError(
        'UNAUTHORIZED',
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // Unknown and foreign accountIds are the SAME 404.
    const account = await this.accessService.getOwnedAccountOrThrow(
      userId,
      typeof accountId === 'string' ? accountId.trim() : accountId,
    );
    if (
      account.mode !== TradingAccountMode.general ||
      account.seasonParticipant
    ) {
      // Season and beginner accounts are never reset.
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_GENERAL_ACCOUNT_ONLY,
        'Ad rewards are only available for general-mode accounts.',
      );
    }
    return account;
  }
}

/** The stored first answer, minus the replay flags. Null when malformed. */
function readStoredResetPayload(
  value: Prisma.JsonValue | null,
): Omit<GeneralAccountResetResponse['data'], 'reset' | 'duplicate'> | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    return null;
  }
  const data = value.data;
  if (
    data.reset !== true ||
    data.duplicate !== false ||
    typeof data.resetId !== 'string' ||
    typeof data.claimId !== 'string' ||
    typeof data.sequence !== 'number' ||
    typeof data.resetAt !== 'string' ||
    typeof data.totalAssetKrw !== 'string' ||
    !Array.isArray(data.wallets)
  ) {
    return null;
  }
  const wallets: ResetWalletView[] = [];
  for (const wallet of data.wallets) {
    if (
      !isRecord(wallet) ||
      typeof wallet.walletScope !== 'string' ||
      typeof wallet.currencyCode !== 'string' ||
      typeof wallet.balanceAmount !== 'string'
    ) {
      return null;
    }
    wallets.push({
      walletScope: wallet.walletScope as WalletScope,
      currencyCode: wallet.currencyCode as CurrencyCode,
      balanceAmount: wallet.balanceAmount,
    });
  }
  return {
    resetId: data.resetId,
    claimId: data.claimId,
    sequence: data.sequence,
    resetAt: data.resetAt,
    totalAssetKrw: data.totalAssetKrw,
    wallets,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(caught: unknown): boolean {
  return (
    caught instanceof Prisma.PrismaClientKnownRequestError &&
    caught.code === 'P2002'
  );
}
