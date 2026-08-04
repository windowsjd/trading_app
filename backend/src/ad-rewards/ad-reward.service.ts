import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AdRewardClaimStatus,
  CurrencyCode,
  Prisma,
  TradingAccountMode,
  TradingAccountStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { buildPagination, type Pagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { assertGeneralAccountFinancialIntegrity } from '../trading-accounts/general-account-integrity';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import {
  adRewardErrorCodes,
  throwAdRewardError,
  type AdRewardLimitErrorCode,
} from './ad-reward-error-policy';
import {
  readAdRewardConfig,
  resolveAdRewardDayStart,
  type AdRewardConfig,
} from './ad-reward.config';
import {
  AD_REWARD_VERIFICATION_REGISTRY,
  AdRewardVerificationRegistry,
  buildAdRewardClaimRequestHash,
  buildAdRewardProofFingerprint,
  type AdRewardVerificationSuccess,
} from './ad-reward-verifier';
import {
  assertGrantedClaimIntegrity,
  assertKeyedClaimIntegrity,
  assertKeyedGrantedClaimBoundaryIntegrity,
  assertRejectedClaimIntegrity,
  assertReplayableClaimStatus,
  assertStoredGrantedResponse,
  assertStoredRejectedResponse,
  type StoredClaimForIntegrity,
} from './ad-reward-claim-integrity';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import type { VerifiedGeneralAccountWallets } from '../trading-accounts/general-account-integrity';

/**
 * Rewarded-ad funding for GENERAL accounts (작업 6).
 *
 * Shape of a claim:
 *   ownership → general+active gate → feature enabled → provider registered
 *   → EXTERNAL verifier call (outside any transaction) → ONE DB transaction
 *   that locks the account row, re-checks everything that depends on DB state
 *   (duplicate event, daily count, daily amount, cooldown, wallet shape),
 *   credits the KRW wallet, writes the ad_reward ledger row, and flips the
 *   claim to granted.
 *
 * Invariants:
 *  - The reward amount ALWAYS comes from server config; the request body
 *    carries only a provider key and an opaque proof.
 *  - providerEventId always comes from the verifier; (provider,
 *    providerEventId) is UNIQUE, so one ad completion can be granted once.
 *  - Season accounts can never be credited, and USD is never credited.
 *  - TradingAccount.initialCapitalKrw is never touched: an ad reward is
 *    EXTERNAL virtual funding, ledgered as txType=ad_reward, not a return.
 *  - Wallet credit + ledger row + claim state live in one transaction.
 *  - A verified event that hits a limit is recorded as a REJECTED claim and
 *    is never payable later; the transaction still COMMITS so the rejection
 *    is durable, and the 429 is raised outside it.
 */

/** Everything the integrity checks and the replay response need. */
const STORED_CLAIM_SELECT = {
  id: true,
  userId: true,
  tradingAccountId: true,
  status: true,
  rewardAmountKrw: true,
  grantedAt: true,
  rejectedAt: true,
  failureCode: true,
  failureReason: true,
  idempotencyKey: true,
  requestHash: true,
  responsePayloadJson: true,
  walletTransactionId: true,
  walletTransaction: {
    select: {
      id: true,
      tradingAccountId: true,
      seasonParticipantId: true,
      walletId: true,
      currencyCode: true,
      direction: true,
      txType: true,
      referenceType: true,
      referenceId: true,
      amount: true,
      balanceAfter: true,
      wallet: {
        select: {
          id: true,
          tradingAccountId: true,
          seasonParticipantId: true,
          currencyCode: true,
        },
      },
    },
  },
} satisfies Prisma.AdRewardClaimSelect;

const CLAIM_LIST_DEFAULT_LIMIT = 50;
const CLAIM_LIST_MAX_LIMIT = 100;

export type AdRewardClaimRequestBody = {
  provider?: unknown;
  proof?: unknown;
  verificationToken?: unknown;
  idempotencyKey?: unknown;
};

export type AdRewardClaimsQuery = {
  limit?: string;
  offset?: string;
};

type ClaimView = {
  id: string;
  provider: string;
  status: AdRewardClaimStatus;
  rewardAmountKrw: string;
  requestedAt: string;
  verifiedAt: string | null;
  grantedAt: string | null;
  rejectedAt: string | null;
  failureCode: string | null;
  failureReason: string | null;
};

/**
 * Result of the grant transaction. Limit rejections are returned as a
 * SENTINEL rather than thrown, so the rejected-claim row commits before the
 * 429 is raised outside the transaction.
 */
type GrantOutcome =
  | { kind: 'granted'; claimId: string; balanceAfter: string; grantedAt: Date }
  | {
      kind: 'replayed';
      claimId: string;
      balanceAfter: string | null;
      grantedAt: Date | null;
    }
  | { kind: 'rejected'; code: AdRewardLimitErrorCode; message: string };

@Injectable()
export class AdRewardService {
  private readonly logger = new Logger(AdRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: TradingAccountAccessService,
    @Inject(AD_REWARD_VERIFICATION_REGISTRY)
    private readonly registry: AdRewardVerificationRegistry,
    private readonly performanceService: GeneralAccountPerformanceService,
  ) {}

  // ---------------------------------------------------------------- reads

  /**
   * Advisory only: it performs NO grant and creates no claim, wallet, or
   * ledger row. The claim transaction re-checks every limit against locked
   * rows, so a race after this response can still be refused there.
   */
  async getEligibility(userId: string | undefined, accountId: string) {
    const account = await this.resolveGeneralAccount(userId, accountId);

    // Structure BEFORE configuration (작업 6 보완 4). The disabled / no-provider
    // / not-active answers used to short-circuit above this line, so an account
    // whose USD wallet or initial-grant ledger row had vanished reported a
    // perfectly normal `eligible: false, reason: AD_REWARD_DISABLED` — the
    // damage stayed invisible for exactly as long as the feature stayed off,
    // which is the whole current release. Whether ads are switched on has
    // nothing to do with whether the account's money is intact, so the
    // structural check runs first and fails closed with a structured 500. It
    // is read-only: no wallet, grant, or ledger row is ever created here.
    await assertGeneralAccountFinancialIntegrity(this.prisma, account);

    const config = this.readConfig();

    if (!config.enabled) {
      return this.eligibilityResponse({
        account,
        config,
        eligible: false,
        reason: adRewardErrorCodes.AD_REWARD_DISABLED,
      });
    }

    if (!this.registry.resolve(config.provider)) {
      return this.eligibilityResponse({
        account,
        config,
        eligible: false,
        reason: adRewardErrorCodes.AD_REWARD_PROVIDER_UNAVAILABLE,
      });
    }

    if (account.status !== TradingAccountStatus.active) {
      return this.eligibilityResponse({
        account,
        config,
        eligible: false,
        reason: adRewardErrorCodes.TRADING_ACCOUNT_NOT_ACTIVE,
      });
    }

    const now = new Date();
    const usage = await this.readDailyUsage(
      this.prisma,
      account.id,
      config,
      now,
    );
    const limit = this.evaluateLimits(usage, config, now);

    return this.eligibilityResponse({
      account,
      config,
      eligible: limit === null,
      reason: limit?.code ?? null,
      usage,
      nextEligibleAt: usage.nextEligibleAt,
    });
  }

  /**
   * Claim history for the owned general account. Readable for suspended and
   * closed accounts too — status gates grants, never reads. Provider secrets,
   * the verification fingerprint, the metadata, and the full providerEventId
   * are never exposed.
   */
  async listClaims(
    userId: string | undefined,
    accountId: string,
    query: AdRewardClaimsQuery = {},
  ) {
    const account = await this.resolveGeneralAccount(userId, accountId);
    const limit = this.parseLimit(query.limit);
    const offset = this.parseOffset(query.offset);

    const where = { tradingAccountId: account.id, userId: account.userId };
    const [total, claims] = await Promise.all([
      this.prisma.adRewardClaim.count({ where }),
      this.prisma.adRewardClaim.findMany({
        where,
        // Deterministic: createdAt desc, then id asc to break exact ties.
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
        select: CLAIM_VIEW_SELECT,
      }),
    ]);

    return {
      success: true as const,
      data: {
        tradingAccountId: account.id,
        claims: claims.map((claim) => this.toClaimView(claim)),
        pagination: buildPagination({
          limit,
          offset,
          total,
          returned: claims.length,
        }) satisfies Pagination,
      },
    };
  }

  // --------------------------------------------------------------- claim

  /**
   * Claim ordering is deliberate and load-bearing (작업 6 보완 1).
   *
   * Ownership is checked FIRST so a borrowed accountId can never reach
   * another user's claim. Then the COMMAND-idempotency lookup runs, BEFORE
   * account status, before AD_REWARD_ENABLED, before the provider registry,
   * and before the verifier: a payout that already committed owes its caller
   * the first result even if the account was suspended since, the feature was
   * switched off, or the provider adapter was removed. Re-running those gates
   * would fail a retry whose money has already moved — and a retry storm
   * happens exactly when one of them has started failing.
   *
   * Only when no keyed claim exists do the state gates and the external
   * verifier run.
   */
  async claim(
    userId: string | undefined,
    accountId: string,
    body: AdRewardClaimRequestBody = {},
  ) {
    const account = await this.resolveGeneralAccount(userId, accountId);
    const request = this.parseClaimRequest(body);
    const proofFingerprint = buildAdRewardProofFingerprint(request.proof);
    const requestHash = buildAdRewardClaimRequestHash({
      provider: request.provider,
      proofFingerprint,
    });

    const keyed = await this.findKeyedClaim(
      account.id,
      request.idempotencyKey,
      this.prisma,
    );
    if (keyed) {
      return this.replayKeyedClaim(account, keyed, requestHash);
    }

    // ---- from here on this is a NEW command ----
    this.assertAccountActive(account);

    const config = this.readConfig();
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
      // No real provider adapter is registered anywhere in production
      // wiring today, so this is the normal production answer. An
      // unverifiable ad completion is NEVER treated as complete.
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_PROVIDER_UNAVAILABLE,
        'No verification adapter is registered for this ad provider.',
      );
    }

    // The external call happens BEFORE the transaction: a provider round trip
    // must never hold DB locks. Everything that depends on DB state is
    // re-checked inside the transaction below.
    const verification = await verifier.verify({
      provider: request.provider,
      proof: request.proof,
      expectedUserId: account.userId,
      expectedTradingAccountId: account.id,
    });

    if (!verification.ok) {
      // Nothing is written: no claim row, no wallet change, no ledger row.
      this.logger.warn(
        JSON.stringify({
          event: 'ad_reward_verification_failed',
          tradingAccountId: account.id,
          provider: request.provider,
          reasonCode: verification.reasonCode,
        }),
      );
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_VERIFICATION_FAILED,
        'Ad completion could not be verified.',
      );
    }

    const outcome = await this.runGrantTransaction({
      account,
      config,
      verification,
      proofFingerprint,
      idempotencyKey: request.idempotencyKey,
      requestHash,
    });

    if (outcome.kind === 'rejected') {
      // The rejected claim row is already COMMITTED, so this verified event
      // can never be paid later.
      throwAdRewardError(outcome.code, outcome.message);
    }

    return this.buildClaimResponse(outcome);
  }

  private findKeyedClaim(
    tradingAccountId: string,
    idempotencyKey: string,
    client: Pick<Prisma.TransactionClient, 'adRewardClaim'> | PrismaService,
  ) {
    return client.adRewardClaim.findUnique({
      where: {
        tradingAccountId_idempotencyKey: { tradingAccountId, idempotencyKey },
      },
      select: STORED_CLAIM_SELECT,
    });
  }

  /**
   * Replays a claim found by (account, idempotencyKey) BEFORE any transaction
   * is opened. Nothing but the shared resolver runs: no verifier call, no
   * wallet change, no ledger row, no snapshot.
   */
  private async replayKeyedClaim(
    account: OwnedTradingAccount,
    claim: StoredClaimForIntegrity,
    requestHash: string,
  ) {
    const outcome = await this.resolveStoredClaimOutcome({
      claim,
      account,
      client: this.prisma,
      matchedBy: 'command_key',
      requestHash,
    });

    if (outcome.kind === 'rejected') {
      throwAdRewardError(outcome.code, outcome.message);
    }

    return this.buildClaimResponse(outcome);
  }

  /**
   * THE single replay validator every path funnels through (작업 6 보완 4).
   *
   * There used to be three of these, and they disagreed. The pre-transaction
   * command-key path ran the full ledger check; the in-transaction raced-key
   * path only asked "is walletTransaction non-null?"; the provider-event path
   * asked nothing at all and would happily answer
   * `{duplicate: true, walletBalanceAfter: null}`. Which validation a caller
   * got therefore depended on how its request happened to race — the one
   * dimension that must NOT change what "your reward was already paid" means.
   *
   * What is verified, identically, on every path:
   *   ownership (userId + tradingAccountId) → terminal status → keyed command
   *   state → for a refusal: no ledger link + a recognised limit code + the
   *   stored refusal payload → for a payout: the account's full financial
   *   structure, the ledger row (account, participant, wallet, currency,
   *   direction, txType, reference, amount, wallet scope), the keyed
   *   external-funding boundary pair, and the stored response payload.
   *
   * What it deliberately does NOT do: call the verifier, credit anything,
   * write a ledger row or snapshot, or repair a damaged claim. Damage is a
   * structured 500, never a `duplicate: true` success.
   *
   * `matchedBy` keeps the two idempotency axes separate. `command_key` is the
   * same COMMAND arriving twice, so its requestHash must match. `provider_event`
   * is the same AD EVENT arriving under a different key — a different command
   * by definition, so its hash is irrelevant there and comparing it would turn
   * a legitimate duplicate-event answer into a bogus conflict.
   */
  private async resolveStoredClaimOutcome(input: {
    claim: StoredClaimForIntegrity;
    account: OwnedTradingAccount;
    client: Prisma.TransactionClient | PrismaService;
    matchedBy: 'command_key' | 'provider_event';
    requestHash: string;
    /** Already-verified wallets, when the caller has them (payout tx). */
    wallets?: VerifiedGeneralAccountWallets;
  }): Promise<GrantOutcome> {
    const { claim, account } = input;

    if (
      claim.userId !== account.userId ||
      claim.tradingAccountId !== account.id
    ) {
      // For the provider-event axis this is another user's claim and the
      // answer must not reveal that it exists. For the command-key axis the
      // unique is per account, so it is corruption instead — same flat answer
      // either way.
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_EVENT_ALREADY_USED,
        'This ad completion event has already been used.',
      );
    }

    if (
      input.matchedBy === 'command_key' &&
      claim.requestHash !== input.requestHash
    ) {
      // The key already means a different request. Never re-verify or
      // re-grant under it.
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_IDEMPOTENCY_CONFLICT,
        'Same idempotencyKey was used with a different ad reward claim request.',
      );
    }

    assertReplayableClaimStatus(claim);
    assertKeyedClaimIntegrity(claim);

    if (claim.status === AdRewardClaimStatus.rejected) {
      assertRejectedClaimIntegrity(claim);
      assertStoredRejectedResponse(claim);

      return {
        kind: 'rejected',
        // assertRejectedClaimIntegrity has already proven this is one of the
        // three limit codes.
        code: claim.failureCode as AdRewardLimitErrorCode,
        message:
          claim.failureReason ??
          'This ad completion event was already refused and cannot be granted later.',
      };
    }

    const wallets =
      input.wallets ??
      (await this.performanceService.assertGeneralAccountReady(
        account,
        input.client,
      ));
    const ledger = assertGrantedClaimIntegrity(claim, wallets.krwWalletId);
    await assertKeyedGrantedClaimBoundaryIntegrity(input.client, claim);

    const balanceAfter = ledger.balanceAfter.toFixed(8);
    assertStoredGrantedResponse(claim, balanceAfter);

    return {
      kind: 'replayed',
      claimId: claim.id,
      balanceAfter,
      grantedAt: claim.grantedAt,
    };
  }

  private async runGrantTransaction(input: {
    account: OwnedTradingAccount;
    config: Extract<AdRewardConfig, { enabled: true }>;
    verification: AdRewardVerificationSuccess;
    proofFingerprint: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<GrantOutcome> {
    const { account, config, verification, proofFingerprint } = input;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize ad grants for THIS account only. Without the row lock,
        // two concurrent claims could both read "0 granted today" and both
        // pay out past the daily cap. No global or distributed lock is used.
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
        if (!locked) {
          throwAdRewardError(
            adRewardErrorCodes.TRADING_ACCOUNT_NOT_ACTIVE,
            'Trading account is no longer available.',
          );
        }
        if (locked.mode !== TradingAccountMode.general) {
          throwAdRewardError(
            adRewardErrorCodes.AD_REWARD_GENERAL_ACCOUNT_ONLY,
            'Ad rewards are only granted to general-mode accounts.',
          );
        }
        if (locked.status !== TradingAccountStatus.active) {
          throwAdRewardError(
            adRewardErrorCodes.TRADING_ACCOUNT_NOT_ACTIVE,
            'Trading account is not active.',
          );
        }

        // A concurrent request with the SAME command key may have won while
        // this one waited on the account lock. Re-checking here (not just
        // before the transaction) is what makes two simultaneous identical
        // commands pay exactly once.
        const racedKeyed = await this.findKeyedClaim(
          account.id,
          input.idempotencyKey,
          tx,
        );
        if (racedKeyed) {
          return this.resolveStoredClaimOutcome({
            claim: racedKeyed,
            account,
            client: tx,
            matchedBy: 'command_key',
            requestHash: input.requestHash,
          });
        }

        // Structural check of the account's wallets and initial grant. A
        // damaged account is reported (500 GENERAL_ACCOUNT_INTEGRITY), never
        // repaired and never auto-provisioned mid-claim.
        const verified = await assertGeneralAccountFinancialIntegrity(tx, {
          id: account.id,
          mode: account.mode,
          initialCapitalKrw: account.initialCapitalKrw,
          seasonParticipant: account.seasonParticipant,
        });

        const existing = await tx.adRewardClaim.findUnique({
          where: {
            provider_providerEventId: {
              provider: verification.provider,
              providerEventId: verification.providerEventId,
            },
          },
          select: STORED_CLAIM_SELECT,
        });

        if (existing) {
          return this.resolveStoredClaimOutcome({
            claim: existing,
            account,
            client: tx,
            matchedBy: 'provider_event',
            requestHash: input.requestHash,
            wallets: verified,
          });
        }

        const now = new Date();
        const usage = await this.readDailyUsage(tx, account.id, config, now);
        const limitViolation = this.evaluateLimits(usage, config, now);

        if (limitViolation) {
          // Record the verified-but-refused event so the SAME
          // providerEventId can never be granted later, and let the
          // transaction COMMIT so that record survives.
          await tx.adRewardClaim.create({
            data: {
              userId: account.userId,
              tradingAccountId: account.id,
              provider: verification.provider,
              providerEventId: verification.providerEventId,
              status: AdRewardClaimStatus.rejected,
              rewardAmountKrw: config.rewardAmountKrw,
              verificationFingerprint: proofFingerprint,
              verificationMetadataJson: this.buildMetadataJson(verification),
              requestedAt: now,
              verifiedAt: now,
              rejectedAt: now,
              failureCode: limitViolation.code,
              failureReason: limitViolation.message,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
              responsePayloadJson: {
                refused: true,
                code: limitViolation.code,
                message: limitViolation.message,
              } as Prisma.InputJsonValue,
              // No walletTransactionId: nothing was paid.
            },
            select: { id: true },
          });

          return {
            kind: 'rejected',
            code: limitViolation.code,
            message: limitViolation.message,
          };
        }

        const claim = await tx.adRewardClaim.create({
          data: {
            userId: account.userId,
            tradingAccountId: account.id,
            provider: verification.provider,
            providerEventId: verification.providerEventId,
            status: AdRewardClaimStatus.verified,
            rewardAmountKrw: config.rewardAmountKrw,
            verificationFingerprint: proofFingerprint,
            verificationMetadataJson: this.buildMetadataJson(verification),
            requestedAt: now,
            verifiedAt: now,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          },
          select: { id: true },
        });

        // ---- external-funding boundary, BEFORE the money lands (작업 7) ----
        // Captures every bit of market performance up to this instant so the
        // inflow itself changes neither the TWR factor nor investment PnL.
        const boundary =
          await this.performanceService.buildExternalFundingSnapshots({
            account,
            wallets: verified,
            externalFundingAmountKrw: config.rewardAmountKrw,
            referenceType: WalletTransactionReferenceType.ad_reward_claim,
            referenceId: claim.id,
            capturedAt: now,
            client: tx,
          });
        await tx.equitySnapshot.create({
          data: boundary.before,
          select: { id: true },
        });

        // Credit the KRW wallet only, with the general-account scope pinned
        // in the WHERE: a season-linked or foreign-account wallet matches 0
        // rows. reservedAmount is untouched.
        const credited = await tx.cashWallet.updateMany({
          where: {
            id: verified.krwWalletId,
            tradingAccountId: account.id,
            seasonParticipantId: null,
            currencyCode: CurrencyCode.KRW,
          },
          data: {
            balanceAmount: { increment: config.rewardAmountKrw },
          },
        });
        if (credited.count !== 1) {
          throw new HttpException(
            {
              success: false,
              error: {
                code: 'GENERAL_ACCOUNT_INTEGRITY',
                message:
                  'General account KRW wallet could not be credited under its own account scope.',
              },
            },
            500,
          );
        }

        const walletAfter = await tx.cashWallet.findUniqueOrThrow({
          where: { id: verified.krwWalletId },
          select: { balanceAmount: true },
        });

        const ledger = await tx.walletTransaction.create({
          data: {
            seasonParticipantId: null,
            tradingAccountId: account.id,
            walletId: verified.krwWalletId,
            currencyCode: CurrencyCode.KRW,
            direction: WalletTransactionDirection.credit,
            // ad_reward marks EXTERNAL virtual funding, so later return/PnL
            // work can exclude it from trading performance.
            txType: WalletTransactionType.ad_reward,
            referenceType: WalletTransactionReferenceType.ad_reward_claim,
            referenceId: claim.id,
            amount: config.rewardAmountKrw,
            balanceAfter: walletAfter.balanceAmount,
            occurredAt: now,
          },
          select: { id: true },
        });

        // ---- external-funding boundary, AFTER the money landed ----
        // Same investment PnL, same factor, same return rate as `before`;
        // only totalAsset and cumulative external funding move.
        await tx.equitySnapshot.create({
          data: boundary.after,
          select: { id: true },
        });

        const responsePayloadJson = this.buildClaimResponse({
          kind: 'granted',
          claimId: claim.id,
          balanceAfter: walletAfter.balanceAmount.toFixed(8),
          grantedAt: now,
        });

        await tx.adRewardClaim.update({
          where: { id: claim.id },
          data: {
            status: AdRewardClaimStatus.granted,
            grantedAt: now,
            walletTransactionId: ledger.id,
            // Stored INSIDE the payout transaction: a committed grant always
            // has the exact response its retries will be answered with, and a
            // failure here rolls the credit, ledger, claim, and both boundary
            // snapshots back together.
            responsePayloadJson:
              responsePayloadJson as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        // Ledger and boundary must agree BEFORE this commits (작업 7 보완 2
        // 항목 7). It runs LAST on purpose: the external-funding summary only
        // counts an ad_reward row once its claim is `granted` and points back
        // at it, which is exactly what the update above just established. If
        // the two disagree, the credit, the ledger row, the claim, and both
        // boundary rows roll back together rather than leaving the account one
        // inflow ahead of its performance state.
        await this.performanceService.assertExternalFundingSettled({
          accountId: account.id,
          krwWalletId: verified.krwWalletId,
          expectedCumulativeKrw:
            boundary.afterState.cumulativeExternalFundingKrw,
          client: tx,
        });

        return {
          kind: 'granted',
          claimId: claim.id,
          balanceAfter: walletAfter.balanceAmount.toFixed(8),
          grantedAt: now,
        };
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      // A concurrent request for the SAME provider event won the unique
      // index. Re-read it and answer exactly as the winner did instead of
      // surfacing a raw 500 — one claim, one ledger row, one credit.
      // Two different uniques can raise here and they mean different things:
      // (tradingAccountId, idempotencyKey) is a raced COMMAND retry, while
      // (provider, providerEventId) is the same AD EVENT arriving under a
      // different key. Each is re-read on its own axis rather than collapsed
      // into one generic P2002 replay.
      const racedKeyed = await this.findKeyedClaim(
        account.id,
        input.idempotencyKey,
        this.prisma,
      );
      if (racedKeyed) {
        return this.resolveStoredClaimOutcome({
          claim: racedKeyed,
          account,
          client: this.prisma,
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
        select: STORED_CLAIM_SELECT,
      });
      if (!raced) {
        throw error;
      }
      return this.resolveStoredClaimOutcome({
        claim: raced,
        account,
        client: this.prisma,
        matchedBy: 'provider_event',
        requestHash: input.requestHash,
      });
    }
  }

  // ------------------------------------------------------------- limits

  private async readDailyUsage(
    client: Pick<Prisma.TransactionClient, 'adRewardClaim'>,
    tradingAccountId: string,
    config: Extract<AdRewardConfig, { enabled: true }>,
    now: Date,
  ) {
    const dayStart = resolveAdRewardDayStart(now, config.dayTimeZone);

    // Only GRANTED claims count toward the caps; rejected/failed ones never
    // consume a user's daily allowance.
    const [aggregate, lastGranted] = await Promise.all([
      client.adRewardClaim.aggregate({
        where: {
          tradingAccountId,
          status: AdRewardClaimStatus.granted,
          grantedAt: { gte: dayStart },
        },
        _count: { _all: true },
        _sum: { rewardAmountKrw: true },
      }),
      client.adRewardClaim.findFirst({
        where: {
          tradingAccountId,
          status: AdRewardClaimStatus.granted,
          grantedAt: { not: null },
        },
        orderBy: { grantedAt: 'desc' },
        select: { grantedAt: true },
      }),
    ]);

    const grantedCountToday = aggregate._count._all;
    const grantedAmountToday =
      aggregate._sum.rewardAmountKrw ?? new Prisma.Decimal(0);
    const lastGrantedAt = lastGranted?.grantedAt ?? null;
    const nextEligibleAt =
      lastGrantedAt && config.cooldownSeconds > 0
        ? new Date(lastGrantedAt.getTime() + config.cooldownSeconds * 1000)
        : null;

    return {
      dayStart,
      grantedCountToday,
      grantedAmountToday,
      lastGrantedAt,
      nextEligibleAt,
    };
  }

  private evaluateLimits(
    usage: {
      grantedCountToday: number;
      grantedAmountToday: Prisma.Decimal;
      nextEligibleAt: Date | null;
    },
    config: Extract<AdRewardConfig, { enabled: true }>,
    now: Date,
  ): { code: AdRewardLimitErrorCode; message: string } | null {
    if (usage.grantedCountToday >= config.dailyMaxCount) {
      return {
        code: adRewardErrorCodes.AD_REWARD_DAILY_COUNT_LIMIT,
        message: 'Daily ad reward count limit reached.',
      };
    }

    const projected = usage.grantedAmountToday.add(
      new Prisma.Decimal(config.rewardAmountKrw),
    );
    if (projected.gt(new Prisma.Decimal(config.dailyMaxAmountKrw))) {
      return {
        code: adRewardErrorCodes.AD_REWARD_DAILY_AMOUNT_LIMIT,
        message: 'Daily ad reward amount limit reached.',
      };
    }

    if (
      usage.nextEligibleAt &&
      usage.nextEligibleAt.getTime() > now.getTime()
    ) {
      return {
        code: adRewardErrorCodes.AD_REWARD_COOLDOWN_ACTIVE,
        message: 'Ad reward cooldown has not elapsed yet.',
      };
    }

    return null;
  }

  // ------------------------------------------------------------ helpers

  private async resolveGeneralAccount(
    userId: string | undefined,
    accountId: string,
  ): Promise<OwnedTradingAccount> {
    if (!userId) {
      throw new HttpException(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
        },
        401,
      );
    }

    // Unknown and foreign accountIds are the SAME 404 here.
    const account = await this.accessService.getOwnedAccountOrThrow(
      userId,
      typeof accountId === 'string' ? accountId.trim() : accountId,
    );

    if (
      account.mode !== TradingAccountMode.general ||
      account.seasonParticipant
    ) {
      // Season accounts never receive ad rewards, and their claim history is
      // not a thing that exists — same conflict for every ad endpoint.
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_GENERAL_ACCOUNT_ONLY,
        'Ad rewards are only available for general-mode accounts.',
      );
    }

    return account;
  }

  private assertAccountActive(account: OwnedTradingAccount) {
    if (account.status !== TradingAccountStatus.active) {
      throwAdRewardError(
        adRewardErrorCodes.TRADING_ACCOUNT_NOT_ACTIVE,
        'Trading account is not active.',
      );
    }
  }

  private readConfig(): AdRewardConfig {
    return readAdRewardConfig();
  }

  /**
   * The request may carry ONLY a provider key and an opaque proof. There is
   * deliberately no reward amount, event id, user id, account id, or granted
   * timestamp field — a client cannot influence what it is paid.
   */
  /**
   * The request may carry ONLY a provider key, an opaque proof, and a client
   * idempotency key. There is deliberately no reward amount, provider event
   * id, user id, account id, granted timestamp, request hash, or response
   * payload field — a client cannot influence what it is paid.
   *
   * `provider` is REQUIRED (작업 6 보완 1): a replay must not depend on what
   * AD_REWARD_PROVIDER happens to say at retry time. No real provider exists
   * yet, so there is no frontend compatibility reason to keep a fallback.
   */
  private parseClaimRequest(body: AdRewardClaimRequestBody): {
    provider: string;
    proof: string;
    idempotencyKey: string;
  } {
    const provider = this.parseText(body.provider);
    if (!provider) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'provider is required.',
      );
    }
    if (provider.length > 64) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'provider is too long.',
      );
    }

    const proof =
      this.parseText(body.proof) ?? this.parseText(body.verificationToken);
    if (!proof) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'proof (or verificationToken) is required.',
      );
    }
    if (proof.length > 4096) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'proof is too long.',
      );
    }

    const idempotencyKey = this.parseText(body.idempotencyKey);
    if (!idempotencyKey) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'idempotencyKey is required.',
      );
    }
    if (idempotencyKey.length > 255) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'idempotencyKey is too long.',
      );
    }
    // Control characters would make the key unloggable and unsafe to echo.
    // Matching control characters IS the check here; the rule exists to catch
    // them being typed into a pattern by accident.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/u.test(idempotencyKey)) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'idempotencyKey must not contain control characters.',
      );
    }

    return { provider, proof, idempotencyKey };
  }

  private parseText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  /**
   * Only the non-sensitive fields the adapter explicitly returned are
   * persisted, plus the provider-reported completion time. The proof itself
   * is never stored — only its one-way fingerprint.
   */
  private buildMetadataJson(
    verification: AdRewardVerificationSuccess,
  ): Prisma.InputJsonValue {
    return {
      occurredAt: verification.occurredAt.toISOString(),
      ...(verification.metadata ?? {}),
    } as Prisma.InputJsonValue;
  }

  private buildClaimResponse(
    outcome: Extract<GrantOutcome, { kind: 'granted' | 'replayed' }>,
  ) {
    return {
      success: true as const,
      data: {
        /** false when this call replayed an already-granted claim. */
        granted: outcome.kind === 'granted',
        duplicate: outcome.kind === 'replayed',
        claimId: outcome.claimId,
        grantedAt: outcome.grantedAt?.toISOString() ?? null,
        /** KRW wallet balance recorded on the claim's ledger row. */
        walletBalanceAfter: outcome.balanceAfter,
      },
    };
  }

  private eligibilityResponse(input: {
    account: OwnedTradingAccount;
    config: AdRewardConfig;
    eligible: boolean;
    reason: string | null;
    usage?: {
      grantedCountToday: number;
      grantedAmountToday: Prisma.Decimal;
      nextEligibleAt: Date | null;
    };
    nextEligibleAt?: Date | null;
  }) {
    const { config } = input;
    const enabled = config.enabled;

    return {
      success: true as const,
      data: {
        tradingAccountId: input.account.id,
        enabled,
        // The provider KEY only; no endpoint, credential, or secret.
        provider: enabled ? config.provider : null,
        eligible: input.eligible,
        rewardAmountKrw: enabled ? config.rewardAmountKrw : null,
        grantedCountToday: input.usage?.grantedCountToday ?? 0,
        grantedAmountTodayKrw:
          input.usage?.grantedAmountToday.toFixed(8) ?? '0.00000000',
        remainingCountToday: enabled
          ? Math.max(
              0,
              config.dailyMaxCount - (input.usage?.grantedCountToday ?? 0),
            )
          : 0,
        remainingAmountTodayKrw: enabled
          ? Prisma.Decimal.max(
              new Prisma.Decimal(0),
              new Prisma.Decimal(config.dailyMaxAmountKrw).sub(
                input.usage?.grantedAmountToday ?? new Prisma.Decimal(0),
              ),
            ).toFixed(8)
          : '0.00000000',
        nextEligibleAt: input.nextEligibleAt?.toISOString() ?? null,
        reason: input.reason,
      },
    };
  }

  private toClaimView(claim: {
    id: string;
    provider: string;
    status: AdRewardClaimStatus;
    rewardAmountKrw: Prisma.Decimal;
    requestedAt: Date;
    verifiedAt: Date | null;
    grantedAt: Date | null;
    rejectedAt: Date | null;
    failureCode: string | null;
    failureReason: string | null;
  }): ClaimView {
    // providerEventId, verificationFingerprint, and verificationMetadataJson
    // are deliberately absent from this projection.
    return {
      id: claim.id,
      provider: claim.provider,
      status: claim.status,
      rewardAmountKrw: claim.rewardAmountKrw.toFixed(8),
      requestedAt: claim.requestedAt.toISOString(),
      verifiedAt: claim.verifiedAt?.toISOString() ?? null,
      grantedAt: claim.grantedAt?.toISOString() ?? null,
      rejectedAt: claim.rejectedAt?.toISOString() ?? null,
      failureCode: claim.failureCode,
      failureReason: claim.failureReason,
    };
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) return CLAIM_LIST_DEFAULT_LIMIT;
    const parsed = this.parseNonNegativeInteger(value, 'limit');
    if (parsed < 1) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        'limit must be greater than 0.',
      );
    }
    return Math.min(parsed, CLAIM_LIST_MAX_LIMIT);
  }

  private parseOffset(value: string | undefined): number {
    if (value === undefined) return 0;
    return this.parseNonNegativeInteger(value, 'offset');
  }

  private parseNonNegativeInteger(value: string, field: string): number {
    if (!/^\d+$/u.test(value.trim())) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        `${field} must be a non-negative integer.`,
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
        `${field} must be a safe integer.`,
      );
    }
    return parsed;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}

const CLAIM_VIEW_SELECT = {
  id: true,
  provider: true,
  status: true,
  rewardAmountKrw: true,
  requestedAt: true,
  verifiedAt: true,
  grantedAt: true,
  rejectedAt: true,
  failureCode: true,
  failureReason: true,
} satisfies Prisma.AdRewardClaimSelect;
