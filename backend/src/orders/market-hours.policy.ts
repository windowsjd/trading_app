import { AssetType } from '../generated/prisma/client';
import {
  resolveCalendarMarket,
  resolveStockMarketSessionState,
} from './market-calendar.policy';

/**
 * Machine-readable non-tradable reasons. MARKET_CLOSED means a CONFIRMED
 * non-trading instant (holiday, weekend, outside session hours, operator
 * closure). MARKET_CALENDAR_UNAVAILABLE means the session could not be
 * decided at all (year without a calendar dataset, or the operator override
 * snapshot has not loaded) — orders are still blocked (fail-closed), but the
 * cause is an infrastructure/coverage gap, never a confirmed closure.
 * Consumers must branch on this code, not on the human-readable message.
 */
export type MarketNotTradableReason =
  | 'MARKET_CLOSED'
  | 'MARKET_CALENDAR_UNAVAILABLE'
  | 'ASSET_NOT_TRADABLE';

export type MarketTradingStatus =
  | { tradable: true }
  | {
      tradable: false;
      reason: MarketNotTradableReason;
      message: string;
    };

export type MarketHoursAsset = {
  assetType: AssetType;
  market: string;
};

export class MarketHoursError extends Error {
  constructor(
    readonly code: MarketNotTradableReason,
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
    if (!sessionState || sessionState.state === 'calendar_unavailable') {
      return {
        tradable: false,
        reason: 'MARKET_CALENDAR_UNAVAILABLE',
        message: `${market} market calendar has no data for this date; treating the day as not tradable.`,
      };
    }
    return {
      tradable: false,
      reason: 'MARKET_CLOSED',
      message: `${market} market is closed.`,
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
