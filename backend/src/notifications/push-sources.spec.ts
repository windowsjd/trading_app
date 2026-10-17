import {
  isSeasonEndCleanup,
  keysetWhere,
  parseSeasonEndingSourceKey,
  readConditionalBuyFailures,
  readConditionalSellFailures,
  readEntryPlanFailures,
  readFriendRequests,
  readFuturesConditionalEntryFailures,
  readFuturesFills,
  readFuturesTpSlFailures,
  readLiquidations,
  readLocFailures,
  readSeasonFinalResults,
  readSpotFills,
  scanSeasonEndingSoon,
  SEASON_ENDING_MIN_LEAD_MS,
  seasonEndingSourceKey,
  SOURCE_PAGE_SIZE,
  type ScanArgs,
} from './push-sources';

const window = {
  from: new Date('2026-10-17T00:00:00.000Z'),
  to: new Date('2026-10-17T00:10:00.000Z'),
};
const args: ScanArgs = { window, after: null, now: window.to };
const decimal = (value: string) => ({ toFixed: () => value });

function account(
  overrides: Partial<{
    id: string;
    userId: string;
    mode: 'season' | 'general' | 'beginner';
    endAt: Date;
  }> = {},
) {
  const mode = overrides.mode ?? 'season';
  return {
    id: overrides.id ?? 'account-a',
    userId: overrides.userId ?? 'user-a',
    mode,
    seasonParticipant:
      mode === 'season'
        ? {
            season: {
              id: 'season-1',
              name: '2026 시즌 3',
              endAt: overrides.endAt ?? new Date('2026-10-20T00:00:00.000Z'),
            },
          }
        : null,
  };
}

function fakeDb(rows: Record<string, unknown[]> = {}) {
  const calls: Record<string, unknown[]> = {};
  const model = (name: string) => ({
    findMany: jest.fn(async (args: unknown) => {
      calls[name] = [...(calls[name] ?? []), args];
      return rows[name] ?? [];
    }),
  });
  const names = [
    'order',
    'futuresExecution',
    'futuresLiquidation',
    'limitOnCloseOrder',
    'conditionalBuyOrder',
    'conditionalSellOrder',
    'futuresConditionalEntry',
    'futuresTpSlSetting',
    'entryTpSlPlan',
    'friendship',
    'season',
    'seasonParticipant',
    'pushNotification',
  ];
  return {
    db: Object.fromEntries(names.map((name) => [name, model(name)])) as never,
    calls,
  };
}

function spotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    side: 'buy',
    orderType: 'limit',
    quantity: decimal('3'),
    executedQuantity: null,
    canceledQuantity: null,
    executedAt: new Date('2026-10-17T00:05:00.000Z'),
    asset: { name: '삼성전자', symbol: '005930' },
    tradingAccount: account(),
    limitOnClose: null,
    conditionalBuy: null,
    conditionalSell: null,
    protectionChild: null,
    ...overrides,
  };
}

