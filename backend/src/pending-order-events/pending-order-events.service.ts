import { Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import type {
  ConditionalSellKind,
  ProtectionKind,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';

/**
 * 대기주문 발동·체결 알림의 원천 (docs/pending-order-events-contract.md):
 * the account's confirmed events, derived on read from committed rows only —
 * an order's `executed` fill and a watch's recorded trigger. Read-only and
 * apart from every financial transaction (nothing is written, queued or
 * pushed here), so a notice can never delay or decide a fill.
 *
 * - A fill: a Spot limit / LOC order, or an order a condition, a stop-loss /
 *   take-profit or an OCO placed; a Futures execution of a limit entry, a
 *   conditional entry or a stop-loss / take-profit. A market order the user
 *   placed directly is not an event (its own screen showed the result), nor
 *   is a canceled, rejected or unfilled order.
 * - A trigger: a watch whose condition was met. It is listed only while its
 *   own fill is not known: a condition met and filled at once reads as one
 *   fill, not two notices. A market-execution trigger waits out a short grace
 *   for that fill; a limit-execution trigger is listed at once (an order now
 *   waits on the book).
 *
 * The client keeps a cursor (`serverTime`) per account. Without one it gets
 * no events, only the cursor: a new sign-in never replays old history. Each
 * read looks back a little further than the cursor for rows committed late,
 * and the client drops keys it already showed.
 */
export const EVENT_LOOKBACK_MS = 2 * 60_000;
export const MARKET_TRIGGER_GRACE_MS = 30_000;
export const EVENT_MAX_WINDOW_MS = 7 * 86_400_000;
export const EVENT_PAGE = 50;

type Origin =
  | 'limit'
  | 'loc'
  | 'condition'
  | 'stop_loss'
  | 'take_profit'
  | 'protection'
  | 'futures_limit'
  | 'futures_condition'
  | 'futures_stop_loss'
  | 'futures_take_profit'
  | 'futures_protection';

export type PendingOrderEvent = {
  key: string;
  type: 'fill' | 'trigger';
  market: 'spot' | 'futures';
  origin: Origin;
  side: 'buy' | 'sell' | null;
  direction: 'long' | 'short' | null;
  asset: { id: string; symbol: string; name: string; market: string };
  quantity: string | null;
  price: string | null;
  currencyCode: string;
  /** A trigger's next step: its limit order now waits, or a market order is being placed. */
  executionType: 'market' | 'limit' | null;
  /** The fill or trigger time. */
  at: string;
  /** When the feed lists it (a market trigger after its grace). */
  visibleAt: string;
};

const ASSET = { select: { id: true, symbol: true, name: true, market: true } };
const decimal = (
  value: { toFixed(scale: number): string } | null | undefined,
) => (value ? value.toFixed(8) : null);

@Injectable()
export class PendingOrderEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
  ) {}

  async list(
    userId: string | undefined,
    accountId: string,
    query: { after?: string },
  ) {
    if (!userId) throw createApiError('UNAUTHORIZED', 'Unauthorized', 401);
    const account = await this.access.getOwnedAccountOrThrow(userId, accountId);
    const [{ now }] = await this.prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const empty = {
      success: true as const,
      data: {
        tradingAccountId: account.id,
        serverTime: now.toISOString(),
        events: [] as PendingOrderEvent[],
        total: 0,
      },
    };
    if (query.after === undefined) return empty;
    const after = new Date(query.after);
    if (
      typeof query.after !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(query.after) ||
      Number.isNaN(after.getTime()) ||
      after > now
    )
      throw createApiError(
        'INVALID_EVENT_CURSOR',
        'The event cursor must be a past ISO time from this API.',
        400,
      );
    const from = new Date(
      Math.max(
        after.getTime() - EVENT_LOOKBACK_MS,
        now.getTime() - EVENT_MAX_WINDOW_MS,
      ),
    );
    const triggeredSince = new Date(from.getTime() - MARKET_TRIGGER_GRACE_MS);
    const events = [
      ...(await this.spotFills(account.id, from, now)),
      ...(await this.spotTriggers(account.id, triggeredSince, now)),
      ...(await this.futuresFills(account.id, from, now)),
      ...(await this.futuresTriggers(account.id, triggeredSince, now)),
    ]
      .filter(
        (event) =>
          new Date(event.visibleAt) > from && new Date(event.visibleAt) <= now,
      )
      .sort(
        (a, b) =>
          a.visibleAt.localeCompare(b.visibleAt) || a.key.localeCompare(b.key),
      );
    return {
      ...empty,
      data: {
        ...empty.data,
        events: events.slice(-EVENT_PAGE),
        total: events.length,
      },
    };
  }

  private async spotFills(accountId: string, from: Date, now: Date) {
    const rows = await this.prisma.order.findMany({
      where: {
        tradingAccountId: accountId,
        status: 'executed',
        executedAt: { gt: from, lte: now },
        OR: [
          { orderType: 'limit' },
          { conditionalBuy: { isNot: null } },
          { conditionalSell: { isNot: null } },
          { protectionChild: { isNot: null } },
        ],
      },
      select: {
        id: true,
        side: true,
        orderType: true,
        executedQuantity: true,
        quantity: true,
        executedPrice: true,
        currencyCode: true,
        executedAt: true,
        asset: ASSET,
        limitOnClose: { select: { orderId: true } },
        conditionalBuy: { select: { id: true } },
        conditionalSell: { select: { kind: true } },
        protectionChild: { select: { id: true } },
      },
    });
    return rows.map((row): PendingOrderEvent => {
      const at = row.executedAt!.toISOString();
      return {
        key: `fill:spot_order:${row.id}`,
        type: 'fill',
        market: 'spot',
        origin: row.protectionChild
          ? 'protection'
          : row.conditionalSell
            ? sellOrigin(row.conditionalSell.kind)
            : row.conditionalBuy
              ? 'condition'
              : row.limitOnClose
                ? 'loc'
                : 'limit',
        side: row.side,
        direction: null,
        asset: row.asset,
        quantity: decimal(row.executedQuantity ?? row.quantity),
        price: decimal(row.executedPrice),
        currencyCode: row.currencyCode,
        executionType: null,
        at,
        visibleAt: at,
      };
    });
  }

  private async spotTriggers(accountId: string, since: Date, now: Date) {
    const where = {
      tradingAccountId: accountId,
      triggeredAt: { gt: since, lte: now },
    };
    const select = {
      id: true,
      triggerPrice: true,
      executionType: true,
      currencyCode: true,
      triggeredAt: true,
      asset: ASSET,
      order: { select: { status: true } },
    } as const;
    const [buys, sells] = await Promise.all([
      this.prisma.conditionalBuyOrder.findMany({ where, select }),
      this.prisma.conditionalSellOrder.findMany({
        where,
        select: { ...select, kind: true },
      }),
    ]);
    const event = (
      row: (typeof buys)[number],
      kind: 'conditional_buy' | 'conditional_sell',
      origin: Origin,
      side: 'buy' | 'sell',
    ) =>
      triggerEvent({
        key: `trigger:${kind}:${row.id}`,
        market: 'spot',
        origin,
        side,
        direction: null,
        asset: row.asset,
        price: row.triggerPrice,
        currencyCode: row.currencyCode,
        executionType: row.executionType,
        triggeredAt: row.triggeredAt!,
        filled: row.order?.status === 'executed',
      });
    return [
      ...buys.map((row) => event(row, 'conditional_buy', 'condition', 'buy')),
      ...sells.map((row) =>
        event(row, 'conditional_sell', sellOrigin(row.kind), 'sell'),
      ),
    ].filter((row): row is PendingOrderEvent => row !== null);
  }

  private async futuresFills(accountId: string, from: Date, now: Date) {
    const rows = await this.prisma.futuresExecution.findMany({
      where: {
        tradingAccountId: accountId,
        executedAt: { gt: from, lte: now },
        OR: [
          { limitOrder: { isNot: null } },
          { conditionalEntry: { isNot: null } },
          { tpSlSetting: { isNot: null } },
          { protectionChild: { isNot: null } },
        ],
      },
      select: {
        id: true,
        direction: true,
        quantity: true,
        executionPrice: true,
        executedAt: true,
        instrument: { select: { underlyingAsset: ASSET } },
        limitOrder: { select: { conditionalEntry: { select: { id: true } } } },
        conditionalEntry: { select: { id: true } },
        tpSlSetting: { select: { kind: true } },
        protectionChild: { select: { id: true } },
      },
    });
    return rows.map((row): PendingOrderEvent => {
      const at = row.executedAt.toISOString();
      return {
        key: `fill:futures_execution:${row.id}`,
        type: 'fill',
        market: 'futures',
        origin: row.tpSlSetting
          ? futuresProtectionOrigin(row.tpSlSetting.kind)
          : row.protectionChild
            ? 'futures_protection'
            : row.conditionalEntry || row.limitOrder?.conditionalEntry
              ? 'futures_condition'
              : 'futures_limit',
        side: null,
        direction: row.direction,
        asset: row.instrument.underlyingAsset,
        quantity: decimal(row.quantity),
        price: decimal(row.executionPrice),
        currencyCode: 'USD',
        executionType: null,
        at,
        visibleAt: at,
      };
    });
  }

  private async futuresTriggers(accountId: string, since: Date, now: Date) {
    const where = {
      tradingAccountId: accountId,
      triggeredAt: { gt: since, lte: now },
    };
    const asset = { select: { underlyingAsset: ASSET } };
    const [entries, settings] = await Promise.all([
      this.prisma.futuresConditionalEntry.findMany({
        where,
        select: {
          id: true,
          direction: true,
          triggerPrice: true,
          executionType: true,
          triggeredAt: true,
          executionId: true,
          instrument: asset,
          limitOrder: { select: { status: true } },
        },
      }),
      this.prisma.futuresTpSlSetting.findMany({
        where,
        select: {
          id: true,
          direction: true,
          kind: true,
          triggerPrice: true,
          triggeredAt: true,
          executionId: true,
          instrument: asset,
        },
      }),
    ]);
    return [
      ...entries.map((row) =>
        triggerEvent({
          key: `trigger:futures_conditional_entry:${row.id}`,
          market: 'futures',
          origin: 'futures_condition',
          side: null,
          direction: row.direction,
          asset: row.instrument.underlyingAsset,
          price: row.triggerPrice,
          currencyCode: 'USD',
          executionType: row.executionType,
          triggeredAt: row.triggeredAt!,
          filled: !!row.executionId || row.limitOrder?.status === 'executed',
        }),
      ),
      ...settings.map((row) =>
        triggerEvent({
          key: `trigger:futures_tp_sl:${row.id}`,
          market: 'futures',
          origin: futuresProtectionOrigin(row.kind),
          side: null,
          direction: row.direction,
          asset: row.instrument.underlyingAsset,
          price: row.triggerPrice,
          currencyCode: 'USD',
          executionType: 'market',
          triggeredAt: row.triggeredAt!,
          filled: !!row.executionId,
        }),
      ),
    ].filter((row): row is PendingOrderEvent => row !== null);
  }
}

