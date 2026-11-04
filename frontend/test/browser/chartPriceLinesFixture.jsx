// Browser-only fixture: the production candlestick chart (RN Web) with the
// account's price lines of one scenario (`?scenario=`), in a phone-sized box.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppearanceProvider } from '../../src/theme/appearance';
import CandlestickChart from '../../src/components/charts/CandlestickChart';

const params = new URLSearchParams(location.search);
// 120 fifteen-minute candles drifting around 67,000 (the latest 60 are shown).
const candles = Array.from({ length: 120 }, (_, i) => {
  const base = 67000 + Math.sin(i / 7) * 600 + i * 8;
  const close = base + (i % 3 ? 60 : -50);
  return { time: new Date(Date.UTC(2026, 10, 3, 0, i * 15)).toISOString(),
    open: base, high: Math.max(base, close) + 120, low: Math.min(base, close) - 140, close };
});
const line = (key, kind, price, title, note) => ({ key, kind, price, title, note });
const scenarios = {
  // One of each, apart: the holding's average, two limit orders, two watched triggers.
  spread: [
    line('avg', 'average', 67350.5, '평단가', '+5.2%'),
    line('buy', 'limit', 66900, '지정가 매수'),
    line('sell', 'limit', 68100, '지정가 매도', '2건'),
    line('sl', 'trigger', 66650, '손절가'),
    line('tp', 'trigger', 68250, '익절가'),
  ],
  // Seven prices within a few dollars: labels must make room without overlapping.
  crowd: [
    line('avg', 'average', 67500, '평단가', '-3.25%'),
    ...['지정가 매수', '지정가 매도', 'LOC 매수'].map((title, i) => line(`l${i}`, 'limit', 67500 + i * 2, title)),
    ...['손절가', '익절가', '조건 매수 감시가'].map((title, i) => line(`t${i}`, 'trigger', 67499 - i * 3, title)),
  ],
  // Outside the visible range: no line, labels pinned to the edges.
  edges: [
    line('avg', 'average', 80000, '롱 진입가', '-106.17%'),
    line('limit', 'limit', 50000, '지정가 롱'),
    line('watch', 'trigger', 90000, '조건 숏 감시가'),
  ],
};

function App() {
  const won = params.get('won') === '1';
  return (
    <AppearanceProvider>
      <div data-testid="chart-box" style={{ padding: 8, boxSizing: 'border-box', width: '100%' }}>
        <CandlestickChart
          candles={candles}
          currencyCode={won ? 'KRW' : 'USD'}
          displayPriceDecimals={won ? 0 : 2}
          displayRate={won ? 1384.45 : null}
          currentPrice={String(candles[candles.length - 1].close)}
          height={300}
          viewportResetKey="15m"
          priceLines={scenarios[params.get('scenario') ?? 'spread']}
        />
      </div>
    </AppearanceProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
