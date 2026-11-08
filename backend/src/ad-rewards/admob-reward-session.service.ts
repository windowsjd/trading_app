import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AdRewardClaimStatus,
  AdRewardPurpose,
  AdRewardRedemptionStatus,
  Prisma,
  TradingAccountStatus,
  type AdRewardSession,
} from '../generated/prisma/client';
import { classifyFailureCause } from '../common/safe-failure-cause';
import { PrismaService } from '../prisma/prisma.service';
import { AdRewardService } from './ad-reward.service';
import { GeneralAccountResetService } from './general-account-reset.service';
import {
  parseAdRewardCommand,
  type AdRewardCommandBody,
} from './ad-reward-command';
import {
  adRewardErrorCodes,
  throwAdRewardError,
  throwAdRewardErrorWithDetails,
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
  ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
  ADMOB_REDEMPTION_UNSETTLED,
  ADMOB_REDEMPTION_WINDOW_MS,
  ADMOB_SESSION_TTL_MS,
  adMobAdUnitMatches,
  adMobRedemptionRetryDelayMs,
  adMobSessionEndedUnconfirmed,
  isAdMobPlatform,
  readAdMobConfig,
} from './admob.config';
import {
  classifyRedemptionFailure,
  type RedemptionResult,
} from './admob-redemption-policy';
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

/** One recovery pass, as counts only (the Ops run result). */
export type AdMobRedemptionSweep = {
  due: number;
  redeemed: number;
  refused: number;
  retrying: number;
  exhausted: number;
  /** Resets closed because an earlier attempt's outcome was never recorded. */
  unknown: number;
  /** Attempts whose own outcome could not be recorded (a later pass decides). */
  unsettled: number;
  skipped: number;
};

type RecoveryOutcome = Exclude<keyof AdMobRedemptionSweep, 'due'>;

type RedemptionRow = Pick<
  AdRewardSession,
  'redemptionStatus' | 'redemptionErrorCode' | 'redemptionAttemptCount'
>;

/** What one settle write left behind. */
type Settled =
  | { state: 'recorded' }
  /** Another path decided first, or a newer attempt took this one over. */
  | { state: 'superseded'; current: RedemptionRow | null }
  /** The write failed: the attempt's unsettled marker stays. */
  | { state: 'write_failed' };

