import { Prisma } from '../generated/prisma/client';
import {
  summarizeFuturesCompletedTrade,
  summarizeSpotCompletedTrade,
  type FriendCompletedTrade,
} from '../friends/friend-completed-trades';
import { presentFuturesInstrument } from '../futures/futures.presenter';

/**
 * 수익 공유 (docs/completed-trades-share-contract.md): the owner's own
 * completed trades, each with the stored evidence a share card shows. The
 * result and return rate are the 거래 완료 종목 policy itself
 * (friend-completed-trades.ts: the same summarize functions, the same
 * reconciliation, nothing recomputed); this reader only adds what the owner
 * may see of their own trade:
 *
 * - Spot: when it completed (the last SELL), and the quantity-weighted
 *   average executed BUY and SELL prices (Σ gross amount / Σ executed
 *   quantity) of the same orders the policy summed. A general account's
 *   Spot realized PnL restarts at its latest reset (re-based to 0 there), so
 *   only orders executed after `spotSince` belong to it.
 * - Futures: the lifetime's id, leverage, margin mode, close time and how it
 *   ended (closed / forced liquidation / season-final close), and the
 *   quantity-weighted average entry price (open/increase executions) and exit
 *   price (reduce/close executions plus a liquidation or season-final close).
 *
 * A price whose evidence is missing is null, never estimated. Amounts stay in
 * the trade's own currency (no FX). Read inside the caller's snapshot.
 */
export const OWN_COMPLETED_TRADES_LIMIT = 30;
/** The friend reader's bound: every asset of the fixed universes fits. */
const SPOT_POSITION_CAP = 400;

export type OwnCompletedTrade =
  | (Extract<FriendCompletedTrade, { kind: 'spot' }> & {
      key: string;
      completedAt: string;
      averageBuyPrice: string | null;
      averageSellPrice: string | null;
      displayPriceDecimals: number | null;
    })
  | (Extract<FriendCompletedTrade, { kind: 'futures' }> & {
      key: string;
      positionId: string;
      leverage: number;
      marginMode: 'isolated' | 'cross';
      closeKind: 'closed' | 'liquidated' | 'season_closed';
      completedAt: string;
      averageEntryPrice: string | null;
      averageExitPrice: string | null;
      displayPriceDecimals: number | null;
    });

export type OwnCompletedTrades = {
  items: OwnCompletedTrade[];
  /** More completed trades exist than the newest ones listed. */
  hasMore: boolean;
};

type Decimalish = Prisma.Decimal | string | number;
const decimal = (value: Decimalish) => new Prisma.Decimal(value.toString());

/** Σ(price × quantity) / Σ quantity, 8 dp half up; null without evidence. */
export function averagePrice(
  priceQuantity: Decimalish | null | undefined,
  quantity: Decimalish | null | undefined,
): string | null {
  if (priceQuantity == null || quantity == null) return null;
  const units = decimal(quantity);
  if (!units.gt(0)) return null;
  return decimal(priceQuantity)
    .div(units)
    .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
    .toFixed(8);
}

type SpotTotalsRow = {
  assetId: string;
  side: 'buy' | 'sell';
  currencyCode: string;
  netAmount: Prisma.Decimal | null;
  grossAmount: Prisma.Decimal | null;
  quantity: Prisma.Decimal;
  count: number;
  missingAmount: number;
  missingGross: number;
  lastExecutedAt: Date | null;
};

type FuturesTotalsRow = {
  positionId: string;
  operation: 'open' | 'increase' | 'reduce' | 'close';
  quantity: Prisma.Decimal;
  notional: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  realizedPnl: Prisma.Decimal;
  priceQuantity: Prisma.Decimal;
  count: number;
};

type FuturesCloseRow = {
  positionId: string;
  quantity: Prisma.Decimal;
  realizedPnl: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  executionPrice: Prisma.Decimal;
};

const CLOSE_SELECT = {
  positionId: true,
  quantity: true,
  realizedPnl: true,
  feeAmount: true,
  executionPrice: true,
} as const;

/** A Spot side's average executed price, or null when any order lacks its gross amount. */
function spotSidePrice(row: SpotTotalsRow | undefined) {
  return row && row.missingGross === 0
    ? averagePrice(row.grossAmount, row.quantity)
    : null;
}

