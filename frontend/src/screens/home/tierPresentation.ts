import type { AppearanceMode } from '../../theme/appearance';

export type HomeTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'whale';
type CardPalette = { backgroundColor: string; borderColor: string; color: string };

// Home presentation only. The ranking API's canonical top tier remains master.
const TIERS: Record<string, { id: HomeTier; name: string; light: CardPalette; dark: CardPalette }> = {
  bronze: { id: 'bronze', name: 'Bronze',
    light: { backgroundColor: '#f1d8c6', borderColor: '#d2a280', color: '#744024' },
    dark: { backgroundColor: '#432c23', borderColor: '#855639', color: '#f0bc98' } },
  silver: { id: 'silver', name: 'Silver',
    light: { backgroundColor: '#dce2e8', borderColor: '#a8b5c2', color: '#405366' },
    dark: { backgroundColor: '#343c48', borderColor: '#637387', color: '#e0e7ef' } },
  gold: { id: 'gold', name: 'Gold',
    light: { backgroundColor: '#f2e0ae', borderColor: '#ceb06d', color: '#6c5016' },
    dark: { backgroundColor: '#44371e', borderColor: '#88703c', color: '#f4d98f' } },
  platinum: { id: 'platinum', name: 'Platinum',
    light: { backgroundColor: '#c8e9e1', borderColor: '#7dbeb1', color: '#1d5e54' },
    dark: { backgroundColor: '#173e3a', borderColor: '#397c70', color: '#a3e9db' } },
  diamond: { id: 'diamond', name: 'Diamond',
    light: { backgroundColor: '#d1e4fc', borderColor: '#87b1e4', color: '#285589' },
    dark: { backgroundColor: '#1b365c', borderColor: '#4979ae', color: '#bcddff' } },
  master: { id: 'whale', name: 'Whale',
    light: { backgroundColor: '#cbd7eb', borderColor: '#8c9eba', color: '#293f64' },
    dark: { backgroundColor: '#202d4b', borderColor: '#626b88', color: '#eed7a3' } },
};

export function getHomeTier(tier: string | null | undefined, mode: AppearanceMode) {
  const key = tier?.trim().toLowerCase() ?? '';
  const entry = Object.hasOwn(TIERS, key) ? TIERS[key] : null;
  return entry ? { id: entry.id, name: entry.name, palette: entry[mode] } : null;
}
