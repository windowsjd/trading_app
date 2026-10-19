import { Prisma } from '../generated/prisma/client';
import { roundDecimalHalfUp, monetaryScale } from '../fx/fx-decimal-policy';
import { futuresDecimal, marginCeil } from '../futures/futures-math';

/**
 * 거래 완료 종목 (docs/friends-api-contract.md): fully closed holdings of the
 * friend's current season account, as aggregates only — never an order,
 * execution, quantity, price, average cost, fee line or ledger row.
 *
 * - Spot: one item per asset whose position is fully closed now (quantity 0).
 *   매수 금액 = every executed BUY's net amount (fee included) on this account;
 *   실현 손익 = the position's own confirmed realized PnL (fees included).
 *   Re-entries and partial sells add up once; a holding open again is not
 *   complete and stays out (its earlier rounds return when it closes).
 * - Futures: one item per closed position lifetime. 진입 증거금 = the margin
 *   policy's ceil(entry notional / leverage) over its open/increase
 *   executions; 실현 손익 = the position's confirmed realized PnL less every
 *   fee of that lifetime (executions, liquidation or season-final close).
 * - 수익률 = 실현 손익 / basis × 100 (8 dp, half up); null when the basis is
 *   not above zero. Amounts are in the trade's own currency (no FX).
 * - An item whose stored rows do not reconcile (quantities in vs out, a
 *   missing amount, realized PnL vs its parts) is left out, never guessed.
 */
export const COMPLETED_TRADES_LIMIT = 30;
/** Every asset in the fixed universes fits; bounds the Spot read. */
const SPOT_POSITION_CAP = 400;

export type FriendCompletedTrade =
  | {
      kind: 'spot';
      assetId: string;
      symbol: string;
      name: string;
      market: string;
      assetType: string;
      currencyCode: string;
      buyAmount: string;
      realizedPnl: string;
      returnRate: string | null;
    }
  | {
      kind: 'futures';
      assetId: string;
      symbol: string;
      name: string;
      market: string;
      direction: 'long' | 'short';
      currencyCode: 'USD';
      entryMargin: string;
      realizedPnl: string;
      returnRate: string | null;
    };

export type FriendCompletedTrades = {
  items: FriendCompletedTrade[];
  /** More fully closed trades exist than the newest ones listed. */
  hasMore: boolean;
};

type Decimalish = Prisma.Decimal | string | number;
const decimal = (value: Decimalish) => new Prisma.Decimal(value.toString());

function returnRate(pnl: Prisma.Decimal, basis: Prisma.Decimal) {
  return basis.gt(0)
    ? pnl
        .div(basis)
        .mul(100)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(8)
    : null;
}

export type SpotOrderTotals = {
  side: 'buy' | 'sell';
  currencyCode: string;
  netAmount: Decimalish | null;
  quantity: Decimalish;
  count: number;
  missingAmount: number;
};

/** One closed Spot holding from its position and its executed order totals. */
export function summarizeSpotCompletedTrade(
  position: {
    assetId: string;
    currencyCode: string;
    quantity: Decimalish;
    realizedPnl: Decimalish;
    asset: { symbol: string; name: string; market: string; assetType: string };
  },
  totals: SpotOrderTotals[],
): Extract<FriendCompletedTrade, { kind: 'spot' }> | null {
  if (!decimal(position.quantity).eq(0)) return null;
  const buys = totals.filter((row) => row.side === 'buy');
  const sells = totals.filter((row) => row.side === 'sell');
  if (
    !buys.length ||
    !sells.length ||
    totals.some(
      (row) =>
        row.currencyCode !== position.currencyCode ||
        row.missingAmount > 0 ||
        row.netAmount === null,
    )
  )
    return null;
  const sum = (rows: SpotOrderTotals[], key: 'netAmount' | 'quantity') =>
    rows.reduce((total, row) => total.add(decimal(row[key]!)), decimal(0));
  // Every unit bought on this account was sold: the orders explain the close.
  if (!sum(buys, 'quantity').eq(sum(sells, 'quantity'))) return null;
  const buyAmount = roundDecimalHalfUp(sum(buys, 'netAmount'), monetaryScale);
  const realizedPnl = decimal(position.realizedPnl);
  return {
    kind: 'spot',
    assetId: position.assetId,
    symbol: position.asset.symbol,
    name: position.asset.name,
    market: position.asset.market,
    assetType: position.asset.assetType,
    currencyCode: position.currencyCode,
    buyAmount: buyAmount.toFixed(8),
    realizedPnl: realizedPnl.toFixed(8),
    returnRate: returnRate(realizedPnl, buyAmount),
  };
}

