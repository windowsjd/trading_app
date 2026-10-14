// Line breaks around figures in guide text. Korean text may wrap between any
// two syllables and after a digit, so `1,000,000원` could end a line with `원`
// below it and `-0.2%포인트` could become `-0.2%포` / `인트`. An invisible
// WORD JOINER (U+2060) inside each figure keeps a number and its unit together
// (the space in `만 원` becomes a NO-BREAK SPACE), and a range wraps after its
// tilde (ZERO WIDTH SPACE, U+200B) instead of inside a number. What a reader
// sees and the values stay exactly as formatted. Only break opportunities
// change, so a figure wider than its whole line still wraps, never overflows:
// given the line, such a figure wraps where it stays readable (breakable).

export const WORD_JOINER = '\u2060';
export const ZERO_WIDTH_SPACE = '\u200B';
// The space inside 만 원: it looks like a space but never ends a line.
export const NO_BREAK_SPACE = '\u00A0';

// Units written right after a number in the guides; longer units first.
const UNITS = ['%포인트', '포인트', '만 원', '만원', '주당', '종목', '시간', '개월', '원', '주', '%', '건', '분', '초', '시', '일', '월', '년', '개', '명', '배'];
const FIGURE = new RegExp(`([+\\-\\u2212]?\\d[\\d,.]*)(${UNITS.join('|')})`, 'g');
const RANGE = /~(?=[+\-\u2212]?\d)/g;
const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/** A Text's laid-out width and its font (px). */
export type TextLine = { width: number; fontSize: number; bold: boolean };

// Rough advance widths in em, a little generous. They only decide whether a
// figure is wider than its whole line, where it must break somewhere anyway.
const ADVANCE: Record<string, number> = { ',': 0.27, '.': 0.27, ':': 0.27, '%': 0.85, '+': 0.55, '-': 0.35, '\u2212': 0.55, ' ': 0.25 };

/** Estimated width of a figure in the given font (px). */
export function figureWidth(figure: string, fontSize: number, bold = false) {
  const em = [...figure].reduce((sum, char) => sum + (ADVANCE[char] ?? (/[가-힣]/.test(char) ? 1 : 0.6)), 0);
  return em * fontSize * (bold ? 1.05 : 1);
}

const letters = (word: string) =>
  [...word].join(WORD_JOINER).replaceAll(`${WORD_JOINER} ${WORD_JOINER}`, NO_BREAK_SPACE);

// Wider than the whole line: wrap after a thousands separator or before the
// unit (after the % of %포인트), never inside a digit group or a unit word.
function breakable(number: string, unit: string) {
  const groups = number.replaceAll(',', `,${ZERO_WIDTH_SPACE}`);
  if (unit === '%') return `${groups}${WORD_JOINER}%`;
  const [lead, word] = unit.startsWith('%') ? ['%', unit.slice(1)] : ['', unit];
  return `${groups}${lead}${ZERO_WIDTH_SPACE}${letters(word)}`;
}

/**
 * The same text with each figure kept on one line (see above). Given the
 * line it is set on, a figure wider than that line wraps readably instead.
 */
export function joinFigures(text: string, line?: TextLine): string {
  if (!/\d/.test(text)) return text;
  return text
    .replace(DATE, `$1-${WORD_JOINER}$2-${WORD_JOINER}$3`)
    .replace(RANGE, `~${ZERO_WIDTH_SPACE}`)
    .replace(FIGURE, (figure: string, number: string, unit: string) =>
      line && figureWidth(figure, line.fontSize, line.bold) > line.width
        ? breakable(number, unit)
        : `${number}${WORD_JOINER}${letters(unit)}`);
}

/** What a reader sees: no invisible break controls, and a no-break space reads as a space. */
export const visibleText = (text: string) => text.replace(/[\u2060\u200B]/g, '').replace(/\u00A0/g, ' ');
