/**
 * Position DTO shapes only (작업 11 §12).
 *
 * The legacy `/positions` reads that used to live here are GONE. They resolved
 * the account implicitly from the current season's participant, so on a screen
 * showing a selected account they answered about a different one. Every caller
 * now uses `getTradingAccountPositions(accountId, …)`. The types below mirror
 * the account-scoped payload: raw position facts plus nested valuation state.
 */
import type {
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  PublicSourceMetadata,
  QuantityString,
  RateString,
  SectionState,
} from '../../models/dto/common';
import type { AssetType, CurrencyCode } from '../market/api';

export interface PositionAvailableValuationDto {
  state: 'available';
  currentPrice: MoneyString;
  priceCurrency: CurrencyCode;
  assetPriceSnapshotId: string;
  priceEffectiveAt: IsoDateTimeString;
  priceCapturedAt: IsoDateTimeString;
  priceSource: PublicSourceMetadata | null;
  fxRateSource?: PublicSourceMetadata | null;
  positionValue: MoneyString;
  positionValueKrw: MoneyString;
  unrealizedPnl: MoneyString;
  unrealizedPnlKrw: MoneyString;
  returnRate: RateString;
}

export interface PositionStaleCacheValuationDto {
  state: 'stale_cache';
  currentPrice: MoneyString;
  priceCurrency: CurrencyCode;
  assetPriceSnapshotId: null;
  priceEffectiveAt: null;
  priceCapturedAt: null;
  priceSource: null;
  fxRateSource: null;
  positionValue: MoneyString;
  positionValueKrw: MoneyString;
  unrealizedPnl: MoneyString;
  unrealizedPnlKrw: MoneyString;
  returnRate: RateString;
  reason: 'LIVE_VALUATION_UNAVAILABLE';
  message: string;
}

export interface PositionUnavailableValuationDto {
  state: 'unavailable';
  reason: string;
  message: string;
  fxRateSource?: PublicSourceMetadata | null;
}

export type PositionValuationDto =
  | PositionAvailableValuationDto
  | PositionStaleCacheValuationDto
  | PositionUnavailableValuationDto;

export interface PositionItemDto {
  positionId: string;
  assetId: string;
  symbol: string;
  name: string;
  market: string;
  assetType: AssetType;
  currencyCode: CurrencyCode;
  quantity: QuantityString;
  averageCost: MoneyString;
  realizedPnl: MoneyString;
  realizedPnlKrw: MoneyString;
  valuation: PositionValuationDto;
}

export interface PositionsResponseDto {
  state: SectionState;
  pagination: OffsetPagination;
  positions: PositionItemDto[];
}
