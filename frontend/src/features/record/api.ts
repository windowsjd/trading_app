import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  PercentString,
  QuantityString,
  RateString,
} from '../../models/dto/common';

export interface RecordSeasonListItemDto {
  seasonId: string;
  seasonName: string;
  joinedAt: IsoDateTimeString;
  finalRank?: number | null;
  rank?: number | null;
  finalTier?: string | null;
  tier?: string | null;
  finalReturnRate?: RateString | null;
  returnRate?: RateString | null;
  finalTotalAssetKrw?: MoneyString | null;
  totalAssetKrw?: MoneyString | null;
}

export interface RecordSeasonDetailDto {
  season: {
    id: string;
    name: string;
    startAt: IsoDateTimeString;
    endAt: IsoDateTimeString;
  };
  summary: {
    finalRank?: number | null;
    rank?: number | null;
    finalTier?: string | null;
    tier?: string | null;
    finalReturnRate?: RateString | null;
    returnRate?: RateString | null;
    finalTotalAssetKrw?: MoneyString | null;
    totalAssetKrw?: MoneyString | null;
    maxDrawdown?: PercentString | null;
    mdd?: PercentString | null;
    totalFillCount?: number | null;
    fillCount?: number | null;
  };
  stats?: {
    bestAsset?: string | null;
    worstAsset?: string | null;
  } | null;
  equityChart: Array<{
    time: IsoDateTimeString;
    totalAssetKrw: MoneyString;
  }>;
}

export interface RecordOrderItemDto {
  orderId?: string;
  id?: string;
  executedAt?: IsoDateTimeString;
  submittedAt?: IsoDateTimeString;
  assetId?: string;
  symbol?: string;
  name?: string;
  side: 'buy' | 'sell';
  quantity: QuantityString;
  price?: MoneyString;
  executedPrice?: MoneyString;
  fillPriceLocal?: MoneyString;
  currencyCode?: 'KRW' | 'USD';
  fillCurrency?: 'KRW' | 'USD';
  netAmount?: MoneyString;
  netAmountLocal?: MoneyString;
}

export interface RecordExchangeItemDto {
  exchangeId?: string;
  id?: string;
  executedAt?: IsoDateTimeString;
  fromCurrency: 'KRW' | 'USD';
  toCurrency: 'KRW' | 'USD';
  sourceAmount: MoneyString;
  appliedRate?: RateString;
  executeRate?: RateString;
  rate?: RateString;
  feeAmount?: MoneyString;
  feeCurrency?: 'KRW' | 'USD';
  netTargetAmount?: MoneyString;
}

export interface OffsetRecordResponse<T> {
  items: T[];
  pagination: OffsetPagination;
}

export interface GetRecordPageParams {
  limit?: number;
  offset?: number;
}

export interface GetRecordOrdersParams extends GetRecordPageParams {
  seasonId: string;
  side?: 'buy' | 'sell';
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

function normalizePage<T>(
  data: {
    items?: T[];
    seasons?: T[];
    orders?: T[];
    exchanges?: T[];
    pagination?: OffsetPagination;
  },
  limit: number,
  offset: number,
): OffsetRecordResponse<T> {
  const items = data.items ?? data.seasons ?? data.orders ?? data.exchanges ?? [];

  return {
    items,
    pagination:
      data.pagination ?? buildFallbackPagination(limit, offset, items.length),
  };
}

export function getRecordOrderDisplay(item: RecordOrderItemDto) {
  return {
    key: item.orderId ?? item.id ?? `${item.assetId ?? item.symbol}-${item.executedAt}`,
    symbol: item.symbol ?? item.assetId ?? '-',
    name: item.name ?? '-',
    executedAt: item.executedAt ?? item.submittedAt ?? '-',
    side: item.side,
    quantity: item.quantity,
    price: item.price ?? item.executedPrice ?? item.fillPriceLocal ?? '-',
    currencyCode: item.currencyCode ?? item.fillCurrency ?? '',
    netAmount: item.netAmount ?? item.netAmountLocal ?? '-',
  };
}

export function getRecordExchangeDisplay(item: RecordExchangeItemDto) {
  return {
    key: item.exchangeId ?? item.id ?? `${item.fromCurrency}-${item.toCurrency}-${item.executedAt}`,
    executedAt: item.executedAt ?? '-',
    direction: `${item.fromCurrency} → ${item.toCurrency}`,
    sourceAmount: item.sourceAmount,
    rate: item.appliedRate ?? item.executeRate ?? item.rate ?? '-',
    feeAmount: item.feeAmount ?? '-',
    feeCurrency: item.feeCurrency ?? '',
    netTargetAmount: item.netTargetAmount ?? '-',
  };
}

export async function getMySeasonRecords(params: GetRecordPageParams = {}) {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<
    ApiSuccessResponse<
      OffsetRecordResponse<RecordSeasonListItemDto> & {
        seasons?: RecordSeasonListItemDto[];
      }
    >
  >(`/records/me/seasons?${searchParams.toString()}`);

  return normalizePage(response.data.data, limit, offset);
}

export async function getMySeasonRecordDetail(seasonId: string) {
  const response = await apiClient.get<ApiSuccessResponse<RecordSeasonDetailDto>>(
    `/records/me/seasons/${seasonId}`,
  );
  return response.data.data;
}

export async function getMySeasonOrders(params: GetRecordOrdersParams) {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));
  if (params.side) searchParams.set('side', params.side);

  const response = await apiClient.get<
    ApiSuccessResponse<
      OffsetRecordResponse<RecordOrderItemDto> & {
        orders?: RecordOrderItemDto[];
      }
    >
  >(
    `/records/me/seasons/${params.seasonId}/orders?${searchParams.toString()}`,
  );

  return normalizePage(response.data.data, limit, offset);
}

export async function getMySeasonExchanges(
  seasonId: string,
  params: GetRecordPageParams = {},
) {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<
    ApiSuccessResponse<
      OffsetRecordResponse<RecordExchangeItemDto> & {
        exchanges?: RecordExchangeItemDto[];
      }
    >
  >(`/records/me/seasons/${seasonId}/exchanges?${searchParams.toString()}`);

  return normalizePage(response.data.data, limit, offset);
}
