import type { CompletedTrade } from '../tradingAccount/api';
import {
  formatAssetPrice,
  formatKrwDecimal,
  formatMoneyDecimal,
  formatSignedPercent,
  getAssetNameDisplay,
} from '../../utils/format.ts';

/**
 * What the 수익 공유 card shows for one completed trade. Display only: every
 * figure is the server's confirmed value (backend
 * docs/completed-trades-share-contract.md) rounded for the eye — nothing is
 * recomputed, converted or unified between Spot and Futures here.
 */
export type ShareMetric = 'amount' | 'rate';
export type ShareTone = 'profit' | 'loss' | 'neutral';

export type TradeShareCardModel = {
  /** `BTCUSDT Perpetual` for a futures contract; the asset's display name for Spot. */
  title: string;
  /** Spot only: the listing's code or symbol under the name. */
  subtitle: string | null;
  /** Futures only: the lifetime's side and leverage. */
  position: { direction: 'long' | 'short'; label: 'Long' | 'Short'; leverage: string } | null;
  headline: { value: string; unit: string | null; tone: ShareTone };
  /** Entry and exit prices with their labels; a price without evidence is left out. */
  prices: Array<{ label: string; value: string }>;
  /** The completion time, Asia/Seoul, to the second. */
  completedAt: string;
};

/** 수익률 needs the server's rate; a trade without one (basis not above zero) shares its amount only. */
export const canShareReturnRate = (trade: CompletedTrade) => trade.returnRate != null;

/** The metric actually shown: a requested 수익률 the trade does not have falls back to 수익금액. */
export const resolveShareMetric = (trade: CompletedTrade, requested: ShareMetric): ShareMetric =>
  requested === 'rate' && canShareReturnRate(trade) ? 'rate' : 'amount';

const KST_SECONDS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** `YYYY-MM-DD HH:mm:ss` in Asia/Seoul whatever the device zone; '-' for anything but an instant. */
export function formatShareDateTime(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(text) || !/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text)) return '-';
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return '-';
  const parts = KST_SECONDS.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const [year, month, day, hour, minute, second] = (['year', 'month', 'day', 'hour', 'minute', 'second'] as const).map(part);
  if (!year || !month || !day || !hour || !minute || !second) return '-';
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/**
 * The app formatters round half up and then drop trailing zeros (152.30 →
 * 152.3); a card keeps the full precision it rounded to (152.30), as money and
 * rates are usually printed. Padding only: the rounded value is unchanged.
 */
function padFraction(text: string, decimals: number) {
  if (decimals <= 0) return text;
  return text.replace(/^([+-]?[\d,]+)(?:\.(\d*))?(.*)$/u, (_, whole: string, fraction = '', rest: string) =>
    `${whole}.${fraction.padEnd(decimals, '0')}${rest}`);
}

/** The tone of a displayed figure: its own sign after rounding (a rounded 0 is neutral). */
function toneOf(displayed: string): ShareTone {
  if (!/[1-9]/u.test(displayed)) return 'neutral';
  return displayed.startsWith('-') ? 'loss' : 'profit';
}

/**
 * The card's big figure. 수익금액: the confirmed realized PnL in the trade's own
 * currency (USD to the cent, KRW to the won), the unit beside it. 수익률: the
 * server's return rate to 2 dp. Exactly one of the two, never both.
 */
export function getShareHeadline(trade: CompletedTrade, metric: ShareMetric): TradeShareCardModel['headline'] {
  if (resolveShareMetric(trade, metric) === 'rate') {
    const formatted = formatSignedPercent(trade.returnRate);
    const value = formatted === '-' ? formatted : padFraction(formatted, 2);
    return { value, unit: null, tone: toneOf(value) };
  }
  const formatted = formatMoneyDecimal(trade.realizedPnl, trade.currencyCode, true);
  if (formatted === '-') return { value: '-', unit: null, tone: 'neutral' };
  const usd = trade.currencyCode === 'USD';
  const value = usd ? padFraction(formatted.replace('$', ''), 2) : formatted.replace(/원$/u, '');
  return { value, unit: usd ? 'USD' : '원', tone: toneOf(value) };
}

