jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<typeof import('@prisma/client/runtime/client')>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
}));
import { Prisma } from '../generated/prisma/client';
import {
  readFriendCompletedTrades,
  summarizeFuturesCompletedTrade,
  summarizeSpotCompletedTrade,
  type FuturesExecutionTotals,
  type SpotOrderTotals,
} from './friend-completed-trades';

const samsung = {
  symbol: '005930',
  name: 'Samsung Electronics',
  market: 'KRX',
  assetType: 'domestic_stock',
};
const closedSamsung = {
  assetId: 'asset-samsung',
  currencyCode: 'KRW',
  quantity: '0.00000000',
  // Buy 10 @ 70,000 and 5 @ 72,000 (0.1% fee), sell 15 @ 75,000: the
  // engine's own average-cost result, rounding included.
  realizedPnl: '62815.00000005',
  asset: samsung,
};
const spotTotals = (
  overrides: Partial<Record<'buy' | 'sell', Partial<SpotOrderTotals>>> = {},
): SpotOrderTotals[] => [
  {
    side: 'buy',
    currencyCode: 'KRW',
    netAmount: '1061060.00000000',
    quantity: '15.00000000',
    count: 2,
    missingAmount: 0,
    ...overrides.buy,
  },
  {
    side: 'sell',
    currencyCode: 'KRW',
    netAmount: '1123875.00000000',
    quantity: '15.00000000',
    count: 1,
    missingAmount: 0,
    ...overrides.sell,
  },
];

describe('Spot completed trade (거래 완료 종목)', () => {
  it('buy amount is every buy net of fee; realized PnL is the position’s own; return on the buy amount', () => {
    expect(summarizeSpotCompletedTrade(closedSamsung, spotTotals())).toEqual({
      kind: 'spot',
      assetId: 'asset-samsung',
      ...samsung,
      currencyCode: 'KRW',
      buyAmount: '1061060.00000000',
      realizedPnl: '62815.00000005',
      returnRate: '5.92002337',
    });
  });

  it('a holding that is still open (a partial sell, or bought again) is not complete', () => {
    expect(
      summarizeSpotCompletedTrade(
        { ...closedSamsung, quantity: '5.00000000' },
        spotTotals({ sell: { quantity: '10.00000000' } }),
      ),
    ).toBeNull();
  });

  it('rounds and re-entries add up once (the totals already cover every closed round)', () => {
    // Two closed rounds: 1,061,060 then 500,500 bought; cumulative realized 62,815.00000005 - 1,000.
    const item = summarizeSpotCompletedTrade(
      { ...closedSamsung, realizedPnl: '61815.00000005' },
      spotTotals({
        buy: {
          netAmount: '1561560.00000000',
          quantity: '22.00000000',
          count: 3,
        },
        sell: {
          netAmount: '1623375.00000000',
          quantity: '22.00000000',
          count: 2,
        },
      }),
    );
    expect(item).toMatchObject({
      buyAmount: '1561560.00000000',
      realizedPnl: '61815.00000005',
      returnRate: '3.95854146',
    });
  });

  it('orders that do not explain the close, or an unknown amount, leave the item out', () => {
    for (const totals of [
      spotTotals({ sell: { quantity: '14.00000000' } }),
      spotTotals({ buy: { missingAmount: 1 } }),
      spotTotals({ buy: { netAmount: null } }),
      spotTotals({ sell: { currencyCode: 'USD' } }),
      spotTotals().filter((row) => row.side === 'buy'),
    ])
      expect(summarizeSpotCompletedTrade(closedSamsung, totals)).toBeNull();
  });
});

const btc = {
  settlementCurrency: 'USD',
  underlyingAsset: {
    id: 'asset-btc',
    symbol: 'BTCUSDT',
    name: '비트코인',
    market: 'BINANCE',
  },
};
const execution = (
  operation: FuturesExecutionTotals['operation'],
  values: Partial<FuturesExecutionTotals>,
): FuturesExecutionTotals => ({
  operation,
  quantity: '0',
  notional: '0',
  feeAmount: '0',
  realizedPnl: '0',
  count: 1,
  ...values,
});

