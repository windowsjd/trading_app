import {
  BeginnerQuestEvidence,
  beginnerLearningPermissions,
  type BeginnerQuestCompletion,
  type QuestClient,
} from './beginner-quest-evidence';
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 11, 0, 0, seconds));
const decimal = (value: number) => ({ gt: (other: number) => value > other });
function setup() {
  const db = {
    order: { findFirst: jest.fn().mockResolvedValue(null) },
    futuresExecution: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const reader = new BeginnerQuestEvidence(db as unknown as QuestClient);
  return { db, reader };
}
it('market evidence requires actual filled quantity, matching account/market/side and strict chronology; automated exits (OCO child, SELL setting) excluded', async () => {
  const { db, reader } = setup();
  await reader.filledOrder(
    'A',
    { id: 'prior', executedAt: at(2) },
    'crypto',
    'sell',
    'manual',
  );
  expect(db.order.findFirst.mock.calls[0][0].where).toEqual({
    id: 'manual',
    tradingAccountId: 'A',
    asset: { assetType: 'crypto' },
    orderType: 'market',
    side: 'sell',
    status: 'executed',
    executedAt: { gt: at(2) },
    protectionChild: { is: null },
    conditionalSell: { is: null },
    OR: [
      { executedQuantity: { gt: 0 } },
      { executedQuantity: null, quantity: { gt: 0 } },
    ],
  });
});
it('limit registration requires real reservation and rejects failed/automatic-cancel orders', async () => {
  const { db, reader } = setup();
  await reader.limitOrder('A', { id: 'sell', executedAt: at(5) }, 'limit');
  const where = db.order.findFirst.mock.calls[0][0].where;
  expect(where.tradingAccountId).toBe('A');
  expect(where.orderType).toBe('limit');
  expect(where.submittedAt.gt.getTime()).toBe(at(5).getTime());
  expect(where.reservedAmount.gt).toBe(0);
  expect(where.protectionChild.is === null).toBe(true);
  expect(where.OR.map((r: { status: string }) => r.status)).toEqual([
    'submitted',
    'executed',
    'canceled',
  ]);
  expect(where.OR[2].cancelReason).toBe('user_canceled');
});
it.each([
  ['submitted', null, 1, null, false],
  ['executed', null, 1, null, false],
  ['executed', at(8), 0, null, false],
  ['executed', at(8), 0.1, null, true],
  ['canceled', at(8), 0, 'user_canceled', true],
  ['canceled', at(8), 0, 'season_closed', false],
  ['rejected', at(8), 0, null, false],
])(
  'terminal evidence requires settlement: %s reservation=%s qty=%s reason=%s',
  (status, released, qty, reason, done) => {
    const { reader } = setup();
    const value = reader.limitResolvedAt({
      status,
      reservationReleasedAt: released,
      executedQuantity: decimal(qty as number),
      quantity: decimal(1),
      executedAt: at(7),
      canceledAt: at(7),
      cancelReason: reason,
    } as never);
    expect(value !== null).toBe(done);
  },
);
it('futures evidence ties a manual full close to its opening lifetime and excludes liquidation, settlement and protection exits', async () => {
  const { reader, db } = setup();
  db.futuresExecution.findMany.mockResolvedValue([
    { id: 'open', positionId: 'lifetime-A', executedAt: at(7) },
  ]);
  db.futuresExecution.findFirst.mockResolvedValue({
    id: 'close',
    executedAt: at(8),
  });
  // Test the query boundary that PostgreSQL enforces, independently of mocks returning rows.
  const result = await (
    reader as unknown as {
      futuresLifetime: (
        a: string,
        b: { id: string; executedAt: Date },
        d: string,
      ) => Promise<{ open: { id: string }; close: { id: string } }>;
    }
  ).futuresLifetime('A', { id: 'q6', executedAt: at(6) }, 'short');
  expect(result.close.id).toBe('close');
  const open = db.futuresExecution.findMany.mock.calls[0][0].where,
    close = db.futuresExecution.findFirst.mock.calls[0][0].where;
  expect(open.direction).toBe('short');
  expect(open.leverage.gt).toBe(1);
  expect(open.executedAt.gt.getTime()).toBe(at(6).getTime());
  expect(close.positionId).toBe('lifetime-A');
  expect(close.tradingAccountId).toBe('A');
  expect(close.positionQuantityAfter).toBe(0);
  expect(close.executeRequest.is.tradingAccountId).toBe('A');
  expect(close.protectionChild.is === null).toBe(true);
  expect(close.position.is).toEqual({
    status: 'closed',
    quantity: 0,
    liquidationClose: { is: null },
    seasonClose: { is: null },
  });
});

type Query<W> = { where: W };
describe('QUEST 04 TP/SL registration evidence', () => {
  /** QUEST 01–03 proven at 1–4 s (holdings reviewed at 4 s); nothing later. */
  function proven(
    oco: { id: string; activatedAt: Date } | null,
    setting: { id: string; createdAt: Date } | null,
  ) {
    const db = {
      exchangeTransaction: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'fx', executedAt: at(1) }]),
      },
      walletTransfer: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'transfer', executedAt: at(2) }]),
      },
      walletTransaction: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: Query<{ referenceType: string }>) =>
            where.referenceType === 'exchange_transaction'
              ? [
                  leg('fx', 'exchange_source', 'debit', 'KRW', 'securities'),
                  leg('fx', 'exchange_target', 'credit', 'USD', 'securities'),
                ]
              : [
                  leg(
                    'transfer',
                    'wallet_transfer',
                    'debit',
                    'USD',
                    'securities',
                  ),
                  leg(
                    'transfer',
                    'wallet_transfer',
                    'credit',
                    'USD',
                    'crypto_spot',
                  ),
                ],
          ),
      },
      beginnerQuestAcknowledgement: {
        findMany: jest.fn().mockResolvedValue([
          {
            stepId: 'holdings_reviewed',
            orderId: 'buy',
            acknowledgedAt: at(4),
          },
        ]),
      },
      order: {
        findFirst: jest
          .fn()
          .mockImplementation(
            ({ where }: Query<{ side: string; orderType: string }>) =>
              where.side === 'buy' && where.orderType === 'market'
                ? { id: 'buy', executedAt: at(3), assetId: 'btc' }
                : null,
          ),
      },
      protectionGroup: { findFirst: jest.fn().mockResolvedValue(oco) },
      conditionalSellOrder: { findFirst: jest.fn().mockResolvedValue(setting) },
    };
    return {
      db,
      reader: new BeginnerQuestEvidence(db as unknown as QuestClient),
    };
  }
  function leg(
    referenceId: string,
    txType: string,
    direction: string,
    currencyCode: string,
    walletScope: string,
  ) {
    return {
      referenceId,
      txType,
      direction,
      currencyCode,
      wallet: { tradingAccountId: 'A', walletScope, currencyCode },
    };
  }
  const step = async (reader: BeginnerQuestEvidence) => {
    const progress = await reader.read('A');
    const quest = progress.quests.find(
      (row) => row.questId === 'common-04-protection',
    )!;
    return {
      completed: quest.status === 'completed',
      referenceId: quest.steps[0].referenceId,
      completedAt: quest.steps[0].completedAt,
      spotProtection: progress.learningAccess.spotProtection,
    };
  };

  it('accepts one independent stop-loss or take-profit on the practiced asset after the review', async () => {
    const { db, reader } = proven(null, { id: 'sl', createdAt: at(5) });
    expect(await step(reader)).toEqual({
      completed: true,
      referenceId: 'sl',
      completedAt: at(5).toISOString(),
      spotProtection: true,
    });
    const [[{ where }]] = db.conditionalSellOrder.findFirst.mock.calls as [
      [
        Query<{
          tradingAccountId: string;
          assetId: string;
          kind: unknown;
          position: unknown;
          createdAt: { gt: Date };
        }>,
      ],
    ];
    expect(where.tradingAccountId).toBe('A');
    expect(where.assetId).toBe('btc');
    expect(where.kind).toEqual({ in: ['stop_loss', 'take_profit'] });
    expect(where.position).toEqual({
      is: { tradingAccountId: 'A', assetId: 'btc' },
    });
    expect(where.createdAt.gt.getTime()).toBe(at(4).getTime());
  });

  it('keeps an earlier OCO completion and takes the earliest registration of either kind', async () => {
    const oco = await step(
      proven({ id: 'oco', activatedAt: at(6) }, { id: 'tp', createdAt: at(7) })
        .reader,
    );
    expect([oco.completed, oco.referenceId]).toEqual([true, 'oco']);
    const setting = await step(
      proven({ id: 'oco', activatedAt: at(9) }, { id: 'tp', createdAt: at(7) })
        .reader,
    );
    expect([setting.completed, setting.referenceId]).toEqual([true, 'tp']);
  });

  it('stays open without a qualifying registration', async () => {
    expect((await step(proven(null, null).reader)).completed).toBe(false);
  });
});

