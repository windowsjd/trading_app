import { Prisma } from '../generated/prisma/client';
import { buildPagination } from '../common/pagination';
import {
  futuresInstrumentInclude,
  presentFuturesExecution,
  presentFuturesInstrument,
} from './futures.presenter';

/**
 * 거래 내역 › 선물 (docs/futures-api-contract.md, 2026-11-06): one account's
 * position records grouped by what they did to a position, newest first.
 *
 * - `entry` (포지션 진입): executions that opened or added to a lifetime
 *   (`open`, `increase`), long and short, whatever command filled them.
 * - `exit` (포지션 종료): executions that reduced or closed one (`reduce`,
 *   `close`), every forced liquidation, and the Season-final exit when it
 *   closed at least one position.
 *
 * One read in the caller's snapshot pages the union with one total order
 * (time, then kind, then id), so a page never repeats or skips a record of
 * another kind. Every record keeps its own id and its stored figures: an
 * execution as the executions route presents it, a liquidation as the
 * liquidations route returns it, and a liquidation or Season exit stays one
 * record holding all of its closes. Nothing is derived or written; pending
 * orders are not executions and never appear here.
 */
export const FUTURES_HISTORY_PHASES = ['entry', 'exit'] as const;
export type FuturesHistoryPhase = (typeof FUTURES_HISTORY_PHASES)[number];

const OPERATIONS: Record<FuturesHistoryPhase, string[]> = {
  entry: ['open', 'increase'],
  exit: ['reduce', 'close'],
};

type RecordRef = {
  kind: 'execution' | 'liquidation' | 'season_settlement';
  id: string;
  executedAt: Date;
};

/** The union of the phase's record ids, one row per record. */
function recordUnion(tradingAccountId: string, phase: FuturesHistoryPhase) {
  const executions = Prisma.sql`
    SELECT 'execution'::text AS kind, e.id, e.executed_at
    FROM futures_executions e
    WHERE e.trading_account_id = ${tradingAccountId}
      AND e.operation::text = ANY(${OPERATIONS[phase]}::text[])`;
  if (phase === 'entry') return executions;
  return Prisma.sql`${executions}
    UNION ALL
    SELECT 'liquidation'::text AS kind, l.id, l.executed_at
    FROM futures_liquidations l
    WHERE l.trading_account_id = ${tradingAccountId}
    UNION ALL
    SELECT 'season_settlement'::text AS kind, s.id, s.executed_at
    FROM futures_season_settlements s
    WHERE s.trading_account_id = ${tradingAccountId}
      AND EXISTS (
        SELECT 1 FROM futures_season_closes c
        WHERE c.settlement_id = s.id
          AND c.trading_account_id = s.trading_account_id
      )`;
}

const decimal = (value: Prisma.Decimal) => value.toFixed(8);

const liquidationInclude = {
  closes: {
    include: { markSnapshot: true },
    orderBy: { positionId: 'asc' },
  },
} satisfies Prisma.FuturesLiquidationInclude;
const settlementInclude = {
  closes: {
    include: {
      instrument: { include: futuresInstrumentInclude },
      price: { select: { lastPriceSnapshotId: true } },
    },
    orderBy: { positionId: 'asc' },
  },
} satisfies Prisma.FuturesSeasonSettlementInclude;
type SettlementRow = Prisma.FuturesSeasonSettlementGetPayload<{
  include: typeof settlementInclude;
}>;

/** The Season-final exit with its closes, each naming its contract and price basis. */
function presentSeasonSettlement(row: SettlementRow) {
  return {
    id: row.id,
    seasonId: row.seasonId,
    endAt: row.endAt.toISOString(),
    realizedPnl: decimal(row.realizedPnl),
    feeAmount: decimal(row.feeAmount),
    settledFee: decimal(row.settledFee),
    settledCash: decimal(row.settledCash),
    bankruptcyShortfall: decimal(row.bankruptcyShortfall),
    executedAt: row.executedAt.toISOString(),
    closes: row.closes.map((close) => ({
      positionId: close.positionId,
      instrumentId: close.instrumentId,
      direction: close.direction,
      marginMode: close.marginMode,
      quantity: decimal(close.quantity),
      executionPrice: decimal(close.executionPrice),
      realizedPnl: decimal(close.realizedPnl),
      feeAmount: decimal(close.feeAmount),
      // Legacy pins hold Spot evidence; new pins hold Futures Last.
      priceBasis: close.price.lastPriceSnapshotId
        ? ('futures_last' as const)
        : ('spot_last' as const),
      instrument: presentFuturesInstrument(close.instrument),
    })),
  };
}

