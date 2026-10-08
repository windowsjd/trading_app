import type { ImageSourcePropType } from '../../theme/native';
import type { AppearanceMode } from '../../theme/appearance';
import type { HomeTier } from './tierPresentation';
import bronzeLight from '../../assets/home-tier-backgrounds/01_Bronze_Light.png';
import bronzeDark from '../../assets/home-tier-backgrounds/01_Bronze_Dark.png';
import silverLight from '../../assets/home-tier-backgrounds/02_Silver_Light.png';
import silverDark from '../../assets/home-tier-backgrounds/02_Silver_Dark.png';
import goldLight from '../../assets/home-tier-backgrounds/03_Gold_Light.png';
import goldDark from '../../assets/home-tier-backgrounds/03_Gold_Dark.png';
import platinumLight from '../../assets/home-tier-backgrounds/04_Platinum_Light.png';
import platinumDark from '../../assets/home-tier-backgrounds/04_Platinum_Dark.png';
import diamondLight from '../../assets/home-tier-backgrounds/05_Diamond_Light.png';
import diamondDark from '../../assets/home-tier-backgrounds/05_Diamond_Dark.png';
import whaleLight from '../../assets/home-tier-backgrounds/06_Whale_Light.png';
import whaleDark from '../../assets/home-tier-backgrounds/06_Whale_Dark.png';
import manifest from '../../assets/home-tier-backgrounds/manifest.json';

type Background = { source: ImageSourcePropType; width: number; height: number };
function asset(source: ImageSourcePropType, filename: keyof typeof manifest): Background {
  const { width, height } = manifest[filename];
  return { source, width, height };
}

// Original ZIP filenames and bytes are retained. Canonical master is mapped to
// Home's whale by getHomeTier before reaching this presentation-only table.
export const TIER_BACKGROUNDS: Record<HomeTier, Record<AppearanceMode, Background>> = {
  bronze: { light: asset(bronzeLight, '01_Bronze_Light.png'), dark: asset(bronzeDark, '01_Bronze_Dark.png') },
  silver: { light: asset(silverLight, '02_Silver_Light.png'), dark: asset(silverDark, '02_Silver_Dark.png') },
  gold: { light: asset(goldLight, '03_Gold_Light.png'), dark: asset(goldDark, '03_Gold_Dark.png') },
  platinum: { light: asset(platinumLight, '04_Platinum_Light.png'), dark: asset(platinumDark, '04_Platinum_Dark.png') },
  diamond: { light: asset(diamondLight, '05_Diamond_Light.png'), dark: asset(diamondDark, '05_Diamond_Dark.png') },
  whale: { light: asset(whaleLight, '06_Whale_Light.png'), dark: asset(whaleDark, '06_Whale_Dark.png') },
};