const CLOSED_MESSAGE =
  'This ad reward request was not applied and will not run again.';

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
 *    Every ordering ends in one claim: the command key and (provider, event)
 *    are unique, and the payout/reset transactions are unchanged.
 * 4. Who runs it (2026-11-08). Once the event is recorded the SERVER owns the
 *    redemption: the callback that recorded it runs the first attempt, and
 *    AdMobRedemptionWorker any later one. Each attempt is reserved before it
 *    runs (ADMOB_REDEMPTION_UNSETTLED) and replaced by its outcome, so an
 *    outcome that was never written is detected instead of looking like a
 *    retryable failure. Re-sent callbacks and the member's own call only read
 *    where it stands (memberCommand): a "결과 확인" is never a new reset.
 *    Which failures are run again: admob-redemption-policy.ts. The session's
 *    status is bookkeeping; the claim row is what was paid or reset.
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
    // An earlier ad's reset the server is still completing would wipe what a
    // new ad adds, or reset twice: no new ad until it is settled (2026-11-08).
    const resetPending = await this.prisma.adRewardSession.findFirst({
      where: {
        tradingAccountId: account.id,
        purpose: AdRewardPurpose.account_reset,
        redemptionStatus: AdRewardRedemptionStatus.pending,
      },
      select: { id: true },
    });
    if (resetPending) {
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_REDEMPTION_PENDING,
        'An earlier ad reward is still being completed. Try again shortly.',
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

  // ------------------------------------------------------ member's command

  /**
   * POST …/ad-rewards/claim and POST …/account-reset (2026-11-08). Any proof
   * other than an AdMob session of THIS member, account, command key and
   * purpose is the plain command, unchanged (it refuses those itself, and can
   * run nothing for them). For this command's session the member's call
   * never runs the command once Google's event is recorded — the server
   * redeems it (the recording callback, then AdMobRedemptionWorker) — so a
   * 결과 확인 only reads the result and can never become a new reset:
   *
   * - a committed command (granted, or a top-up recorded as rejected): the
   *   command's own replay of it;
   * - not confirmed by Google yet: 409 AD_REWARD_VERIFICATION_PENDING (422
   *   AD_REWARD_VERIFICATION_FAILED past the grace), as the verifier would
   *   answer — without running the command, so an event recorded in between
   *   is never also run here;
   * - pending: 409 AD_REWARD_REDEMPTION_PENDING, nothing run or written;
   * - refused / exhausted (or redeemed without a claim): 409
   *   AD_REWARD_REDEMPTION_CLOSED with the stored reason — final; trying
   *   again is a new session and a new ad.
   *
   * Recorded before 2026-11-08 (no status, none in production): the command,
   * as before.
   */
  async memberCommand(
    purpose: AdRewardPurpose,
    userId: string | undefined,
    accountId: string,
    body: AdRewardCommandBody = {},
  ) {
    const command = () =>
      purpose === AdRewardPurpose.funding
        ? this.ads.claim(userId, accountId, body)
        : this.resets.reset(userId, accountId, body);
    // The command's own order: ownership, then the body.
    const account = await this.ads.resolveGeneralAccount(userId, accountId);
    const request = parseAdRewardCommand(body);
    if (request.provider !== ADMOB_PROVIDER || !SESSION_ID.test(request.proof))
      return command();
    const session = await this.prisma.adRewardSession.findUnique({
      where: { id: request.proof },
    });
    if (
      !session ||
      session.provider !== ADMOB_PROVIDER ||
      session.userId !== account.userId ||
      session.tradingAccountId !== account.id ||
      session.idempotencyKey !== request.idempotencyKey ||
      session.purpose !== purpose
    )
      return command();
    // Claims are never undone: once one exists the command only replays it.
    if (await this.keyedClaim(session)) return command();
    if (!session.ssvTransactionId) {
      if (adMobSessionEndedUnconfirmed(session.expiresAt, new Date()))
        throwAdRewardError(
          adRewardErrorCodes.AD_REWARD_VERIFICATION_FAILED,
          'Ad completion could not be verified.',
        );
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_VERIFICATION_PENDING,
        'The ad completion has not been confirmed yet. Retry the same request.',
      );
    }
    if (session.redemptionStatus === null) return command();
    if (session.redemptionStatus === AdRewardRedemptionStatus.pending)
      throwAdRewardError(
        adRewardErrorCodes.AD_REWARD_REDEMPTION_PENDING,
        'The confirmed ad reward is still being completed. Ask again later.',
      );
    throwAdRewardErrorWithDetails(
      adRewardErrorCodes.AD_REWARD_REDEMPTION_CLOSED,
      CLOSED_MESSAGE,
      {
        status: session.redemptionStatus,
        ...(session.redemptionErrorCode
          ? { reasonCode: session.redemptionErrorCode }
          : {}),
      },
    );
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
      const recordedEvent = {
        ssvTransactionId: callback.params.transactionId,
        ssvVerifiedAt: at,
        ssvRewardedAt: adMobRewardTime(callback.params.timestamp),
        ssvAdUnit: callback.params.adUnit,
        ssvKeyId: callback.keyId,
        ssvRewardItem: callback.params.rewardItem,
        ssvRewardAmount: callback.params.rewardAmount,
        // Recorded = the server's to redeem, in the same write, which also
        // reserves THIS callback's attempt (count 0): should the command
        // below fail, or its outcome never be written, the recovery worker
        // takes it from there once the attempt's time is up.
        redemptionStatus: AdRewardRedemptionStatus.pending,
        redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
        redemptionNextAttemptAt: new Date(
          at.getTime() + ADMOB_REDEMPTION_FIRST_ATTEMPT_DELAY_MS,
        ),
      };
      let recorded: number;
      try {
        recorded = (
          await this.prisma.adRewardSession.updateMany({
            where: { id: current.id, ssvTransactionId: null },
            data: recordedEvent,
          })
        ).count;
      } catch (caught) {
        if (!isUniqueViolation(caught)) throw caught;
        // The event is already another session's: it never pays twice.
        return this.answer(200, 'TRANSACTION_ALREADY_USED', logged);
      }
      if (recorded === 1)
        return this.redeemFromCallback(
          { ...current, ...recordedEvent, redemptionAttemptCount: 0 },
          logged,
        );
      // A concurrent copy of the callback recorded it first.
      current = await this.prisma.adRewardSession.findUniqueOrThrow({
        where: { id: current.id },
      });
    }
    // A different event for an already confirmed session never applies.
    if (current.ssvTransactionId !== callback.params.transactionId)
      return this.answer(200, 'SESSION_ALREADY_CONFIRMED', logged);
    // The same event again (Google's retries, a re-send): the attempt that
    // recorded it ran the command and the worker runs any later one, so this
    // only reports where it stands — it never runs the command again.
    return this.answerRecorded(current, logged);
  }

  /**
   * The first attempt, run by the callback that recorded the event. A
   * refusal is final once settled; a server failure is answered 503 and the
   * worker runs it again; an outcome that could not be written leaves the
   * unsettled marker for the worker to read (a reset is then never re-run).
   */
  private async redeemFromCallback(
    session: AdRewardSession,
    logged: Record<string, string>,
  ): Promise<AdMobSsvOutcome> {
    const result = await this.runCommand(session);
    const settled = await this.settle(session, 0, result);
    // The command committed: 200 even if the bookkeeping write failed (the
    // worker finds the claim behind the marker and settles it).
    if (result.kind === 'redeemed')
      return this.answer(200, 'REDEEMED', logged, 'log');
    if (settled.state === 'superseded')
      return this.answerRecorded(settled.current ?? {}, logged);
    if (settled.state === 'write_failed')
      return this.answer(503, 'REDEMPTION_RECORD_FAILED', {
        ...logged,
        code: result.code,
      });
    return result.kind === 'refused'
      ? this.answer(200, result.code, logged)
      : this.answer(503, result.code, logged);
  }

  /** Where a recorded event stands, without running anything. */
  private answerRecorded(
    row: Partial<RedemptionRow>,
    logged: Record<string, string>,
  ): AdMobSsvOutcome {
    switch (row.redemptionStatus) {
      case AdRewardRedemptionStatus.redeemed:
        return this.answer(200, 'REDEEMED', logged, 'log');
      case AdRewardRedemptionStatus.refused:
        return this.answer(200, 'REDEMPTION_REFUSED', {
          ...logged,
          code: row.redemptionErrorCode ?? '',
        });
      case AdRewardRedemptionStatus.exhausted:
        return this.answer(200, 'REDEMPTION_EXHAUSTED', logged);
      case AdRewardRedemptionStatus.pending:
        return this.answer(200, 'REDEMPTION_PENDING', logged);
      default:
        // Recorded before 2026-11-08: the member's own command redeems it.
        return this.answer(200, 'SESSION_ALREADY_RECORDED', logged);
    }
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
   * sessions, each through its own command, the one the callback ran. Every
   * attempt is reserved first — attempt count, the unsettled marker and the
   * next attempt time, conditional on the row as read — so two passes never
   * run the same attempt, and a crash mid-command waits out the backoff
   * instead of looping. The command itself is what makes any overlap pay or
   * reset at most once.
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
      unknown: 0,
      unsettled: 0,
      skipped: 0,
    };
    for (const session of due) sweep[await this.recover(session)] += 1;
    return sweep;
  }

  private async recover(session: AdRewardSession): Promise<RecoveryOutcome> {
    const at = new Date();
    // Every write is conditional on the row exactly as read.
    const asRead = {
      id: session.id,
      redemptionStatus: AdRewardRedemptionStatus.pending,
      redemptionAttemptCount: session.redemptionAttemptCount,
      redemptionErrorCode: session.redemptionErrorCode,
    };
    // Due with its marker still there: the last attempt's outcome was never
    // written (a crash, or the database failing on that write). A session
    // recorded before the marker existed (pending, no code) reads the same.
    const unsettled =
      session.redemptionErrorCode === null ||
      session.redemptionErrorCode === ADMOB_REDEMPTION_UNSETTLED;
    // Counted from Google's confirmation (pending implies a recorded event,
    // SQL CHECK): past the window the server stops without running it.
    const confirmedAt = session.ssvVerifiedAt?.getTime() ?? 0;
    const windowEnded =
      at.getTime() - confirmedAt >= ADMOB_REDEMPTION_WINDOW_MS;
    const claim =
      unsettled || windowEnded ? await this.keyedClaim(session) : null;

    if (windowEnded) {
      // Stopped without running the command; the claim decides what is
      // reported, so a paid top-up or a done reset is never "unredeemed".
      const granted = claim?.status === AdRewardClaimStatus.granted;
      const code = granted
        ? null
        : claim
          ? (claim.failureCode ?? 'AD_REWARD_CLAIM_NOT_GRANTED')
          : (session.redemptionErrorCode ?? 'REDEMPTION_WINDOW_ENDED');
      const ended = await this.prisma.adRewardSession.updateMany({
        where: asRead,
        data: granted
          ? redeemedData()
          : claim
            ? refusedData(code ?? '')
            : {
                redemptionStatus: AdRewardRedemptionStatus.exhausted,
                redemptionNextAttemptAt: null,
                redemptionErrorCode: code,
              },
      });
      if (ended.count !== 1) return 'skipped';
      this.logRecovery(
        granted ? 'log' : 'error',
        session,
        session.redemptionAttemptCount,
        granted
          ? { kind: 'redeemed' }
          : { kind: 'refused', code: claim ? (code ?? '') : 'EXHAUSTED' },
      );
      return granted ? 'redeemed' : claim ? 'refused' : 'exhausted';
    }

    if (
      unsettled &&
      !claim &&
      session.purpose === AdRewardPurpose.account_reset
    ) {
      // That attempt may have been refused for a product rule whose record
      // was lost: a reset never runs again without the member. (A top-up
      // runs again — it pays at most once; a committed command only replays.)
      const closed = await this.prisma.adRewardSession.updateMany({
        where: asRead,
        data: refusedData(ADMOB_REDEMPTION_OUTCOME_UNKNOWN),
      });
      if (closed.count !== 1) return 'skipped';
      this.logRecovery('error', session, session.redemptionAttemptCount, {
        kind: 'refused',
        code: ADMOB_REDEMPTION_OUTCOME_UNKNOWN,
      });
      return 'unknown';
    }

    const attempt = session.redemptionAttemptCount + 1;
    const reserved = await this.prisma.adRewardSession.updateMany({
      where: asRead,
      data: {
        redemptionAttemptCount: attempt,
        redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
        redemptionNextAttemptAt: new Date(
          at.getTime() + adMobRedemptionRetryDelayMs(attempt),
        ),
      },
    });
    if (reserved.count !== 1) return 'skipped';
    const result = await this.runCommand(session);
    const settled = await this.settle(session, attempt, result);
    this.logRecovery(
      result.kind === 'redeemed' ? 'log' : 'warn',
      session,
      attempt,
      result,
    );
    // Money that moved is reported as such whatever the bookkeeping did.
    if (result.kind === 'redeemed') return 'redeemed';
    if (settled.state === 'superseded') return 'skipped';
    if (settled.state === 'write_failed') return 'unsettled';
    return result.kind === 'failed' ? 'retrying' : 'refused';
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
      return classifyRedemptionFailure(session.purpose, caught);
    }
  }

  /**
   * Records what attempt `attempt` meant, on that attempt's own reservation
   * only (pending, its attempt count, the unsettled marker): whichever path
   * decides first wins, and an attempt that outlived its reservation never
   * overwrites the one that took over. A failure keeps the session pending
   * with its code; the next attempt time is the reservation's.
   */
  private async settle(
    session: Pick<AdRewardSession, 'id'>,
    attempt: number,
    result: RedemptionResult,
  ): Promise<Settled> {
    const data: Prisma.AdRewardSessionUpdateManyMutationInput =
      result.kind === 'redeemed'
        ? redeemedData()
        : result.kind === 'refused'
          ? refusedData(result.code)
          : { redemptionErrorCode: result.code };
    try {
      const written = await this.prisma.adRewardSession.updateMany({
        where: {
          id: session.id,
          redemptionStatus: AdRewardRedemptionStatus.pending,
          redemptionAttemptCount: attempt,
          redemptionErrorCode: ADMOB_REDEMPTION_UNSETTLED,
        },
        data,
      });
      if (written.count === 1) return { state: 'recorded' };
      // Not this attempt's to decide any more: what the row says now is the
      // answer (the claim row stays what was paid or reset).
      const current = await this.prisma.adRewardSession.findUnique({
        where: { id: session.id },
        select: {
          redemptionStatus: true,
          redemptionErrorCode: true,
          redemptionAttemptCount: true,
        },
      });
      this.logger.warn(
        JSON.stringify({
          event: 'admob_ssv_redemption_superseded',
          sessionId: session.id,
          attempt,
          outcome: result.kind,
          status: current?.redemptionStatus ?? 'missing',
          currentAttempt: current?.redemptionAttemptCount ?? null,
        }),
      );
      return { state: 'superseded', current };
    } catch (caught) {
      this.logger.error(
        JSON.stringify({
          event: 'admob_ssv_redemption_record_failed',
          sessionId: session.id,
          attempt,
          outcome: result.kind,
          safeCause: classifyFailureCause(caught),
        }),
      );
      return { state: 'write_failed' };
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
        purpose: session.purpose,
        outcome: result.kind === 'redeemed' ? 'REDEEMED' : result.code,
        attempt,
        sessionId: session.id,
        transactionId: session.ssvTransactionId,
        ...(result.kind !== 'redeemed' && result.safeCause
          ? { safeCause: result.safeCause }
          : {}),
      }),
    );
  }

  // ------------------------------------------------------------- helpers

  /** The claim of the session's command key, if one was ever committed. */
  private keyedClaim(
    session: Pick<AdRewardSession, 'tradingAccountId' | 'idempotencyKey'>,
  ) {
    return this.prisma.adRewardClaim.findUnique({
      where: {
        tradingAccountId_idempotencyKey: {
          tradingAccountId: session.tradingAccountId,
          idempotencyKey: session.idempotencyKey,
        },
      },
      select: { status: true, failureCode: true },
    });
  }

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

function redeemedData(): Prisma.AdRewardSessionUpdateManyMutationInput {
  return {
    redemptionStatus: AdRewardRedemptionStatus.redeemed,
    redemptionNextAttemptAt: null,
    redemptionErrorCode: null,
  };
}

function refusedData(
  code: string,
): Prisma.AdRewardSessionUpdateManyMutationInput {
  return {
    redemptionStatus: AdRewardRedemptionStatus.refused,
    redemptionNextAttemptAt: null,
    redemptionErrorCode: code,
  };
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
