import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

type TabIconName = 'home' | 'market' | 'ranking' | 'record' | 'profile';

type Props = {
  name: TabIconName;
  color: string;
  size: number;
};

export default function TabBarIcon({ name, color, size }: Props) {
  let drawing: React.ReactNode;

  switch (name) {
    case 'home':
      drawing = <Path d="M3 10 12 3 21 10 M5 9v12h14V9 M9 21v-7h6v7" />;
      break;
    case 'market':
      drawing = (
        <Path d="M3 7h4v7H3z M5 3v4m0 7v7 M10 10h4v7h-4z M12 3v7m0 7v4 M17 5h4v6h-4z M19 3v2m0 6v10" />
      );
      break;
    case 'ranking':
      drawing = (
        <Path d="M6 3h12v6a6 6 0 0 1-12 0V3Z M6 5H3v3a4 4 0 0 0 4 4 M18 5h3v3a4 4 0 0 1-4 4 M12 15v4 M8 21v-2h8v2 M6 21h12" />
      );
      break;
    case 'record':
      drawing = (
        <Path d="M8 5H5v16h14V5h-3 M8 3h8v4H8z M8 11h8 M8 15h8 M8 18h5" />
      );
      break;
    case 'profile':
      drawing = (
        <>
          <Circle cx={12} cy={7} r={4} />
          <Path d="M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2" />
        </>
      );
      break;
  }

  // The tab owns the accessible label. Hide both active/inactive SVG copies
  // from screen readers, using View so native accessibility props map on web.
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
    >
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable={false}
        aria-hidden
      >
        {drawing}
      </Svg>
    </View>
  );
}
