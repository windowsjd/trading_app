import { HttpException } from '@nestjs/common';
import { AdRewardPurpose, Prisma } from '../generated/prisma/client';
import {
  databaseFailureKind,
  postgresErrorCode,
} from '../common/database-failure';
import {
  classifyFailureCause,
  type SafeFailureCause,
} from '../common/safe-failure-cause';
import { adRewardErrorCodes } from './ad-reward-error-policy';

/** What one run of a session's command means for the server's own redemption. */
export type RedemptionResult =
  | { kind: 'redeemed' }
  /** Final for every automatic path: never run again without the member. */
  | { kind: 'refused'; code: string; safeCause?: SafeFailureCause }
  /** The server may run the same command again (backoff, 24 h window). */
  | { kind: 'failed'; code: string; safeCause?: SafeFailureCause };

const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * Prisma request codes of a database that rolled a transaction back for
 * concurrency or did not answer in time (shapes probed on Prisma 7 +
 * adapter-pg, 2026-11-08): P2034 a write conflict or deadlock on a model call
 * (SQLSTATE 40001/40P01), P2028 an interactive transaction that expired or
 * could not start, P2024 the connection pool timed out, P1008 operations
 * timed out. Connection loss (P1001/P1002/P1017, driver kinds) and the
 * statement/lock timeouts come from databaseFailureKind.
 */
const TRANSIENT_PRISMA_CODES = new Set(['P2034', 'P2028', 'P2024', 'P1008']);
/** The same through raw queries (P2010 carries the SQLSTATE). */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01']);

/**
 * A failure known to say nothing about the command: the database could not
 * be reached, timed out, or rolled the transaction back for concurrency.
 * PostgreSQL rolled that whole transaction back and no product rule decided
 * it, so the same command may run again. Anything else — a constraint or
 * data rejection, any other database error, any application error — is not.
 */
export function isTransientDatabaseFailure(caught: unknown): boolean {
  if (caught instanceof HttpException) return false;
  const sqlState = postgresErrorCode(caught);
  if (sqlState !== null && TRANSIENT_SQLSTATES.has(sqlState)) return true;
  const kind = databaseFailureKind(caught);
  if (
    kind === 'connection' ||
    kind === 'statement_timeout' ||
    kind === 'lock_timeout'
  )
    return true;
  return (
    caught instanceof Prisma.PrismaClientKnownRequestError &&
    TRANSIENT_PRISMA_CODES.has(caught.code)
  );
}

/**
 * What a failed run of a session's command means (2026-11-08). HTTP status
 * alone does not decide it: `503 GENERAL_ACCOUNT_RESET_UNAVAILABLE` is a
 * product answer about the account, not a server outage.
 *
 * TOP-UP — a payout owed for a Google-confirmed ad. Only a product rule's
 * refusal (4xx) is final; a 5xx answer (ads switched off, an account that
 * cannot be valued right now, …) or any other failure is run again within
 * the window: paying later is what the member asked for, and the command
 * pays at most once.
 *
 * RESET — it wipes the account, so it runs again ONLY after a transient
 * database failure. Every answer of the command itself is final, the coded
 * 5xx refusals included (a reset refused now never runs later because the
 * condition passed), and so is any failure that cannot be classified.
 */
export function classifyRedemptionFailure(
  purpose: AdRewardPurpose,
  caught: unknown,
): Exclude<RedemptionResult, { kind: 'redeemed' }> {
  if (caught instanceof HttpException) {
    const status = caught.getStatus();
    const answered = (caught.getResponse() as { error?: { code?: unknown } })
      .error?.code;
    const code =
      typeof answered === 'string' && FIXED_CODE.test(answered)
        ? answered
        : `HTTP_${status}`;
    if (purpose === AdRewardPurpose.account_reset)
      return { kind: 'refused', code };
    // A recorded event is never "not confirmed yet"; should that answer
    // appear anyway the top-up is retried, never settled as a refusal.
    return status >= 500 ||
      code === adRewardErrorCodes.AD_REWARD_VERIFICATION_PENDING
      ? { kind: 'failed', code }
      : { kind: 'refused', code };
  }
  const safeCause = classifyFailureCause(caught);
  if (purpose === AdRewardPurpose.funding || isTransientDatabaseFailure(caught))
    return { kind: 'failed', code: 'REDEEM_FAILED', safeCause };
  return { kind: 'refused', code: 'REDEEM_FAILED_UNCLASSIFIED', safeCause };
}