describe('staged learning permissions (B차, 2026-10-18)', () => {
  const KEYS = [
    'exchange',
    'transfer',
    'marketBuy',
    'protection',
    'marketSell',
    'limitBuy',
    'krStock',
    'usStock',
    'futuresLong',
    'futuresShort',
  ] as const;
  /** The first `count` foundation quests complete, plus the named market quests. */
  const progress = (
    count: number,
    market: Array<(typeof KEYS)[number]> = [],
  ): BeginnerQuestCompletion =>
    Object.fromEntries(
      KEYS.map((key, index) => [
        key,
        index < 6 ? index < count : market.includes(key),
      ]),
    ) as BeginnerQuestCompletion;
  const none = { long: false, short: false };
  const open = (done: BeginnerQuestCompletion, positions = none) =>
    Object.entries(beginnerLearningPermissions(done, positions))
      .filter(([, allowed]) => allowed)
      .map(([action]) => action)
      .sort();

  it.each([
    [0, ['exchange']],
    [1, ['exchange', 'transfer']],
    [2, ['cryptoMarketBuy', 'exchange', 'transfer']],
    // QUEST 04/05 keep the market BUY so a practice holding can be bought again.
    [3, ['cryptoMarketBuy', 'exchange', 'spotProtection', 'transfer']],
    [4, ['cryptoMarketBuy', 'exchange', 'transfer']],
    [5, ['cryptoLimitBuy', 'exchange', 'transfer']],
  ])(
    'foundation %s complete opens only its current practice',
    (count, actions) => {
      expect(open(progress(count))).toEqual(actions);
    },
  );

  it('QUEST 06 opens the four market practices, never everything', () => {
    expect(open(progress(6))).toEqual([
      'exchange',
      'futuresLongOpen',
      'futuresShortOpen',
      'fxTransfer',
      'krStockMarketBuy',
      'transfer',
      'usStockMarketBuy',
    ]);
  });

  it('a completed market quest closes its own practice; the others stay independent', () => {
    expect(open(progress(6, ['krStock']))).toEqual([
      'exchange',
      'futuresLongOpen',
      'futuresShortOpen',
      'fxTransfer',
      'transfer',
      'usStockMarketBuy',
    ]);
    expect(open(progress(6, ['futuresShort', 'usStock']))).toEqual([
      'exchange',
      'futuresLongOpen',
      'fxTransfer',
      'krStockMarketBuy',
      'transfer',
    ]);
  });

  it('an open position in a pending direction waits for its close; the other direction stays open', () => {
    expect(open(progress(6), { long: true, short: false })).toEqual([
      'exchange',
      'futuresShortOpen',
      'fxTransfer',
      'krStockMarketBuy',
      'transfer',
      'usStockMarketBuy',
    ]);
  });

  it('all ten quests open every action, open positions included', () => {
    const all = beginnerLearningPermissions(
      progress(6, ['krStock', 'usStock', 'futuresLong', 'futuresShort']),
      { long: true, short: true },
    );
    expect(Object.values(all).every(Boolean)).toBe(true);
  });

  it('reads open positions only while a Futures quest is pending', async () => {
    const db = {
      exchangeTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      futuresPosition: { findMany: jest.fn() },
    };
    const result = await new BeginnerQuestEvidence(
      db as unknown as QuestClient,
    ).read('A');
    expect(db.futuresPosition.findMany).not.toHaveBeenCalled();
    expect(result.learningPermissions.allTrading).toBe(false);
    // The legacy contract keeps its meaning for deployed apps.
    expect(result.learningAccess).toEqual({
      exchange: true,
      transfer: false,
      cryptoMarketBuy: false,
      spotProtection: false,
      cryptoLimitBuy: false,
      allTrading: false,
    });
  });
});
