import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  PercentString,
  SectionState,
  SourceMetadata,
} from '../../models/dto/common';

export type AssetType = 'domestic_stock' | 'us_stock' | 'crypto';
export type CurrencyCode = 'KRW' | 'USD';

export interface MarketAssetPriceDto {
  state: SectionState;
  currentPrice: MoneyString | null;
  priceCurrency: CurrencyCode;
  priceKrwState?: SectionState;
  priceKrw?: MoneyString | null;
  changeRate?: PercentString | null;
  assetPriceSnapshotId?: string | null;
  priceEffectiveAt?: IsoDateTimeString | null;
  priceCapturedAt?: IsoDateTimeString | null;
  priceSource?: SourceMetadata;
}

export interface MarketAssetItemDto {
  id: string;
  assetType: AssetType;
  symbol: string;
  name: string;
  market: string;
  priceCurrency: CurrencyCode;
  settlementCurrency: CurrencyCode;
  isActive: boolean;
  marketStatus: string;
  tradable: boolean;
  tradeBlockedReason?: string | null;
  price?: MarketAssetPriceDto | null;
}

export interface AssetPriceErrorDto {
  assetId: string;
  code?: string;
  message?: string;
}

export interface AssetsResponseDto {
  state?: SectionState;
  filters?: Record<string, unknown>;
  pagination: OffsetPagination;
  assets: MarketAssetItemDto[];
  priceErrors?: AssetPriceErrorDto[];
}

export interface GetAssetsParams {
  assetType?: AssetType;
  currencyCode?: CurrencyCode;
  market?: string;
  search?: string;
  includeInactive?: boolean;
  withPrice?: boolean;
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

export async function getAssets(params: GetAssetsParams) {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();

  if (params.assetType) searchParams.set('assetType', params.assetType);
  if (params.currencyCode) searchParams.set('currencyCode', params.currencyCode);
  if (params.market) searchParams.set('market', params.market);
  if (params.search) searchParams.set('search', params.search);
  if (params.includeInactive !== undefined) {
    searchParams.set('includeInactive', String(params.includeInactive));
  }
  if (params.withPrice !== undefined) {
    searchParams.set('withPrice', String(params.withPrice));
  }
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<
    ApiSuccessResponse<AssetsResponseDto & { items?: MarketAssetItemDto[] }>
  >(`/assets?${searchParams.toString()}`);

  const data = response.data.data;
  const assets = data.assets ?? data.items ?? [];

  return {
    ...data,
    assets,
    pagination:
      data.pagination ?? buildFallbackPagination(limit, offset, assets.length),
  };
}
