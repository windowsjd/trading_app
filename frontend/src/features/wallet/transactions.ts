import type {
  WalletCurrency,
  WalletTransactionDirection,
  WalletTransactionDto,
  WalletTransactionFilter,
} from './api';
import type {
  TradingAccountMode,
  TradingAccountWalletTransactionsDto,
  TradingAccountWalletTransactionsParams,
} from '../tradingAccount/api';
import { formatDisplayDecimal, formatKstDateTime, formatMoney } from '../../utils/format.ts';

export type LedgerDirection = 'all' | WalletTransactionDirection;
export type LedgerType = 'all' | WalletTransactionFilter;

const TYPES: ReadonlyArray<{
  key: LedgerType;
  label: string;
  directions: readonly LedgerDirection[];
  generalKrwOnly?: boolean;
}> = [
  { key: 'all', label: '전체', directions: ['all', 'credit', 'debit'] },
  { key: 'order_buy', label: '매수', directions: ['all', 'debit'] },
  { key: 'order_sell', label: '매도', directions: ['all', 'credit'] },
  { key: 'exchange', label: '환전', directions: ['all', 'credit', 'debit'] },
  { key: 'ad_reward', label: '광고 보상', directions: ['all', 'credit'], generalKrwOnly: true },
];

export function getLedgerTypeFilters(
  direction: LedgerDirection,
  mode: TradingAccountMode | undefined,
  currency: WalletCurrency,
) {
  return TYPES.filter((type) =>
    type.directions.includes(direction) &&
    (!type.generalKrwOnly || (mode === 'general' && currency === 'KRW')),
  );
}

export function compatibleLedgerType(
  type: LedgerType,
  direction: LedgerDirection,
  mode: TradingAccountMode | undefined,
  currency: WalletCurrency,
): LedgerType {
  return getLedgerTypeFilters(direction, mode, currency).some((item) => item.key === type)
    ? type : 'all';
}

const TYPE_LABELS: Record<string, string> = {
  order_buy: '매수', order_sell: '매도',
  exchange_source: '환전', exchange_target: '환전', ad_reward: '광고 보상',
  // No current standalone writers/chips, but historical rows must stay visible.
  fee: '수수료', adjustment: '조정', settlement: '정산',
};

export function getLedgerRowDisplay(item: WalletTransactionDto) {
  return {
    title: TYPE_LABELS[item.txType] ?? item.txType,
    asset: item.asset ? `${item.asset.name} · ${item.asset.symbol}` : null,
    quantity: item.trade && item.asset
      ? `${formatDisplayDecimal(item.trade.quantity)}${item.asset.assetType === 'crypto' ? ` ${item.asset.symbol}` : '주'}`
      : null,
    direction: item.direction === 'credit' ? '입금' : '출금',
    amount: `${item.direction === 'credit' ? '+' : '-'} ${formatMoney(item.amount, item.currencyCode)}`,
    balance: `잔액 ${formatMoney(item.balanceAfter, item.currencyCode)}`,
    date: formatKstDateTime(item.occurredAt),
  };
}

export function mergeLedgerPages(pages: readonly TradingAccountWalletTransactionsDto[]) {
  const rows = new Map<string, WalletTransactionDto>();
  for (const page of pages) {
    for (const row of page.transactions) rows.set(row.id, row);
  }
  return Array.from(rows.values());
}

export class WalletLedgerContractError extends Error {
  constructor() {
    super('지갑 원장 응답을 안전하게 표시할 수 없습니다.');
    this.name = 'WalletLedgerContractError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const money = (value: unknown) => text(value) && /^-?\d+(\.\d+)?$/.test(value);
const date = (value: unknown) => text(value) && value.endsWith('Z') && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Validate at the query boundary: a malformed success becomes ErrorState,
 * never an empty/partial ledger or a render-time exception. No shape fallbacks. */
export function parseWalletLedgerResponse(
  payload: unknown,
  accountId: string,
  params: TradingAccountWalletTransactionsParams,
): TradingAccountWalletTransactionsDto {
  const fail = (): never => { throw new WalletLedgerContractError(); };
  if (!isRecord(payload) || payload.tradingAccountId !== accountId) return fail();
  const { transactions, pagination, filters } = payload;
  if (!Array.isArray(transactions) || !isRecord(pagination) || !isRecord(filters)) return fail();
  if (filters.currency !== (params.currency ?? null) ||
      filters.direction !== (params.direction ?? null) ||
      filters.txType !== (params.txType ?? null)) return fail();
  if (!integer(pagination.limit) || pagination.limit !== Math.min(params.limit ?? 20, 100) ||
      !integer(pagination.offset) || pagination.offset !== (params.offset ?? 0) ||
      !integer(pagination.total) || !integer(pagination.returned) ||
      pagination.returned !== transactions.length || transactions.length > pagination.limit) return fail();
  const next = pagination.offset + pagination.returned;
  if (pagination.nextOffset !== (next < pagination.total ? next : null) ||
      (transactions.length === 0 && pagination.nextOffset !== null)) return fail();

  const ids = new Set<string>();
  for (const row of transactions) {
    if (!isRecord(row) || !text(row.id) || ids.has(row.id) ||
        (row.currencyCode !== 'KRW' && row.currencyCode !== 'USD') ||
        (row.direction !== 'credit' && row.direction !== 'debit') ||
        !text(row.txType) || row.txType === 'initial_grant' ||
        !text(row.referenceType) || !(row.referenceId === null || text(row.referenceId)) ||
        !money(row.amount) || !money(row.balanceAfter) ||
        !date(row.occurredAt) || !date(row.createdAt)) return fail();
    if ((params.currency && row.currencyCode !== params.currency) ||
        (params.direction && row.direction !== params.direction)) return fail();
    if (params.txType && !(params.txType === 'exchange'
      ? row.txType === 'exchange_source' || row.txType === 'exchange_target'
      : row.txType === params.txType)) return fail();
    if (row.txType === 'order_buy' || row.txType === 'order_sell') {
      if (row.referenceType !== 'order' || !text(row.referenceId) ||
          !isRecord(row.asset) || !text(row.asset.id) || !text(row.asset.name) || !text(row.asset.symbol) ||
          !text(row.asset.assetType) || !['domestic_stock', 'us_stock', 'crypto'].includes(row.asset.assetType) ||
          !isRecord(row.trade) || !text(row.trade.quantity) ||
          !/^\d+(\.\d{1,8})?$/.test(row.trade.quantity) || !/[1-9]/.test(row.trade.quantity) ||
          row.direction !== (row.txType === 'order_buy' ? 'debit' : 'credit')) return fail();
    } else if (row.asset !== null || row.trade !== null) return fail();
    ids.add(row.id);
  }
  return payload as unknown as TradingAccountWalletTransactionsDto;
}
