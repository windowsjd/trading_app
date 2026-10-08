import { createApiError } from '../common/api-error';
import { Prisma } from '../generated/prisma/client';
import { assertConditionalEnabled } from './conditional-policy';

export const liveProtection = {
  status: { in: ['holding', 'active'] as ('holding' | 'active')[] },
};
export const protectionInclude = {
  legs: true,
  children: { where: { status: 'pending' as const }, include: { leg: true } },
} as const;

/** Caller has released any Spot Order reservation before terminalizing. */
export async function finishProtection(
  tx: Prisma.TransactionClient,
  id: string,
  status: 'completed' | 'canceled',
  reason: string,
  now: Date,
) {
  await tx.protectionChild.updateMany({
    where: { groupId: id, status: 'pending' },
    data: { status: 'canceled', endedAt: now, terminalReason: reason },
  });
  await tx.protectionGroup.updateMany({
    where: { id, ...liveProtection },
    data: { status, terminalReason: reason, endedAt: now },
  });
}

export async function finishFuturesProtection(
  tx: Prisma.TransactionClient,
  positionId: string,
  reason: string,
  now: Date,
) {
  const groups = await tx.protectionGroup.findMany({
    where: { futuresPositionId: positionId, ...liveProtection },
    select: { id: true },
  });
  for (const group of groups)
    await finishProtection(tx, group.id, 'completed', reason, now);
}

/** Normal cancel and lifecycle cleanup share the reservation-release core. */
export async function protectionOrderCanceled(
  tx: Prisma.TransactionClient,
  orderId: string,
  reason: string,
  now: Date,
) {
  const parent = await tx.protectionGroup.findUnique({
    where: { parentOrderId: orderId },
  });
  if (parent?.status === 'holding')
    await finishProtection(tx, parent.id, 'canceled', reason, now);
  const child = await tx.protectionChild.findUnique({ where: { orderId } });
  if (!child || child.status !== 'pending') return;
  await tx.protectionChild.update({
    where: { id: child.id },
    data: { status: 'canceled', terminalReason: reason, endedAt: now },
  });
  if (
    reason !== 'conditional_replaced' &&
    reason !== 'conditional_manual_reduce'
  )
    await finishProtection(tx, child.groupId, 'canceled', reason, now);
}

/** Executed user order, including one-shot ERS partials. Never assumes full fill. */
export async function reconcileSpotProtection(
  tx: Prisma.TransactionClient,
  accountId: string,
  assetId: string,
  orderId: string,
  now: Date,
  childId?: string,
) {
  const live = await tx.protectionGroup.findFirst({
    where: {
      tradingAccountId: accountId,
      assetId,
      domain: 'spot',
      ...liveProtection,
    },
  });
  if (!live) return;
  const position = await tx.position.findUnique({
    where: {
      tradingAccountId_assetId: { tradingAccountId: accountId, assetId },
    },
  });
  const parent = await tx.protectionGroup.findUnique({
    where: { parentOrderId: orderId },
  });
  if (parent?.status === 'holding' && position?.quantity.gt(0)) {
    await tx.protectionGroup.update({
      where: { id: parent.id },
      data: { status: 'active', positionId: position.id, activatedAt: now },
    });
  }
  const child = childId
    ? await tx.protectionChild.findUnique({ where: { id: childId } })
    : await tx.protectionChild.findUnique({ where: { orderId } });
  if (child?.status === 'pending') {
    await tx.protectionChild.update({
      where: { id: child.id },
      data: {
        status: 'filled',
        orderId,
        endedAt: now,
        terminalReason: 'executed',
      },
    });
  }
  if (!position || position.quantity.lte(0)) {
    const groups = await tx.protectionGroup.findMany({
      where: {
        tradingAccountId: accountId,
        assetId,
        domain: 'spot',
        status: 'active',
      },
    });
    for (const group of groups)
      await finishProtection(tx, group.id, 'completed', 'position_closed', now);
  }
}

export async function assertPendingChild(
  tx: Prisma.TransactionClient,
  childId: string,
  accountId: string,
  domain: 'spot' | 'futures',
) {
  assertConditionalEnabled(domain);
  const child = await tx.protectionChild.findUnique({
    where: { id: childId },
    include: { leg: true, group: true },
  });
  if (
    !child ||
    child.status !== 'pending' ||
    child.group.status !== 'active' ||
    child.group.tradingAccountId !== accountId ||
    child.group.domain !== domain
  )
    throw createApiError(
      'PROTECTION_CHILD_CHANGED',
      'Protection changed before execution.',
      409,
    );
  return child;
}

export async function prepareSpotProtection(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    assetId: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit';
    now: Date;
    childId?: string;
  },
  cancelOrder: (id: string) => Promise<unknown>,
) {
  const group = await tx.protectionGroup.findFirst({
    where: {
      tradingAccountId: input.accountId,
      assetId: input.assetId,
      domain: 'spot',
      ...liveProtection,
    },
    include: protectionInclude,
  });
  if (input.childId) {
    const child = await assertPendingChild(
      tx,
      input.childId,
      input.accountId,
      'spot',
    );
    if (
      !group ||
      child.groupId !== group.id ||
      input.side !== 'sell' ||
      child.leg.childOrderType !== input.orderType
    )
      throw createApiError(
        'PROTECTION_CHILD_CHANGED',
        'Protection changed before execution.',
        409,
      );
    return;
  }
  if (!group) return;
  if (group.status === 'holding')
    throw createApiError(
      'ATTACHED_ENTRY_CONFLICT',
      'An attached entry already owns this position.',
      409,
    );
  const child = group.children[0];
  if (input.side === 'buy') {
    if (child)
      throw createApiError(
        'PROTECTION_CHILD_PENDING',
        'Cancel the pending protection child before increasing.',
        409,
      );
    return;
  }
  if (input.orderType === 'limit')
    throw createApiError(
      'PROTECTION_CONFLICT',
      'Cancel protection before placing a separate Limit sell.',
      409,
    );
  if (child?.orderId) await cancelOrder(child.orderId);
  if (child)
    await tx.protectionChild.updateMany({
      where: { id: child.id, status: 'pending' },
      data: {
        status: 'canceled',
        endedAt: input.now,
        terminalReason: 'conditional_manual_reduce',
      },
    });
}
