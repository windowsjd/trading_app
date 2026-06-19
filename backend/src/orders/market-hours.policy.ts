import { AssetType } from '../generated/prisma/client';
import { findMarketHoliday } from './market-holidays.config';

export type MarketTradingStatus =
  | { tradable: true }
  | {
      tradable: false;
      reason: 'MARKET_CLOSED' | 'ASSET_NOT_TRADABLE';
      message: string;
    };

export type MarketHoursAsset = {
  assetType: AssetType;
  market: string;
};

export class MarketHoursError extends Error {
  constructor(
    readonly code: 'MARKET_CLOSED' | 'ASSET_NOT_TRADABLE',
    message: string,
  ) {
    super(message);
  }
}

const KRX_TIME_ZONE = 'Asia/Seoul';
const US_EASTERN_TIME_ZONE = 'America/New_York';
const KRX_OPEN_SECONDS = 9 * 60 * 60;
const KRX_CLOSE_SECONDS = 15 * 60 * 60 + 30 * 60;
const US_OPEN_SECONDS = 9 * 60 * 60 + 30 * 60;
const US_CLOSE_SECONDS = 16 * 60 * 60;
const WEEKEND_DAYS = new Set(['Sat', 'Sun']);
const KRX_MARKETS = new Set(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX']);
const US_MARKETS = new Set(['NAS', 'NASDAQ', 'NYS', 'NYSE']);
export function getAssetTradingStatus(
  asset: MarketHoursAsset,
  now: Date,
): MarketTradingStatus {
  if (asset.assetType === AssetType.crypto) {
    return { tradable: true };
  }

  if (isKrxAsset(asset)) {
    return getSessionTradingStatus({
      now,
      timeZone: KRX_TIME_ZONE,
      openSeconds: KRX_OPEN_SECONDS,
      closeSeconds: KRX_CLOSE_SECONDS,
      holidayMarket: 'KRX',
      marketName: 'KRX',
    });
  }

  if (isUsStockAsset(asset)) {
    return getSessionTradingStatus({
      now,
      timeZone: US_EASTERN_TIME_ZONE,
      openSeconds: US_OPEN_SECONDS,
      closeSeconds: US_CLOSE_SECONDS,
      holidayMarket: 'US',
      marketName: 'US regular session',
    });
  }

  return {
    tradable: false,
    reason: 'ASSET_NOT_TRADABLE',
    message: 'Asset is not tradable.',
  };
}

export function assertAssetTradable(asset: MarketHoursAsset, now: Date): void {
  const status = getAssetTradingStatus(asset, now);
  if (!status.tradable) {
    throw new MarketHoursError(status.reason, status.message);
  }
}

function getSessionTradingStatus(input: {
  now: Date;
  timeZone: string;
  openSeconds: number;
  closeSeconds: number;
  holidayMarket: 'KRX' | 'US';
  marketName: string;
}): MarketTradingStatus {
  const parts = getZonedDateTimeParts(input.now, input.timeZone);
  const dateOnly = formatDateOnly(parts);
  const holiday = findMarketHoliday(input.holidayMarket, dateOnly);

  if (WEEKEND_DAYS.has(parts.weekday) || holiday) {
    return {
      tradable: false,
      reason: 'MARKET_CLOSED',
      message: holiday
        ? `${input.marketName} market is closed for ${holiday.name}.`
        : `${input.marketName} market is closed.`,
    };
  }

  const seconds = parts.hour * 60 * 60 + parts.minute * 60 + parts.second;
  if (seconds < input.openSeconds || seconds >= input.closeSeconds) {
    return {
      tradable: false,
      reason: 'MARKET_CLOSED',
      message: `${input.marketName} market is closed.`,
    };
  }

  return { tradable: true };
}

function isKrxAsset(asset: MarketHoursAsset): boolean {
  return (
    asset.assetType === AssetType.domestic_stock ||
    KRX_MARKETS.has(normalizeMarket(asset.market))
  );
}

function isUsStockAsset(asset: MarketHoursAsset): boolean {
  return (
    asset.assetType === AssetType.us_stock ||
    US_MARKETS.has(normalizeMarket(asset.market))
  );
}

function normalizeMarket(market: string): string {
  return market.trim().toUpperCase();
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedDateTimeParts(date: Date, timeZone: string) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: lookup.weekday,
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function formatDateOnly(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  return [
    parts.year.toString().padStart(4, '0'),
    parts.month.toString().padStart(2, '0'),
    parts.day.toString().padStart(2, '0'),
  ].join('-');
}
