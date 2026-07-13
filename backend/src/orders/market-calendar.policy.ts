import { AssetType } from '../generated/prisma/client';
import {
  getZonedParts,
  zonedDateTimeToUtc,
} from '../providers/kis/candles/kis-candle-time';
import {
  findMarketSchedule,
  type MarketHoliday,
} from './market-holidays.config';

export type MarketCalendarAsset = {
  assetType: AssetType;
  market: string;
};

export type MarketSessionWindow = {
  market: 'KRX' | 'US';
  localDate: string;
  timeZone: string;
  openTime: Date;
  closeTime: Date;
  earlyClose: boolean;
};

const SESSION_POLICY = {
  KRX: {
    timeZone: 'Asia/Seoul',
    open: '090000',
    close: '153000',
  },
  US: {
    timeZone: 'America/New_York',
    open: '093000',
    close: '160000',
  },
} as const;

export function resolveRegularSessionForEvent(
  asset: MarketCalendarAsset,
  eventTime: Date,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  const market = resolveCalendarMarket(asset);
  if (!market || Number.isNaN(eventTime.getTime())) return null;
  const policy = SESSION_POLICY[market];
  const parts = getZonedParts(eventTime, policy.timeZone);
  const localDate = compactDate(parts.year, parts.month, parts.day);
  const session = resolveMarketSession(market, localDate, scheduleLookup);
  if (!session) return null;
  const timestamp = eventTime.getTime();
  return timestamp >= session.openTime.getTime() &&
    timestamp < session.closeTime.getTime()
    ? session
    : null;
}

export function resolveMarketSession(
  market: 'KRX' | 'US',
  localDate: string,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  if (!/^\d{8}$/u.test(localDate)) return null;
  const policy = SESSION_POLICY[market];
  const midday = zonedDateTimeToUtc(localDate, '120000', policy.timeZone);
  if (!midday) return null;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: policy.timeZone,
    weekday: 'short',
  }).format(midday);
  if (weekday === 'Sat' || weekday === 'Sun') return null;

  const dashedDate = `${localDate.slice(0, 4)}-${localDate.slice(4, 6)}-${localDate.slice(6, 8)}`;
  const override = scheduleLookup(market, dashedDate);
  if (override?.isFullDayClosed) return null;
  const openText = parseOverrideTime(override?.openTimeOverride) ?? policy.open;
  const closeText =
    parseOverrideTime(override?.closeTimeOverride) ?? policy.close;
  const openTime = zonedDateTimeToUtc(localDate, openText, policy.timeZone);
  const closeTime = zonedDateTimeToUtc(localDate, closeText, policy.timeZone);
  if (!openTime || !closeTime || openTime.getTime() >= closeTime.getTime()) {
    return null;
  }
  return {
    market,
    localDate: dashedDate,
    timeZone: policy.timeZone,
    openTime,
    closeTime,
    earlyClose: closeText !== policy.close,
  };
}

export function findLatestCompletedMarketSession(
  asset: MarketCalendarAsset,
  now: Date,
  maxLookbackDays: number,
  scheduleLookup: typeof findMarketSchedule = findMarketSchedule,
): MarketSessionWindow | null {
  const market = resolveCalendarMarket(asset);
  if (!market || maxLookbackDays < 1) return null;
  const policy = SESSION_POLICY[market];
  const local = getZonedParts(now, policy.timeZone);
  const localMidnight = Date.UTC(local.year, local.month - 1, local.day);
  for (let offset = 0; offset <= maxLookbackDays; offset += 1) {
    const candidate = new Date(localMidnight - offset * 86_400_000);
    const localDate = compactDate(
      candidate.getUTCFullYear(),
      candidate.getUTCMonth() + 1,
      candidate.getUTCDate(),
    );
    const session = resolveMarketSession(market, localDate, scheduleLookup);
    if (session && session.closeTime.getTime() <= now.getTime()) return session;
  }
  return null;
}

export function resolveCalendarMarket(
  asset: MarketCalendarAsset,
): 'KRX' | 'US' | null {
  if (asset.assetType === AssetType.domestic_stock) return 'KRX';
  if (asset.assetType === AssetType.us_stock) return 'US';
  const market = asset.market.trim().toUpperCase();
  if (['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(market)) return 'KRX';
  if (['NAS', 'NASDAQ', 'NYS', 'NYSE', 'AMS', 'AMEX'].includes(market)) {
    return 'US';
  }
  return null;
}

function parseOverrideTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/:/gu, '');
  return /^\d{6}$/u.test(compact) ? compact : null;
}

function compactDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}${month
    .toString()
    .padStart(2, '0')}${day.toString().padStart(2, '0')}`;
}

export type MarketScheduleLookup = (
  market: MarketHoliday['market'],
  holidayDate: string,
) => MarketHoliday | null;
