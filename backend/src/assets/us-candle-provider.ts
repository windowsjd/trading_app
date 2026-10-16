import { readUsStockPriceProvider } from '../providers/us-stock-price-provider.config';
import {
  TIINGO_EOD_CANDLE_SOURCE,
  TIINGO_INTRADAY_CANDLE_SOURCE,
} from '../providers/tiingo/tiingo.config';

/**
 * US stock candles follow the financial price provider (2026-10-17): with
 * `US_STOCK_PRICE_PROVIDER=tiingo` they are written only by the Tiingo sync
 * and read only from Tiingo rows (a KIS row left from before the switch has
 * the same window keys and is never served or counted as coverage); there is
 * no KIS repair, legacy read or KIS live candle. `kis` keeps the KIS path.
 */
export function usCandlesFromTiingo(
  asset: { assetType: string },
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    asset.assetType === 'us_stock' && readUsStockPriceProvider(env) === 'tiingo'
  );
}

/** Every stored Tiingo-derived candle row carries this provider prefix. */
export const TIINGO_STORED_CANDLE_PREFIX = 'tiingo_';

export function isTiingoCandleRow(row: { sourceProvider: string }): boolean {
  return row.sourceProvider.startsWith(TIINGO_STORED_CANDLE_PREFIX);
}

/** The Tiingo sync's checkpoint provider of a stored feed. */
export function tiingoFeedProvider(feed: '5m' | '1d' | '1w'): string {
  return feed === '5m'
    ? TIINGO_INTRADAY_CANDLE_SOURCE
    : TIINGO_EOD_CANDLE_SOURCE;
}

/**
 * Stored US rows of the CURRENT provider only, either way: Tiingo mode reads
 * Tiingo rows; KIS mode never reads a Tiingo row left from before a rollback.
 * Null for any other asset (no provider filter).
 */
export function usCandleRowFilter(
  asset: { assetType: string },
  env: Record<string, string | undefined> = process.env,
): ((row: { sourceProvider: string }) => boolean) | null {
  if (asset.assetType !== 'us_stock') return null;
  return usCandlesFromTiingo(asset, env)
    ? isTiingoCandleRow
    : (row) => !isTiingoCandleRow(row);
}

/** Which sync runs may prove US rows (the current provider's only). */
export function usCheckpointFilter(
  asset: { assetType: string },
  feed: '5m' | '1d' | '1w',
  env: Record<string, string | undefined> = process.env,
):
  | { sourceProviders: string[] }
  | { excludeSourceProviderPrefix: string }
  | null {
  if (asset.assetType !== 'us_stock') return null;
  return usCandlesFromTiingo(asset, env)
    ? { sourceProviders: [tiingoFeedProvider(feed)] }
    : { excludeSourceProviderPrefix: TIINGO_STORED_CANDLE_PREFIX };
}
