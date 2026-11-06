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
  averagePrice,
  readOwnCompletedTrades,
  type OwnCompletedTrade,
} from './own-completed-trades';

const D = (value: string) => new Prisma.Decimal(value);
const at = (iso: string) => new Date(iso);
const samsung = {
  symbol: '005930',
  name: 'Samsung Electronics',
  market: 'KRX',
  assetType: 'domestic_stock',
};
// Buy 10 @ 70,000 and 5 @ 72,000 (0.1% fee), sell 15 @ 75,000: the same
// fixture as the friend policy's spec, with the gross amounts the orders store.
const spotPosition = {
  assetId: 'asset-samsung',
  currencyCode: 'KRW',
  quantity: D('0'),
  realizedPnl: D('62815.00000005'),
  asset: samsung,
};
const spotRows = (
  overrides: { buyMissingGross?: number; previousSellAt?: Date | null } = {},
) => [
  {
    assetId: 'asset-samsung',
    side: 'buy',
    currencyCode: 'KRW',
    netAmount: D('1061060'),
    grossAmount: D('1060000'),
    quantity: D('15'),
    count: 2,
    missingAmount: 0,
    missingGross: overrides.buyMissingGross ?? 0,
    lastExecutedAt: at('2026-11-05T10:00:00.000Z'),
    lastOrderId: 'order-buy-2',
    previousExecutedAt: at('2026-11-05T09:00:00.000Z'),
  },
  {
    assetId: 'asset-samsung',
    side: 'sell',
    currencyCode: 'KRW',
    netAmount: D('1123875'),
    grossAmount: D('1125000'),
    quantity: D('15'),
    count: 1,
    missingAmount: 0,
    missingGross: 0,
    lastExecutedAt: at('2026-11-05T12:44:04.000Z'),
    lastOrderId: 'order-sell-1',
    previousExecutedAt: overrides.previousSellAt ?? null,
  },
];
const btc = {
  id: 'instrument-btc',
  underlyingAssetId: 'asset-btc',
  productType: 'synthetic_perpetual',
  settlementCurrency: 'USD',
  isActive: true,
  markContractJson: { priceTickSize: '0.10' },
  markVerifiedAt: null,
  createdAt: at('2026-01-01T00:00:00.000Z'),
  updatedAt: at('2026-01-01T00:00:00.000Z'),
  underlyingAsset: {
    id: 'asset-btc',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    market: 'BINANCE',
  },
};
const futuresPosition = (
  id: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  direction: 'long',
  marginMode: 'isolated',
  leverage: 10,
  realizedPnl: D('2600'),
  closedAt: at('2026-11-05T12:00:00.000Z'),
  instrument: btc,
  ...overrides,
});
const executionRow = (
  positionId: string,
  operation: string,
  quantity: string,
  price: string,
  fee: string,
  realized: string,
) => ({
  positionId,
  operation,
  quantity: D(quantity),
  notional: D(quantity).mul(price),
  feeAmount: D(fee),
  realizedPnl: D(realized),
  priceQuantity: D(quantity).mul(price),
  count: 1,
});
// Open 0.5 @ 60,000, add 0.5 @ 62,000, reduce 0.4 @ 63,000, close 0.6 @ 64,000.
const longRows = [
  executionRow('lifetime-long', 'open', '0.5', '60000', '30', '0'),
  executionRow('lifetime-long', 'increase', '0.5', '62000', '31', '0'),
  executionRow('lifetime-long', 'reduce', '0.4', '63000', '25.2', '800'),
  executionRow('lifetime-long', 'close', '0.6', '64000', '38.4', '1800'),
];

function fakeTx(input: {
  spot?: Array<typeof spotPosition>;
  futures?: Array<ReturnType<typeof futuresPosition>>;
  spotRows?: ReturnType<typeof spotRows>;
  futuresRows?: Array<ReturnType<typeof executionRow>>;
  liquidations?: Array<Record<string, unknown>>;
  seasonCloses?: Array<Record<string, unknown>>;
}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    position: { findMany: jest.fn().mockResolvedValue(input.spot ?? []) },
    futuresPosition: {
      findMany: jest.fn().mockResolvedValue(input.futures ?? []),
    },
    futuresLiquidationClose: {
      findMany: jest.fn().mockResolvedValue(input.liquidations ?? []),
    },
    futuresSeasonClose: {
      findMany: jest.fn().mockResolvedValue(input.seasonCloses ?? []),
    },
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Prisma.sql(strings, ...values);
        queries.push({ text: query.sql, values: query.values });
        return Promise.resolve(
          query.sql.includes('FROM orders')
            ? (input.spotRows ?? [])
            : (input.futuresRows ?? []),
        );
      },
    ),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, queries };
}

