import React from 'react';
import { StyleSheet, View } from '../../theme/native';

/** The glow band's width just outside the control's edge. */
const GLOW_WIDTH = 4;

/**
 * Surface decoration only. The owner gates it by the current guide and capability.
 *
 * A steady glow drawn OUTSIDE the highlighted control. Nothing here paints over
 * the control: a tinted fill, an inner border with its blurred shadow and a
 * white shine sweeping across it used to sit on top of the control's own text
 * and icons, so they looked smeared inside the guide's blue ring. The guide
 * overlay's dim and ring stay the spotlight; the control keeps every press.
 */
export default function QuestTargetHighlight({ active, radius }: { active: boolean; radius: number }) {
  if (!active) return null;
  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      testID="quest-target-highlight" style={StyleSheet.absoluteFill}>
      <View testID="quest-target-glow" style={[styles.glow, { borderRadius: radius + GLOW_WIDTH }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Negative insets and a border as wide as the inset: the band lies entirely
  // outside the control's edge, its inner corners follow the control's radius.
  glow: {
    position: 'absolute',
    top: -GLOW_WIDTH,
    bottom: -GLOW_WIDTH,
    left: -GLOW_WIDTH,
    right: -GLOW_WIDTH,
    borderWidth: GLOW_WIDTH,
    borderColor: 'rgba(112,175,255,0.16)',
  },
});