/** A price figure without its currency mark (the headline names it): KRW to the won, USD to the tick. */
export function formatSharePrice(
  value: string | null | undefined,
  currencyCode: string,
  displayPriceDecimals: number | null,
): string | null {
  if (value == null || !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  if (currencyCode === 'KRW') return formatKrwDecimal(value);
  const decimals = displayPriceDecimals ?? 2;
  const formatted = formatAssetPrice(value, currencyCode, decimals);
  return formatted.startsWith('$') ? padFraction(formatted.slice(1), Math.min(decimals, 8)) : null;
}

export function getTradeShareCard(trade: CompletedTrade, metric: ShareMetric): TradeShareCardModel {
  const price = (value: string | null) => formatSharePrice(value, trade.currencyCode, trade.displayPriceDecimals);
  const prices = (pairs: Array<[string, string | null]>) =>
    pairs.flatMap(([label, value]) => (value ? [{ label, value }] : []));
  const headline = getShareHeadline(trade, metric);
  const completedAt = formatShareDateTime(trade.completedAt);
  if (trade.kind === 'futures') {
    return {
      title: `${trade.symbol} Perpetual`,
      subtitle: null,
      position: {
        direction: trade.direction,
        label: trade.direction === 'long' ? 'Long' : 'Short',
        leverage: `${trade.leverage}x`,
      },
      headline,
      prices: prices([
        ['진입가', price(trade.averageEntryPrice)],
        ['평균 청산가', price(trade.averageExitPrice)],
      ]),
      completedAt,
    };
  }
  const name = getAssetNameDisplay(trade);
  return {
    title: name.primary,
    subtitle: name.secondary && name.secondary !== name.primary ? name.secondary : null,
    position: null,
    headline,
    prices: prices([
      ['평균 매수가', price(trade.averageBuyPrice)],
      ['평균 매도가', price(trade.averageSellPrice)],
    ]),
    completedAt,
  };
}

/** One line for screen readers: what the image says, in reading order. */
export function describeShareCard(card: TradeShareCardModel, nickname: string) {
  return [
    `${nickname} 수익 공유 카드`,
    `${card.completedAt} 완료`,
    [card.title, card.subtitle, card.position && `${card.position.label} ${card.position.leverage}`].filter(Boolean).join(' '),
    `${card.headline.value}${card.headline.unit ? ` ${card.headline.unit}` : ''}`,
    ...card.prices.map((item) => `${item.label} ${item.value}`),
    '트레이딩 클래스',
  ].join(', ');
}

/**
 * Font size for a single line of `text` in `width` design units, shrinking a
 * long figure or name instead of clipping it. Glyph widths are not linear in
 * size, so the estimate is per character with slack, never below `min`.
 */
export function fitFontSize(text: string, width: number, max: number, min: number, em = 0.62) {
  const units = [...text].reduce((sum, char) => sum + (/[ㄱ-힣]/u.test(char) ? 1 : /[.,:\s|]/u.test(char) ? 0.34 : em), 0);
  if (units === 0) return max;
  return Math.max(min, Math.min(max, Math.floor(width / (units * 1.06))));
}

/** The completed-trades row: how a lifetime ended, when it completed. */
export function getCompletedTradeMeta(trade: CompletedTrade) {
  const ended =
    trade.kind === 'futures'
      ? trade.closeKind === 'liquidated'
        ? '강제청산'
        : trade.closeKind === 'season_closed'
          ? '시즌 종료 정산'
          : null
      : null;
  return {
    completedAt: formatShareDateTime(trade.completedAt),
    leverage: trade.kind === 'futures' ? `${trade.leverage}x` : null,
    ended,
  };
}
