import type { AppearanceMode } from '../../theme/appearance';

export type HomeTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'whale';
type CardPalette = { backgroundColor: string; borderColor: string; color: string };

// Home presentation only. The ranking API's canonical top tier remains master.
const TIERS: Record<string, { id: HomeTier; name: string; light: CardPalette; dark: CardPalette }> = {
  bronze: { id: 'bronze', name: 'Bronze',
    light: { backgroundColor: '#faf3ee', borderColor: '#debfaa', color: '#794729' },
    dark: { backgroundColor: '#29211e', borderColor: '#624735', color: '#e8b38d' } },
  silver: { id: 'silver', name: 'Silver',
    light: { backgroundColor: '#f0f3f6', borderColor: '#c5ced8', color: '#4d6072' },
    dark: { backgroundColor: '#22262d', borderColor: '#485564', color: '#d2dce7' } },
  gold: { id: 'gold', name: 'Gold',
    light: { backgroundColor: '#faf5e9', borderColor: '#ddc896', color: '#795b1d' },
    dark: { backgroundColor: '#29251d', borderColor: '#625337', color: '#eacf8c' } },
  platinum: { id: 'platinum', name: 'Platinum',
    light: { backgroundColor: '#edf8f5', borderColor: '#a7d6cc', color: '#24695f' },
    dark: { backgroundColor: '#1b2d2c', borderColor: '#386760', color: '#99e0d4' } },
  diamond: { id: 'diamond', name: 'Diamond',
    light: { backgroundColor: '#eef4fc', borderColor: '#b0cbee', color: '#315f96' },
    dark: { backgroundColor: '#1b273b', borderColor: '#3b5880', color: '#b0d4ff' } },
  master: { id: 'whale', name: 'Whale',
    light: { backgroundColor: '#eaf0f7', borderColor: '#9aacc5', color: '#304c71' },
    dark: { backgroundColor: '#172338', borderColor: '#455570', color: '#e3cea0' } },
};

export function getHomeTier(tier: string | null | undefined, mode: AppearanceMode) {
  const key = tier?.trim().toLowerCase() ?? '';
  const entry = Object.hasOwn(TIERS, key) ? TIERS[key] : null;
  return entry ? { id: entry.id, name: entry.name, palette: entry[mode] } : null;
}
