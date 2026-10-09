import type { PositionsService } from '../positions/positions.service';
import type { readFuturesHoldingSummaries } from '../futures/futures-position-display';
export type FriendPortfolio = {
  valuationState: 'available' | 'unavailable';
  allocation: {
    cashKrwValue: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  } | null;
  holdings: Array<
    Awaited<
      ReturnType<PositionsService['readOpenHoldingProjection']>
    >[number] & {
      weight: string | null;
    }
  >;
  futures: Awaited<ReturnType<typeof readFuturesHoldingSummaries>>;
  history: Array<{ date: string; totalAssetKrw: string; returnRate: string }>;
};