/** The owner's newest completed trades (Spot holdings and Futures lifetimes). */
export async function readOwnCompletedTrades(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  options: {
    /** The account's latest general reset: Spot orders before it are the ended epoch's. */
    spotSince: Date | null;
    spotDisplayDecimals: (asset: {
      market: string;
      symbol: string;
    }) => number | null;
    limit?: number;
  },
): Promise<OwnCompletedTrades> {
  const limit = options.limit ?? OWN_COMPLETED_TRADES_LIMIT;
  const [spotPositions, futuresPositions] = await Promise.all([
    tx.position.findMany({
      where: { tradingAccountId, quantity: { equals: '0' } },
      select: {
        assetId: true,
        currencyCode: true,
        quantity: true,
        realizedPnl: true,
        asset: {
          select: { symbol: true, name: true, market: true, assetType: true },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: SPOT_POSITION_CAP,
    }),
    tx.futuresPosition.findMany({
      where: { tradingAccountId, status: 'closed' },
      select: {
        id: true,
        direction: true,
        marginMode: true,
        leverage: true,
        realizedPnl: true,
        closedAt: true,
        instrument: { include: { underlyingAsset: true } },
      },
      orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }),
  ]);
  const assetIds = spotPositions.map((position) => position.assetId);
  const listedFutures = futuresPositions.slice(0, limit);
  const positionIds = listedFutures.map((position) => position.id);
  const epoch = options.spotSince
    ? Prisma.sql`AND o.executed_at > ${options.spotSince}::timestamp`
    : Prisma.empty;
  const [spotTotals, futuresTotals, liquidationCloses, seasonCloses] =
    await Promise.all([
      assetIds.length
        ? tx.$queryRaw<SpotTotalsRow[]>`
            SELECT o.asset_id AS "assetId", o.side::text AS "side",
                   o.currency_code::text AS "currencyCode",
                   SUM(o.net_amount) AS "netAmount",
                   SUM(o.gross_amount) AS "grossAmount",
                   SUM(COALESCE(o.executed_quantity, o.quantity)) AS "quantity",
                   COUNT(*)::int AS "count",
                   (COUNT(*) - COUNT(o.net_amount))::int AS "missingAmount",
                   (COUNT(*) - COUNT(o.gross_amount))::int AS "missingGross",
                   MAX(o.executed_at) AS "lastExecutedAt"
            FROM orders o
            WHERE o.trading_account_id = ${tradingAccountId}
              AND o.status = 'executed'
              AND o.asset_id = ANY(${assetIds}::text[])
              ${epoch}
            GROUP BY o.asset_id, o.side, o.currency_code`
        : Promise.resolve([] as SpotTotalsRow[]),
      positionIds.length
        ? tx.$queryRaw<FuturesTotalsRow[]>`
            SELECT e.position_id AS "positionId", e.operation::text AS "operation",
                   SUM(e.quantity) AS "quantity", SUM(e.notional) AS "notional",
                   SUM(e.fee_amount) AS "feeAmount",
                   SUM(e.realized_pnl) AS "realizedPnl",
                   SUM(e.execution_price * e.quantity) AS "priceQuantity",
                   COUNT(*)::int AS "count"
            FROM futures_executions e
            WHERE e.trading_account_id = ${tradingAccountId}
              AND e.position_id = ANY(${positionIds}::text[])
            GROUP BY e.position_id, e.operation`
        : Promise.resolve([] as FuturesTotalsRow[]),
      positionIds.length
        ? tx.futuresLiquidationClose.findMany({
            where: { tradingAccountId, positionId: { in: positionIds } },
            select: CLOSE_SELECT,
          })
        : Promise.resolve([] as FuturesCloseRow[]),
      positionIds.length
        ? tx.futuresSeasonClose.findMany({
            where: { tradingAccountId, positionId: { in: positionIds } },
            select: CLOSE_SELECT,
          })
        : Promise.resolve([] as FuturesCloseRow[]),
    ]);

  const completed: Array<{ at: number; item: OwnCompletedTrade }> = [];
  for (const position of spotPositions) {
    const rows = spotTotals.filter((row) => row.assetId === position.assetId);
    const summary = summarizeSpotCompletedTrade(position, rows);
    const buy = rows.find((row) => row.side === 'buy');
    const sell = rows.find((row) => row.side === 'sell');
    const soldAt = sell?.lastExecutedAt;
    if (!summary || !soldAt) continue;
    completed.push({
      at: soldAt.getTime(),
      item: {
        ...summary,
        key: `spot:${position.assetId}`,
        completedAt: soldAt.toISOString(),
        averageBuyPrice: spotSidePrice(buy),
        averageSellPrice: spotSidePrice(sell),
        displayPriceDecimals: options.spotDisplayDecimals(position.asset),
      },
    });
  }
  for (const position of listedFutures) {
    const rows = futuresTotals.filter((row) => row.positionId === position.id);
    const closes = [
      ...liquidationCloses.map((row) => ({
        ...row,
        kind: 'liquidated' as const,
      })),
      ...seasonCloses.map((row) => ({
        ...row,
        kind: 'season_closed' as const,
      })),
    ].filter((row) => row.positionId === position.id);
    const summary = summarizeFuturesCompletedTrade(
      position,
      rows.map((row) => ({
        operation: row.operation,
        quantity: row.quantity,
        notional: row.notional,
        feeAmount: row.feeAmount,
        realizedPnl: row.realizedPnl,
        count: row.count,
      })),
      closes,
    );
    if (!summary || !position.closedAt) continue;
    const sum = (values: Decimalish[]) =>
      values.reduce<Prisma.Decimal>(
        (total, value) => total.add(decimal(value)),
        decimal(0),
      );
    const entries = rows.filter(
      (row) => row.operation === 'open' || row.operation === 'increase',
    );
    const exits = rows.filter(
      (row) => row.operation === 'reduce' || row.operation === 'close',
    );
    completed.push({
      at: position.closedAt.getTime(),
      item: {
        ...summary,
        key: `futures:${position.id}`,
        positionId: position.id,
        leverage: position.leverage,
        marginMode: position.marginMode,
        closeKind: closes[0]?.kind ?? 'closed',
        completedAt: position.closedAt.toISOString(),
        averageEntryPrice: averagePrice(
          sum(entries.map((row) => row.priceQuantity)),
          sum(entries.map((row) => row.quantity)),
        ),
        averageExitPrice: averagePrice(
          sum([
            ...exits.map((row) => row.priceQuantity),
            ...closes.map((row) =>
              decimal(row.executionPrice).mul(row.quantity),
            ),
          ]),
          sum([
            ...exits.map((row) => row.quantity),
            ...closes.map((row) => row.quantity),
          ]),
        ),
        displayPriceDecimals: presentFuturesInstrument(position.instrument)
          .underlying.displayPriceDecimals,
      },
    });
  }
  completed.sort(
    (left, right) =>
      right.at - left.at || left.item.key.localeCompare(right.item.key),
  );
  return {
    items: completed.slice(0, limit).map((entry) => entry.item),
    hasMore:
      completed.length > limit ||
      futuresPositions.length > limit ||
      spotPositions.length >= SPOT_POSITION_CAP,
  };
}