describe('Futures completed trade (거래 완료 종목)', () => {
  it('Long: 진입 증거금 = ceil(entry notional / leverage); realized PnL is net of every fee', () => {
    // Open 0.5 @ 60,000 (notional 30,000, fee 30) at 10x; close @ 63,000
    // (notional 31,500, fee 31.5, realized 1,500).
    expect(
      summarizeFuturesCompletedTrade(
        {
          id: 'p-long',
          direction: 'long',
          leverage: 10,
          realizedPnl: '1500',
          instrument: btc,
        },
        [
          execution('open', {
            quantity: '0.5',
            notional: '30000',
            feeAmount: '30',
          }),
          execution('close', {
            quantity: '0.5',
            notional: '31500',
            feeAmount: '31.5',
            realizedPnl: '1500',
          }),
        ],
        [],
      ),
    ).toEqual({
      kind: 'futures',
      assetId: 'asset-btc',
      symbol: 'BTCUSDT',
      name: '비트코인',
      market: 'BINANCE',
      direction: 'long',
      currencyCode: 'USD',
      entryMargin: '3000.00000000',
      realizedPnl: '1438.50000000',
      returnRate: '47.95000000',
    });
  });

  it('Short with an increase and a partial reduce: margin on every entry, PnL over every exit', () => {
    // Open 1 @ 100, increase 1 @ 90 (avg 95) at 3x; reduce 1 @ 80 (+15), close 1 @ 85 (+10).
    expect(
      summarizeFuturesCompletedTrade(
        {
          id: 'p-short',
          direction: 'short',
          leverage: 3,
          realizedPnl: '25',
          instrument: btc,
        },
        [
          execution('open', {
            quantity: '1',
            notional: '100',
            feeAmount: '0.1',
          }),
          execution('increase', {
            quantity: '1',
            notional: '90',
            feeAmount: '0.09',
          }),
          execution('reduce', {
            quantity: '1',
            notional: '80',
            feeAmount: '0.08',
            realizedPnl: '15',
          }),
          execution('close', {
            quantity: '1',
            notional: '85',
            feeAmount: '0.085',
            realizedPnl: '10',
          }),
        ],
        [],
      ),
    ).toMatchObject({
      direction: 'short',
      entryMargin: '63.33333334',
      realizedPnl: '24.64500000',
      returnRate: '38.91315789',
    });
  });

  it('a liquidation or season-final close counts with its own PnL and fee', () => {
    for (const close of [
      { quantity: '1', realizedPnl: '-9.5', feeAmount: '0.0905' },
    ])
      expect(
        summarizeFuturesCompletedTrade(
          {
            id: 'p-liq',
            direction: 'long',
            leverage: 10,
            realizedPnl: '-9.5',
            instrument: btc,
          },
          [
            execution('open', {
              quantity: '1',
              notional: '100',
              feeAmount: '0.1',
            }),
          ],
          [close],
        ),
      ).toMatchObject({
        entryMargin: '10.00000000',
        realizedPnl: '-9.69050000',
        returnRate: '-96.90500000',
      });
  });

  it('rows that do not reconcile are left out, never guessed', () => {
    const position = {
      id: 'p',
      direction: 'long' as const,
      leverage: 10,
      realizedPnl: '1500',
      instrument: btc,
    };
    const open = execution('open', {
      quantity: '0.5',
      notional: '30000',
      feeAmount: '30',
    });
    const close = execution('close', {
      quantity: '0.5',
      notional: '31500',
      feeAmount: '31.5',
      realizedPnl: '1500',
    });
    // Realized PnL that is not its parts; quantities in vs out; no open; no exit.
    expect(
      summarizeFuturesCompletedTrade(
        { ...position, realizedPnl: '1400' },
        [open, close],
        [],
      ),
    ).toBeNull();
    expect(
      summarizeFuturesCompletedTrade(
        position,
        [open, { ...close, quantity: '0.4' }],
        [],
      ),
    ).toBeNull();
    expect(summarizeFuturesCompletedTrade(position, [close], [])).toBeNull();
    expect(summarizeFuturesCompletedTrade(position, [open], [])).toBeNull();
    expect(
      summarizeFuturesCompletedTrade(
        position,
        [{ ...open, count: 2 }, close],
        [],
      ),
    ).toBeNull();
    expect(
      summarizeFuturesCompletedTrade(
        { ...position, instrument: { ...btc, settlementCurrency: 'KRW' } },
        [open, close],
        [],
      ),
    ).toBeNull();
  });
});

type ReadArgs = { where: { positionId: { in: string[] } } };

