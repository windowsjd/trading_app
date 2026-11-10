import type { AssetDetailAssetDto } from './api';
import { getAssetNameDisplay } from '../../utils/format.ts';
import { getExtendedHoursSessionLabel } from './extendedHours.ts';

/** Binance's quote symbol stays in market data; the account settles in USD. */
export function getTradingAssetName(
  asset: Pick<AssetDetailAssetDto, 'assetType' | 'market' | 'symbol' | 'name'>,
) {
  return asset.assetType === 'crypto' && asset.market === 'BINANCE'
    ? asset.symbol.replace(/USDT$/u, '')
    : getAssetNameDisplay(asset).primary;
}

export function getTradingPair(asset: AssetDetailAssetDto) {
  return `${getTradingAssetName(asset)} / ${asset.settlementCurrency}`;
}

/** A closed US market inside its pre-market/after-hours names that session. */
export function getStockMarketStatus(marketStatus: string, extendedHoursSession?: unknown) {
  return marketStatus === 'open'
    ? '장중'
    : marketStatus === 'closed'
      ? (getExtendedHoursSessionLabel(extendedHoursSession) ?? '장마감')
      : '상태 확인 불가';
}
