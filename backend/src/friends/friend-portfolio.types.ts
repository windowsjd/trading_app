import type { AssetType } from '../generated/prisma/client';
export type FriendPortfolio = {
  valuationState: 'available' | 'unavailable';
  allocation: {
    cashKrwValue: string;
    domesticStockValueKrw: string;
    usStockValueKrw: string;
    cryptoValueKrw: string;
  } | null;
  holdings: Array<{
    assetId: string;
    name: string;
    symbol: string;
    assetType: AssetType;
    weight: string | null;
  }>;
  history: Array<{ date: string; totalAssetKrw: string; returnRate: string }>;
};
