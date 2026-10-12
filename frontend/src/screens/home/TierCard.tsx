import React, { useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type TextStyle } from '../../theme/native';
import type { AppearanceMode } from '../../theme/appearance';
import type { getHomeTier } from './tierPresentation';
import TierCardBackground from './TierCardBackground';
import TierEmblem from './TierEmblem';
import { TIER_BACKGROUNDS } from './tierBackgrounds';

export type TierPresentation = NonNullable<ReturnType<typeof getHomeTier>>;

/** Light foregrounds can cross bright facets: a small halo keeps the artwork visible. */
export function tierForeground(tier: TierPresentation, mode: AppearanceMode): TextStyle {
  return {
    color: tier.palette.color,
    ...(mode === 'dark' || tier.id === 'whale' ? {
      textShadowColor: '#001124', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 3,
    } : {}),
  };
}

/**
 * The season tier card (formerly Home's): the original facet background at its
 * own aspect ratio and corner proportion, information on the left and the
 * emblem on the right. Large fonts put the emblem above the information so
 * nothing is clipped; the card grows with its content.
 */
export default function TierCard({ tier, mode, emblemSize, caption, testID, children }: {
  tier: TierPresentation;
  mode: AppearanceMode;
  emblemSize: number;
  caption?: React.ReactNode;
  testID?: string;
  children: React.ReactNode;
}) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const background = TIER_BACKGROUNDS[tier.id][mode];
  const corner = tier.id === 'whale' ? 0.05 : 0.04;
  const headingTop = tier.id === 'whale' ? 0.06 : 0;
  const stacked = fontScale > 1.3;
  const emblem = (
    <View style={styles.emblem}>
      <TierEmblem tier={tier.id} size={emblemSize} />
      {caption}
    </View>
  );
  return (
    <View testID={testID} onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)} style={[styles.card, stacked && styles.stacked, {
      backgroundColor: tier.palette.backgroundColor,
      borderRadius: width * corner,
      paddingHorizontal: Math.max(12, width * 0.035),
      paddingTop: Math.max(14, width * headingTop + 10),
      paddingBottom: Math.max(14, width * corner),
      minHeight: width ? width / (background.width / background.height) : undefined,
    }]}>
      <TierCardBackground key={`${tier.id}-${mode}`} tier={tier.id} mode={mode} />
      {stacked ? emblem : null}
      <View style={[styles.info, !stacked && styles.infoBeside]}>{children}</View>
      {stacked ? null : emblem}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 4, overflow: 'hidden', minWidth: 0 },
  stacked: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  info: { minWidth: 0, gap: 6 },
  infoBeside: { flex: 1 },
  emblem: { alignItems: 'center', flexShrink: 0, maxWidth: '100%' },
});
