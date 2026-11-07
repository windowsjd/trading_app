/** Korean time and count copy for the community (React-free). */
const KST_OFFSET_MS = 9 * 3_600_000;
const pad = (value: number) => String(value).padStart(2, '0');

/** YYYY.MM.DD in Korea time, or '-' for an unreadable time. */
export function formatKstDate(iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return '-';
  const date = new Date(time + KST_OFFSET_MS);
  return `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`;
}

/** 방금 전 · N분 전 · N시간 전 · N일 전, then the date. A time ahead of the clock reads 방금 전. */
export function formatCommunityTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '-';
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}일 전` : formatKstDate(iso);
}

/** 0–9,999 as digits; then 1.2만 (one decimal, trailing .0 dropped). */
export function formatCommunityCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 10_000) return String(Math.floor(value));
  const tenThousands = Math.floor(value / 1_000) / 10;
  return `${tenThousands % 1 === 0 ? tenThousands.toFixed(0) : tenThousands.toFixed(1)}만`;
}

/** Characters as the server counts them (code points, trimmed). */
export const communityTextLength = (value: string) => [...value.trim()].length;
