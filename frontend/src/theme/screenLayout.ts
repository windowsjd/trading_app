import type { ViewStyle } from 'react-native';

export const DESKTOP_CONTENT_MAX_WIDTH = 1120;

// Limit content, never the scroll viewport. Keep each screen's native spacing.
export function getScreenContentStyle(platform: string): ViewStyle {
  return platform === 'web'
    ? { width: '100%', maxWidth: DESKTOP_CONTENT_MAX_WIDTH, alignSelf: 'center' }
    : {};
}
