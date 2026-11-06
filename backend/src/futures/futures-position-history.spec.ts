jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    Prisma: {
      Decimal: runtime.Decimal,
      sql: runtime.sqltag,
      empty: runtime.empty,
    },
  };
});
import { Prisma } from '../generated/prisma/client';
import {
  readFuturesPositionHistory,
  type FuturesHistoryRecord,
} from './futures-position-history';

const D = (value: string) => new Prisma.Decimal(value);
const at = (iso: string) => new Date(iso);
const instrument = {
  id: 'instrument-btc',
  underlyingAssetId: 'asset-btc',
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  isActive: true,
  markContractJson: { priceTickSize: '0.10' },
  underlyingAsset: {
    id: 'asset-btc',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    market: 'BINANCE',
  },
};
const execution = (id: string, operation: string, executedAt: string) => ({
  id,
  tradingAccountId: 'account-1',
  instrumentId: 'instrument-btc',
  positionId: 'position-long',
  operation,
  direction: 'long',
  marginMode: 'isolated',
  quantity: D('0.5'),
  leverage: 10,
  executionPrice: D('64000'),
  notional: D('32000'),
  feeRate: D('0.0005'),
  feeAmount: D('16'),
  realizedPnl: D(operation === 'close' ? '1800' : '0'),
  assetPriceSnapshotId: null,
  lastPriceSnapshotId: 'last-1',
  priceSourceType: 'provider_api',
  priceSourceName: 'binance_usdm_last',
  priceEffectiveAt: at(executedAt),
  priceCapturedAt: at(executedAt),
  positionQuantityAfter: D(operation === 'close' ? '0' : '0.5'),
  averageEntryPriceAfter: D('61000'),
  isolatedMarginAfter: D('0'),
  executedAt: at(executedAt),
  instrument,
});
const liquidation = {
  id: 'liquidation-1',
  tradingAccountId: 'account-1',
  marginMode: 'cross',
  realizedPnl: D('-900'),
  feeAmount: D('12'),
  settledFee: D('12'),
  settledCash: D('-912'),
  bankruptcyShortfall: D('0'),
  executedAt: at('2026-11-05T10:00:00.000Z'),
  closes: [
    {
      positionId: 'position-a',
      instrumentId: 'instrument-btc',
      direction: 'long',
      quantity: D('0.2'),
      executionPrice: D('58000'),
      markSnapshot: { symbol: 'BTCUSDT' },
    },
    {
      positionId: 'position-b',
      instrumentId: 'instrument-btc',
      direction: 'short',
      quantity: D('0.1'),
      executionPrice: D('58000'),
      markSnapshot: { symbol: 'BTCUSDT' },
    },
  ],
};
const settlement = {
  id: 'settlement-1',
  seasonId: 'season-1',
  tradingAccountId: 'account-1',
  endAt: at('2026-11-06T00:00:00.000Z'),
  realizedPnl: D('120'),
  feeAmount: D('3.2'),
  settledFee: D('3.2'),
  settledCash: D('116.8'),
  bankruptcyShortfall: D('0'),
  executedAt: at('2026-11-06T00:05:00.000Z'),
  closes: [
    {
      positionId: 'position-c',
      instrumentId: 'instrument-btc',
      direction: 'short',
      marginMode: 'isolated',
      quantity: D('0.1'),
      executionPrice: D('62000'),
      realizedPnl: D('120'),
      feeAmount: D('3.2'),
      price: { lastPriceSnapshotId: null },
      instrument,
    },
  ],
};

function fakeTx(input: {
  refs: Array<{ kind: string; id: string; executedAt: Date }>;
  total: number;
}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const finds = {
    futuresExecution: jest.fn((args: { where: { id: { in: string[] } } }) =>
      Promise.resolve(
        [
          execution('execution-open', 'open', '2026-11-05T08:00:00.000Z'),
          execution('execution-close', 'close', '2026-11-05T12:00:00.000Z'),
        ].filter((row) => args.where.id.in.includes(row.id)),
      ),
    ),
    futuresLiquidation: jest.fn().mockResolvedValue([liquidation]),
    futuresSeasonSettlement: jest.fn().mockResolvedValue([settlement]),
  };
  const tx = {
    futuresExecution: { findMany: finds.futuresExecution },
    futuresLiquidation: { findMany: finds.futuresLiquidation },
    futuresSeasonSettlement: { findMany: finds.futuresSeasonSettlement },
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Prisma.sql(strings, ...values);
        queries.push({ text: query.sql, values: query.values });
        return Promise.resolve(
          query.sql.includes('COUNT(*)')
            ? [{ total: input.total }]
            : input.refs,
        );
      },
    ),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, queries, finds };
}

