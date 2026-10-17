/** Home's total assets type size: the base, before the system font scale. */
export const HERO_TOTAL_FONT_SIZE = 36;
/** Never smaller than the 총 자산 label above it (18, bold). */
export const HERO_TOTAL_MIN_FONT_SIZE = 18;
/** Between the total's column and the tier emblem. */
export const HERO_ASIDE_GAP = 12;
// Kept free on the line. Glyph advances do not scale exactly linearly with
// the font size (renderers round each glyph's advance: 232 dp at 36 measured
// 220 at 33.5, not 216), so the room grows with the number of glyphs.
const SAFETY = 2;
const SAFETY_PER_GLYPH = 0.5;
/** One correction step when a drawn line still breaks. */
export const HERO_TOTAL_SHRINK_STEP = 0.5;

/**
 * Where Home's tier emblem goes and how large the total assets are, from three
 * measured widths (dp): the hero row, the emblem column, and the total at the
 * base size, unwrapped (the system font scale is already in it).
 *
 * The emblem stays beside the total in one fixed-width column (row - gap -
 * emblem), whatever the amount: a total too long for that column is drawn at
 * a smaller size that fits, never cut or ellipsized. Only when even the
 * minimum size cannot fit beside the emblem (large text on a narrow phone,
 * e.g. 360 dp at x1.3 beside Diamond) does the emblem move below the total,
 * which then takes the whole row.
 *
 * `shrinkSteps` counts half points taken off because the drawn line still
 * broke (HomeAssetHero checks the drawn height); it never goes below the
 * minimum, and past the minimum beside the emblem the emblem moves below.
 *
 * `aside` null = no emblem (general/beginner accounts); 0 = not measured yet.
 * Until every width is known the intended layout is kept: beside, base size.
 */
export function fitHeroTotal({ row, aside, natural, glyphs = 0, shrinkSteps = 0 }: {
  row: number;
  aside: number | null;
  natural: number;
  /** Characters in the total (`10,450,000원` = 11). */
  glyphs?: number;
  shrinkSteps?: number;
}) {
  const base = HERO_TOTAL_FONT_SIZE;
  if (!(row > 0) || !(natural > 0) || (aside !== null && !(aside > 0))) return { beside: true, fontSize: base };
  const safety = SAFETY + SAFETY_PER_GLYPH * glyphs;
  const shrink = HERO_TOTAL_SHRINK_STEP * shrinkSteps;
  // Half-point steps, rounded down: the scaled width stays inside `width`.
  const fit = (width: number) => Math.min(base, Math.floor(base * (width - safety) / natural * 2) / 2) - shrink;
  if (aside === null) return { beside: true, fontSize: Math.max(HERO_TOTAL_MIN_FONT_SIZE, fit(row)) };
  const besideSize = fit(row - HERO_ASIDE_GAP - aside);
  if (besideSize >= HERO_TOTAL_MIN_FONT_SIZE) return { beside: true, fontSize: besideSize };
  return { beside: false, fontSize: Math.max(HERO_TOTAL_MIN_FONT_SIZE, fit(row)) };
}