function sellOrigin(kind: ConditionalSellKind): Origin {
  return kind === 'stop_loss'
    ? 'stop_loss'
    : kind === 'take_profit'
      ? 'take_profit'
      : 'condition';
}

function futuresProtectionOrigin(kind: ProtectionKind): Origin {
  return kind === 'stop_loss' ? 'futures_stop_loss' : 'futures_take_profit';
}

/** A trigger whose own fill is known reads as that fill alone (no second notice). */
function triggerEvent(input: {
  key: string;
  market: 'spot' | 'futures';
  origin: Origin;
  side: 'buy' | 'sell' | null;
  direction: 'long' | 'short' | null;
  asset: PendingOrderEvent['asset'];
  price: { toFixed(scale: number): string };
  currencyCode: string;
  executionType: 'market' | 'limit';
  triggeredAt: Date;
  filled: boolean;
}): PendingOrderEvent | null {
  if (input.filled) return null;
  const visibleAt =
    input.executionType === 'market'
      ? new Date(input.triggeredAt.getTime() + MARKET_TRIGGER_GRACE_MS)
      : input.triggeredAt;
  return {
    key: input.key,
    type: 'trigger',
    market: input.market,
    origin: input.origin,
    side: input.side,
    direction: input.direction,
    asset: input.asset,
    quantity: null,
    price: input.price.toFixed(8),
    currencyCode: input.currencyCode,
    executionType: input.executionType,
    at: input.triggeredAt.toISOString(),
    visibleAt: visibleAt.toISOString(),
  };
}