describe('push sources', () => {
  it('reads only executed Spot orders inside the window', async () => {
    const { db, calls } = fakeDb({ order: [spotRow()] });
    const scan = await readSpotFills(db, args);
    const where = (calls.order[0] as { where: Record<string, unknown> }).where;
    expect(where.status).toBe('executed');
    expect(where.AND).toEqual([
      { executedAt: { gte: window.from, lte: window.to } },
    ]);
    expect(scan.candidates).toHaveLength(1);
    const [candidate] = scan.candidates;
    expect(candidate.userId).toBe('user-a');
    expect(candidate.sourceKey).toBe('order:order-1');
    expect(candidate.type).toBe('trade_fill');
    expect(candidate.data).toEqual({
      v: 1,
      type: 'trade_fill',
      uid: 'user-a',
      accountId: 'account-a',
      market: 'spot',
    });
    expect(candidate.copy.title).toBe('삼성전자 매수 체결 완료');
    expect(candidate.expiresAt.getTime()).toBeGreaterThan(
      candidate.eventAt.getTime(),
    );
    expect(scan.full).toBe(false);
    expect(scan.last).toEqual({
      at: new Date('2026-10-17T00:05:00.000Z'),
      id: 'order-1',
    });
  });

  it('classifies automated Spot fills by their linked intent', async () => {
    const { db } = fakeDb({
      order: [
        spotRow({
          id: 'a',
          conditionalSell: { kind: 'stop_loss' },
          side: 'sell',
        }),
        spotRow({
          id: 'b',
          conditionalSell: { kind: 'condition' },
          side: 'sell',
        }),
        spotRow({ id: 'c', conditionalBuy: { id: 'cb' } }),
        spotRow({ id: 'd', protectionChild: { leg: { kind: 'take_profit' } } }),
        spotRow({ id: 'e', limitOnClose: { orderId: 'e' } }),
      ],
    });
    const bodies = (await readSpotFills(db, args)).candidates.map(
      (c) => c.copy,
    );
    expect(bodies[0].body).toContain('손절');
    expect(bodies[1].body).toContain('조건주문');
    expect(bodies[2].body).toContain('조건주문');
    expect(bodies[3].body).toContain('익절');
    expect(bodies[4].title).toBe('삼성전자 LOC 매수 체결 완료');
  });

  it('reports a full page and its last row for keyset continuation', async () => {
    const times = Array.from(
      { length: SOURCE_PAGE_SIZE },
      (_, index) => new Date(window.from.getTime() + index * 1000),
    );
    const { db } = fakeDb({
      order: times.map((executedAt, index) =>
        spotRow({ id: `o${index}`, executedAt }),
      ),
    });
    const scan = await readSpotFills(db, args);
    expect(scan.full).toBe(true);
    expect(scan.last).toEqual({
      at: times[times.length - 1],
      id: `o${SOURCE_PAGE_SIZE - 1}`,
    });
  });

  it('maps Futures executions to their origin and the futures history', async () => {
    const row = (overrides: Record<string, unknown>) => ({
      id: 'x',
      operation: 'open',
      direction: 'long',
      quantity: decimal('0.5'),
      executedAt: new Date('2026-10-17T00:03:00.000Z'),
      instrument: { underlyingAsset: { symbol: 'BTC' } },
      tradingAccount: account({ mode: 'general', id: 'g1' }),
      limitOrder: null,
      conditionalEntry: null,
      tpSlSetting: null,
      protectionChild: null,
      ...overrides,
    });
    const { db, calls } = fakeDb({
      futuresExecution: [
        row({ id: 'market' }),
        row({ id: 'limit', limitOrder: { conditionalEntry: null } }),
        row({
          id: 'cond-limit',
          limitOrder: { conditionalEntry: { id: 'ce' } },
        }),
        row({ id: 'cond', conditionalEntry: { id: 'ce2' } }),
        row({
          id: 'tp',
          tpSlSetting: { kind: 'take_profit' },
          operation: 'reduce',
        }),
      ],
    });
    const scan = await readFuturesFills(db, args);
    expect(
      (calls.futuresExecution[0] as { where: Record<string, unknown> }).where,
    ).toEqual({ AND: [{ executedAt: { gte: window.from, lte: window.to } }] });
    expect(scan.candidates.map((c) => c.copy.body.split(' · ')[1])).toEqual([
      '시장가',
      '지정가',
      '조건 진입',
      '조건 진입',
      '익절',
    ]);
    expect(scan.candidates[0].sourceKey).toBe('futures_execution:market');
    expect(scan.candidates[0].data).toMatchObject({
      market: 'futures',
      futuresView: 'executions',
      accountId: 'g1',
    });
  });

  it('emits one notification per liquidation event', async () => {
    const { db } = fakeDb({
      futuresLiquidation: [
        {
          id: 'liq-1',
          marginMode: 'cross',
          executedAt: new Date('2026-10-17T00:04:00.000Z'),
          tradingAccount: account(),
          closes: [
            {
              direction: 'long',
              instrument: { underlyingAsset: { symbol: 'BTC' } },
            },
            {
              direction: 'short',
              instrument: { underlyingAsset: { symbol: 'ETH' } },
            },
          ],
        },
      ],
    });
    const scan = await readLiquidations(db, args);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].type).toBe('futures_liquidation');
    expect(scan.candidates[0].sourceKey).toBe('futures_liquidation:liq-1');
    expect(scan.candidates[0].data.futuresView).toBe('liquidations');
    expect(scan.candidates[0].copy.body).toContain('교차 포지션 2개');
  });

  it('reads only terminal failures and skips Season-end cleanup', async () => {
    const at = new Date('2026-10-17T00:02:00.000Z');
    const afterEnd = account({ endAt: new Date('2026-10-17T00:01:00.000Z') });
    const { db, calls } = fakeDb({
      limitOnCloseOrder: [
        {
          orderId: 'loc-1',
          status: 'unfilled',
          decisionReason: 'loc_close_not_reached',
          decidedAt: at,
          asset: { name: '삼성전자', symbol: '005930' },
          order: { side: 'buy' },
          tradingAccount: account(),
        },
        {
          orderId: 'loc-2',
          status: 'expired',
          decisionReason: 'loc_fill_not_permitted',
          decidedAt: at,
          asset: { name: '삼성전자', symbol: '005930' },
          order: { side: 'buy' },
          tradingAccount: afterEnd,
        },
      ],
      conditionalBuyOrder: [
        {
          id: 'cb-1',
          endedAt: at,
          asset: { name: 'Apple', symbol: 'AAPL' },
          tradingAccount: account({ mode: 'general' }),
        },
      ],
      futuresTpSlSetting: [
        {
          id: 'tpsl-1',
          kind: 'stop_loss',
          endedAt: at,
          instrument: { underlyingAsset: { symbol: 'BTC' } },
          tradingAccount: account({ mode: 'general' }),
        },
      ],
      entryTpSlPlan: [
        {
          id: 'plan-1',
          domain: 'futures',
          kind: 'take_profit',
          endedAt: at,
          asset: { name: 'Bitcoin', symbol: 'BTC' },
          tradingAccount: account({ mode: 'general' }),
        },
      ],
    });
    const pages = await Promise.all(
      [
        readLocFailures,
        readConditionalBuyFailures,
        readConditionalSellFailures,
        readFuturesConditionalEntryFailures,
        readFuturesTpSlFailures,
        readEntryPlanFailures,
      ].map((read) => read(db, args)),
    );
    const candidates = pages.flatMap((page) => page.candidates);
    const statusOf = (name: string) =>
      (calls[name][0] as { where: { status: unknown } }).where.status;
    expect(statusOf('limitOnCloseOrder')).toEqual({
      in: ['unfilled', 'expired'],
    });
    for (const name of [
      'conditionalBuyOrder',
      'conditionalSellOrder',
      'futuresConditionalEntry',
      'futuresTpSlSetting',
      'entryTpSlPlan',
    ])
      expect(statusOf(name)).toBe('failed');
    expect(candidates.map((c) => c.sourceKey)).toEqual([
      'loc:loc-1',
      'conditional_buy:cb-1',
      'futures_tp_sl:tpsl-1',
      'entry_tp_sl_plan:plan-1',
    ]);
    expect(candidates.every((c) => c.type === 'order_failure')).toBe(true);
    expect(candidates[2].data.market).toBe('futures');
    expect(candidates[3].copy.title).toBe('BTC 익절가 설정 실패');
    // The skipped cleanup row still advances the scan.
    expect(pages[0].last).toEqual({ at, id: 'loc-2' });
  });

  it('continues strictly after the last row in (time, id) order', () => {
    const at = new Date('2026-10-17T00:03:00.000Z');
    expect(
      keysetWhere('executedAt', 'id', { ...args, after: { at, id: 'o-9' } }),
    ).toEqual([
      { executedAt: { gte: window.from, lte: window.to } },
      {
        OR: [{ executedAt: { gt: at } }, { executedAt: at, id: { gt: 'o-9' } }],
      },
    ]);
  });

  it('treats only events at or after a Season end as cleanup', () => {
    const end = new Date('2026-10-17T00:00:00.000Z');
    expect(isSeasonEndCleanup(account({ endAt: end }), end)).toBe(true);
    expect(
      isSeasonEndCleanup(account({ endAt: end }), new Date(end.getTime() - 1)),
    ).toBe(false);
    expect(isSeasonEndCleanup(account({ mode: 'general' }), end)).toBe(false);
  });

  it('notifies only the recipient of a new pending request', async () => {
    const createdAt = new Date('2026-10-17T00:01:00.000Z');
    const user = (id: string, status = 'active') => ({
      id,
      nickname: `nick-${id}`,
      status,
    });
    const { db, calls } = fakeDb({
      friendship: [
        {
          id: 'f1',
          requesterUserId: 'u-high',
          createdAt,
          lowUser: user('u-low'),
          highUser: user('u-high'),
        },
        {
          id: 'f2',
          requesterUserId: 'u-x',
          createdAt,
          lowUser: user('u-x'),
          highUser: user('u-suspended', 'suspended'),
        },
      ],
    });
    const scan = await readFriendRequests(db, args);
    expect(
      (calls.friendship[0] as { where: { status: string } }).where.status,
    ).toBe('pending');
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].userId).toBe('u-low');
    expect(scan.candidates[0].sourceKey).toBe('friend:u-high:f1');
    expect(scan.candidates[0].copy.body).toBe(
      'nick-u-high님이 친구 요청을 보냈어요.',
    );
    expect(scan.candidates[0].data).toEqual({
      v: 1,
      type: 'friend_request',
      uid: 'u-low',
    });
  });

  it('holds a re-request of the same pair inside the cooldown', async () => {
    const createdAt = new Date('2026-10-17T00:01:00.000Z');
    const user = (id: string) => ({ id, nickname: id, status: 'active' });
    const { db } = fakeDb({
      friendship: [
        {
          id: 'f-new',
          requesterUserId: 'a',
          createdAt,
          lowUser: user('a'),
          highUser: user('b'),
        },
      ],
      pushNotification: [{ userId: 'b', sourceKey: 'friend:a:f-old' }],
    });
    expect((await readFriendRequests(db, args)).candidates).toEqual([]);
    // The very same request is still offered (the outbox key deduplicates it).
    const again = fakeDb({
      friendship: [
        {
          id: 'f-old',
          requesterUserId: 'a',
          createdAt,
          lowUser: user('a'),
          highUser: user('b'),
        },
      ],
      pushNotification: [{ userId: 'b', sourceKey: 'friend:a:f-old' }],
    });
    expect(
      (await readFriendRequests(again.db, args)).candidates.map(
        (c) => c.sourceKey,
      ),
    ).toEqual(['friend:a:f-old']);
  });

  it('announces final results only for settled Seasons and confirmed rows', async () => {
    const settledAt = new Date('2026-10-17T00:06:00.000Z');
    const { db, calls } = fakeDb({
      season: [{ id: 's1', name: '2026 시즌 3', updatedAt: settledAt }],
      seasonParticipant: [
        {
          userId: 'u1',
          tradingAccountId: 'a1',
          finalRank: 4,
          finalTier: 'diamond',
        },
      ],
    });
    const scan = await readSeasonFinalResults(db, args);
    expect(
      (calls.season[0] as { where: { status: string } }).where.status,
    ).toBe('settled');
    const participantWhere = (
      calls.seasonParticipant[0] as { where: Record<string, unknown> }
    ).where;
    expect(participantWhere).toMatchObject({
      seasonId: 's1',
      finalRank: { not: null },
      finalTier: { not: null },
      participantStatus: { not: 'excluded' },
      rankingHiddenAt: null,
    });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].sourceKey).toBe('season_final:s1');
    expect(scan.candidates[0].copy.body).toContain('최종 4위 · Diamond');
    expect(scan.candidates[0].data).toEqual({
      v: 1,
      type: 'season_final_result',
      uid: 'u1',
      seasonId: 's1',
    });
  });

  it('targets active participants of a running Season ending within 24 h', async () => {
    const now = new Date('2026-10-17T00:00:00.000Z');
    const endAt = new Date('2026-10-17T20:00:00.000Z');
    const { db, calls } = fakeDb({
      season: [{ id: 's1', name: '2026 시즌 3', endAt }],
      seasonParticipant: [{ userId: 'u1', tradingAccountId: 'a1' }],
    });
    const [group] = await scanSeasonEndingSoon(db, now);
    const where = (calls.season[0] as { where: Record<string, unknown> }).where;
    expect(where.status).toBe('active');
    expect(where.endAt).toEqual({
      gt: new Date(now.getTime() + SEASON_ENDING_MIN_LEAD_MS),
      lte: new Date(now.getTime() + 24 * 3_600_000),
    });
    expect(
      (calls.seasonParticipant[0] as { where: Record<string, unknown> }).where,
    ).toEqual({
      seasonId: 's1',
      participantStatus: 'active',
      tradingAccount: { status: 'active' },
    });
    expect(group.candidates[0].expiresAt).toBe(endAt);
    expect(group.candidates[0].sourceKey).toBe(
      seasonEndingSourceKey('s1', endAt),
    );
    expect(parseSeasonEndingSourceKey(group.candidates[0].sourceKey)).toEqual({
      seasonId: 's1',
      endAtMs: endAt.getTime(),
    });
    expect(parseSeasonEndingSourceKey('season_final:s1')).toBe(null);
  });
});
