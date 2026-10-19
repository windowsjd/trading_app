import type { PositionsService } from '../positions/positions.service';
import type { readFuturesHoldingSummaries } from '../futures/futures-position-display';
import type { FriendCompletedTrades } from './friend-completed-trades';
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
  /** 거래 완료 종목: fully closed trades as aggregates (friend-completed-trades.ts). */
  completedTrades: FriendCompletedTrades;
};
