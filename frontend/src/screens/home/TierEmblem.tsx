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

/** The emblem's slot width at `size`: its visible silhouette, optically scaled. */
export function tierEmblemWidth(tier: HomeTier, size: number) {
  // Same arithmetic as TierEmblem, so the column matches its slot exactly.
  return preparation[tier].displayAt160.width * (size / 160 * EMBLEM_OPTICAL_SCALE[tier]);
}

/** The `size` at which the emblem's slot fits whole inside a `box` square, proportions kept. */
export function tierEmblemSizeToFit(tier: HomeTier, box: number) {
  const { width, height } = preparation[tier].displayAt160;
  return box * 160 / (Math.max(width, height) * EMBLEM_OPTICAL_SCALE[tier]);
}

/**
 * The visible silhouette at `size`: the prepared alpha bounds, placed as
 * TierEmblem places the canvas, as edges from the slot's top-left. The slot
 * is a layout box; this is the emblem a viewer sees.
 */
export function tierEmblemVisibleBox(tier: HomeTier, size: number) {
  const asset = preparation[tier];
  const image = 'imageAt160' in asset ? asset.imageAt160 : { ...asset.displayAt160, left: 0, top: 0 };
  const [left, top, right, bottom] = asset.outputMetrics.bounds;
  const [width, height] = asset.outputSize;
  const scale = size / 160 * EMBLEM_OPTICAL_SCALE[tier];
  const x = (column: number) => (image.left + column / width * image.width) * scale;
  const y = (row: number) => (image.top + row / height * image.height) * scale;
  return { left: x(left), top: y(top), right: x(right), bottom: y(bottom) };
}

export default function TierEmblem({ tier, size, testID = `home-emblem-${tier}`, imageTestID = 'home-tier-image' }: {
  tier: HomeTier;
  size: number;
  /** Defaults are Home's ids; other screens (ranking rows) pass their own. */
  testID?: string;
  imageTestID?: string;
}) {
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
    <View testID={testID} style={{ width, height, flexShrink: 0 }}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
      <Image testID={imageTestID} source={EMBLEMS[tier]} resizeMode="contain"
        style={{ position: 'absolute', left: image.left * scale, top: image.top * scale,
          width: image.width * scale, height: image.height * scale }} accessible={false} />
    </View>
  );
}
