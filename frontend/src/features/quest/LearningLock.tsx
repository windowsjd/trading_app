import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { semantic } from '../../theme/tokens';
/** Small shape cue complements desaturated controls; the owner supplies the label. */
export default function LearningLock() {
  return <Svg width={14} height={16} viewBox="0 0 14 16" accessible={false} testID="learning-lock-icon">
    <Path d="M4 7V5a3 3 0 0 1 6 0v2" stroke={semantic.secondary} strokeWidth={1.6} fill="none" />
    <Rect x={2} y={7} width={10} height={8} rx={2} fill={semantic.secondary} />
  </Svg>;
}
