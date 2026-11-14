// Runtime imports carry the .ts extension so `node --test` can load this module.
import { formatKstDateTime } from '../../utils/format.ts';

/**
 * A season's operating period as Home shows it under the season name
 * (2026-11-14): `YYYY.MM.DD ~ YYYY.MM.DD` in Korea time, from the server's
 * `startAt` and `endAt` of THAT season.
 *
 * `endAt` is the server's exclusive trading boundary (trading is open while
 * `now < endAt`), so the last operating day is the Korea-time day of the last
 * instant before it — a season ending at 2026-11-30 00:00 KST ran until
 * 2026-11-29, never "11.30". The app's fixed-KST formatter decides the day
 * whatever the device zone. Anything missing or unreadable shows nothing: no
 * date is ever invented.
 */
export type SeasonPeriod = {
  /** `2026.11.14 ~ 2026.11.29` */
  text: string;
  /** For screen readers: `2026년 11월 14일부터 2026년 11월 29일까지`. */
  spoken: string;
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/iu;

/** The KST calendar day of an instant, through the shared formatter. */
function kstDay(instant: Date): [string, string, string] | null {
  const formatted = formatKstDateTime(instant);
  const match = /^(\d{4})-(\d{2})-(\d{2}) /u.exec(formatted);
  return match ? [match[1], match[2], match[3]] : null;
}

export function getSeasonPeriod(
  season: { startAt?: string | null; endAt?: string | null } | null | undefined,
): SeasonPeriod | null {
  const startAt = season?.startAt?.trim() ?? '';
  const endAt = season?.endAt?.trim() ?? '';
  if (!ISO_INSTANT.test(startAt) || !ISO_INSTANT.test(endAt)) return null;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const first = kstDay(new Date(start));
  // The last instant trading was open: the boundary itself is exclusive.
  const last = kstDay(new Date(end - 1));
  if (!first || !last) return null;
  const dotted = (day: [string, string, string]) => day.join('.');
  const spokenDay = ([year, month, date]: [string, string, string]) =>
    `${year}년 ${Number(month)}월 ${Number(date)}일`;
  return {
    text: `${dotted(first)} ~ ${dotted(last)}`,
    spoken: `${spokenDay(first)}부터 ${spokenDay(last)}까지`,
  };
}
