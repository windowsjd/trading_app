/**
 * The server refuses links (contract §6.2, COMMUNITY_LINK_NOT_ALLOWED). The
 * app checks the same rule first only to say so before sending; the server
 * remains the authority and its list may grow.
 */
export const COMMUNITY_BLOCKED_LINK_DOMAINS = [
  'open.kakao.com', 'pf.kakao.com', 't.me', 'telegram.me', 'discord.gg', 'discord.com/invite', 'line.me', 'band.us',
] as const;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
const DOMAIN_PATTERNS = COMMUNITY_BLOCKED_LINK_DOMAINS.map(
  (domain) => new RegExp(`(^|[^a-z0-9.-])${escape(domain)}($|[^a-z0-9-])`, 'u'),
);

export function containsBlockedLink(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase();
  if (/https?:\/\/|www\./u.test(normalized)) return true;
  return DOMAIN_PATTERNS.some((pattern) => pattern.test(normalized));
}
