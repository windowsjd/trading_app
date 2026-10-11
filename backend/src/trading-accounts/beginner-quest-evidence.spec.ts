import {
  BeginnerQuestEvidence,
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
it('market evidence requires actual filled quantity, matching account/market/side and strict chronology; automated exits excluded', async () => {
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
