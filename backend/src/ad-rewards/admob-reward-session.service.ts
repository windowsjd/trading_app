import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AdRewardPurpose,
  AdRewardRedemptionStatus,
  Prisma,
  TradingAccountStatus,
  type AdRewardSession,
} from '../generated/prisma/client';
import {
  classifyFailureCause,
  type SafeFailureCause,
} from '../common/safe-failure-cause';
import { PrismaService } from '../prisma/prisma.service';
import { AdRewardService } from './ad-reward.service';
import { GeneralAccountResetService } from './general-account-reset.service';
import { parseAdRewardCommand } from './ad-reward-command';
import {
  adRewardErrorCodes,
  throwAdRewardError,
} from './ad-reward-error-policy';
import { readAdRewardConfig } from './ad-reward.config';
import {
  AD_REWARD_VERIFICATION_REGISTRY,
  AdRewardVerificationRegistry,
} from './ad-reward-verifier';
import {
  ADMOB_PROVIDER,
  ADMOB_REDEMPTION_BATCH_SIZE,
  ADMOB_REDEMPTION_FIRST_ATTEMPT_DELAY_MS,
  ADMOB_REDEMPTION_WINDOW_MS,
  ADMOB_SESSION_TTL_MS,
  adMobAdUnitMatches,
  adMobRedemptionRetryDelayMs,
  isAdMobPlatform,
  readAdMobConfig,
} from './admob.config';
import {
  adMobRewardTime,
  adMobSsvUserId,
  parseAdMobSsvQuery,
  verifyAdMobSsvSignature,
} from './admob-ssv';
import { AdMobSsvKeyStore } from './admob-ssv-keys';

/**
 * Unconfirmed, unexpired sessions an account may hold (ads closed early or
 * never filled leave one for 30 min). A bound on scripted session creation,
 * not a cooldown: a person never abandons 100 ads within 30 minutes. Counted
 * before the insert, so concurrent opens may pass it by a few — no money
 * moves on a session.
 */
export const ADMOB_MAX_OPEN_SESSIONS = 100;

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type AdRewardSessionBody = {
  purpose?: unknown;
  platform?: unknown;
  idempotencyKey?: unknown;
};

/** The answer Google gets: only 200 stops its retries (up to five, 1 s apart). */
export type AdMobSsvOutcome = {
  status: 200 | 400 | 403 | 503;
  outcome: string;
};

/** What one run of a session's command means for the server's own redemption. */
type RedemptionResult =
  | { kind: 'redeemed' }
  /** A product rule refused it (4xx): final for every automatic path. */
  | { kind: 'refused'; code: string }
  /** A server failure (5xx, database, anything unexpected): retried. */
  | { kind: 'failed'; code: string; safeCause?: SafeFailureCause };

/** One recovery pass, as counts only (the Ops run result). */
export type AdMobRedemptionSweep = {
  due: number;
  redeemed: number;
  refused: number;
  retrying: number;
  exhausted: number;
  skipped: number;
};

type RecoveryOutcome = Exclude<keyof AdMobRedemptionSweep, 'due'>;

const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * AdMob rewarded ads with server-side verification (2026-11-07).
 *
 * 1. BEFORE the ad, the app opens a session (광고 시청 시도) for one command:
 *    the member, the general account, the purpose (top-up or reset) and the
 *    command's idempotency key are fixed here, after the same gates the
 *    command will meet (a blocked reset or a reached cap never shows an ad).
 *    The app sets the session id as the SSV custom data and the derived
 *    user id (adMobSsvUserId) on the rewarded ad.
 * 2. Google calls the SSV URL (GET, public). The signature is verified with
 *    Google's keys, the ad unit must be the session platform's rewarded unit,
 *    the user id must be the session's, and the session must not have
 *    expired; the reward event (transaction_id, unique) is then recorded on
 *    the session ONCE. A callback is never trusted for anything else.
 * 3. The session is redeemed through the EXISTING claim/reset command — the
 *    same key, proof = session id — whose AdMob verifier reads that record.
 *    The callback redeems on arrival (an app that closed still gets its
 *    reward); the app's own call with the same key replays or, if it comes
 *    first, gets AD_REWARD_VERIFICATION_PENDING and asks again. Every
 *    ordering ends in one claim: the command key and (provider, event) are
 *    unique, and the payout/reset transactions are unchanged.
 * 4. Server recovery (2026-11-08). Recording the event also marks the session
 *    `pending`. A command that fails for a SERVER reason leaves it pending,
 *    and AdMobRedemptionWorker runs the same command again (backoff, 24 h
 *    window) — no app, no Google retry needed. A product-rule refusal settles
 *    it `refused`: no automatic path (worker or re-sent callback) runs it
 *    again; the member's own command still can, as before. The session's
 *    status is bookkeeping only; the claim row is what was paid or reset.
 *
 * The client's EARNED_REWARD event is never evidence of anything.
 */
