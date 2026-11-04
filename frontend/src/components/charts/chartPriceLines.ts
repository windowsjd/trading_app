import { chartLabelWidth } from './candlestickLayout.ts';

/**
 * The account's own prices on a candlestick chart: the holding's average
 * price, its open limit orders and the trigger prices the server is watching.
 * A line is only ever drawn at its real price. One outside the visible range
 * keeps no line; its label is pinned to that edge with an arrow, and the
 * chart's price range is never widened to bring it into view.
 */
export type ChartPriceLineKind = 'average' | 'limit' | 'trigger';

export type ChartPriceLine = {
  /** Stable identity: source + row id. */
  key: string;
  kind: ChartPriceLineKind;
  /** In the candles' own currency (a won view only converts the label). */
  price: number;
  /** What the price is: 평단가, 지정가 매수, 손절가 … */
  title: string;
  /** The holding's return rate (the average's left label), or how many orders share it (after the price). */
  note?: string | null;
};

/** Average price first, then limit orders, then watched triggers. */
const PRIORITY: Record<ChartPriceLineKind, number> = { average: 0, limit: 1, trigger: 2 };

/** Light/dark line colors: red average, blue limit, purple trigger. */
export const CHART_PRICE_LINE_COLORS: Record<ChartPriceLineKind, { light: string; dark: string }> = {
  average: { light: '#c8241e', dark: '#ff6b64' },
  limit: { light: '#1b5ec9', dark: '#64a2ff' },
  trigger: { light: '#7a3fc4', dark: '#c3a1ff' },
};

/** Solid average, dashed limit, dotted trigger (the current price is 3 3). */
export const CHART_PRICE_LINE_DASH: Record<ChartPriceLineKind, string | undefined> = {
  average: undefined,
  limit: '6 4',
  trigger: '1.5 3',
};

export const PRICE_LABEL_HEIGHT = 16;
export const PRICE_LABEL_GAP = 2;
export const PRICE_LABEL_FONT_SIZE = 10;
const PRICE_LABEL_PADDING = 5;

