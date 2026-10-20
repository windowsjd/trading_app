/**
 * The account sheet's scrolling area (계정 변경 바텀시트): up to about 85% of
 * the window, but never under the status bar or behind the navigation bar /
 * home indicator. BottomSheetBackdrop adds its own frame around the content
 * (20 top padding, at most 20 above the bottom inset), and a strip of the
 * dimmed backdrop stays visible above the sheet so it can still be tapped
 * to close. Taller content scrolls inside.
 */
export const ACCOUNT_SHEET_HEIGHT_RATIO = 0.85;
const SHEET_FRAME = 20 + 20;
const BACKDROP_STRIP = 24;

export function accountSheetMaxHeight(
  windowHeight: number,
  insets: { top: number; bottom: number },
): number {
  return Math.max(
    0,
    Math.min(
      windowHeight * ACCOUNT_SHEET_HEIGHT_RATIO,
      windowHeight - insets.top - insets.bottom - SHEET_FRAME - BACKDROP_STRIP,
    ),
  );
}
