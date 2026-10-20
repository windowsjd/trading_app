import React from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { Text, View } from '../../theme/native';

/** The server supplies the launch badge independently of its reusable name/ID. */
export default function SeasonTitle({ name, displayBadge, style, containerStyle, testID, heading = false, numberOfLines }: {
  name: string; displayBadge?: 'beta'; style?: StyleProp<TextStyle>; containerStyle?: StyleProp<ViewStyle>;
  testID?: string; heading?: boolean;
  numberOfLines?: number;
}) {
  return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1, maxWidth: '100%' }, containerStyle]}
    accessible accessibilityLabel={displayBadge === 'beta' ? `${name}, beta` : name} accessibilityRole={heading ? 'header' : undefined}>
    <Text testID={testID} numberOfLines={numberOfLines} style={[{ flexShrink: 1, minWidth: 0, maxWidth: '100%' }, style]}>{name}</Text>
    {displayBadge === 'beta' ? <View testID={testID ? `${testID}-beta` : undefined} accessible={false}
      style={{ backgroundColor: '#565B63', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2, minHeight: 20, justifyContent: 'center' }}>
      <Text style={{ color: '#FFFFFF', fontSize: 11, lineHeight: 14 }}>beta</Text>
    </View> : null}
  </View>;
}
