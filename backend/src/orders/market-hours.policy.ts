import { AssetType } from '../generated/prisma/client';
import {
  resolveCalendarMarket,
  resolveStockMarketSessionState,
} from './market-calendar.policy';

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

export function getAssetTradingStatus(
  asset: MarketHoursAsset,
  now: Date,
): MarketTradingStatus {
  if (asset.assetType === AssetType.crypto) {
    return { tradable: true };
  }

  const market = resolveCalendarMarket(asset);
  if (market) {
    const sessionState = resolveStockMarketSessionState(asset, now);
    if (sessionState?.state === 'open') return { tradable: true };
    return {
      tradable: false,
      reason: 'MARKET_CLOSED',
      message:
        sessionState?.state === 'calendar_unavailable'
          ? `${market} market calendar has no data for this date; treating the day as not tradable.`
          : `${market} market is closed.`,
    };
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
