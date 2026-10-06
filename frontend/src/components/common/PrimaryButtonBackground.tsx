import React, { useId } from 'react';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet, View, type ViewStyle } from '../../theme/native';
import { primaryGradient, type ActionGradient } from '../../theme/tokens';

/** A decoration only: relative SVG coordinates fill each button's actual width. */
export default function PrimaryButtonBackground({ shape, gradient = primaryGradient }: { shape: ViewStyle; gradient?: ActionGradient }) {
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
            x1={gradient.start.x}
            y1={gradient.start.y}
            x2={gradient.end.x}
            y2={gradient.end.y}
          >
            <Stop offset={gradient.locations[0]} stopColor={gradient.colors[0]} stopOpacity={gradient.opacity} />
            <Stop offset={gradient.locations[1]} stopColor={gradient.colors[1]} stopOpacity={gradient.opacity} />
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