export type FuturesExecutionTotals = {
  operation: 'open' | 'increase' | 'reduce' | 'close';
  quantity: Decimalish;
  notional: Decimalish;
  feeAmount: Decimalish;
  realizedPnl: Decimalish;
  count: number;
};
type FuturesCloseRow = {
  quantity: Decimalish;
  realizedPnl: Decimalish;
  feeAmount: Decimalish;
};

/** One closed Futures position lifetime from its own executions and close rows. */
export function summarizeFuturesCompletedTrade(
  position: {
    id: string;
    direction: 'long' | 'short';
    leverage: number;
    realizedPnl: Decimalish;
    instrument: {
      settlementCurrency: string;
      underlyingAsset: {
        id: string;
        symbol: string;
        name: string;
        market: string;
      };
    };
  },
  executions: FuturesExecutionTotals[],
  closes: FuturesCloseRow[],
): Extract<FriendCompletedTrade, { kind: 'futures' }> | null {
  const of = (operations: FuturesExecutionTotals['operation'][]) =>
    executions.filter((row) => operations.includes(row.operation));
  const total = (
    rows: Array<FuturesExecutionTotals | FuturesCloseRow>,
    key: 'quantity' | 'notional' | 'feeAmount' | 'realizedPnl',
  ) =>
    rows.reduce(
      (sum, row) => sum.add(decimal((row as Record<string, Decimalish>)[key])),
      decimal(0),
    );
  const entries = of(['open', 'increase']);
  const exits = of(['reduce', 'close']);
  if (
    position.instrument.settlementCurrency !== 'USD' ||
    !Number.isInteger(position.leverage) ||
    position.leverage < 1 ||
    of(['open']).reduce((count, row) => count + row.count, 0) !== 1 ||
    (!exits.length && !closes.length)
  )
    return null;
  // Everything opened was closed, and the stored realized PnL is its parts.
  const entered = total(entries, 'quantity');
  if (!entered.eq(total(exits, 'quantity').add(total(closes, 'quantity'))))
    return null;
  const realized = decimal(position.realizedPnl);
  if (
    !realized.eq(
      total(executions, 'realizedPnl').add(total(closes, 'realizedPnl')),
    )
  )
    return null;
  const fees = total(executions, 'feeAmount').add(total(closes, 'feeAmount'));
  const net = roundDecimalHalfUp(realized.sub(fees), monetaryScale);
  const entryMargin = decimal(
    marginCeil(
      futuresDecimal(total(entries, 'notional')).div(position.leverage),
    ).toString(),
  );
  return {
    kind: 'futures',
    assetId: position.instrument.underlyingAsset.id,
    symbol: position.instrument.underlyingAsset.symbol,
    name: position.instrument.underlyingAsset.name,
    market: position.instrument.underlyingAsset.market,
    direction: position.direction,
    currencyCode: 'USD',
    entryMargin: entryMargin.toFixed(8),
    realizedPnl: net.toFixed(8),
    returnRate: returnRate(net, entryMargin),
  };
}

type SpotTotalsRow = {
  assetId: string;
  side: 'buy' | 'sell';
  currencyCode: string;
  netAmount: Prisma.Decimal | null;
  quantity: Prisma.Decimal;
  count: number;
  missingAmount: number;
  lastExecutedAt: Date | null;
};

/**
 * Reads one account's completed trades in the caller's snapshot (the guarded
 * friend detail runs it in a repeatable-read transaction). Bounded: the
 * account's closed Spot positions (≤ one per asset), its newest closed
 * Futures positions, and one aggregate per kind over only those rows.
 */