describe('futures position history (포지션 진입 / 포지션 종료)', () => {
  it('entry pages open/increase executions only, presented as the executions route does', async () => {
    const { tx, queries, finds } = fakeTx({
      refs: [
        {
          kind: 'execution',
          id: 'execution-open',
          executedAt: at('2026-11-05T08:00:00.000Z'),
        },
      ],
      total: 3,
    });
    const page = await readFuturesPositionHistory(tx, 'account-1', 'entry', {
      limit: 1,
      offset: 0,
    });
    const [list] = queries;
    expect(list.text).toContain('FROM futures_executions e');
    expect(list.text).not.toContain('futures_liquidations');
    expect(list.text).not.toContain('futures_season_settlements');
    expect(list.values).toContainEqual(['open', 'increase']);
    expect(list.values).toContain('account-1');
    expect(list.text).toContain(
      'ORDER BY r.executed_at DESC, r.kind DESC, r.id DESC',
    );
    expect(finds.futuresExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tradingAccountId: 'account-1',
          id: { in: ['execution-open'] },
        },
      }),
    );
    expect(finds.futuresLiquidation).not.toHaveBeenCalled();
    expect(finds.futuresSeasonSettlement).not.toHaveBeenCalled();
    const [record] = page.records;
    expect(record.kind).toBe('execution');
    expect(record.kind === 'execution' && record.execution).toMatchObject({
      id: 'execution-open',
      operation: 'open',
      direction: 'long',
      quantity: '0.50000000',
      executionPrice: '64000.00000000',
      realizedPnl: '0.00000000',
      feeAmount: '16.00000000',
      priceEvidence: { priceBasis: 'futures_last' },
      instrument: {
        underlying: { symbol: 'BTCUSDT', displayPriceDecimals: 1 },
      },
    });
    expect(page.pagination).toEqual({
      limit: 1,
      offset: 0,
      total: 3,
      returned: 1,
      nextOffset: 1,
    });
  });

  it('exit merges reduce/close executions, liquidations and a Season exit that closed something, in the union order', async () => {
    const { tx, queries } = fakeTx({
      refs: [
        {
          kind: 'season_settlement',
          id: 'settlement-1',
          executedAt: at('2026-11-06T00:05:00.000Z'),
        },
        {
          kind: 'execution',
          id: 'execution-close',
          executedAt: at('2026-11-05T12:00:00.000Z'),
        },
        {
          kind: 'liquidation',
          id: 'liquidation-1',
          executedAt: at('2026-11-05T10:00:00.000Z'),
        },
      ],
      total: 3,
    });
    const page = await readFuturesPositionHistory(tx, 'account-1', 'exit', {
      limit: 20,
      offset: 0,
    });
    const [list, count] = queries;
    for (const query of [list, count]) {
      expect(query.text).toContain('FROM futures_executions e');
      expect(query.text).toContain('FROM futures_liquidations l');
      expect(query.text).toContain('FROM futures_season_settlements s');
      expect(query.text).toContain('FROM futures_season_closes c');
      expect(query.values).toContainEqual(['reduce', 'close']);
    }
    expect(list.text).toMatch(/LIMIT \? OFFSET \?/);
    expect(list.values.slice(-2)).toEqual([20, 0]);
    expect(page.records.map((record) => [record.kind, record.id])).toEqual([
      ['season_settlement', 'settlement-1'],
      ['execution', 'execution-close'],
      ['liquidation', 'liquidation-1'],
    ]);
    const [season, close, liquidated] = page.records as [
      Extract<FuturesHistoryRecord, { kind: 'season_settlement' }>,
      Extract<FuturesHistoryRecord, { kind: 'execution' }>,
      Extract<FuturesHistoryRecord, { kind: 'liquidation' }>,
    ];
    expect(season.settlement).toMatchObject({
      endAt: '2026-11-06T00:00:00.000Z',
      realizedPnl: '120.00000000',
      settledCash: '116.80000000',
      bankruptcyShortfall: '0.00000000',
      closes: [
        {
          positionId: 'position-c',
          direction: 'short',
          quantity: '0.10000000',
          executionPrice: '62000.00000000',
          priceBasis: 'spot_last',
          instrument: { underlying: { symbol: 'BTCUSDT' } },
        },
      ],
    });
    expect(close.execution.operation).toBe('close');
    // One event keeps all of its closes (a Cross liquidation of two positions).
    expect(liquidated.liquidation).toMatchObject({
      id: 'liquidation-1',
      marginMode: 'cross',
      settledCash: '-912',
      closes: [
        { positionId: 'position-a', direction: 'long', quantity: '0.2' },
        { positionId: 'position-b', direction: 'short', quantity: '0.1' },
      ],
    });
    expect(page.pagination.nextOffset).toBeNull();
  });

  it('an empty page reads no record rows', async () => {
    const { tx, finds } = fakeTx({ refs: [], total: 0 });
    const page = await readFuturesPositionHistory(tx, 'account-1', 'exit', {
      limit: 20,
      offset: 0,
    });
    expect(page.records).toEqual([]);
    expect(page.pagination).toMatchObject({ total: 0, nextOffset: null });
    expect(finds.futuresExecution).not.toHaveBeenCalled();
    expect(finds.futuresLiquidation).not.toHaveBeenCalled();
    expect(finds.futuresSeasonSettlement).not.toHaveBeenCalled();
  });
});
