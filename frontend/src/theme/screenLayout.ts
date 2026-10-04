import type { ViewStyle } from 'react-native';

export const DESKTOP_CONTENT_MAX_WIDTH = 1120;
export const SCREEN_SECTION_GAP = 12;

// Native stack headers and tabs own the vertical safe area. Use one gap
// between the header and content, and between the screen's main sections.
export function getHeaderScreenContentStyle(platform: string): ViewStyle {
  return {
    ...getScreenContentStyle(platform),
    paddingHorizontal: 16,
    paddingTop: SCREEN_SECTION_GAP,
    paddingBottom: 24,
    gap: SCREEN_SECTION_GAP,
  };
}

// Limit content, never the scroll viewport. Keep each screen's native spacing.
export function getScreenContentStyle(platform: string): ViewStyle {
  return platform === 'web'
    ? { width: '100%', maxWidth: DESKTOP_CONTENT_MAX_WIDTH, alignSelf: 'center' }
    : {};
}