/** Parses a positive decimal string into a chartable price, or null. */
export function chartPrice(value: string | null | undefined): number | null {
  if (!value || !/^\d+(\.\d+)?$/u.test(value.trim())) return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Orders of the same kind at the same price become one line ("· 2건"), so two
 * identical labels never stack; the average price is never merged.
 */
export function mergeChartPriceLines(lines: ChartPriceLine[]): ChartPriceLine[] {
  const merged = new Map<string, { line: ChartPriceLine; count: number }>();
  for (const line of lines) {
    const id = line.kind === 'average' ? line.key : `${line.kind}|${line.title}|${line.price}`;
    const existing = merged.get(id);
    if (existing) existing.count += 1;
    else merged.set(id, { line, count: 1 });
  }
  return [...merged.values()].map(({ line, count }) =>
    count > 1 ? { ...line, note: `${count}건` } : line);
}

const edgeArrow = (edge: 'above' | 'below' | null) => (edge === 'above' ? '▲ ' : edge === 'below' ? '▼ ' : '');

/** `title price · note` — the price already formatted for the chart's currency. */
export function chartPriceLineLabel(line: ChartPriceLine, formattedPrice: string, edge: 'above' | 'below' | null) {
  return `${edgeArrow(edge)}${line.title} ${formattedPrice}${line.note ? ` · ${line.note}` : ''}`;
}

/**
 * The words a line shows on the chart. The average price is split: its return
 * rate at the plot's left (none when there is no rate) and on the right axis
 * its title (평단가, 롱/숏 진입가) over the price itself, where the price reads
 * against the scale and the current price. Every other line keeps one left
 * label. (A pinned average's arrow goes on the title row, so the price keeps
 * the size the axis was made for.)
 */
export function chartPriceLineTexts(line: ChartPriceLine, formattedPrice: string, edge: 'above' | 'below' | null) {
  if (line.kind !== 'average') return { plot: chartPriceLineLabel(line, formattedPrice, edge), axis: null };
  const arrow = edgeArrow(edge);
  return { plot: line.note ? `${arrow}${line.note}` : null, axis: { title: `${arrow}${line.title}`, price: formattedPrice } };
}

/** Label box width and font size so the text fits `maxWidth`. */
export function priceLabelBox(text: string, maxWidth: number) {
  const natural = chartLabelWidth(text, PRICE_LABEL_FONT_SIZE);
  const room = Math.max(maxWidth - PRICE_LABEL_PADDING * 2, 1);
  const fontSize = Math.min(PRICE_LABEL_FONT_SIZE, PRICE_LABEL_FONT_SIZE * room / Math.max(natural, 1));
  return {
    fontSize,
    width: Math.min(maxWidth, chartLabelWidth(text, fontSize) + PRICE_LABEL_PADDING * 2),
    textInset: PRICE_LABEL_PADDING,
  };
}

export type PriceLabelRequest = {
  key: string;
  kind: ChartPriceLineKind;
  /** Where the label wants its center: the line, or the edge it is pinned to. */
  y: number;
};

/**
 * Non-overlapping label tops between `top` and `bottom`, in the requests'
 * vertical order, each as close to its own line as the others allow. When
 * there are more labels than fit, the lower-priority ones get no label (their
 * lines stay); a label is never drawn over another.
 */
export function layoutPriceLabels(
  requests: PriceLabelRequest[],
  bounds: { top: number; bottom: number },
): Map<string, number> {
  const step = PRICE_LABEL_HEIGHT + PRICE_LABEL_GAP;
  const capacity = Math.max(0, Math.floor((bounds.bottom - bounds.top + PRICE_LABEL_GAP) / step));
  const kept = requests
    .map((request, index) => ({ request, index }))
    .sort((a, b) => PRIORITY[a.request.kind] - PRIORITY[b.request.kind] || a.index - b.index)
    .slice(0, capacity)
    .map(({ request }) => request)
    .sort((a, b) => a.y - b.y || PRIORITY[a.kind] - PRIORITY[b.kind] || (a.key < b.key ? -1 : 1));
  const lowest = bounds.bottom - PRICE_LABEL_HEIGHT;
  const tops = kept.map((request) =>
    Math.min(Math.max(request.y - PRICE_LABEL_HEIGHT / 2, bounds.top), lowest));
  for (let index = 1; index < tops.length; index += 1)
    tops[index] = Math.max(tops[index], tops[index - 1] + step);
  if (tops.length && tops[tops.length - 1] > lowest) {
    tops[tops.length - 1] = lowest;
    for (let index = tops.length - 2; index >= 0; index -= 1)
      tops[index] = Math.min(tops[index], tops[index + 1] - step);
  }
  return new Map(kept.map((request, index) => [request.key, tops[index]]));
}

/** The average's axis box: a title row over a price row the size of the current price's box. */
export const AXIS_TITLE_HEIGHT = 12;
export const AXIS_LABEL_HEIGHT = AXIS_TITLE_HEIGHT + PRICE_LABEL_HEIGHT;

/**
 * Right-axis box tops between `top` and `bottom`: each box's price row
 * centered on its own line when it can be, otherwise the box at the nearest
 * free spot, never over a fixed label (the current price's box, centered at
 * each of `fixed`) or another. One that finds no room gets no label (its line
 * stays).
 */
export function layoutAxisLabels(
  requests: Omit<PriceLabelRequest, 'kind'>[],
  fixed: number[],
  bounds: { top: number; bottom: number },
): Map<string, number> {
  const lowest = bounds.bottom - AXIS_LABEL_HEIGHT;
  const taken = fixed.map((y) => ({ top: y - PRICE_LABEL_HEIGHT / 2, bottom: y + PRICE_LABEL_HEIGHT / 2 }));
  const free = (top: number) => taken.every((other) =>
    top + AXIS_LABEL_HEIGHT + PRICE_LABEL_GAP <= other.top + 1e-9 || top >= other.bottom + PRICE_LABEL_GAP - 1e-9);
  const tops = new Map<string, number>();
  for (const request of [...requests].sort((a, b) => a.y - b.y || (a.key < b.key ? -1 : 1))) {
    const wanted = Math.min(Math.max(request.y - AXIS_TITLE_HEIGHT - PRICE_LABEL_HEIGHT / 2, bounds.top), lowest);
    // The nearest free top is the wanted one or the edge of a taken label.
    const [top] = [wanted, ...taken.flatMap((other) => [other.top - PRICE_LABEL_GAP - AXIS_LABEL_HEIGHT, other.bottom + PRICE_LABEL_GAP])]
      .filter((candidate) => candidate >= bounds.top && candidate <= lowest && free(candidate))
      .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
    if (top === undefined) continue;
    tops.set(request.key, top);
    taken.push({ top, bottom: top + AXIS_LABEL_HEIGHT });
  }
  return tops;
}

/** The lines in words, for the chart's accessibility label. */
export function describeChartPriceLines(
  lines: ChartPriceLine[],
  formatPrice: (price: number) => string,
): string {
  return lines.map((line) => chartPriceLineLabel(line, formatPrice(line.price), null)).join(', ');
}