export async function readFuturesPositionHistory(
  tx: Prisma.TransactionClient,
  tradingAccountId: string,
  phase: FuturesHistoryPhase,
  page: { limit: number; offset: number },
) {
  const union = recordUnion(tradingAccountId, phase);
  const [refs, counted] = await Promise.all([
    tx.$queryRaw<RecordRef[]>`
      SELECT r.kind, r.id, r.executed_at AS "executedAt"
      FROM (${union}) r
      ORDER BY r.executed_at DESC, r.kind DESC, r.id DESC
      LIMIT ${page.limit} OFFSET ${page.offset}`,
    tx.$queryRaw<Array<{ total: number }>>`
      SELECT COUNT(*)::int AS total FROM (${union}) r`,
  ]);
  // Each kind's rows of this page only, read by id within the same account.
  const rowsOf = <T>(
    kind: RecordRef['kind'],
    read: (ids: string[]) => Promise<T[]>,
  ) => {
    const ids = refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
    return ids.length ? read(ids) : Promise.resolve<T[]>([]);
  };
  const [executions, liquidations, settlements] = await Promise.all([
    rowsOf('execution', (ids) =>
      tx.futuresExecution.findMany({
        where: { tradingAccountId, id: { in: ids } },
        include: { instrument: { include: futuresInstrumentInclude } },
      }),
    ),
    rowsOf('liquidation', (ids) =>
      tx.futuresLiquidation.findMany({
        where: { tradingAccountId, id: { in: ids } },
        include: liquidationInclude,
      }),
    ),
    rowsOf('season_settlement', (ids) =>
      tx.futuresSeasonSettlement.findMany({
        where: { tradingAccountId, id: { in: ids } },
        include: settlementInclude,
      }),
    ),
  ]);
  const records: FuturesHistoryRecord[] = [];
  for (const ref of refs) {
    const base = { id: ref.id, executedAt: ref.executedAt.toISOString() };
    if (ref.kind === 'execution') {
      const row = executions.find((item) => item.id === ref.id);
      if (row)
        records.push({
          kind: 'execution',
          ...base,
          execution: {
            ...presentFuturesExecution(row),
            instrument: presentFuturesInstrument(row.instrument),
          },
        });
    } else if (ref.kind === 'liquidation') {
      const row = liquidations.find((item) => item.id === ref.id);
      // The liquidations route's own shape (closes with their Mark evidence).
      if (row)
        records.push({
          kind: 'liquidation',
          ...base,
          liquidation: JSON.parse(JSON.stringify(row)) as Prisma.JsonValue,
        });
    } else {
      const row = settlements.find((item) => item.id === ref.id);
      if (row)
        records.push({
          kind: 'season_settlement',
          ...base,
          settlement: presentSeasonSettlement(row),
        });
    }
  }
  return {
    records,
    pagination: buildPagination({
      limit: page.limit,
      offset: page.offset,
      total: counted[0]?.total ?? 0,
      returned: refs.length,
    }),
  };
}

export type FuturesHistoryRecord = { id: string; executedAt: string } & (
  | {
      kind: 'execution';
      execution: ReturnType<typeof presentFuturesExecution> & {
        instrument: ReturnType<typeof presentFuturesInstrument>;
      };
    }
  | { kind: 'liquidation'; liquidation: Prisma.JsonValue }
  | {
      kind: 'season_settlement';
      settlement: ReturnType<typeof presentSeasonSettlement>;
    }
);
