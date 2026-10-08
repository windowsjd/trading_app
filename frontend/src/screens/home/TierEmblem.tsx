import React from 'react';
import { Image, View, type ImageSourcePropType } from '../../theme/native';
import type { HomeTier } from './tierPresentation';
import bronze from '../../assets/home-tiers/bronze.png';
import silver from '../../assets/home-tiers/silver.png';
import gold from '../../assets/home-tiers/gold.png';
import platinum from '../../assets/home-tiers/platinum.png';
import diamond from '../../assets/home-tiers/diamond.png';
import whale from '../../assets/home-tiers/whale.png';
import preparation from '../../assets/home-tiers/preparation.json';

const EMBLEMS: Record<HomeTier, ImageSourcePropType> = { bronze, silver, gold, platinum, diamond, whale };

// Optical adjustment after comparing the complete silhouettes at card size.
// Diamond's wide, sparse side ornaments otherwise outweigh Whale's denser body.
// Scale both axes together; the prepared artwork and rim geometry stay intact.
export const EMBLEM_OPTICAL_SCALE: Record<HomeTier, number> = {
  bronze: 1, silver: 1.005, gold: 1.01, platinum: 1.015, diamond: 0.985, whale: 1.065,
};

export default function TierEmblem({ tier, size }: { tier: HomeTier; size: number }) {
  // Keep the prepared intrinsic ratio; no new circle correction or asset edits.
  const layout = preparation[tier].displayAt160;
  const scale = size / 160 * EMBLEM_OPTICAL_SCALE[tier];
  const width = layout.width * scale;
  const height = layout.height * scale;
  return (
    <View testID={`home-emblem-${tier}`} style={{ width, height, flexShrink: 0 }}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
      <Image testID="home-tier-image" source={EMBLEMS[tier]} resizeMode="contain"
        style={{ width, height }} accessible={false} />
    </View>
  );
}
