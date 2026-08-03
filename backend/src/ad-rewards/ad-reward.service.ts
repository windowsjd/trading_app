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
import { assertGeneralAccountIntegrity } from '../trading-accounts/general-account-integrity';
import {
  TradingAccountAccessService,
  type OwnedTradingAccount,
} from '../trading-accounts/trading-account-access.service';
import {
  adRewardErrorCodes,
  isAdRewardLimitErrorCode,
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
  buildAdRewardProofFingerprint,
  type AdRewardVerificationSuccess,
} from './ad-reward-verifier';

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

const CLAIM_LIST_DEFAULT_LIMIT = 50;
const CLAIM_LIST_MAX_LIMIT = 100;

export type AdRewardClaimRequestBody = {
  provider?: unknown;
  proof?: unknown;
  verificationToken?: unknown;
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
  ) {}

  // ---------------------------------------------------------------- reads

  /**
   * Advisory only: it performs NO grant and creates no claim, wallet, or
   * ledger row. The claim transaction re-checks every limit against locked
   * rows, so a race after this response can still be refused there.
   */
  async getEligibility(userId: string | undefined, accountId: string) {
    const account = await this.resolveGeneralAccount(userId, accountId);
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

  async claim(
    userId: string | undefined,
    accountId: string,
    body: AdRewardClaimRequestBody = {},
  ) {
    const account = await this.resolveGeneralAccount(userId, accountId);
    this.assertAccountActive(account);

    const config = this.readConfig();
    if (!config.enabled) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_DISABLED,
        'Ad rewards are disabled.',
      );
    }

    const request = this.parseClaimRequest(body, config);
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

    const proofFingerprint = buildAdRewardProofFingerprint(request.proof);
    const outcome = await this.runGrantTransaction({
      account,
      config,
      verification,
      proofFingerprint,
    });

    if (outcome.kind === 'rejected') {
      // The rejected claim row is already COMMITTED, so this verified event
      // can never be paid later.
      throwAdRewardError(outcome.code, outcome.message);
    }

    return this.buildClaimResponse(outcome);
  }

  private async runGrantTransaction(input: {
    account: OwnedTradingAccount;
    config: Extract<AdRewardConfig, { enabled: true }>;
    verification: AdRewardVerificationSuccess;
    proofFingerprint: string;
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

        // Structural check of the account's wallets and initial grant. A
        // damaged account is reported (500 GENERAL_ACCOUNT_INTEGRITY), never
        // repaired and never auto-provisioned mid-claim.
        const verified = await assertGeneralAccountIntegrity(tx, {
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
          select: {
            id: true,
            userId: true,
            tradingAccountId: true,
            status: true,
            grantedAt: true,
            failureCode: true,
            failureReason: true,
            walletTransaction: { select: { balanceAfter: true } },
          },
        });

        if (existing) {
          return this.resolveExistingClaimOutcome(existing, account);
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
          },
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

        await tx.adRewardClaim.update({
          where: { id: claim.id },
          data: {
            status: AdRewardClaimStatus.granted,
            grantedAt: now,
            walletTransactionId: ledger.id,
          },
          select: { id: true },
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
      const raced = await this.prisma.adRewardClaim.findUnique({
        where: {
          provider_providerEventId: {
            provider: verification.provider,
            providerEventId: verification.providerEventId,
          },
        },
        select: {
          id: true,
          userId: true,
          tradingAccountId: true,
          status: true,
          grantedAt: true,
          failureCode: true,
          failureReason: true,
          walletTransaction: { select: { balanceAfter: true } },
        },
      });
      if (!raced) {
        throw error;
      }
      return this.resolveExistingClaimOutcome(raced, account);
    }
  }

  /**
   * What a previously-recorded claim for the same provider event means for
   * THIS request. Another user's or account's claim is a flat 409 with no
   * detail — the existence of someone else's claim is not disclosed.
   */
  private resolveExistingClaimOutcome(
    existing: {
      id: string;
      userId: string;
      tradingAccountId: string;
      status: AdRewardClaimStatus;
      grantedAt: Date | null;
      failureCode: string | null;
      failureReason: string | null;
      walletTransaction: { balanceAfter: Prisma.Decimal } | null;
    },
    account: OwnedTradingAccount,
  ): GrantOutcome {
    if (
      existing.userId !== account.userId ||
      existing.tradingAccountId !== account.id
    ) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_EVENT_ALREADY_USED,
        'This ad completion event has already been used.',
      );
    }

    if (existing.status === AdRewardClaimStatus.granted) {
      // Idempotent replay: no second credit, no second ledger row.
      return {
        kind: 'replayed',
        claimId: existing.id,
        balanceAfter:
          existing.walletTransaction?.balanceAfter.toFixed(8) ?? null,
        grantedAt: existing.grantedAt,
      };
    }

    if (
      existing.status === AdRewardClaimStatus.rejected &&
      isAdRewardLimitErrorCode(existing.failureCode)
    ) {
      // A rejected event stays rejected forever: replay the original refusal
      // rather than paying it out once the limit window moves on.
      return {
        kind: 'rejected',
        code: existing.failureCode,
        message:
          existing.failureReason ??
          'This ad completion event was already refused and cannot be granted later.',
      };
    }

    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_EVENT_ALREADY_USED,
      'This ad completion event has already been used.',
    );
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
  private parseClaimRequest(
    body: AdRewardClaimRequestBody,
    config: Extract<AdRewardConfig, { enabled: true }>,
  ): { provider: string; proof: string } {
    const provider = this.parseText(body.provider) ?? config.provider;
    if (provider !== config.provider) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_PROVIDER_UNAVAILABLE,
        'Requested ad provider is not the configured provider.',
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

    return { provider, proof };
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
