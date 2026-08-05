import type { RecordOrderItemDto } from './api';
import type { TradingAccountOrdersDto } from '../tradingAccount/api';

/**
 * Adapts an account-scoped order row to the row shape the order list already
 * renders (작업 10 §A-5).
 *
 * The two payloads describe the same Order rows through the same server
 * presenter; they differ in one respect that matters to the UI: the
 * account-scoped row nests the asset (`asset: { symbol, name }`) while the
 * record row carries `symbol`/`name` flat. Rather than teach every display
 * helper about both shapes — which is how a screen ends up rendering "-" for a
 * name it was actually given — the difference is flattened once, here.
 *
 * WHY THE SCREEN MOVED TO THE ACCOUNT-SCOPED LIST AT ALL
 * -----------------------------------------------------
 * This list shows LIVE orders: it polls open limit buys and offers cancel. The
 * record API selects by season participation; the account API selects by the
 * order's own `tradingAccountId` and fails closed when those two disagree. For
 * a screen whose buttons move money, the stricter source is the correct one,
 * and it makes the list, the cancel, and the cache invalidation all name the
 * same account.
 */

type AccountOrderRow = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function strOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return str(value);
}

export function toRecordOrderItem(row: AccountOrderRow): RecordOrderItemDto {
  const asset = (row.asset ?? null) as Record<string, unknown> | null;

  return {
    orderId: str(row.orderId) ?? str(row.id),
    id: str(row.id),
    assetId: str(asset?.id) ?? str(row.assetId),
    symbol: str(asset?.symbol) ?? str(row.symbol),
    name: str(asset?.name) ?? str(row.name),
    side: (str(row.side) ?? 'buy') as RecordOrderItemDto['side'],
    orderType: str(row.orderType),
    status: str(row.status),
    quantity: str(row.quantity) ?? '0',
    limitPrice: strOrNull(row.limitPrice),
    executedPrice: str(row.executedPrice),
    currencyCode: str(row.currencyCode) as RecordOrderItemDto['currencyCode'],
    grossAmount: strOrNull(row.grossAmount),
    feeAmount: strOrNull(row.feeAmount),
    netAmount: str(row.netAmount),
    reservedAmount: strOrNull(row.reservedAmount),
    reservationReleasedAt: strOrNull(row.reservationReleasedAt),
    cancelReason: strOrNull(row.cancelReason),
    submittedAt: str(row.submittedAt),
    executedAt: str(row.executedAt),
  };
}

export function toRecordOrderItems(
  data: TradingAccountOrdersDto | null | undefined,
): RecordOrderItemDto[] {
  return (data?.orders ?? []).map(toRecordOrderItem);
}
