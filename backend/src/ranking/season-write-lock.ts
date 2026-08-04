import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma, SeasonStatus } from '../generated/prisma/client';

/**
 * The ONE serialization point for every writer that changes a season's ranking
 * or settlement result (작업 8 §13).
 *
 * WHY A DB ROW LOCK AND NOT THE EXISTING IN-MEMORY SET
 * ---------------------------------------------------
 * `RankingRefreshService` keeps a `Set` of in-flight season ids. That stops one
 * process from refreshing the same season twice, and nothing more: two backend
 * instances, or a batch job running beside the API, share no memory at all. The
 * race that actually matters is between a live ranking refresh and settlement —
 * a refresh that started before settlement committed could delete and rewrite
 * the daily rows of a season whose final result had already been fixed.
 *
 * `SELECT ... FROM seasons WHERE id = $1 FOR UPDATE` costs one statement, works
 * across instances, and is released by COMMIT/ROLLBACK automatically. No Redis
 * lock, no advisory-lock namespace, no queue. The in-memory Set stays as a cheap
 * same-process short circuit; THIS is the actual mutual exclusion.
 *
 * Every caller must already be inside `prisma.$transaction`, and must re-read
 * the season's state from THIS result rather than from whatever it read before
 * the lock — the whole point is that the state may have changed while waiting.
 */

export type LockedSeason = {
  id: string;
  status: SeasonStatus;
  startAt: Date;
  endAt: Date;
};

type SeasonLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

export const SEASON_WRITE_LOCK_NOT_FOUND = 'SEASON_NOT_FOUND';

/**
 * Takes the season's row lock and returns its CURRENT committed state.
 * Returns null when the season no longer exists, so each caller can map that to
 * its own contract (404 for an API, a job error for a batch).
 */
export async function lockSeasonForWrite(
  tx: SeasonLockClient,
  seasonId: string,
): Promise<LockedSeason | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      status: SeasonStatus;
      start_at: Date;
      end_at: Date;
    }>
  >`
    SELECT "id", "status", "start_at", "end_at"
    FROM "seasons"
    WHERE "id" = ${seasonId}
    FOR UPDATE
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
  };
}

/** Same lock, but a missing season is a structured error instead of null. */
export async function lockSeasonForWriteOrThrow(
  tx: SeasonLockClient,
  seasonId: string,
): Promise<LockedSeason> {
  const season = await lockSeasonForWrite(tx, seasonId);
  if (!season) {
    throw new HttpException(
      {
        success: false,
        error: {
          code: SEASON_WRITE_LOCK_NOT_FOUND,
          message: `Season ${seasonId} disappeared before its ranking write could be serialized.`,
        },
      },
      HttpStatus.NOT_FOUND,
    );
  }

  return season;
}