const read = (
  tx: Prisma.TransactionClient,
  spotSince: Date | null = null,
  limit?: number,
) =>
  readOwnCompletedTrades(tx, 'account-1', {
    spotSince,
    spotDisplayDecimals: (asset) => (asset.market === 'BINANCE' ? 5 : null),
    limit,
  });

describe('averagePrice', () => {
  it('is the quantity-weighted average, 8 dp half up', () => {
    expect(averagePrice('1060000', '15')).toBe('70666.66666667');
    expect(averagePrice(D('63600'), D('1'))).toBe('63600.00000000');
  });
  it('is null without quantity or evidence (never estimated)', () => {
    expect(averagePrice(null, '1')).toBeNull();
    expect(averagePrice('100', '0')).toBeNull();
    expect(averagePrice('100', null)).toBeNull();
  });
});

describe('own completed trades (수익 공유)', () => {
  it('a closed Spot holding keeps the friend policy figures and adds its own prices and completion', async () => {
    const { tx } = fakeTx({ spot: [spotPosition], spotRows: spotRows() });
    const { items, hasMore } = await read(tx);
    expect(hasMore).toBe(false);
    expect(items).toEqual<OwnCompletedTrade[]>([
      {
        kind: 'spot',
        assetId: 'asset-samsung',
        ...samsung,
        currencyCode: 'KRW',
        buyAmount: '1061060.00000000',
        realizedPnl: '62815.00000005',
        returnRate: '5.92002337',
        key: 'spot:asset-samsung',
        completedAt: '2026-11-05T12:44:04.000Z',
        lastSellOrderId: 'order-sell-1',
        averageBuyPrice: '70666.66666667',
        averageSellPrice: '75000.00000000',
        displayPriceDecimals: null,
      },
    ]);
  });

  it('names the SELL that completed the holding only when no other SELL shares its instant', async () => {
    const earlier = fakeTx({
      spot: [spotPosition],
      spotRows: spotRows({ previousSellAt: at('2026-11-05T12:00:00.000Z') }),
    });
    const [item] = (await read(earlier.tx)).items;
    expect(item.kind === 'spot' && item.lastSellOrderId).toBe('order-sell-1');
    const query = earlier.queries.find((q) => q.text.includes('FROM orders'));
    expect(query?.text).toContain(
      '(ARRAY_AGG(o.id ORDER BY o.executed_at DESC NULLS LAST, o.id DESC))[1]',
    );

    const tie = fakeTx({
      spot: [spotPosition],
      spotRows: spotRows({ previousSellAt: at('2026-11-05T12:44:04.000Z') }),
    });
    const [tied] = (await read(tie.tx)).items;
    expect(tied.kind === 'spot' && tied.lastSellOrderId).toBeNull();
    expect(tied.realizedPnl).toBe('62815.00000005');
  });

  it('a side with an order lacking its gross amount shows no price for that side', async () => {
    const { tx } = fakeTx({
      spot: [spotPosition],
      spotRows: spotRows({ buyMissingGross: 1 }),
    });
    const [item] = (await read(tx)).items;
    expect(item.kind === 'spot' && item.averageBuyPrice).toBeNull();
    expect(item.kind === 'spot' && item.averageSellPrice).toBe(
      '75000.00000000',
    );
  });

  it('reads only Spot orders after the latest general reset when one exists', async () => {
    const since = at('2026-11-01T00:00:00.000Z');
    const withReset = fakeTx({ spot: [spotPosition], spotRows: spotRows() });
    await read(withReset.tx, since);
    const spotQuery = withReset.queries.find((q) =>
      q.text.includes('FROM orders'),
    );
    expect(spotQuery?.text).toContain('AND o.executed_at > ');
    expect(spotQuery?.values).toContain(since);

    const noReset = fakeTx({ spot: [spotPosition], spotRows: spotRows() });
    await read(noReset.tx);
    expect(
      noReset.queries.find((q) => q.text.includes('FROM orders'))?.text,
    ).not.toContain('executed_at >');
  });

  it('a holding whose orders no longer reconcile (e.g. a reset epoch with no new round) is not listed', async () => {
    const { tx } = fakeTx({ spot: [spotPosition], spotRows: [] });
    expect((await read(tx, at('2026-11-06T00:00:00.000Z'))).items).toEqual([]);
  });

  it('a closed Futures lifetime: net result and return as the friend policy, average entry and exit from its executions', async () => {
    const { tx } = fakeTx({
      futures: [futuresPosition('lifetime-long')],
      futuresRows: longRows,
    });
    const [item] = (await read(tx)).items;
    expect(item).toEqual({
      kind: 'futures',
      assetId: 'asset-btc',
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      market: 'BINANCE',
      direction: 'long',
      currencyCode: 'USD',
      // ceil((30,000 + 31,000) / 10); 2,600 realized less 124.6 of fees.
      entryMargin: '6100.00000000',
      realizedPnl: '2475.40000000',
      returnRate: '40.58032787',
      key: 'futures:lifetime-long',
      positionId: 'lifetime-long',
      leverage: 10,
      marginMode: 'isolated',
      closeKind: 'closed',
      completedAt: '2026-11-05T12:00:00.000Z',
      averageEntryPrice: '61000.00000000',
      averageExitPrice: '63600.00000000',
      displayPriceDecimals: 1,
    });
  });

  it('a liquidated or season-closed lifetime says how it ended and counts its close row as an exit', async () => {
    const short = futuresPosition('lifetime-short', {
      direction: 'short',
      marginMode: 'cross',
      leverage: 20,
      realizedPnl: D('-10'),
      closedAt: at('2026-11-05T13:00:00.000Z'),
    });
    const settled = futuresPosition('lifetime-final', {
      realizedPnl: D('5'),
      closedAt: at('2026-11-05T11:00:00.000Z'),
    });
    const { tx } = fakeTx({
      futures: [short, settled],
      futuresRows: [
        executionRow('lifetime-short', 'open', '1', '100', '0.1', '0'),
        executionRow('lifetime-final', 'open', '1', '100', '0.1', '0'),
      ],
      liquidations: [
        {
          positionId: 'lifetime-short',
          quantity: D('1'),
          realizedPnl: D('-10'),
          feeAmount: D('0.11'),
          executionPrice: D('110'),
        },
      ],
      seasonCloses: [
        {
          positionId: 'lifetime-final',
          quantity: D('1'),
          realizedPnl: D('5'),
          feeAmount: D('0.105'),
          executionPrice: D('105'),
        },
      ],
    });
    const items = (await read(tx)).items;
    expect(
      items.map((item) =>
        item.kind === 'futures'
          ? [
              item.positionId,
              item.closeKind,
              item.direction,
              item.leverage,
              item.realizedPnl,
              item.averageEntryPrice,
              item.averageExitPrice,
            ]
          : null,
      ),
    ).toEqual([
      [
        'lifetime-short',
        'liquidated',
        'short',
        20,
        '-10.21000000',
        '100.00000000',
        '110.00000000',
      ],
      [
        'lifetime-final',
        'season_closed',
        'long',
        10,
        '4.79500000',
        '100.00000000',
        '105.00000000',
      ],
    ]);
  });

  it('a lifetime whose stored rows do not reconcile is left out, never guessed', async () => {
    const { tx } = fakeTx({
      futures: [futuresPosition('lifetime-long', { realizedPnl: D('2599') })],
      futuresRows: longRows,
    });
    expect((await read(tx)).items).toEqual([]);
  });

  it('lists Spot and Futures together, newest completion first, at most `limit`', async () => {
    const { tx } = fakeTx({
      spot: [spotPosition],
      spotRows: spotRows(),
      futures: [
        futuresPosition('lifetime-long'),
        futuresPosition('lifetime-older', {
          closedAt: at('2026-11-04T00:00:00.000Z'),
        }),
      ],
      futuresRows: [
        ...longRows,
        ...longRows.map((row) => ({ ...row, positionId: 'lifetime-older' })),
      ],
    });
    const first = await read(tx, null, 1);
    expect(first.items.map((item) => item.key)).toEqual(['spot:asset-samsung']);
    expect(first.hasMore).toBe(true);
    const all = await read(tx);
    expect(all.items.map((item) => item.key)).toEqual([
      'spot:asset-samsung',
      'futures:lifetime-long',
      'futures:lifetime-older',
    ]);
    expect(all.hasMore).toBe(false);
  });
});
