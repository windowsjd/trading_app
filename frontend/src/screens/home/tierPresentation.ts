import type { AppearanceMode } from '../../theme/appearance';

export type HomeTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'whale';
type CardPalette = { backgroundColor: string; color: string };

// Home presentation only. The ranking API's canonical top tier remains master.
const TIERS: Record<string, { id: HomeTier; name: string; light: CardPalette; dark: CardPalette }> = {
  bronze: { id: 'bronze', name: 'Bronze',
    light: { backgroundColor: '#f1d8c6', color: '#1a1008' },
    dark: { backgroundColor: '#432c23', color: '#fff6eb' } },
  silver: { id: 'silver', name: 'Silver',
    light: { backgroundColor: '#dce2e8', color: '#111922' },
    dark: { backgroundColor: '#343c48', color: '#ffffff' } },
  gold: { id: 'gold', name: 'Gold',
    light: { backgroundColor: '#f2e0ae', color: '#1c1503' },
    dark: { backgroundColor: '#44371e', color: '#fff9eb' } },
  platinum: { id: 'platinum', name: 'Platinum',
    light: { backgroundColor: '#c8e9e1', color: '#061b1b' },
    dark: { backgroundColor: '#173e3a', color: '#f1fffb' } },
  diamond: { id: 'diamond', name: 'Diamond',
    light: { backgroundColor: '#d1e4fc', color: '#05162d' },
    dark: { backgroundColor: '#1b365c', color: '#f5faff' } },
  master: { id: 'whale', name: 'Whale',
    light: { backgroundColor: '#12396a', color: '#ffffff' },
    dark: { backgroundColor: '#202d4b', color: '#ffffff' } },
};

export function getHomeTier(tier: string | null | undefined, mode: AppearanceMode) {
  const key = tier?.trim().toLowerCase() ?? '';
  const entry = Object.hasOwn(TIERS, key) ? TIERS[key] : null;
  return entry ? { id: entry.id, name: entry.name, palette: entry[mode] } : null;
}

/** The display name alone (MY's text row; names do not depend on the appearance): master → Whale, unknown → null. */
export function getHomeTierName(tier: string | null | undefined) {
  return getHomeTier(tier, 'light')?.name ?? null;
}

// The small diamond beside a community author's tier name (2026-11-07): a
// stronger shade of each card color, readable on the surface of either mode.
const TIER_ACCENTS: Record<HomeTier, { light: string; dark: string }> = {
  bronze: { light: '#A8683C', dark: '#D9A27A' },
  silver: { light: '#7D8794', dark: '#B4BEC9' },
  gold: { light: '#C29A2E', dark: '#E2C16A' },
  platinum: { light: '#2F9C8C', dark: '#6FD1C2' },
  diamond: { light: '#3F7FD9', dark: '#8DB8F2' },
  whale: { light: '#12396A', dark: '#9DB7E8' },
};

/** The tier mark color, or null for no or an unknown tier. */
export function getTierAccent(tier: string | null | undefined, mode: AppearanceMode) {
  const entry = getHomeTier(tier, mode);
  return entry ? TIER_ACCENTS[entry.id][mode] : null;
}
