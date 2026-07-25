import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { G, Line as SvgLine, Rect, Text as SvgText } from 'react-native-svg';

import { formatCurrency, formatMoney } from '../../utils/format';
import { candleXCenter } from './candlestickLayout';

/**
 * The ONE candlestick renderer, shared by every platform. Gesture adapters
 * (native / web) only produce viewport + crosshair state and wrap this
 * component — none of this SVG is duplicated per platform.
 */

export type RenderedCandle = {
  /** Index in the full parsed array (crosshair labels resolve against it). */
  index: number;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bullish: boolean;
};

export type CandlestickCrosshair = {
  /** Candle the vertical line snaps to. */
  index: number;
  /** Free pointer y (price line). */
  y: number;
};

export type CandlestickChartGeometry = {
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  padding: { top: number; right: number; bottom: number; left: number };
  slotWidth: number;
  bodyWidth: number;
  /** First VISIBLE candle index; x positions are measured from it. */
  startIndex: number;
  minY: number;
  maxY: number;
  range: number;
};

export type CandlestickChartRendererProps = {
  geometry: CandlestickChartGeometry;
  /** Visible window + buffer only — never the whole loaded array. */
  candles: RenderedCandle[];
  currencyCode?: string | null;
  /** Only supplied while the latest candle is on screen. */
  currentPrice?: number | null;
  currentBullish?: boolean;
  crosshair?: CandlestickCrosshair | null;
  formatTimeLabel: (timeMs: number) => string;
  /** First/last visible candle times for the static x-axis. */
  firstVisibleTime: number | null;
  lastVisibleTime: number | null;
};

const GRID_LINES = 4;
const UP_COLOR = '#16a34a';
const DOWN_COLOR = '#dc2626';
const GRID_COLOR = '#eef1f4';
const AXIS_TEXT_COLOR = '#98a2b3';
const CROSSHAIR_COLOR = '#64748b';

