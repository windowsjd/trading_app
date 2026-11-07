/**
 * Home's header (2026-11-07): the mode title at the left, the mode's buttons
 * at the right (beginner 퀘스트, general 가이드 + 보상, season none). Labels
 * scale up to 1.6x; when title and labelled buttons no longer fit the width,
 * the buttons keep only their icons (their accessibility labels stay).
 * React-free so `node --test` covers it.
 */
export type HomeHeaderMode = 'beginner' | 'general' | 'season';

const PADDING = 32; // the header's 16 on each side
const GAP = 12; // between the title and the buttons
const LABEL_SIZE = 14;
const TITLE_SIZE = 20;
const TITLE_MIN_CHARS = 4; // 초보모드, 일반모드
const CHIP = 28 + 8; // the change chip and its gap
const ICON_ONLY = 44;

/** Characters of each button label. */
export function homeHeaderButtons(mode: HomeHeaderMode): readonly number[] {
  return mode === 'beginner' ? [3] : mode === 'general' ? [3, 2] : [];
}

export function homeHeaderLayout(width: number, fontScale: number, mode: HomeHeaderMode) {
  const scale = Math.min(Math.max(fontScale || 1, 1), 1.6);
  const buttons = homeHeaderButtons(mode);
  const gaps = Math.max(0, buttons.length - 1) * 8;
  // padding 12 + icon 18 + gap 6 + label + padding 12
  const labelled = buttons.reduce((sum, chars) => sum + 48 + LABEL_SIZE * chars * scale, 0) + gaps;
  const title = TITLE_SIZE * TITLE_MIN_CHARS * scale + CHIP;
  const iconOnly = buttons.length > 0 && title + labelled + GAP + PADDING > width;
  const actions = buttons.length === 0 ? 0 : iconOnly ? buttons.length * ICON_ONLY + Math.max(0, buttons.length - 1) * 4 : labelled;
  return { iconOnly, titleMaxWidth: Math.max(120, Math.floor(width - PADDING - actions - (actions ? GAP : 0))) };
}

/** The badge counts quests not yet completed; none (or unknown progress) hides it. */
export function questBadgeCount(total: number, completed: number | null): number | null {
  if (completed === null) return null;
  const remaining = Math.max(0, total - completed);
  return remaining > 0 ? remaining : null;
}
