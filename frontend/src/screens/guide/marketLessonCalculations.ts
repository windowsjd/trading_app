import { ohlcFromPrices, type Ohlc, type Quote } from './lessonCalculations.ts';
import type { SessionTrade } from './marketLessonData';

export const percent = (value: number) =>
  `${value > 0 ? '+' : ''}${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%`;
export const changeRate = (start: number, end: number) =>
  start > 0 ? ((end - start) / start) * 100 : null;
export function usTradingSession(day: string, early = false) {
  // Only the selected fixed lesson dates use this conversion; this is not a market calendar.
  const noon = new Date(`${day}T12:00:00Z`);
  const offsetLabel = new Intl.DateTimeFormat('en', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  })
    .formatToParts(noon)
    .find((part) => part.type === 'timeZoneName').value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetLabel);
  const offset =
    (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
  const etToUtc = (time: string) =>
    new Date(Date.parse(`${day}T${time}:00Z`) - offset * 60000);
  const kst = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (name: string) => parts.find((p) => p.type === name).value;
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  };
  const close = early ? '13:00' : '16:00';
  return {
    day,
    openEt: `${day} 09:30`,
    closeEt: `${day} ${close}`,
    openKst: kst(etToUtc('09:30')),
    closeKst: kst(etToUtc(close)),
    daylightSaving: offset === -240,
  };
}
export function callAuction(buys: Quote[], sells: Quote[]) {
  const candidates = [
    ...new Set([...buys, ...sells].map((order) => order.price)),
  ]
    .sort((a, b) => a - b)
    .map((price) => {
      const buy = buys
        .filter((order) => order.price >= price)
        .reduce((sum, order) => sum + order.quantity, 0);
      const sell = sells
        .filter((order) => order.price <= price)
        .reduce((sum, order) => sum + order.quantity, 0);
      return { price, buy, sell, quantity: Math.min(buy, sell) };
    });
  const maximum = Math.max(0, ...candidates.map((row) => row.quantity));
  const best = candidates.filter(
    (row) => row.quantity === maximum && maximum > 0,
  );
  // These fixtures have one clear result. Do not invent exchange tie-breaking rules.
  return { candidates, result: best.length === 1 ? best[0] : null };
}
export function sessionOhlc(trades: SessionTrade[], extended: boolean) {
  const records = trades.filter(
    (trade) =>
      trade.day === '당일' && (extended || trade.session === 'regular'),
  );
  return {
    records,
    candle: records.length
      ? ohlcFromPrices(records.map((trade) => trade.price))
      : null,
  };
}
// Fixed display buckets from these samples. Missing/excluded sessions remain visible gaps.
export function sessionTimeline(trades: SessionTrade[], extended: boolean) {
  const groups = new Map<string, SessionTrade[]>();
  for (const trade of trades) {
    const key =
      trade.day === '전 거래일'
        ? trade.day
        : `${trade.session}-${trade.time.slice(0, 2)}`;
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.values()].flatMap((records) => {
    const first = records[0];
    const label = `${first.day} ${first.time} · ${first.session === 'regular' ? '정규장' : first.session === 'pre' ? '장전' : '장후'}`;
    const included = extended || first.session === 'regular';
    const item = {
      label,
      candle: included ? ohlcFromPrices(records.map((r) => r.price)) : null,
    };
    return first.day === '전 거래일'
      ? [item, { label: '밤사이 거래 공백 · 예제 기록 없음', candle: null }]
      : [item];
  });
}
export const payoutRatio = (dividends: number, netIncome: number) =>
  netIncome > 0 ? (dividends / netIncome) * 100 : null;
export function adjustOhlc(candle: Ohlc, factor: number): Ohlc {
  return {
    open: candle.open * factor,
    high: candle.high * factor,
    low: candle.low * factor,
    close: candle.close * factor,
  };
}
export function shareConversion(
  price: number,
  quantity: number,
  afterPerBefore: number,
) {
  return {
    price: price / afterPerBefore,
    quantity: quantity * afterPerBefore,
    value: price * quantity,
  };
}
export function dividendAssets(
  stage: 'before' | 'ex' | 'paid',
  price = 10000,
  quantity = 10,
  dividend = 500,
) {
  const stock = (stage === 'before' ? price : price - dividend) * quantity;
  const receivable = stage === 'ex' ? dividend * quantity : 0;
  const cash = stage === 'paid' ? dividend * quantity : 0;
  return {
    price: stage === 'before' ? price : price - dividend,
    quantity,
    stock,
    receivable,
    cash,
    total: stock + receivable + cash,
  };
}
export const eligibleDividend = (purchaseDay: string, exDay: string) =>
  purchaseDay < exDay;
export function indexImpact(
  assets: { price: number; quantity: number }[],
  returns: number[],
  initialIndex = 1000,
) {
  const initialValue = assets.reduce(
    (sum, asset) => sum + asset.price * asset.quantity,
    0,
  );
  const rows = assets.map((asset, i) => {
    const weight = initialValue
      ? (asset.price * asset.quantity) / initialValue
      : 0;
    const price = asset.price * (1 + returns[i] / 100);
    return {
      ...asset,
      nextPrice: price,
      value: price * asset.quantity,
      weight,
      contribution: weight * returns[i],
    };
  });
  const value = rows.reduce((sum, row) => sum + row.value, 0);
  const rate = rows.reduce((sum, row) => sum + row.contribution, 0);
  return {
    rows,
    initialValue,
    value,
    rate,
    index: initialIndex * (1 + rate / 100),
  };
}
export function nav(assets: number, liabilities: number, shares: number) {
  const netAssets = assets - liabilities;
  return { netAssets, perShare: shares > 0 ? netAssets / shares : null };
}
export const premium = (price: number, perShare: number) =>
  perShare > 0 ? ((price - perShare) / perShare) * 100 : null;
export const normalize = (values: number[]) =>
  values.length && values[0] > 0
    ? values.map((value) => (value / values[0]) * 100)
    : [];
export function differenceStats(values: number[]) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    deviation: Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        values.length,
    ),
  };
}
export function priceDomain(values: number[]): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  const min = Math.min(...finite),
    max = Math.max(...finite);
  const padding = Math.max((max - min) * 0.1, Math.abs(max) * 0.01, 1);
  return [min - padding, max + padding];
}
