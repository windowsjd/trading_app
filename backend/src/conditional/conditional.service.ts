import {
  isStandaloneAccountMode,
  assertBeginnerModeEnabled,
  isBeginnerModeEnabled,
} from '../trading-accounts/account-mode-policy';
import { createApiError } from '../common/api-error';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { OrdersService } from '../orders/orders.service';
import { LimitOrderCancelService } from '../orders/limit-order-cancel.service';
import { FuturesService } from '../futures/futures.service';
import { futuresTradingMode } from '../futures/futures.config';
import { buildPagination } from '../common/pagination';
import { isLimitOrderEnabled } from '../orders/limit-order.config';
import { readLimitOrderMatchingConfig } from '../orders/limit-order-matching.config';
import {
  assertConditionalEnabled,
  conditionalEnabled,
  conditionalHash,
  conditionalKey,
  conditionalTradable,
  isTriggered,
  parseProtectionLegs,
} from './conditional-policy';
import { createProtectionInTransaction } from './conditional-registration';
import {
  finishProtection,
  liveProtection,
  protectionInclude,
} from './conditional-state';
import { conditionalPrice } from './conditional-price';

export type ProtectionBody = {
  domain?: unknown;
  positionId?: unknown;
  assetId?: unknown;
  legs?: unknown;
  idempotencyKey?: unknown;
};
@Injectable()
export class ConditionalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly orders: OrdersService,
    private readonly cancel: LimitOrderCancelService,
    private readonly futures: FuturesService,
  ) {}

  private user(userId: string | undefined): asserts userId is string {
    if (!userId) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  private async lockAccount(
    tx: Prisma.TransactionClient,
    accountId: string,
    userId: string,
  ) {
    const account = await this.access.getOwnedAccountOrThrow(
      userId,
      accountId,
      tx,
    );
    if (account.mode === 'season')
      await lockSeasonTradingContext(tx, {
        seasonParticipantId: account.seasonParticipant!.id,
        userId,
        participantWrite: true,
      });
    else
      await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${accountId} AND user_id = ${userId} FOR UPDATE`;
  }
  private async now(tx: Prisma.TransactionClient) {
    const [row] = await tx.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    return row.now;
  }
  async create(
    userId: string | undefined,
    accountId: string,
    body: ProtectionBody,
  ) {
    this.user(userId);
    const legs = parseProtectionLegs(body?.legs);
    const key = conditionalKey(body?.idempotencyKey);
    if (
      (body.domain !== 'spot' && body.domain !== 'futures') ||
      typeof body.assetId !== 'string' ||
      !body.assetId ||
      typeof body.positionId !== 'string' ||
      !body.positionId
    )
      throw createApiError(
        'INVALID_PROTECTION',
        'Specify a product, asset, and open position.',
        400,
      );
    const domain = body.domain,
      assetId = body.assetId,
      positionId = body.positionId;
    const hash = conditionalHash({
      operation: 'create',
      domain,
      assetId,
      positionId,
      legs,
    });
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const replay = await this.replay(tx, accountId, key, hash);
      if (replay) return replay;
      assertConditionalEnabled(domain);
      const now = await this.now(tx);
      const account = await this.access.getOwnedAccountOrThrow(
        userId,
        accountId,
        tx,
      );
      assertBeginnerModeEnabled(account.mode);
      if (!conditionalTradable(account, now))
        throw createApiError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account cannot create protection now.',
          409,
        );
      const group = await createProtectionInTransaction(tx, {
        accountId,
        domain,
        assetId,
        positionId,
        legs,
        now,
      });
      if (!conditionalTradable(account, await this.now(tx)))
        throw createApiError(
          'CONDITIONAL_ACCOUNT_NOT_TRADABLE',
          'The account trading window ended.',
          409,
        );
      return this.remember(tx, accountId, key, hash, {
        success: true,
        data: {
          tradingAccountId: accountId,
          groupId: group.id,
          status: group.status,
        },
      });
    });
  }
  async cancelGroup(
    userId: string | undefined,
    accountId: string,
    id: string,
    body: { idempotencyKey?: unknown },
  ) {
    this.user(userId);
    const key = conditionalKey(body?.idempotencyKey),
      hash = conditionalHash({ operation: 'cancel', id });
    await this.access.getOwnedAccountOrThrow(userId, accountId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const replay = await this.replay(tx, accountId, key, hash);
      if (replay) return replay;
      const group = await this.lockGroup(tx, id, accountId);
      if (!group)
        throw createApiError(
          'PROTECTION_NOT_FOUND',
          'Protection not found.',
          404,
        );
      const now = await this.now(tx);
      if (group.status === 'active' || group.status === 'holding') {
        await this.cancelPending(tx, group.children[0], 'user_canceled', now);
        await finishProtection(tx, id, 'canceled', 'user_canceled', now);
      }
      const state = await tx.protectionGroup.findUniqueOrThrow({
        where: { id },
      });
      return this.remember(tx, accountId, key, hash, {
        success: true,
        data: {
          tradingAccountId: accountId,
          groupId: id,
          status: state.status,
        },
      });
    });
  }
  private async replay(
    tx: Prisma.TransactionClient,
    accountId: string,
    key: string,
    hash: string,
  ) {
    const row = await tx.protectionCommand.findUnique({
      where: {
        tradingAccountId_idempotencyKey: {
          tradingAccountId: accountId,
          idempotencyKey: key,
        },
      },
    });
    if (!row) return null;
    if (row.requestHash !== hash)
      throw createApiError(
        'CONDITIONAL_IDEMPOTENCY_CONFLICT',
        'The command differs from the committed request.',
        409,
      );
    return row.responsePayloadJson;
  }
  private async remember(
    tx: Prisma.TransactionClient,
    accountId: string,
    key: string,
    hash: string,
    result: Prisma.InputJsonObject,
  ) {
    await tx.protectionCommand.create({
      data: {
        tradingAccountId: accountId,
        idempotencyKey: key,
        requestHash: hash,
        responsePayloadJson: result,
      },
    });
    return result;
  }
  async list(
    userId: string | undefined,
    accountId: string,
    query: {
      limit?: string;
      offset?: string;
      assetId?: string;
      domain?: string;
      history?: string;
    },
  ) {
    this.user(userId);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const limit = Number(query.limit ?? 30),
      offset = Number(query.offset ?? 0);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      (query.domain && !['spot', 'futures'].includes(query.domain)) ||
      (query.history !== undefined &&
        !['true', 'false'].includes(query.history))
    )
      throw createApiError('INVALID_PAGINATION', 'Invalid history query.', 400);
    const where: Prisma.ProtectionGroupWhereInput = {
      tradingAccountId: accountId,
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.domain ? { domain: query.domain as 'spot' | 'futures' } : {}),
      ...(query.history === 'true' ? {} : liveProtection),
    };
    const [rows, total, clock] = await Promise.all([
      this.prisma.protectionGroup.findMany({
        where,
        include: {
          asset: {
            select: { settlementCurrency: true, symbol: true, name: true },
          },
          legs: true,
          children: {
            orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
            take: 20,
            include: {
              order: {
                select: {
                  status: true,
                  executedQuantity: true,
                  executedAt: true,
                },
              },
            },
          },
          position: { select: { quantity: true } },
          futuresPosition: { select: { quantity: true, status: true } },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.protectionGroup.count({ where }),
      this.now(this.prisma),
    ]);
    const tradable =
      conditionalTradable(account, clock) &&
      conditionalEnabled() &&
      (account.mode !== 'beginner' || isBeginnerModeEnabled());
    return {
      success: true,
      data: {
        tradingAccountId: accountId,
        capabilities: {
          enabled: conditionalEnabled(),
          canCreateSpot: tradable,
          canCreateFutures: tradable && futuresTradingMode() !== 'DISABLED',
          canCancel: true,
          canUseSpotLimit:
            conditionalEnabled() &&
            isLimitOrderEnabled() &&
            readLimitOrderMatchingConfig().matchingEnabled,
        },
        groups: rows.map((g) => ({
          id: g.id,
          domain: g.domain,
          assetId: g.assetId,
          currencyCode:
            g.domain === 'futures' ? 'USD' : g.asset.settlementCurrency,
          positionId: g.positionId ?? g.futuresPositionId,
          parentOrderId: g.parentOrderId,
          parentFuturesOrderId: g.parentFuturesOrderId,
          asset: { symbol: g.asset.symbol, name: g.asset.name },
          direction: g.direction,
          status: g.status,
          terminalReason: g.terminalReason,
          remainingQuantity:
            g.status === 'active'
              ? ((g.position?.quantity ?? g.futuresPosition?.quantity)?.toFixed(
                  8,
                ) ?? null)
              : null,
          createdAt: g.createdAt.toISOString(),
          activatedAt: g.activatedAt?.toISOString() ?? null,
          endedAt: g.endedAt?.toISOString() ?? null,
          legs: g.legs.map((leg) => ({
            id: leg.id,
            kind: leg.kind,
            triggerPrice: leg.triggerPrice.toFixed(8),
            childOrderType: leg.childOrderType,
            childLimitPrice: leg.childLimitPrice?.toFixed(8) ?? null,
            state:
              g.status === 'holding'
                ? 'holding'
                : g.status !== 'active'
                  ? g.status === 'completed' &&
                    g.children.some(
                      (c) =>
                        c.legId === leg.id &&
                        c.status === 'filled' &&
                        c.endedAt?.getTime() === g.endedAt?.getTime(),
                    )
                    ? 'completed'
                    : 'canceled'
                  : g.children.some(
                        (c) => c.legId === leg.id && c.status === 'pending',
                      )
                    ? 'triggered'
                    : 'armed',
          })),
          children: g.children.map((c) => ({
            id: c.id,
            legId: c.legId,
            status: c.status,
            quantity: c.quantity.toFixed(8),
            orderId: c.orderId,
            futuresExecutionId: c.futuresExecutionId,
            triggerEvidence: c.triggerEvidenceJson,
            triggeredAt: c.triggeredAt.toISOString(),
            endedAt: c.endedAt?.toISOString() ?? null,
            terminalReason: c.terminalReason,
          })),
        })),
        pagination: buildPagination({
          limit,
          offset,
          total,
          returned: rows.length,
        }),
      },
    };
  }

  private async lockGroup(
    tx: Prisma.TransactionClient,
    id: string,
    accountId: string,
  ) {
    const target = await tx.protectionGroup.findFirst({
      where: { id, tradingAccountId: accountId },
      include: protectionInclude,
    });
    // Never hold Position/group while waiting on a canceler's Order lock.
    const orderId = target?.children[0]?.orderId;
    if (orderId)
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM protection_groups WHERE id = ${id} AND trading_account_id = ${accountId} FOR UPDATE`;
    return tx.protectionGroup.findFirst({
      where: { id, tradingAccountId: accountId },
      include: {
        ...protectionInclude,
        asset: true,
        position: true,
        futuresPosition: true,
      },
    });
  }
  private async cancelPending(
    tx: Prisma.TransactionClient,
    child: { id: string; orderId: string | null } | undefined,
    reason:
      | 'user_canceled'
      | 'season_ended'
      | 'participant_excluded'
      | 'account_not_tradable'
      | 'conditional_replaced',
    now: Date,
  ) {
    if (!child) return;
    if (child.orderId)
      await this.cancel.cancelConditionalChildInTransaction(
        tx,
        child.orderId,
        reason,
        now,
      );
    await tx.protectionChild.updateMany({
      where: { id: child.id, status: 'pending' },
      data: { status: 'canceled', terminalReason: reason, endedAt: now },
    });
  }
  async evaluate(id: string) {
    const target = await this.prisma.protectionGroup.findUnique({
      where: { id },
      select: {
        tradingAccountId: true,
        tradingAccount: { select: { userId: true } },
      },
    });
    if (!target) return { state: 'terminal' };
    const accountId = target.tradingAccountId,
      userId = target.tradingAccount.userId;
    const decision = await this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, accountId, userId);
      const group = await this.lockGroup(tx, id, accountId);
      if (!group || !['holding', 'active'].includes(group.status))
        return { state: 'terminal' };
      // The lifecycle/account writer fence serializes all normal mutations.
      const now = await this.now(tx);
      const account = await this.access.getOwnedAccountOrThrow(
        userId,
        accountId,
        tx,
      );
      if (!conditionalTradable(account, now)) {
        const reason = isStandaloneAccountMode(account.mode)
          ? 'account_not_tradable'
          : account.seasonParticipant?.participantStatus === 'excluded'
            ? 'participant_excluded'
            : 'season_ended';
        await this.cancelPending(tx, group.children[0], reason, now);
        await finishProtection(tx, id, 'canceled', reason, now);
        return { state: 'lifecycle_canceled' };
      }
      if (group.status === 'holding') return { state: 'holding' };
      const quantity =
        group.domain === 'spot'
          ? group.position?.quantity
          : group.futuresPosition?.quantity;
      if (
        !quantity?.gt(0) ||
        (group.domain === 'futures' && group.futuresPosition?.status !== 'open')
      ) {
        await this.cancelPending(tx, group.children[0], 'user_canceled', now);
        await finishProtection(tx, id, 'completed', 'position_closed', now);
        return { state: 'completed' };
      }
      if (
        !conditionalEnabled() ||
        (group.domain === 'futures' && futuresTradingMode() === 'DISABLED')
      )
        return { state: 'disabled' };
      const price = await conditionalPrice(tx, group.asset, group.domain, now);
      if (!price) return { state: 'price_unavailable' };
      const pending = group.children[0];
      const leg = group.legs.find(
        (l) =>
          l.id !== pending?.legId &&
          isTriggered(group.direction, l.kind, price.price, l.triggerPrice),
      );
      if (leg) {
        await this.cancelPending(tx, pending, 'conditional_replaced', now);
        const child = await tx.protectionChild.create({
          data: {
            groupId: id,
            legId: leg.id,
            quantity,
            ...(price.kind === 'futures_last'
              ? { futuresLastPriceSnapshotId: price.id }
              : { assetPriceSnapshotId: price.id }),
            triggeredAt: now,
            triggerEvidenceJson: {
              assetId: group.assetId,
              symbol: group.asset.symbol,
              domain: group.domain,
              positionId: group.positionId ?? group.futuresPositionId,
              kind: leg.kind,
              triggerPrice: leg.triggerPrice.toFixed(8),
              price: price.price.toFixed(8),
              currencyCode: price.currencyCode,
              priceBasis: price.kind,
              instrumentId: price.instrumentId,
              sourceType: price.sourceType,
              sourceName: price.sourceName,
              effectiveAt: price.effectiveAt.toISOString(),
              capturedAt: price.capturedAt.toISOString(),
              snapshotId: price.id,
            },
          },
        });
        return { state: 'triggered', childId: child.id, domain: group.domain };
      }
      return pending
        ? { state: 'pending', childId: pending.id, domain: group.domain }
        : { state: 'armed' };
    });
    if (!decision.childId) return decision;
    // Trigger survives an unavailable execution attempt. No financial lock is
    // held while the ordinary Spot quote/ERS adapter prepares its evidence.
    if (decision.domain === 'spot')
      await this.orders.executeConditionalExit(
        userId,
        accountId,
        decision.childId,
      );
    else {
      const child = await this.prisma.protectionChild.findUnique({
        where: { id: decision.childId },
        include: { group: { include: { futuresPosition: true } } },
      });
      const position = child?.group.futuresPosition;
      if (child?.status === 'pending' && position?.status === 'open')
        await this.futures.execute(
          userId,
          accountId,
          {
            instrumentId: position.instrumentId,
            positionId: position.id,
            operation: 'close',
            direction: position.direction,
            quantity: position.quantity.toFixed(8),
            leverage: position.leverage,
            marginMode: position.marginMode,
            idempotencyKey: `protection:${child.id}`,
          },
          child.id,
        );
    }
    return decision;
  }
}
