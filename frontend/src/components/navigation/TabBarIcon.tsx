import React from 'react';
import { View } from '../../theme/native';
import Svg, { Circle, Path } from 'react-native-svg';

export type TabIconName =
  | 'home'
  | 'market'
  | 'guide'
  | 'quest'
  | 'ranking'
  | 'record'
  | 'wallet'
  | 'profile'
  | 'menu';

type Props = {
  name: TabIconName;
  color: string;
  size: number;
  focused?: boolean;
};

// The bottom edge turns into the arched doorway. Filling the same contour
// leaves that opening transparent at both tab and header sizes.
const HOME_HOUSE = 'M10.65 3.55Q12 2.4 13.35 3.55L20.15 9.4Q21 10.15 21 11.3V18.7Q21 21 18.7 21H15.35Q14.8 21 14.8 20.45V16.1C14.8 14.75 13.75 13.7 12.4 13.7H11.6C10.25 13.7 9.2 14.75 9.2 16.1V20.45Q9.2 21 8.65 21H5.3Q3 21 3 18.7V11.3Q3 10.15 3.85 9.4Z';
// A goal pennant on a pole: a mission marker, unlike the guide's open book
// and the ranking trophy. The filled pole is a solid bar of the same width.
const QUEST_FLAG_OUTLINE = 'M5 21V3 M5 4h13.5l-3.3 4.5 3.3 4.5H5';
const QUEST_FLAG_FILLED = 'M4 3h2v18H4z M6 4h13.5l-3.3 4.5 3.3 4.5H6z';

export default function TabBarIcon({ name, color, size, focused = false }: Props) {
  let drawing: React.ReactNode;

  if (name === 'home') {
    drawing = (
      <Path d={HOME_HOUSE} strokeWidth={2.2} />
    );
  } else if (focused) {
    switch (name) {
      case 'market': drawing = <><Path d="M2 7h5v8H2zM9 10h5v8H9zM16 5h6v7h-6z" /><Path d="M4.5 3v18M11.5 3v18M19 2v19" fill="none" stroke={color} strokeWidth={2} /></>; break;
      case 'guide': drawing = <Path d="M3 3h6c1.3 0 2.5.5 3 1.5C12.5 3.5 13.7 3 15 3h6v17h-6c-1.4 0-2.4.5-3 1-0.6-.5-1.6-1-3-1H3V3Zm8 2v12c-1-.6-2-.8-3-.8H5V5h3c1.3 0 2.3.1 3 0Zm2 0v12c1-.6 2-.8 3-.8h3V5h-3c-1.3 0-2.3.1-3 0Z" fillRule="evenodd" />; break;
      case 'quest': drawing = <Path d={QUEST_FLAG_FILLED} />; break;
      case 'ranking': drawing = <Path d="M6 2h12v3h4v3c0 3-2 5-5 5-.6 1.5-2 2.5-4 3v3h4v3H7v-3h4v-3c-2-.5-3.4-1.5-4-3-3 0-5-2-5-5V5h4V2Zm0 5H4v1c0 1.2.6 2 2 2V7Zm12 0v3c1.4 0 2-.8 2-2V7h-2Z" fillRule="evenodd" />; break;
      case 'wallet': drawing = <Path d="M4 3h15v3H5a1 1 0 0 0 0 2h16v4h-6v6h6v3H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm13 11v2h5v-2h-5Z" fillRule="evenodd" />; break;
      case 'record': drawing = <Path d="M8 2h8v3h3v17H5V5h3V2Zm2 2v2h4V4h-4Zm-2 6v2h8v-2H8Zm0 4v2h8v-2H8Zm0 4v2h6v-2H8Z" fillRule="evenodd" />; break;
      case 'menu': drawing = <Path d="M4 5h16v3H4zM4 11h16v3H4zM4 17h16v3H4z" />; break;
      case 'profile': drawing = <><Circle cx={12} cy={7} r={4} /><Path d="M3 21v-2c0-3 3-5 6-5h6c3 0 6 2 6 5v2H3Z" /></>; break;
    }
  } else switch (name) {
    case 'market':
      drawing = (
        <Path d="M3 7h4v7H3z M5 3v4m0 7v7 M10 10h4v7h-4z M12 3v7m0 7v4 M17 5h4v6h-4z M19 3v2m0 6v10" />
      );
      break;
    case 'guide':
      drawing = (
        <Path d="M4 4h5a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H4V4Z M20 4h-5a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h5V4Z" />
      );
      break;
    case 'quest':
      drawing = <Path d={QUEST_FLAG_OUTLINE} />;
      break;
    case 'ranking':
      drawing = (
        <Path d="M6 3h12v6a6 6 0 0 1-12 0V3Z M6 5H3v3a4 4 0 0 0 4 4 M18 5h3v3a4 4 0 0 1-4 4 M12 15v4 M8 21v-2h8v2 M6 21h12" />
      );
      break;
    case 'wallet':
      drawing = <Path d="M20 7V3H5a2 2 0 0 0 0 4h16v14H5a2 2 0 0 1-2-2V5 M21 12h-6v5h6 M18 14.5h.01" />;
      break;
    case 'record':
      drawing = (
        <Path d="M8 5H5v16h14V5h-3 M8 3h8v4H8z M8 11h8 M8 15h8 M8 18h5" />
      );
      break;
    case 'menu':
      drawing = <Path d="M4 6h16 M4 12h16 M4 18h16" />;
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
        fill={focused ? color : 'none'}
        stroke={focused ? 'none' : color}
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
