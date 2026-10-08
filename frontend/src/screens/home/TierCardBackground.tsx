import React, { useState } from 'react';
import Svg, { Image as SvgImage } from 'react-native-svg';
import { StyleSheet, View } from '../../theme/native';
import type { AppearanceMode } from '../../theme/appearance';
import type { HomeTier } from './tierPresentation';
import { TIER_BACKGROUNDS } from './tierBackgrounds';

export default function TierCardBackground({ tier, mode }: { tier: HomeTier; mode: AppearanceMode }) {
  const asset = TIER_BACKGROUNDS[tier][mode];
  const [width, setWidth] = useState(0);
  const scale = width / asset.width;
  // Preserve the artwork through its last interior row, plus all four corners.
  // Extension uses only edge-color scanlines. Keeping the lower center artwork
  // in place avoids turning diagonal facets into steps above the bottom rim.
  const corner = Math.ceil(asset.width * 0.06);
  const rim = tier === 'whale' ? 20 : 8;
  const cut = asset.height - corner;
  const centerWidth = asset.width - corner * 2;
  const bands = [
    { name: 'artwork', x: 0, width: asset.width, sourceY: 0, sourceHeight: cut, style: { top: 0, height: cut * scale } },
    { name: 'lower-artwork', x: corner, width: centerWidth, sourceY: cut, sourceHeight: corner - rim,
      style: { top: cut * scale, height: (corner - rim) * scale } },
    { name: 'extension', x: corner, width: centerWidth, sourceY: asset.height - rim - 0.5, sourceHeight: 1,
      style: { top: (asset.height - rim) * scale, bottom: rim * scale } },
    ...[0, asset.width - corner].flatMap((x, index) => [
      { name: `side-extension-${index}`, x, width: corner, sourceY: cut - 0.5, sourceHeight: 1,
        style: { top: cut * scale, bottom: corner * scale } },
      { name: `bottom-corner-${index}`, x, width: corner, sourceY: cut, sourceHeight: corner,
        style: { bottom: 0, height: corner * scale } },
    ]),
    { name: 'bottom-rim', x: corner, width: centerWidth, sourceY: asset.height - rim, sourceHeight: rim,
      style: { bottom: 0, height: rim * scale } },
  ];
  return (
    <View testID={`home-tier-background-${tier}-${mode}`} style={styles.background}
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
      {width > 0 && bands.map(band => (
        <View key={band.name} testID={`home-tier-background-${band.name}`}
          style={[{ position: 'absolute', left: band.x * scale, width: band.width * scale, overflow: 'hidden' }, band.style]}>
          <Svg width="100%" height="100%"
            viewBox={`${band.x} ${band.sourceY} ${band.width} ${band.sourceHeight}`} preserveAspectRatio="none">
            <SvgImage href={asset.source} x={0} y={0} width={asset.width} height={asset.height} />
          </Svg>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  background: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
});
