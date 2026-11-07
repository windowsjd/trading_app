import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { View } from '../../theme/native';

export type CommunityIconName =
  | 'heart' | 'comment' | 'flame' | 'photo' | 'pencil' | 'more' | 'shield' | 'info'
  | 'send' | 'plus' | 'close' | 'check' | 'chevron';

// Hand-drawn 24×24 paths (no icon font or library). Stroked unless `filled`.
const STROKES: Record<Exclude<CommunityIconName, 'more' | 'flame'>, string> = {
  heart: 'M12 20.3s-7.4-4.5-9.1-9.2C1.8 8.1 3.7 4.6 7.1 4.6c2 0 3.4 1.1 4.9 3 1.5-1.9 2.9-3 4.9-3 3.4 0 5.3 3.5 4.2 6.5-1.7 4.7-9.1 9.2-9.1 9.2Z',
  comment: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
  photo: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5Z M3 16l5-5 4 4 3-3 6 6 M15.5 9.5h.01',
  pencil: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z M14 8l3 3',
  shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 11v5 M12 8h.01',
  send: 'M12 19V5 M6 11l6-6 6 6',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M9 5l7 7-7 7',
};
const FLAME = 'M12.3 2c.9 3.1-1.2 5.1-2.8 7.1-1.4 1.8-2.7 3.5-2.7 5.9a5.2 5.2 0 0 0 10.4 0c0-2.1-1-3.8-2.3-5.2.1 1.6-.6 2.7-1.6 3.2.6-2.9-.1-5.5-1-11Z';

/** A decorative icon: screen readers get the label of the control around it. */
export default function CommunityIcon({ name, size = 18, color, filled = false, strokeWidth = 1.8 }: {
  name: CommunityIconName; size?: number; color: string; filled?: boolean; strokeWidth?: number;
}) {
  let drawing: React.ReactNode;
  if (name === 'more') {
    drawing = <>{[5, 12, 19].map((cx) => <Circle key={cx} cx={cx} cy={12} r={1.9} fill={color} stroke="none" />)}</>;
  } else if (name === 'flame') {
    drawing = <Path d={FLAME} fill={color} stroke="none" />;
  } else {
    drawing = <Path d={STROKES[name]} fill={filled ? color : 'none'} />;
  }
  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none">
      <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth}
        strokeLinecap="round" strokeLinejoin="round" fill="none" focusable={false}>
        {drawing}
      </Svg>
    </View>
  );
}
