import type {
  IsoDateTimeString,
  MoneyString,
  RateString,
} from './common';
import type { SeasonStatus } from './season';

export interface HomeResponseDto {
  season: {
    id: string;
    name: string;
    status: SeasonStatus;
    endAt: IsoDateTimeString;
  };
  summary: {
    totalAssetKrw: MoneyString;
    returnRate: RateString;
    krwBalance: MoneyString;
    usdBalance: MoneyString;
    usdBalanceKrw: MoneyString;
  };
  ranking: {
    rank: number;
    tier: string;
    percentile: RateString;
  };
  allocation: {
    cashKrwValue: MoneyString;
    domesticStockValueKrw: MoneyString;
    usStockValueKrw: MoneyString;
    cryptoValueKrw: MoneyString;
  };
  topPositions: Array<{
    assetId: string;
    symbol: string;
    name: string;
    assetClass: 'domestic_stock' | 'us_stock' | 'crypto';
    marketValueKrw: MoneyString;
    unrealizedPnlKrw: MoneyString;
    returnRate: RateString;
  }>;
  equityChart: Array<{
    time: IsoDateTimeString;
    totalAssetKrw: MoneyString;
  }>;
}