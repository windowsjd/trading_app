import type { Prisma } from '../generated/prisma/client';

/**
 * What keeps a general account from being reset (2026-10-20).
 *
 * A reset moves the four wallets to their targets; it never sells, closes or
 * cancels anything on the user's behalf. So it is refused while anything is
 * held or could still execute or move money:
 *
 *   SPOT_HOLDINGS             a Position with quantity or reserved quantity
 *   FUTURES_POSITIONS         an open FuturesPosition
 *   OPEN_ORDERS               a submitted spot/limit Order, a pending LOC
 *                             order, a submitted Futures limit order
 *   ACTIVE_CONDITIONAL_ORDERS a watching/triggered conditional BUY/SELL or
 *                             Futures conditional entry, a watching/triggered
 *                             Futures TP/SL, a pending entry TP/SL plan, a
 *                             holding/active protection group
 *   RESERVED_FUNDS            any wallet with reserved cash
 *
 * Read twice: once before the ad completion is verified (so an obviously
 * blocked reset never spends a verification) and again under the account row
 * lock inside the reset transaction, which every order, fill, FX, transfer and
 * Futures path also takes — nothing can be added between the check and the
 * reset. An `ordered` conditional row is covered by its linked order.
 */

export const GENERAL_ACCOUNT_RESET_BLOCKERS = [
  'SPOT_HOLDINGS',
  'FUTURES_POSITIONS',
  'OPEN_ORDERS',
  'ACTIVE_CONDITIONAL_ORDERS',
  'RESERVED_FUNDS',
] as const;

export type GeneralAccountResetBlocker =
  (typeof GENERAL_ACCOUNT_RESET_BLOCKERS)[number];

export type ResetBlockerClient = Pick<
  Prisma.TransactionClient,
  | 'position'
  | 'futuresPosition'
  | 'order'
  | 'limitOnCloseOrder'
  | 'futuresLimitOrder'
  | 'conditionalBuyOrder'
  | 'conditionalSellOrder'
  | 'futuresConditionalEntry'
  | 'futuresTpSlSetting'
  | 'entryTpSlPlan'
  | 'protectionGroup'
  | 'cashWallet'
>;

/** A fresh filter per query: Prisma's enum filters take mutable arrays. */
const liveConditional = () => ({
  in: ['watching' as const, 'triggered' as const],
});

export async function readGeneralAccountResetBlockers(
  client: ResetBlockerClient,
  tradingAccountId: string,
): Promise<GeneralAccountResetBlocker[]> {
  const id = { id: true } as const;
  const [
    holding,
    futuresPosition,
    order,
    limitOnClose,
    futuresLimit,
    conditionalBuy,
    conditionalSell,
    futuresEntry,
    futuresTpSl,
    entryPlan,
    protection,
    reserved,
  ] = await Promise.all([
    client.position.findFirst({
      where: {
        tradingAccountId,
        OR: [{ quantity: { gt: 0 } }, { reservedQuantity: { gt: 0 } }],
      },
      select: id,
    }),
    client.futuresPosition.findFirst({
      where: { tradingAccountId, status: 'open' },
      select: id,
    }),
    client.order.findFirst({
      where: { tradingAccountId, status: 'submitted' },
      select: id,
    }),
    client.limitOnCloseOrder.findFirst({
      where: { tradingAccountId, status: 'pending' },
      // Keyed by its Order.
      select: { orderId: true },
    }),
    client.futuresLimitOrder.findFirst({
      where: { tradingAccountId, status: 'submitted' },
      select: id,
    }),
    client.conditionalBuyOrder.findFirst({
      where: { tradingAccountId, status: liveConditional() },
      select: id,
    }),
    client.conditionalSellOrder.findFirst({
      where: { tradingAccountId, status: liveConditional() },
      select: id,
    }),
    client.futuresConditionalEntry.findFirst({
      where: { tradingAccountId, status: liveConditional() },
      select: id,
    }),
    client.futuresTpSlSetting.findFirst({
      where: { tradingAccountId, status: liveConditional() },
      select: id,
    }),
    client.entryTpSlPlan.findFirst({
      where: { tradingAccountId, status: 'pending' },
      select: id,
    }),
    client.protectionGroup.findFirst({
      where: { tradingAccountId, status: { in: ['holding', 'active'] } },
      select: id,
    }),
    client.cashWallet.findFirst({
      where: { tradingAccountId, reservedAmount: { gt: 0 } },
      select: id,
    }),
  ]);

  const blockers: GeneralAccountResetBlocker[] = [];
  if (holding) blockers.push('SPOT_HOLDINGS');
  if (futuresPosition) blockers.push('FUTURES_POSITIONS');
  if (order || limitOnClose || futuresLimit) blockers.push('OPEN_ORDERS');
  if (
    conditionalBuy ||
    conditionalSell ||
    futuresEntry ||
    futuresTpSl ||
    entryPlan ||
    protection
  ) {
    blockers.push('ACTIVE_CONDITIONAL_ORDERS');
  }
  if (reserved) blockers.push('RESERVED_FUNDS');
  return blockers;
}
