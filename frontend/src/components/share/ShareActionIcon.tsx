import React from 'react';
import { View } from '../../theme/native';
import Svg, { Path } from 'react-native-svg';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import type { ShareAction } from '../../features/share/shareTargets';

/**
 * 수익 공유's two action icons in the theme's own colors: 공유하기 (an arrow out
 * of a tray, the system share sheet) and 이미지 저장 (an arrow into a tray).
 */
export default function ShareActionIcon({ action, size = 28 }: { action: ShareAction; size?: number }) {
  const { colors } = useAppearance();
  return (
    <View accessible={false} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: semantic.raised,
      borderWidth: 1, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" accessible={false}>
        <Path d={action === 'save'
          ? 'M12 3v11m0 0-4.5-4.5M12 14l4.5-4.5M4 15.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5'
          : 'M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5'}
          stroke={colors.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
    </View>
  );
}
