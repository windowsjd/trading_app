import React, { useId } from 'react';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet, View, type ViewStyle } from '../../theme/native';
import { primaryGradient } from '../../theme/tokens';

/** A decoration only: relative SVG coordinates fill each button's actual width. */
export default function PrimaryButtonBackground({ shape }: { shape: ViewStyle }) {
  const id = `primary-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.clip, shape]}
    >
      <Svg width="100%" height="100%" pointerEvents="none" accessible={false}>
        <Defs>
          <LinearGradient
            id={id}
            gradientUnits="objectBoundingBox"
            x1={primaryGradient.start.x}
            y1={primaryGradient.start.y}
            x2={primaryGradient.end.x}
            y2={primaryGradient.end.y}
          >
            <Stop offset={primaryGradient.locations[0]} stopColor={primaryGradient.colors[0]} stopOpacity={primaryGradient.opacity} />
            <Stop offset={primaryGradient.locations[1]} stopColor={primaryGradient.colors[1]} stopOpacity={primaryGradient.opacity} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
});
