import { apiClient } from '../../services/api/client';
import type {
  ApiSuccessResponse,
  IsoDateTimeString,
  MoneyString,
  OffsetPagination,
  QuantityString,
  RateString,
} from '../../models/dto/common';
import { formatCurrency, getAssetNameDisplay } from '../../utils/format';
import { getOrderStatusLabel, isOpenLimitBuyOrder } from './openOrder';

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

export interface ProfitAnalysisItemDto {
  assetId: string;
  symbol: string;
  name: string;
  market: string;
  assetType: string;
  currencyCode: 'KRW' | 'USD';
  realizedPnlLocal: MoneyString;
  realizedPnlKrw: MoneyString;
  unrealizedPnlLocal: MoneyString;
  unrealizedPnlKrw: MoneyString;
  totalPnlKrw: MoneyString;
  returnRate: RateString | null;
  returnRateState: 'available' | 'unavailable';
  positionState: 'open' | 'fully_sold';
  valuationState: 'available' | 'unavailable';
}

export interface RecordSeasonDetailDto {
  state: 'available' | 'not_joined';
  season: {
    id: string;
    name: string;
    status: string;
    startAt: IsoDateTimeString;
    endAt: IsoDateTimeString;
  };
  participant: {
    id: string;
    joinedAt: IsoDateTimeString;
    participantStatus: string;
    initialCapitalKrw: MoneyString;
    finalRank: number | null;
    finalTier: string | null;
    rewardGrantedAt: IsoDateTimeString | null;
  } | null;
  performance: {
    state: 'available' | 'unavailable';
    totalAssetKrw: MoneyString | null;
    returnRate: RateString | null;
    maxDrawdown: string | null;
    snapshotDate: string | null;
    capturedAt: IsoDateTimeString | null;
    reason?: string;
    message?: string;
  };
  activitySummary: {
    orders: {
      total: number;
      submitted: number;
      executed: number;
      canceled: number;
      rejected: number;
    };
    exchanges: {
      total: number;
    };
    walletTransactions: {
      total: number;
    };
    positions: {
      open: number;
    };
  };
  profitAnalysis: {
    state: 'available' | 'unavailable' | 'partial_unavailable';
    totalRealizedPnlKrw: MoneyString;
    totalUnrealizedPnlKrw: MoneyString;
    totalPnlKrw: MoneyString;
    bestAsset: ProfitAnalysisItemDto | null;
    worstAsset: ProfitAnalysisItemDto | null;
    items: ProfitAnalysisItemDto[];
    valuationErrors: Array<{
      assetId: string;
      code: string;
      message: string;
    }>;
  };
  reason?: string;
  message?: string;
}

export interface RecordSeasonEquityPointDto {
  time: string;
  totalAssetKrw: string;
  returnRate: string | null;
  capturedAt: string;
}

export interface RecordSeasonEquityDto {
  state: 'available' | 'empty' | 'not_joined';
  seasonId: string;
  points: RecordSeasonEquityPointDto[];
  pagination: OffsetPagination;
  reason?: string;
  message?: string;
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
  orderType?: 'market' | 'limit' | (string & {});
  status?: 'submitted' | 'executed' | 'canceled' | 'rejected' | (string & {});
  quantity: QuantityString;
  price?: MoneyString;
  limitPrice?: MoneyString | null;
  executedPrice?: MoneyString;
  fillPriceLocal?: MoneyString;
  currencyCode?: 'KRW' | 'USD';
  fillCurrency?: 'KRW' | 'USD';
  netAmount?: MoneyString;
  netAmountLocal?: MoneyString;
  // Limit-buy additive fields.
  reservedAmount?: MoneyString | null;
  reservationReleasedAt?: IsoDateTimeString | null;
  cancelReason?: string | null;
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

export interface GetRecordSeasonEquityParams {
  seasonId: string;
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

export { isOpenLimitBuyOrder } from './openOrder';

export function getRecordOrderDisplay(item: RecordOrderItemDto) {
  const currencyCode = item.currencyCode ?? item.fillCurrency ?? '';
  const nameDisplay = getAssetNameDisplay({ name: item.name, symbol: item.symbol });

  return {
    key: item.orderId ?? item.id ?? `${item.assetId ?? item.symbol}-${item.executedAt}`,
    orderId: item.orderId ?? item.id ?? null,
    symbol: item.symbol ?? item.assetId ?? '-',
    name: nameDisplay.primary,
    executedAt: item.executedAt ?? item.submittedAt ?? '-',
    side: item.side,
    // '지정가 매수' badge input; market rows keep their historical look.
    isLimitOrder: item.orderType === 'limit',
    statusLabel: getOrderStatusLabel(item.status),
    isOpenLimitBuy: isOpenLimitBuyOrder(item),
    limitPrice: item.limitPrice
      ? formatCurrency(item.limitPrice, currencyCode)
      : null,
    reservedAmount: item.reservedAmount
      ? formatCurrency(item.reservedAmount, currencyCode)
      : null,
    submittedAt: item.submittedAt ?? '-',
    quantity: item.quantity,
    price: formatCurrency(
      item.price ?? item.executedPrice ?? item.fillPriceLocal,
      currencyCode,
    ),
    currencyCode,
    netAmount: formatCurrency(item.netAmount ?? item.netAmountLocal, currencyCode),
  };
}

export function getRecordExchangeDisplay(item: RecordExchangeItemDto) {
  const feeCurrency = item.feeCurrency ?? '';

  return {
    key: item.exchangeId ?? item.id ?? `${item.fromCurrency}-${item.toCurrency}-${item.executedAt}`,
    executedAt: item.executedAt ?? '-',
    direction: `${item.fromCurrency} → ${item.toCurrency}`,
    sourceAmount: formatCurrency(item.sourceAmount, item.fromCurrency),
    rate: item.appliedRate ?? item.executeRate ?? item.rate ?? '-',
    feeAmount: formatCurrency(item.feeAmount, feeCurrency),
    feeCurrency,
    netTargetAmount: formatCurrency(item.netTargetAmount, item.toCurrency),
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

export async function getMySeasonEquity({
  seasonId,
  limit = 500,
  offset = 0,
}: GetRecordSeasonEquityParams) {
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  searchParams.set('offset', String(offset));

  const response = await apiClient.get<ApiSuccessResponse<RecordSeasonEquityDto>>(
    `/records/me/seasons/${seasonId}/equity?${searchParams.toString()}`,
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
