/**
 * Position DTO shapes only (작업 11 §12).
 *
 * The legacy `/positions` reads that used to live here are GONE. They resolved
 * the account implicitly from the current season's participant, so on a screen
 * showing a selected account they answered about a different one. Every caller
 * now uses `getTradingAccountPositions(accountId, …)`. The types stay because
 * the account-scoped payload has the same row shape.
 */
import type {
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  QuantityString,
  RateString,
  SectionState,
} from '../../models/dto/common';
import type { AssetType, CurrencyCode } from '../market/api';

export interface PositionAssetDto {
  id: string;
  assetType: AssetType;
  symbol: string;
  name: string;
  market?: string;
  priceCurrency?: CurrencyCode;
  settlementCurrency?: CurrencyCode;
}

export interface PositionItemDto {
  id?: string;
  assetId: string;
  assetType?: AssetType;
  symbol?: string;
  name?: string;
  asset?: PositionAssetDto | null;
  quantity: QuantityString;
  avgEntryPriceLocal?: MoneyString;
  avgEntryPrice?: MoneyString;
  marketValueKrw?: MoneyString;
  unrealizedPnlKrw?: MoneyString;
  returnRate?: RateString;
  updatedAt?: IsoDateTimeString;
}

export interface PositionsResponseDto {
  state?: SectionState;
  pagination: OffsetPagination;
  positions: PositionItemDto[];
}