describe('readFriendCompletedTrades', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 0, minute));
  function fakeTx(options: { futures?: number } = {}) {
    const futures = Array.from(
      { length: options.futures ?? 1 },
      (_, index) => ({
        id: `p${index}`,
        direction: 'long',
        leverage: 10,
        realizedPnl: new Prisma.Decimal('1500'),
        closedAt: at(30 - index),
        instrument: btc,
      }),
    );
    const tx = {
      position: {
        findMany: jest.fn().mockResolvedValue([
          closedSamsung,
          // Closed, but its orders do not explain the close: left out.
          { ...closedSamsung, assetId: 'asset-broken' },
        ]),
      },
      futuresPosition: { findMany: jest.fn().mockResolvedValue(futures) },
      $queryRaw: jest.fn().mockResolvedValue([
        ...spotTotals().map((row) => ({
          ...row,
          assetId: 'asset-samsung',
          lastExecutedAt: row.side === 'sell' ? at(45) : at(1),
        })),
        { ...spotTotals()[0], assetId: 'asset-broken', lastExecutedAt: at(2) },
      ]),
      futuresExecution: {
        groupBy: jest.fn().mockImplementation(({ where }: ReadArgs) =>
          Promise.resolve(
            where.positionId.in.flatMap((positionId) => [
              {
                positionId,
                operation: 'open',
                _sum: {
                  quantity: new Prisma.Decimal('0.5'),
                  notional: new Prisma.Decimal('30000'),
                  feeAmount: new Prisma.Decimal('30'),
                  realizedPnl: new Prisma.Decimal('0'),
                },
                _count: { _all: 1 },
              },
              {
                positionId,
                operation: 'close',
                _sum: {
                  quantity: new Prisma.Decimal('0.5'),
                  notional: new Prisma.Decimal('31500'),
                  feeAmount: new Prisma.Decimal('31.5'),
                  realizedPnl: new Prisma.Decimal('1500'),
                },
                _count: { _all: 1 },
              },
            ]),
          ),
        ),
      },
      futuresLiquidationClose: { findMany: jest.fn().mockResolvedValue([]) },
      futuresSeasonClose: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return tx;
  }

  it('reads only this account, newest completion first, as aggregates only', async () => {
    const tx = fakeTx();
    const result = await readFriendCompletedTrades(tx as never, 'acc-1');
    expect(result.hasMore).toBe(false);
    expect(result.items.map((item) => item.kind)).toEqual(['spot', 'futures']);
    for (const item of result.items)
      expect(Object.keys(item).sort()).toEqual(
        item.kind === 'spot'
          ? [
              'assetId',
              'assetType',
              'buyAmount',
              'currencyCode',
              'kind',
              'market',
              'name',
              'realizedPnl',
              'returnRate',
              'symbol',
            ]
          : [
              'assetId',
              'currencyCode',
              'direction',
              'entryMargin',
              'kind',
              'market',
              'name',
              'realizedPnl',
              'returnRate',
              'symbol',
            ],
      );
    expect(tx.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tradingAccountId: 'acc-1', quantity: { equals: '0' } },
      }),
    );
    expect(tx.futuresPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tradingAccountId: 'acc-1', status: 'closed' },
        take: 31,
      }),
    );
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toMatch(
      /o\.trading_account_id = \?[\s\S]*o\.status = 'executed'[\s\S]*ANY\(\?::text\[\]\)/,
    );
    expect(values).toEqual(['acc-1', ['asset-samsung', 'asset-broken']]);
    for (const read of [
      tx.futuresExecution.groupBy,
      tx.futuresLiquidationClose.findMany,
      tx.futuresSeasonClose.findMany,
    ])
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tradingAccountId: 'acc-1', positionId: { in: ['p0'] } },
        }),
      );
  });

  it('lists at most the newest 30 and says when more exist', async () => {
    const tx = fakeTx({ futures: 31 });
    const result = await readFriendCompletedTrades(tx as never, 'acc-1');
    expect(result.items).toHaveLength(30);
    expect(result.hasMore).toBe(true);
    const [args] = tx.futuresExecution.groupBy.mock.calls[0] as [ReadArgs];
    expect(args.where.positionId.in).toHaveLength(30);
  });

  it('nothing closed reads nothing more', async () => {
    const tx = fakeTx({ futures: 0 });
    tx.position.findMany.mockResolvedValue([]);
    expect(await readFriendCompletedTrades(tx as never, 'acc-1')).toEqual({
      items: [],
      hasMore: false,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.futuresExecution.groupBy).not.toHaveBeenCalled();
  });
});
