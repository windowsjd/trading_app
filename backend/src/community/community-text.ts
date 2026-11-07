import {
  COMMUNITY_BLOCKED_LINK_DOMAINS,
  COMMUNITY_CLIENT_REQUEST_ID,
  COMMUNITY_ID_MAX_LENGTH,
} from './community.policy';

/** Control characters other than tab/newline/carriage return never belong
 * in a post, comment or note. */
export function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });
}

/** Trimmed text of 1..max code points without control characters, or null. */
export function parseCommunityText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > max || hasControlCharacter(trimmed)) return null;
  return trimmed;
}

/** Optional note: absent, null or blank = none; otherwise like a body. */
export function parseOptionalNote(
  value: unknown,
  max: number,
): { ok: true; note: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== 'string') return { ok: false };
  if (!value.trim()) return { ok: true, note: null };
  const note = parseCommunityText(value, max);
  return note ? { ok: true, note } : { ok: false };
}

export function isClientRequestId(value: unknown): value is string {
  return typeof value === 'string' && COMMUNITY_CLIENT_REQUEST_ID.test(value);
}

/** Route ids are opaque strings; anything else can never match a row. */
export function isEntityId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= COMMUNITY_ID_MAX_LENGTH
  );
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

/** A host matches only as a whole label sequence: "abt.me" is not "t.me". */
const BLOCKED_DOMAIN_PATTERNS = COMMUNITY_BLOCKED_LINK_DOMAINS.map(
  (domain) =>
    new RegExp(`(?:^|[^a-z0-9.-])${escapeRegExp(domain)}(?![a-z0-9-])`, 'u'),
);

/**
 * Links are refused in bodies (docs/community-api-contract.md §6.2): any
 * http(s):// or www. and the messenger invitation hosts. Checked on the NFKC
 * form without format characters (zero-width spaces), lower-cased, so
 * full-width or zero-width-split spellings are refused too.
 */
export function containsBlockedLink(value: string): boolean {
  const text = value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase();
  if (/https?:\/\//u.test(text) || text.includes('www.')) return true;
  return BLOCKED_DOMAIN_PATTERNS.some((pattern) => pattern.test(text));
}
