import type { LongCandleSyncSummary } from '../../src/assets/market-candle-long-sync.service';
import {
  OpsJobTrigger,
  type OpsJobName,
} from '../../src/generated/prisma/enums';
import type { OpsJobLockService } from '../../src/ops/ops-job-lock.service';
import type { OpsJobRunService } from '../../src/ops/ops-job-run.service';

export const LONG_BACKFILL_LOCK_TTL_SECONDS = 900;
export const LONG_BACKFILL_LOCK_EXTEND_MS = 60_000;

export type LongBackfillResults = Record<string, LongCandleSyncSummary>;

export type LongBackfillGroup = {
  locks: Pick<OpsJobLockService, 'acquireLock' | 'extendLock' | 'releaseLock'>;
  runs: Pick<
    OpsJobRunService,
    'createRunning' | 'recordSucceeded' | 'recordFailed'
  >;
  jobName: OpsJobName;
  lockKey: string;
  apply: boolean;
  metadataJson: unknown;
  /** Operator stop (SIGINT/SIGTERM). */
  signal: AbortSignal;
  /** Runs every market of the group; must stop when `signal` aborts. */
  execute: (signal: AbortSignal) => Promise<LongBackfillResults>;
  lockTtlSeconds?: number;
  extendEveryMs?: number;
};

/**
 * One Ops-locked backfill group (asset markets, or futures). Same lease rules
 * as the Ops runner: the lock is always released, a failed or late renewal
 * stops the work, and a canceled, failed or ownership-lost run is recorded as
 * failed and reported as unsuccessful (non-zero exit).
 */
export async function runLongBackfillGroup(
  group: LongBackfillGroup,
): Promise<boolean> {
  if (!group.apply) {
    await group.execute(group.signal);
    return !group.signal.aborted;
  }
  const ttlMs = (group.lockTtlSeconds ?? LONG_BACKFILL_LOCK_TTL_SECONDS) * 1000;
  const ttlSeconds = ttlMs / 1000;
  const acquiredAtMs = Date.now();
  const lock = await group.locks.acquireLock({
    jobName: group.jobName,
    lockKey: group.lockKey,
    ttlSeconds,
  });
  if (!lock.acquired) {
    console.error(
      `${group.jobName}: another run holds the Ops job lock (${group.lockKey}) until ${lock.expiresAt?.toISOString() ?? '?'}; nothing was started.`,
    );
    return false;
  }

  const work = new AbortController();
  const stopWork = () => work.abort();
  group.signal.addEventListener('abort', stopWork, { once: true });
  if (group.signal.aborted) work.abort();
  let lockLost = false;
  let deadlineMs = acquiredAtMs + ttlMs;
  let renewal: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const lose = () => {
    lockLost = true;
    work.abort();
  };
  const owned = () => {
    if (Date.now() >= deadlineMs) lose();
    return !lockLost;
  };
  // Waits for an in-flight renewal (assigned by the timer callback).
  const settleRenewal = async () => {
    if (renewal) await renewal;
  };
  try {
    const run = await group.runs.createRunning({
      jobName: group.jobName,
      trigger: OpsJobTrigger.manual_script,
      requestedBy: 'script:candle-long-backfill',
      lockKey: group.lockKey,
      metadataJson: group.metadataJson,
    });
    timer = setInterval(() => {
      if (renewal || !owned()) return;
      const startedAtMs = Date.now();
      renewal = group.locks
        .extendLock({
          lockKey: group.lockKey,
          ownerId: lock.ownerId,
          ttlSeconds,
        })
        .then((extended) => {
          // A late answer cannot revive a lease whose deadline already passed.
          if (!extended || !owned()) lose();
          else deadlineMs = startedAtMs + ttlMs;
        }, lose)
        .finally(() => {
          renewal = null;
        });
    }, group.extendEveryMs ?? LONG_BACKFILL_LOCK_EXTEND_MS);

    let results: LongBackfillResults;
    try {
      results = await group.execute(work.signal);
    } catch (error) {
      await group.runs.recordFailed(run, {
        errorCode: lockLost
          ? 'OPS_JOB_LOCK_LOST'
          : 'MARKET_CANDLE_LONG_BACKFILL_FAILED',
        errorMessage: 'Long-range 4h backfill stopped with an error.',
      });
      throw error;
    }
    await settleRenewal();
    const failure = !owned()
      ? {
          errorCode: 'OPS_JOB_LOCK_LOST',
          errorMessage: `${group.jobName} lock ownership was lost.`,
        }
      : group.signal.aborted
        ? {
            errorCode: 'MARKET_CANDLE_LONG_BACKFILL_CANCELED',
            errorMessage: 'Long-range 4h backfill was stopped by the operator.',
          }
        : Object.values(results).some((summary) => summary.runFailed)
          ? {
              errorCode: 'MARKET_CANDLE_LONG_BACKFILL_FAILED',
              errorMessage:
                'Long-range 4h backfill finished with failed series.',
            }
          : null;
    if (failure) {
      // Partial progress stays in the run record; stored rows resume it.
      await group.runs.recordFailed(run, { ...failure, resultJson: results });
      return false;
    }
    await group.runs.recordSucceeded(run, { resultJson: results });
    return true;
  } finally {
    if (timer) clearInterval(timer);
    await settleRenewal();
    group.signal.removeEventListener('abort', stopWork);
    await group.locks
      .releaseLock({ lockKey: group.lockKey, ownerId: lock.ownerId })
      .catch(() => false);
  }
}