@Injectable()
export class AdMobRewardSessionService {
  private readonly logger = new Logger(AdMobRewardSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ads: AdRewardService,
    private readonly resets: GeneralAccountResetService,
    @Inject(AD_REWARD_VERIFICATION_REGISTRY)
    private readonly registry: AdRewardVerificationRegistry,
    private readonly keys: AdMobSsvKeyStore,
  ) {}

  // ------------------------------------------------------------- session

  async createSession(
    userId: string | undefined,
    accountId: string,
    body: AdRewardSessionBody = {},
  ) {
    const account = await this.ads.resolveGeneralAccount(userId, accountId);
    const input = parseSessionBody(body);
    const replay = await this.findSession(account.id, input.idempotencyKey);
    if (replay) return this.replaySession(replay, account.userId, input);

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
    if (
      config.provider !== ADMOB_PROVIDER ||
      !this.registry.resolve(ADMOB_PROVIDER) ||
      !readAdMobConfig().rewardedAdUnits[input.platform]
    ) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_PROVIDER_UNAVAILABLE,
        'AdMob rewarded ads are not available for this platform.',
      );
    }
    // The key already names a committed command: never a second ad for it.
    const committed = await this.prisma.adRewardClaim.findUnique({
      where: {
        tradingAccountId_idempotencyKey: {
          tradingAccountId: account.id,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (committed) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_IDEMPOTENCY_CONFLICT,
        'This idempotencyKey already names a committed ad reward command.',
      );
    }
    // The command's own gates now, so no ad is shown for nothing.
    if (input.purpose === AdRewardPurpose.funding)
      await this.ads.assertFundingAvailable(account);
    else await this.resets.assertResettable(account);

    const now = new Date();
    const open = await this.prisma.adRewardSession.count({
      where: {
        tradingAccountId: account.id,
        ssvTransactionId: null,
        expiresAt: { gt: now },
      },
    });
    if (open >= ADMOB_MAX_OPEN_SESSIONS) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_SESSION_LIMIT,
        'Too many ads are still waiting for their confirmation.',
      );
    }
    try {
      const session = await this.prisma.adRewardSession.create({
        data: {
          userId: account.userId,
          tradingAccountId: account.id,
          provider: ADMOB_PROVIDER,
          purpose: input.purpose,
          platform: input.platform,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ADMOB_SESSION_TTL_MS),
        },
      });
      return this.sessionResponse(session, true);
    } catch (caught) {
      if (!isUniqueViolation(caught)) throw caught;
      // A concurrent open with the same key won: answer as it did.
      const raced = await this.findSession(account.id, input.idempotencyKey);
      if (!raced) throw caught;
      return this.replaySession(raced, account.userId, input);
    }
  }

  // --------------------------------------------------------- SSV callback

  async handleSsvCallback(rawQuery: string): Promise<AdMobSsvOutcome> {
    const parsed = parseAdMobSsvQuery(rawQuery);
    if (!parsed.ok) return this.answer(400, parsed.reason);
    const callback = parsed.callback;
    const event = {
      transactionId: callback.params.transactionId,
      keyId: callback.keyId,
    };

    const production = await this.keys.key('production', callback.keyId);
    if (production === 'unavailable')
      return this.answer(503, 'KEYS_UNAVAILABLE', event);
    if (!production || !verifyAdMobSsvSignature(callback, production)) {
      // Google's testing tool (AdMob console "Verify URL"): acknowledged so
      // the URL can be saved, never applied.
      const test = await this.keys.key('test', callback.keyId);
      if (
        test &&
        test !== 'unavailable' &&
        verifyAdMobSsvSignature(callback, test)
      )
        return this.answer(200, 'TEST_KEY_ACKNOWLEDGED', event);
      return this.answer(403, 'SIGNATURE_INVALID', event);
    }

    // Signed by Google. A callback that cannot apply is answered 200: a
    // retry cannot change it, and nothing is written for it.
    const sessionId = callback.params.customData;
    if (!sessionId || !SESSION_ID.test(sessionId))
      return this.answer(200, 'NO_SESSION', event);
    const session = await this.prisma.adRewardSession.findUnique({
      where: { id: sessionId },
    });
    const logged = { ...event, sessionId };
    if (!session || session.provider !== ADMOB_PROVIDER)
      return this.answer(200, 'SESSION_NOT_FOUND', logged);
    const unit = isAdMobPlatform(session.platform)
      ? readAdMobConfig().rewardedAdUnits[session.platform]
      : null;
    if (!unit || !adMobAdUnitMatches(callback.params.adUnit, unit))
      return this.answer(200, 'AD_UNIT_MISMATCH', logged);
    if (callback.params.userId !== adMobSsvUserId(session))
      return this.answer(200, 'USER_MISMATCH', logged);

    let current = session;
    if (!current.ssvTransactionId) {
      const at = new Date();
      if (at.getTime() > current.expiresAt.getTime())
        return this.answer(200, 'SESSION_EXPIRED', logged);
      try {
        await this.prisma.adRewardSession.updateMany({
          where: { id: current.id, ssvTransactionId: null },
          data: {
            ssvTransactionId: callback.params.transactionId,
            ssvVerifiedAt: at,
            ssvRewardedAt: adMobRewardTime(callback.params.timestamp),
            ssvAdUnit: callback.params.adUnit,
            ssvKeyId: callback.keyId,
            ssvRewardItem: callback.params.rewardItem,
            ssvRewardAmount: callback.params.rewardAmount,
            // Recorded = the server's to redeem, in the same write: should
            // the command below fail for a server reason, the recovery
            // worker runs it again once Google's retries are over.
            redemptionStatus: AdRewardRedemptionStatus.pending,
            redemptionNextAttemptAt: new Date(
              at.getTime() + ADMOB_REDEMPTION_FIRST_ATTEMPT_DELAY_MS,
            ),
          },
        });
      } catch (caught) {
        if (!isUniqueViolation(caught)) throw caught;
        // The event is already another session's: it never pays twice.
        return this.answer(200, 'TRANSACTION_ALREADY_USED', logged);
      }
      current = await this.prisma.adRewardSession.findUniqueOrThrow({
        where: { id: current.id },
      });
    }
    // Retried or re-sent callbacks of the same event redeem (idempotently);
    // a different event for an already confirmed session never does.
    if (current.ssvTransactionId !== callback.params.transactionId)
      return this.answer(200, 'SESSION_ALREADY_CONFIRMED', logged);
    // Settled as refused, or retried until its window ended: no automatic
    // path — a re-sent callback included — runs that command again.
    if (current.redemptionStatus === AdRewardRedemptionStatus.refused)
      return this.answer(200, 'REDEMPTION_REFUSED', {
        ...logged,
        code: current.redemptionErrorCode ?? '',
      });
    if (current.redemptionStatus === AdRewardRedemptionStatus.exhausted)
      return this.answer(200, 'REDEMPTION_EXHAUSTED', logged);
    return this.redeemFromCallback(current, logged);
  }

  /**
   * The same command the app sends. A refusal (cap, blocked reset, inactive
   * account, …) is final for this event and is what the app will read; a
   * server failure is answered 503 so Google retries, and the session stays
   * pending for the recovery worker — the recorded event and the command key
   * make every retry safe.
   */
  private async redeemFromCallback(
    session: AdRewardSession,
    logged: Record<string, string>,
  ): Promise<AdMobSsvOutcome> {
    const result = await this.runCommand(session);
    if (result.kind === 'redeemed') {
      // The command committed: 200 even if the bookkeeping write fails (the
      // worker's replay of the committed command settles the session).
      await this.settle(session, result);
      return this.answer(200, 'REDEEMED', logged, 'log');
    }
    if (result.kind === 'refused') {
      // Final only once settled: otherwise Google retries, and the retry —
      // the same refusal — settles it.
      const settled = await this.settle(session, result);
      return this.answer(settled ? 200 : 503, result.code, logged);
    }
    await this.settle(session, result);
    return this.answer(503, result.code, logged);
  }

  // ------------------------------------------------------ server recovery

  /** One indexed read: is any pending session due? Idle ticks stop here. */
  async hasDueRedemption(now: Date = new Date()): Promise<boolean> {
    const due = await this.prisma.adRewardSession.findFirst({
      where: {
        redemptionStatus: AdRewardRedemptionStatus.pending,
        redemptionNextAttemptAt: { lte: now },
      },
      select: { id: true },
    });
    return due !== null;
  }

  /**
   * One recovery pass (AdMobRedemptionWorker): the oldest due pending
   * sessions, each through its own command, the one the app and the callback
   * send. Every attempt is reserved first — attempt count and next attempt
   * time, conditional on the count read — so two passes, or a pass and a
   * callback, never run the same attempt, and a crash mid-command waits out
   * the backoff instead of looping. The command itself is what makes any
   * overlap with the callback or the app pay or reset at most once.
   */
  async redeemDueSessions(
    now: Date = new Date(),
  ): Promise<AdMobRedemptionSweep> {
    const due = await this.prisma.adRewardSession.findMany({
      where: {
        redemptionStatus: AdRewardRedemptionStatus.pending,
        redemptionNextAttemptAt: { lte: now },
      },
      orderBy: [{ redemptionNextAttemptAt: 'asc' }, { id: 'asc' }],
      take: ADMOB_REDEMPTION_BATCH_SIZE,
    });
    const sweep: AdMobRedemptionSweep = {
      due: due.length,
      redeemed: 0,
      refused: 0,
      retrying: 0,
      exhausted: 0,
      skipped: 0,
    };
    for (const session of due) sweep[await this.recover(session)] += 1;
    return sweep;
  }

  private async recover(session: AdRewardSession): Promise<RecoveryOutcome> {
    const at = new Date();
    const asRead = {
      id: session.id,
      redemptionStatus: AdRewardRedemptionStatus.pending,
      redemptionAttemptCount: session.redemptionAttemptCount,
    };
    // Counted from Google's confirmation (pending implies a recorded event,
    // SQL CHECK): past the window the server stops, without running it.
    const confirmedAt = session.ssvVerifiedAt?.getTime() ?? 0;
    if (at.getTime() - confirmedAt >= ADMOB_REDEMPTION_WINDOW_MS) {
      const ended = await this.prisma.adRewardSession.updateMany({
        where: asRead,
        data: {
          redemptionStatus: AdRewardRedemptionStatus.exhausted,
          redemptionNextAttemptAt: null,
          redemptionErrorCode:
            session.redemptionErrorCode ?? 'REDEMPTION_WINDOW_ENDED',
        },
      });
      if (ended.count !== 1) return 'skipped';
      this.logRecovery('error', session, session.redemptionAttemptCount, {
        kind: 'failed',
        code: 'EXHAUSTED',
      });
      return 'exhausted';
    }
    const attempt = session.redemptionAttemptCount + 1;
    const reserved = await this.prisma.adRewardSession.updateMany({
      where: asRead,
      data: {
        redemptionAttemptCount: attempt,
        redemptionNextAttemptAt: new Date(
          at.getTime() + adMobRedemptionRetryDelayMs(attempt),
        ),
      },
    });
    if (reserved.count !== 1) return 'skipped';
    const result = await this.runCommand(session);
    await this.settle(session, result, attempt);
    this.logRecovery(
      result.kind === 'redeemed' ? 'log' : 'warn',
      session,
      attempt,
      result,
    );
    return result.kind === 'failed' ? 'retrying' : result.kind;
  }

  /** The session's own command, run once; its answer classified, never thrown. */
  private async runCommand(
    session: AdRewardSession,
  ): Promise<RedemptionResult> {
    const body = {
      provider: ADMOB_PROVIDER,
      proof: session.id,
      idempotencyKey: session.idempotencyKey,
    };
    try {
      if (session.purpose === AdRewardPurpose.funding)
        await this.ads.claim(session.userId, session.tradingAccountId, body);
      else
        await this.resets.reset(session.userId, session.tradingAccountId, body);
      return { kind: 'redeemed' };
    } catch (caught) {
      if (!(caught instanceof HttpException))
        return {
          kind: 'failed',
          code: 'REDEEM_FAILED',
          safeCause: classifyFailureCause(caught),
        };
      const status = caught.getStatus();
      const answered = (caught.getResponse() as { error?: { code?: unknown } })
        .error?.code;
      const code =
        typeof answered === 'string' && FIXED_CODE.test(answered)
          ? answered
          : `HTTP_${status}`;
      // A recorded event is never "not confirmed yet"; should that answer
      // appear anyway it is retried, never settled as a refusal.
      return status >= 500 ||
        code === adRewardErrorCodes.AD_REWARD_VERIFICATION_PENDING
        ? { kind: 'failed', code }
        : { kind: 'refused', code };
    }
  }

  /**
   * Records what a run meant — only while the session is still pending, so
   * whichever path settles first wins and later ones change nothing (a
   * failure's code only for the attempt that made it). Legacy sessions
   * (status null) are left alone. False only when the write itself failed.
   */
  private async settle(
    session: Pick<AdRewardSession, 'id'>,
    result: RedemptionResult,
    attempt?: number,
  ): Promise<boolean> {
    const data: Prisma.AdRewardSessionUpdateManyMutationInput =
      result.kind === 'redeemed'
        ? {
            redemptionStatus: AdRewardRedemptionStatus.redeemed,
            redemptionNextAttemptAt: null,
            redemptionErrorCode: null,
          }
        : result.kind === 'refused'
          ? {
              redemptionStatus: AdRewardRedemptionStatus.refused,
              redemptionNextAttemptAt: null,
              redemptionErrorCode: result.code,
            }
          : { redemptionErrorCode: result.code };
    try {
      await this.prisma.adRewardSession.updateMany({
        where: {
          id: session.id,
          redemptionStatus: AdRewardRedemptionStatus.pending,
          ...(result.kind === 'failed' && attempt !== undefined
            ? { redemptionAttemptCount: attempt }
            : {}),
        },
        data,
      });
      return true;
    } catch (caught) {
      this.logger.error(
        JSON.stringify({
          event: 'admob_ssv_redemption_record_failed',
          sessionId: session.id,
          outcome: result.kind,
          safeCause: classifyFailureCause(caught),
        }),
      );
      return false;
    }
  }

  private logRecovery(
    level: 'log' | 'warn' | 'error',
    session: AdRewardSession,
    attempt: number,
    result: RedemptionResult,
  ) {
    // Identifiers and fixed codes only (no user id, no exception text).
    this.logger[level](
      JSON.stringify({
        event: 'admob_ssv_redemption',
        source: 'recovery',
        outcome: result.kind === 'redeemed' ? 'REDEEMED' : result.code,
        attempt,
        sessionId: session.id,
        transactionId: session.ssvTransactionId,
        ...(result.kind === 'failed' && result.safeCause
          ? { safeCause: result.safeCause }
          : {}),
      }),
    );
  }

  // ------------------------------------------------------------- helpers

  private findSession(tradingAccountId: string, idempotencyKey: string) {
    return this.prisma.adRewardSession.findUnique({
      where: {
        tradingAccountId_idempotencyKey: { tradingAccountId, idempotencyKey },
      },
    });
  }

  private replaySession(
    session: AdRewardSession,
    userId: string,
    input: { purpose: AdRewardPurpose; platform: string },
  ) {
    if (
      session.userId !== userId ||
      session.purpose !== input.purpose ||
      session.platform !== input.platform
    ) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_IDEMPOTENCY_CONFLICT,
        'Same idempotencyKey was used for a different ad session.',
      );
    }
    return this.sessionResponse(session, false);
  }

  private sessionResponse(session: AdRewardSession, created: boolean) {
    return {
      success: true as const,
      data: {
        sessionId: session.id,
        tradingAccountId: session.tradingAccountId,
        provider: session.provider,
        purpose: session.purpose,
        platform: session.platform,
        created,
        expiresAt: session.expiresAt.toISOString(),
        // What the app sets on the rewarded ad (ServerSideVerificationOptions).
        ssv: { userId: adMobSsvUserId(session), customData: session.id },
      },
    };
  }

  private answer(
    status: AdMobSsvOutcome['status'],
    outcome: string,
    fields: Record<string, string> = {},
    level: 'log' | 'warn' = 'warn',
  ): AdMobSsvOutcome {
    // Identifiers only: never the signature, the raw query or user_id.
    this.logger[level](
      JSON.stringify({
        event: 'admob_ssv_callback',
        status,
        outcome,
        ...fields,
      }),
    );
    return { status, outcome };
  }
}

function parseSessionBody(body: AdRewardSessionBody): {
  purpose: AdRewardPurpose;
  platform: 'android' | 'ios';
  idempotencyKey: string;
} {
  const row = body && typeof body === 'object' ? body : {};
  if (
    row.purpose !== AdRewardPurpose.funding &&
    row.purpose !== AdRewardPurpose.account_reset
  ) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'purpose must be funding or account_reset.',
    );
  }
  if (!isAdMobPlatform(row.platform)) {
    throwAdRewardError(
      adRewardErrorCodes.AD_REWARD_INVALID_REQUEST,
      'platform must be android or ios.',
    );
  }
  // The command key rules of the claim/reset the session is for.
  const { idempotencyKey } = parseAdRewardCommand({
    provider: ADMOB_PROVIDER,
    proof: 'session',
    idempotencyKey: row.idempotencyKey,
  });
  return { purpose: row.purpose, platform: row.platform, idempotencyKey };
}

function isUniqueViolation(caught: unknown) {
  return (
    caught instanceof Prisma.PrismaClientKnownRequestError &&
    caught.code === 'P2002'
  );
}
