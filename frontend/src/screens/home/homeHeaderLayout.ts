/**
 * Home's header (2026-11-07): the mode title at the left, the mode's buttons
 * at the right (beginner 퀘스트, general 가이드 + 보상, season none). Labels
 * scale up to 1.6x; when title and labelled buttons no longer fit the width,
 * the buttons keep only their icons (their accessibility labels stay). If
 * even then the four-character mode title and its 계정변경 chip do not fit
 * (narrow screens, large text), the chip stops scaling and the title scales
 * only as far as it fits — nothing is cut. React-free so `node --test`
 * covers it.
 */
export type HomeHeaderMode = 'beginner' | 'general' | 'season';

/**
 * The title's 계정변경 chip (2026-11-07 (3), formerly a 28dp ⇄ icon): 13/600
 * text, scaling up to 1.3x, in a 28dp chip with 8dp sides. It never shrinks
 * or wraps; the title beside it gives way.
 */
export const HOME_ACCOUNT_CHANGE_LABEL = '계정변경';
export const HOME_ACCOUNT_CHANGE_FONT_SIZE = 13;
export const HOME_ACCOUNT_CHANGE_FONT_CAP = 1.3;
export const HOME_ACCOUNT_CHANGE_PADDING = 8;

const PADDING = 32; // the header's 16 on each side
const GAP = 12; // between the title and the buttons
const LABEL_SIZE = 14;
const TITLE_SIZE = 20;
const TITLE_MIN_CHARS = 4; // 초보모드, 일반모드
const CHIP_GAP = 8; // between the title and its chip
const GLYPH_SLACK = 1; // per character: text width is not linear in the font size
const ICON_ONLY = 44;

/** The 계정변경 chip's width (with its gap to the title) at a font scale. */
export function homeAccountChangeWidth(fontScale: number) {
  const scale = Math.min(Math.max(fontScale || 1, 1), HOME_ACCOUNT_CHANGE_FONT_CAP);
  const chars = HOME_ACCOUNT_CHANGE_LABEL.length;
  return Math.ceil(chars * (HOME_ACCOUNT_CHANGE_FONT_SIZE * scale + GLYPH_SLACK)) + HOME_ACCOUNT_CHANGE_PADDING * 2 + CHIP_GAP;
}

/** Characters of each button label. */
export function homeHeaderButtons(mode: HomeHeaderMode): readonly number[] {
  return mode === 'beginner' ? [3] : mode === 'general' ? [3, 2] : [];
}

export const HOME_TITLE_FONT_CAP = 1.6;

/** The four-character mode title's width at a scale (with the per-glyph slack). */
export function homeTitleMinWidth(scale: number) {
  return Math.ceil(TITLE_MIN_CHARS * (TITLE_SIZE * scale + GLYPH_SLACK));
}

export function homeHeaderLayout(width: number, fontScale: number, mode: HomeHeaderMode) {
  const scale = Math.min(Math.max(fontScale || 1, 1), HOME_TITLE_FONT_CAP);
  const buttons = homeHeaderButtons(mode);
  const gaps = Math.max(0, buttons.length - 1) * 8;
  // padding 12 + icon 18 + gap 6 + label + padding 12
  const labelled = buttons.reduce((sum, chars) => sum + 48 + LABEL_SIZE * chars * scale, 0) + gaps;
  const title = homeTitleMinWidth(scale) + homeAccountChangeWidth(fontScale);
  const iconOnly = buttons.length > 0 && title + labelled + GAP + PADDING > width;
  const actions = buttons.length === 0 ? 0 : iconOnly ? buttons.length * ICON_ONLY + Math.max(0, buttons.length - 1) * 4 : labelled;
  const titleMaxWidth = Math.max(120, Math.floor(width - PADDING - actions - (actions ? GAP : 0)));
  // Still no room beside the icons: the chip keeps its 1x size and the title
  // grows only as far as the whole mode name still fits (in 0.1 steps).
  if (title <= titleMaxWidth)
    return { iconOnly, titleMaxWidth, titleFontCap: HOME_TITLE_FONT_CAP, changeFontCap: HOME_ACCOUNT_CHANGE_FONT_CAP };
  const room = titleMaxWidth - homeAccountChangeWidth(1);
  let titleFontCap = 1;
  for (let cap = 1.1; cap <= HOME_TITLE_FONT_CAP + 1e-9; cap += 0.1)
    if (homeTitleMinWidth(cap) <= room) titleFontCap = Math.round(cap * 10) / 10;
  return { iconOnly, titleMaxWidth, titleFontCap, changeFontCap: 1 };
}

/** The badge counts quests not yet completed; none (or unknown progress) hides it. */
export function questBadgeCount(total: number, completed: number | null): number | null {
  if (completed === null) return null;
  const remaining = Math.max(0, total - completed);
  return remaining > 0 ? remaining : null;
}
