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
  // Keep the reviewed slot, silhouette area and optical scale. New originals
  // include transparent padding: position the complete canvas around the same
  // visible silhouette without cropping/resampling pixels or correcting rims.
  const asset = preparation[tier];
  const layout = asset.displayAt160;
  const scale = size / 160 * EMBLEM_OPTICAL_SCALE[tier];
  const width = layout.width * scale;
  const height = layout.height * scale;
  const image = 'imageAt160' in asset ? asset.imageAt160 : { ...layout, left: 0, top: 0 };
  return (
    <View testID={`home-emblem-${tier}`} style={{ width, height, flexShrink: 0 }}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
      <Image testID="home-tier-image" source={EMBLEMS[tier]} resizeMode="contain"
        style={{ position: 'absolute', left: image.left * scale, top: image.top * scale,
          width: image.width * scale, height: image.height * scale }} accessible={false} />
    </View>
  );
}
