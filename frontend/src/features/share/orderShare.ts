import type { CreateOrderDto } from '../order/api';
import type { CompletedTrade, CompletedTradesDto } from '../tradingAccount/api';

/**
 * 공유하기 on an order's success screen (2026-11-06; pure, node --test loads it).
 *
 * Only a SELL that really executed may offer it, and only with the completed
 * trade that SELL closed: the 거래 완료 policy's own card (backend
 * docs/completed-trades-share-contract.md), on the same account and asset,
 * whose last SELL is this very order (`lastSellOrderId`). Nothing is computed
 * here — no figure exists for a SELL that has not completed a trade, so a
 * partial sell, an open limit/LOC registration, a BUY, another account's or an
 * earlier round's trade can never become this order's card.
 */
export type OrderShareTarget = { accountId: string; orderId: string; assetId: string };

export type OrderShareCheck =
  | { state: 'ready'; trade: Extract<CompletedTrade, { kind: 'spot' }> }
  /** The holding is still open after this SELL: nothing is complete to share yet. */
  | { state: 'holding' }
  /** No completed trade can be proven to be the one this SELL closed. */
  | { state: 'unverified' };

/** The executed SELL a success shows, or null when it may not offer 공유하기. */
export function getOrderShareTarget(accountId: string, payload: CreateOrderDto | null): OrderShareTarget | null {
  if (!accountId || !payload) return null;
  const { order, execution } = payload;
  if (execution.state !== 'executed' && execution.state !== 'already_executed') return null;
  if ((order.side ?? execution.side) !== 'sell') return null;
  const orderId = order.id ?? order.orderId ?? execution.orderId;
  const assetId = order.assetId ?? order.asset?.id ?? execution.assetId;
  const executed = order.marketExecution?.executedQuantity ?? order.quantity ?? execution.quantity;
  if (!orderId || !assetId || !(Number(executed) > 0)) return null;
  return { accountId, orderId, assetId };
}

/**
 * Decides from the account's completed trades read after the order; the
 * holding still left (from the positions read, null when unknown) only names
 * why a SELL cannot share yet.
 */
export function resolveOrderShare(
  target: OrderShareTarget,
  trades: CompletedTradesDto,
  heldQuantity: string | null,
): OrderShareCheck {
  const trade = trades.tradingAccountId === target.accountId
    ? trades.items.find((item) => item.kind === 'spot' && item.assetId === target.assetId)
    : undefined;
  if (trade?.kind === 'spot' && trade.lastSellOrderId === target.orderId) return { state: 'ready', trade };
  if (heldQuantity !== null && Number(heldQuantity) > 0) return { state: 'holding' };
  return { state: 'unverified' };
}

/** Why 공유하기 is not available (none while it is, or while the check runs). */
export const ORDER_SHARE_NOTE = {
  holding: '보유 수량을 모두 매도해 거래가 완료되면 공유할 수 있어요.',
  unverified: '이 매도로 완료된 거래를 확인하지 못했어요. 거래 내역의 거래 완료에서 확인해 주세요.',
  failed: '공유할 수 있는지 확인하지 못했어요. 다시 눌러 주세요.',
} as const;