export default function CandlestickChartRenderer({
  geometry,
  candles,
  currencyCode,
  currentPrice,
  currentBullish = true,
  crosshair,
  formatTimeLabel,
  firstVisibleTime,
  lastVisibleTime,
}: CandlestickChartRendererProps) {
  const { padding, innerWidth, innerHeight, slotWidth, bodyWidth, startIndex } =
    geometry;
  const rightEdgeX = padding.left + innerWidth;
  const bottomY = padding.top + innerHeight;

  const yForPrice = useMemo(() => {
    const { minY, range } = geometry;
    return (price: number) =>
      padding.top + (1 - (price - minY) / range) * innerHeight;
  }, [geometry, padding.top, innerHeight]);

  // Candle nodes only change with the viewport/data, never with crosshair
  // movement, so scrubbing does not rebuild them.
  const candleNodes = useMemo(
    () =>
      candles.map((candle) => {
        const x = candleXCenter(
          padding.left,
          slotWidth,
          candle.index - startIndex,
        );
        const color = candle.bullish ? UP_COLOR : DOWN_COLOR;
        const openY = yForPrice(candle.open);
        const closeY = yForPrice(candle.close);
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(openY - closeY), 1);
        return (
          <G key={`candle-${candle.time}`}>
            <SvgLine
              x1={x}
              y1={yForPrice(candle.high)}
              x2={x}
              y2={yForPrice(candle.low)}
              stroke={color}
              strokeWidth={1}
            />
            <Rect
              x={x - bodyWidth / 2}
              y={bodyTop}
              width={bodyWidth}
              height={bodyHeight}
              fill={color}
              rx={0.5}
            />
          </G>
        );
      }),
    [candles, padding.left, slotWidth, startIndex, bodyWidth, yForPrice],
  );

  const gridNodes = useMemo(() => {
    const { minY, range } = geometry;
    return Array.from({ length: GRID_LINES + 1 }, (_, index) => {
      const value = minY + (range * index) / GRID_LINES;
      const y = yForPrice(value);
      return (
        <G key={`grid-${index}`}>
          <SvgLine
            x1={padding.left}
            y1={y}
            x2={rightEdgeX}
            y2={y}
            stroke={GRID_COLOR}
            strokeWidth={1}
          />
          <SvgText x={rightEdgeX + 4} y={y + 3} fontSize={9} fill={AXIS_TEXT_COLOR}>
            {formatCurrency(value, currencyCode)}
          </SvgText>
        </G>
      );
    });
  }, [geometry, yForPrice, padding.left, rightEdgeX, currencyCode]);

  const crosshairCandle =
    crosshair != null
      ? candles.find((candle) => candle.index === crosshair.index)
      : undefined;
  const crosshairX =
    crosshair != null
      ? candleXCenter(padding.left, slotWidth, crosshair.index - startIndex)
      : 0;
  const crosshairPrice =
    crosshair != null
      ? geometry.minY +
        (1 - (crosshair.y - padding.top) / innerHeight) * geometry.range
      : 0;

  const currentPriceY =
    currentPrice != null && Number.isFinite(currentPrice)
      ? yForPrice(currentPrice)
      : null;
  const showCurrentPrice =
    currentPriceY !== null &&
    currentPriceY >= padding.top - 1 &&
    currentPriceY <= bottomY + 1;
  const currentColor = currentBullish ? UP_COLOR : DOWN_COLOR;

  return (
    <View style={styles.container}>
      <Svg width="100%" height={geometry.height}>
        {gridNodes}
        {candleNodes}

        {showCurrentPrice && currentPriceY !== null ? (
          <G>
            <SvgLine
              x1={padding.left}
              y1={currentPriceY}
              x2={rightEdgeX}
              y2={currentPriceY}
              stroke={currentColor}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <Rect
              x={rightEdgeX}
              y={currentPriceY - 8}
              width={padding.right}
              height={16}
              fill={currentColor}
              rx={2}
            />
            <SvgText
              x={rightEdgeX + 4}
              y={currentPriceY + 3}
              fontSize={9}
              fontWeight="bold"
              fill="#ffffff"
            >
              {formatMoney(currentPrice, currencyCode)}
            </SvgText>
          </G>
        ) : null}

        {crosshair && crosshairCandle ? (
          <G>
            <SvgLine
              x1={crosshairX}
              y1={padding.top}
              x2={crosshairX}
              y2={bottomY}
              stroke={CROSSHAIR_COLOR}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <SvgLine
              x1={padding.left}
              y1={crosshair.y}
              x2={rightEdgeX}
              y2={crosshair.y}
              stroke={CROSSHAIR_COLOR}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <Rect
              x={rightEdgeX}
              y={crosshair.y - 8}
              width={padding.right}
              height={16}
              fill={CROSSHAIR_COLOR}
              rx={2}
            />
            <SvgText
              x={rightEdgeX + 4}
              y={crosshair.y + 3}
              fontSize={9}
              fontWeight="bold"
              fill="#ffffff"
            >
              {formatMoney(crosshairPrice, currencyCode)}
            </SvgText>
            <Rect
              x={Math.max(
                padding.left,
                Math.min(crosshairX - 62, rightEdgeX - 124),
              )}
              y={bottomY + 4}
              width={124}
              height={16}
              fill={CROSSHAIR_COLOR}
              rx={2}
            />
            <SvgText
              x={Math.max(
                padding.left + 62,
                Math.min(crosshairX, rightEdgeX - 62),
              )}
              y={bottomY + 15}
              fontSize={9}
              fontWeight="bold"
              fill="#ffffff"
              textAnchor="middle"
            >
              {formatTimeLabel(crosshairCandle.time)}
            </SvgText>
          </G>
        ) : (
          <G>
            <SvgText
              x={padding.left}
              y={bottomY + 15}
              fontSize={9}
              fill={AXIS_TEXT_COLOR}
            >
              {firstVisibleTime === null ? '' : formatTimeLabel(firstVisibleTime)}
            </SvgText>
            <SvgText
              x={rightEdgeX}
              y={bottomY + 15}
              fontSize={9}
              fill={AXIS_TEXT_COLOR}
              textAnchor="end"
            >
              {lastVisibleTime === null ? '' : formatTimeLabel(lastVisibleTime)}
            </SvgText>
          </G>
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%' },
});
