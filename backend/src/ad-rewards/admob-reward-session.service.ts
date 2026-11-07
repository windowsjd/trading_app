import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AdRewardPurpose,
  Prisma,
  TradingAccountStatus,
  type AdRewardSession,
} from '../generated/prisma/client';
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
  ADMOB_SESSION_TTL_MS,
  adMobAdUnitMatches,
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
    return this.redeem(current, logged);
  }

  /**
   * The same command the app sends. A refusal (cap, blocked reset, inactive
   * account, …) is final for this event and is what the app will read; a
   * server failure is answered 503 so Google retries — the recorded event
   * and the command key make every retry safe.
   */
  private async redeem(
    session: AdRewardSession,
    logged: Record<string, string>,
  ): Promise<AdMobSsvOutcome> {
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
      return this.answer(200, 'REDEEMED', logged, 'log');
    } catch (caught) {
      const status = caught instanceof HttpException ? caught.getStatus() : 500;
      const code =
        caught instanceof HttpException
          ? ((caught.getResponse() as { error?: { code?: string } }).error
              ?.code ?? `HTTP_${status}`)
          : 'REDEEM_FAILED';
      return status >= 500
        ? this.answer(503, code, logged)
        : this.answer(200, code, logged);
    }
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
