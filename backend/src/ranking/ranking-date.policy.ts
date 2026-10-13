/**
 * Season ranking business dates are Korea (Asia/Seoul) calendar dates: a
 * ranking date changes at KST midnight, never at UTC midnight. The zone is
 * fixed on purpose — it does not follow `SCHEDULER_TIMEZONE`, which other
 * scheduler jobs may configure independently.
 *
 * Only the DATE KEY is Korean. The instants it is derived from
 * (`capturedAt`, `Season.endAt`) stay absolute UTC timestamps and are never
 * shifted. A `YYYY-MM-DD` string that is already a business date (manual
 * batch input, API query) is used as-is and must not go through these helpers.
 */
export const RANKING_DATE_TIME_ZONE = 'Asia/Seoul';

const rankingDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: RANKING_DATE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` Korea date of an absolute instant. */
export function formatKstRankingDate(at: Date): string {
  const parts = Object.fromEntries(
    rankingDateFormatter
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The same Korea date as the value Prisma reads and writes for a `@db.Date`
 * column. Its UTC-midnight `Date` is only the date-only encoding, not a UTC
 * day boundary.
 */
export function toKstRankingDate(at: Date): Date {
  return new Date(`${formatKstRankingDate(at)}T00:00:00.000Z`);
}
