import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
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

export interface GetPositionsParams {
  assetType?: AssetType;
  assetId?: string;
  limit?: number;
  offset?: number;
}

function buildFallbackPagination(
  limit: number,
  offset: number,
  returned: number,
): OffsetPagination {
  return {
    limit,
    offset,
    total: offset + returned,
    returned,
    nextOffset: returned >= limit ? offset + returned : null,
  };
}

export async function getPositions(params: GetPositionsParams = {}) {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();

  if (params.assetType) searchParams.set('assetType', params.assetType);
  if (params.assetId) searchParams.set('assetId', params.assetId);
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<
    ApiSuccessResponse<
      PositionsResponseDto & {
        items?: PositionItemDto[];
      }
    >
  >(`/positions?${searchParams.toString()}`);

  const data = response.data.data;
  const positions = data.positions ?? data.items ?? [];

  return {
    ...data,
    positions,
    pagination:
      data.pagination ?? buildFallbackPagination(limit, offset, positions.length),
  };
}

export function getPositionForAsset(
  positionsResponse: PositionsResponseDto | null | undefined,
  assetId: string,
) {
  return (
    positionsResponse?.positions.find((position) => position.assetId === assetId) ??
    null
  );
}

export function getPositionQuantity(
  positionsResponse: PositionsResponseDto | null | undefined,
  assetId: string,
) {
  return getPositionForAsset(positionsResponse, assetId)?.quantity ?? '0';
}
