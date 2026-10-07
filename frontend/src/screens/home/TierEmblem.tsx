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

export default function TierEmblem({ tier, size }: { tier: HomeTier; size: number }) {
  // Non-square silhouettes keep their intrinsic ratio. Prepared visible alpha
  // area, rather than transparent canvas width, sets the subtle 1% progression.
  const layout = preparation[tier].displayAt160;
  const width = layout.width * size / 160;
  const height = layout.height * size / 160;
  return (
    <View testID={`home-emblem-${tier}`} style={{ width, height, flexShrink: 0 }}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
      <Image testID="home-tier-image" source={EMBLEMS[tier]} resizeMode="contain"
        style={{ width, height }} accessible={false} />
    </View>
  );
}