export async function readFriendCompletedTrades(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  limit = COMPLETED_TRADES_LIMIT,
): Promise<FriendCompletedTrades> {
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
        leverage: true,
        realizedPnl: true,
        closedAt: true,
        instrument: {
          select: {
            settlementCurrency: true,
            underlyingAsset: {
              select: { id: true, symbol: true, name: true, market: true },
            },
          },
        },
      },
      orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    }),
  ]);
  const assetIds = spotPositions.map((position) => position.assetId);
  const positionIds = futuresPositions
    .slice(0, limit)
    .map((position) => position.id);
  const [spotTotals, futuresTotals] = await Promise.all([
    assetIds.length
      ? tx.$queryRaw<SpotTotalsRow[]>`
          SELECT o.asset_id AS "assetId", o.side::text AS "side",
                 o.currency_code::text AS "currencyCode",
                 SUM(o.net_amount) AS "netAmount",
                 SUM(COALESCE(o.executed_quantity, o.quantity)) AS "quantity",
                 COUNT(*)::int AS "count",
                 (COUNT(*) - COUNT(o.net_amount))::int AS "missingAmount",
                 MAX(o.executed_at) AS "lastExecutedAt"
          FROM orders o
          WHERE o.trading_account_id = ${tradingAccountId}
            AND o.status = 'executed'
            AND o.asset_id = ANY(${assetIds}::text[])
          GROUP BY o.asset_id, o.side, o.currency_code`
      : Promise.resolve([] as SpotTotalsRow[]),
    positionIds.length
      ? readFuturesTotals(tx, tradingAccountId, positionIds)
      : Promise.resolve(null),
  ]);

  const completed: Array<{ at: number; item: FriendCompletedTrade }> = [];
  for (const position of spotPositions) {
    const rows = spotTotals.filter((row) => row.assetId === position.assetId);
    const item = summarizeSpotCompletedTrade(position, rows);
    const sold = rows.find((row) => row.side === 'sell')?.lastExecutedAt;
    if (item && sold) completed.push({ at: sold.getTime(), item });
  }
  for (const position of futuresPositions.slice(0, limit)) {
    const item = summarizeFuturesCompletedTrade(
      position,
      (futuresTotals?.executions ?? [])
        .filter((row) => row.positionId === position.id)
        .map((row) => ({
          operation: row.operation,
          quantity: row._sum.quantity ?? 0,
          notional: row._sum.notional ?? 0,
          feeAmount: row._sum.feeAmount ?? 0,
          realizedPnl: row._sum.realizedPnl ?? 0,
          count: row._count._all,
        })),
      (futuresTotals?.closes ?? []).filter(
        (row) => row.positionId === position.id,
      ),
    );
    if (item && position.closedAt)
      completed.push({ at: position.closedAt.getTime(), item });
  }
  completed.sort((left, right) => right.at - left.at);
  return {
    items: completed.slice(0, limit).map((entry) => entry.item),
    hasMore:
      completed.length > limit ||
      futuresPositions.length > limit ||
      spotPositions.length >= SPOT_POSITION_CAP,
  };
}

/** The closed positions' own executions (by operation) and close rows. */
async function readFuturesTotals(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  positionIds: string[],
) {
  const where = { tradingAccountId, positionId: { in: positionIds } };
  const select = {
    positionId: true,
    quantity: true,
    realizedPnl: true,
    feeAmount: true,
  } as const;
  const [executions, liquidationCloses, seasonCloses] = await Promise.all([
    tx.futuresExecution.groupBy({
      by: ['positionId', 'operation'],
      where,
      _sum: {
        quantity: true,
        notional: true,
        feeAmount: true,
        realizedPnl: true,
      },
      _count: { _all: true },
    }),
    tx.futuresLiquidationClose.findMany({ where, select }),
    tx.futuresSeasonClose.findMany({ where, select }),
  ]);
  return { executions, closes: [...liquidationCloses, ...seasonCloses] };
}
