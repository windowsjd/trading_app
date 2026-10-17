jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../operator/operator-audit.service', () => ({
  OperatorAuditService: class {},
}));

import {
  PAGES_PER_SOURCE,
  PushNotificationScanner,
  scanPlan,
  SEASON_ENDING_SWEEP_MS,
  WINDOWED_SOURCES,
} from './push-notification-scanner.service';
import { pushNotificationsConfig } from './push-notifications.config';
import { SOURCE_PAGE_SIZE } from './push-sources';

const now = new Date('2026-10-17T12:00:00.000Z');
const config = pushNotificationsConfig({});
const MINUTE = 60_000;

describe('scanPlan', () => {
  const drained = (
    scannedTo: Date,
    startedAt = new Date(now.getTime() - 3_600_000),
  ) => ({
    startedAt,
    scannedTo,
    resumeId: null,
  });

  it('re-reads the lookback behind the high-water mark after a drained scan', () => {
    const plan = scanPlan(
      drained(new Date(now.getTime() - 10_000)),
      now,
      2 * MINUTE,
      30 * MINUTE,
    );
    expect(plan.window.from.getTime()).toBe(
      now.getTime() - 10_000 - 2 * MINUTE,
    );
    expect(plan.window.to).toBe(now);
    expect(plan.after).toBe(null);
  });

  it('never reaches before the first scan (no backlog at activation)', () => {
    const startedAt = new Date(now.getTime() - 30_000);
    expect(
      scanPlan(drained(startedAt, startedAt), now, 2 * MINUTE, 30 * MINUTE)
        .window.from,
    ).toEqual(startedAt);
  });

  it('caps catch-up after a long stop at the source horizon', () => {
    const plan = scanPlan(
      drained(
        new Date(now.getTime() - 5 * 3_600_000),
        new Date('2026-01-01T00:00:00.000Z'),
      ),
      now,
      2 * MINUTE,
      30 * MINUTE,
    );
    expect(plan.window.from.getTime()).toBe(now.getTime() - 30 * MINUTE);
  });

  it('resumes exactly after the last row of a capped scan', () => {
    const at = new Date(now.getTime() - 60_000);
    const plan = scanPlan(
      {
        startedAt: new Date(now.getTime() - 3_600_000),
        scannedTo: at,
        resumeId: 'order-9',
      },
      now,
      2 * MINUTE,
      30 * MINUTE,
    );
    expect(plan).toEqual({
      window: { from: at, to: now },
      after: { at, id: 'order-9' },
    });
  });

  it('drops a resume point older than the horizon', () => {
    const plan = scanPlan(
      {
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        scannedTo: new Date(now.getTime() - 3_600_000),
        resumeId: 'old',
      },
      now,
      2 * MINUTE,
      30 * MINUTE,
    );
    expect(plan.after).toBe(null);
    expect(plan.window.from.getTime()).toBe(now.getTime() - 30 * MINUTE);
  });
});

function scannerHarness(
  options: {
    cursors?: Record<
      string,
      { startedAt: Date; scannedTo: Date; resumeId?: string | null }
    >;
    notices?: Array<Record<string, unknown>>;
    users?: Array<{ id: string }>;
    seasons?: Array<Record<string, unknown>>;
    participants?: Array<Record<string, unknown>>;
  } = {},
) {
  const created: Array<Record<string, unknown>> = [];
  const cursorWrites: unknown[] = [];
  const noticeUpdates: Array<Record<string, unknown>> = [];
  const empty = () => ({
    findMany: jest.fn(async (): Promise<unknown[]> => []),
  });
  const prisma = {
    pushScanCursor: {
      findUnique: jest.fn(
        async (args: { where: { source: string } }) =>
          options.cursors?.[args.where.source] ?? null,
      ),
      createMany: jest.fn(async (args: unknown) => {
        cursorWrites.push(args);
        return { count: 1 };
      }),
      update: jest.fn(async (args: unknown) => {
        cursorWrites.push(args);
        return {};
      }),
      upsert: jest.fn(async (args: unknown) => {
        cursorWrites.push(args);
        return {};
      }),
    },
    pushNotification: {
      createMany: jest.fn(
        async (args: {
          data: Array<Record<string, unknown>>;
          skipDuplicates: boolean;
        }) => {
          expect(args.skipDuplicates).toBe(true);
          created.push(...args.data);
          return { count: args.data.length };
        },
      ),
      findMany: jest.fn(async () => []),
    },
    importantNotice: {
      findMany: jest.fn(async () => options.notices ?? []),
      updateMany: jest.fn(async (args: Record<string, unknown>) => {
        noticeUpdates.push(args);
        return { count: 1 };
      }),
    },
    user: { findMany: jest.fn(async () => options.users ?? []) },
    season: { findMany: jest.fn(async () => options.seasons ?? []) },
    seasonParticipant: {
      findMany: jest.fn(async () => options.participants ?? []),
    },
    order: empty(),
    futuresExecution: empty(),
    futuresLiquidation: empty(),
    limitOnCloseOrder: empty(),
    conditionalBuyOrder: empty(),
    conditionalSellOrder: empty(),
    futuresConditionalEntry: empty(),
    futuresTpSlSetting: empty(),
    entryTpSlPlan: empty(),
    friendship: empty(),
  };
  return {
    scanner: new PushNotificationScanner(prisma as never),
    prisma,
    created,
    cursorWrites,
    noticeUpdates,
  };
}

describe('PushNotificationScanner', () => {
  it('starts every windowed source at its first scan without reading', async () => {
    const h = scannerHarness();
    const summary = await h.scanner.scan(now, config);
    expect(summary.failedSources).toEqual([]);
    expect(h.prisma.order.findMany).not.toHaveBeenCalled();
    expect(h.cursorWrites).toHaveLength(WINDOWED_SOURCES.length);
    expect(h.cursorWrites[0]).toEqual({
      data: [{ source: 'spot_fills', startedAt: now, scannedTo: now }],
      skipDuplicates: true,
    });
  });

  it('drains more than a page of events inside the lookback in one tick', async () => {
    const cursor = {
      startedAt: new Date(now.getTime() - 3_600_000),
      scannedTo: new Date(now.getTime() - 10_000),
    };
    const h = scannerHarness({
      cursors: Object.fromEntries(
        WINDOWED_SOURCES.map(({ source }) => [source, cursor]),
      ),
    });
    const at = new Date(now.getTime() - 5_000);
    const row = (id: string) => ({
      id,
      side: 'buy',
      orderType: 'market',
      quantity: { toFixed: () => '1' },
      executedQuantity: null,
      canceledQuantity: null,
      executedAt: at,
      asset: { name: 'A', symbol: 'A' },
      tradingAccount: {
        id: 'acct',
        userId: 'u1',
        mode: 'general',
        seasonParticipant: null,
      },
      limitOnClose: null,
      conditionalBuy: null,
      conditionalSell: null,
      protectionChild: null,
    });
    // 600 fills at the same instant: one full page, then the rest.
    const calls: unknown[] = [];
    h.prisma.order.findMany = jest.fn(async (query: unknown) => {
      calls.push(query);
      return calls.length === 1
        ? Array.from({ length: SOURCE_PAGE_SIZE }, (_, i) =>
            row(`o${String(i).padStart(3, '0')}`),
          )
        : Array.from({ length: 100 }, (_, i) =>
            row(`p${String(i).padStart(3, '0')}`),
          );
    });
    await h.scanner.scan(now, config);
    expect(
      h.created.filter((item) => String(item.sourceKey).startsWith('order:')),
    ).toHaveLength(600);
    // The second page continues after the last row of the first.
    expect(JSON.stringify(calls[1])).toContain('o499');
    expect(h.cursorWrites).toContainEqual({
      where: { source: 'spot_fills' },
      data: { scannedTo: now, resumeId: null },
    });
  });

  it('stores a resume point when a tick reaches its page budget', async () => {
    const cursor = {
      startedAt: new Date(now.getTime() - 3_600_000),
      scannedTo: new Date(now.getTime() - 10_000),
    };
    const h = scannerHarness({
      cursors: Object.fromEntries(
        WINDOWED_SOURCES.map(({ source }) => [source, cursor]),
      ),
    });
    const at = new Date(now.getTime() - 5_000);
    let page = 0;
    h.prisma.order.findMany = jest.fn(async () => {
      page++;
      return Array.from({ length: SOURCE_PAGE_SIZE }, (_, i) => ({
        id: `x${page}-${String(i).padStart(3, '0')}`,
        side: 'buy',
        orderType: 'market',
        quantity: { toFixed: () => '1' },
        executedQuantity: null,
        canceledQuantity: null,
        executedAt: at,
        asset: { name: 'A', symbol: 'A' },
        tradingAccount: {
          id: 'acct',
          userId: 'u1',
          mode: 'general',
          seasonParticipant: null,
        },
        limitOnClose: null,
        conditionalBuy: null,
        conditionalSell: null,
        protectionChild: null,
      }));
    });
    await h.scanner.scan(now, config);
    expect(page).toBe(PAGES_PER_SOURCE);
    expect(h.cursorWrites).toContainEqual({
      where: { source: 'spot_fills' },
      data: {
        scannedTo: at,
        resumeId: `x${PAGES_PER_SOURCE}-${SOURCE_PAGE_SIZE - 1}`,
      },
    });
  });

  it('resumes after the newest commit-safe row, re-reading younger ones', async () => {
    const cursor = {
      startedAt: new Date(now.getTime() - 3_600_000),
      scannedTo: new Date(now.getTime() - 10 * 60_000),
    };
    const h = scannerHarness({
      cursors: Object.fromEntries(
        WINDOWED_SOURCES.map(({ source }) => [source, cursor]),
      ),
    });
    const old = new Date(now.getTime() - 5 * 60_000);
    const young = new Date(now.getTime() - 5_000);
    let pageNo = 0;
    h.prisma.order.findMany = jest.fn(async () => {
      pageNo++;
      // Each page: older rows first, the newest ones only seconds old.
      return Array.from({ length: SOURCE_PAGE_SIZE }, (_, i) => ({
        id: `y${pageNo}-${String(i).padStart(3, '0')}`,
        side: 'buy',
        orderType: 'market',
        quantity: { toFixed: () => '1' },
        executedQuantity: null,
        canceledQuantity: null,
        executedAt: i < 400 ? old : young,
        asset: { name: 'A', symbol: 'A' },
        tradingAccount: {
          id: 'acct',
          userId: 'u1',
          mode: 'general',
          seasonParticipant: null,
        },
        limitOnClose: null,
        conditionalBuy: null,
        conditionalSell: null,
        protectionChild: null,
      }));
    });
    await h.scanner.scan(now, config);
    expect(h.cursorWrites).toContainEqual({
      where: { source: 'spot_fills' },
      data: { scannedTo: old, resumeId: `y${PAGES_PER_SOURCE}-399` },
    });
  });

  it('advances a cursor after reading its window', async () => {
    const cursor = {
      startedAt: new Date(now.getTime() - 3_600_000),
      scannedTo: new Date(now.getTime() - 10_000),
    };
    const h = scannerHarness({
      cursors: Object.fromEntries(
        WINDOWED_SOURCES.map(({ source }) => [source, cursor]),
      ),
    });
    await h.scanner.scan(now, config);
    expect(h.prisma.order.findMany).toHaveBeenCalledTimes(1);
    expect(h.cursorWrites).toContainEqual({
      where: { source: 'spot_fills' },
      data: { scannedTo: now, resumeId: null },
    });
  });

  it('sweeps an ending Season at most every ten minutes', async () => {
    const endAt = new Date(now.getTime() + 3_600_000);
    const seasons = [{ id: 's1', name: '시즌', endAt }];
    const participants = [{ userId: 'u1', tradingAccountId: 'a1' }];
    const fresh = scannerHarness({
      seasons,
      participants,
      cursors: {
        'season_ending:s1': {
          startedAt: now,
          scannedTo: new Date(now.getTime() - 60_000),
        },
      },
    });
    await fresh.scanner.scan(now, config);
    expect(fresh.created).toHaveLength(0);
    const due = scannerHarness({
      seasons,
      participants,
      cursors: {
        'season_ending:s1': {
          startedAt: now,
          scannedTo: new Date(now.getTime() - SEASON_ENDING_SWEEP_MS),
        },
      },
    });
    await due.scanner.scan(now, config);
    expect(due.created).toHaveLength(1);
    expect(due.created[0]).toMatchObject({
      userId: 'u1',
      type: 'season_ending_soon',
      expiresAt: endAt,
    });
  });

  it('fans a published notice out page by page and finishes', async () => {
    const publishedAt = new Date(now.getTime() - 60_000);
    const h = scannerHarness({
      notices: [
        {
          id: 'notice-1',
          title: '점검',
          summary: '요약',
          publishedAt,
          fanoutCursor: null,
        },
      ],
      users: [{ id: 'u1' }, { id: 'u2' }],
    });
    await h.scanner.scan(now, config);
    expect(h.created.map((row) => row.userId)).toEqual(['u1', 'u2']);
    expect(h.created[0]).toMatchObject({
      type: 'important_notice',
      sourceKey: 'notice:notice-1',
      title: '[공지] 점검',
      body: '요약',
      eventAt: publishedAt,
      data: { v: 1, type: 'important_notice', uid: 'u1', noticeId: 'notice-1' },
    });
    expect(h.noticeUpdates).toEqual([
      {
        where: { id: 'notice-1', status: 'published' },
        data: { fanoutCursor: 'u2', fanoutCompletedAt: now },
      },
    ]);
    const where = (
      h.prisma.user.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where).toMatchObject({
      status: 'active',
      pushDevices: { some: {} },
    });
  });

  it('closes a stale notice without sending', async () => {
    const h = scannerHarness({
      notices: [
        {
          id: 'old',
          title: 't',
          summary: 's',
          publishedAt: new Date(now.getTime() - 25 * 3_600_000),
          fanoutCursor: null,
        },
      ],
      users: [{ id: 'u1' }],
    });
    await h.scanner.scan(now, config);
    expect(h.created).toHaveLength(0);
    expect(h.noticeUpdates[0]).toMatchObject({
      data: { fanoutCompletedAt: now },
    });
  });

  it('reports a failing source without stopping the others', async () => {
    const cursor = {
      startedAt: new Date(now.getTime() - 3_600_000),
      scannedTo: now,
    };
    const h = scannerHarness({
      cursors: Object.fromEntries(
        WINDOWED_SOURCES.map(({ source }) => [source, cursor]),
      ),
    });
    h.prisma.order.findMany = jest.fn(async () => {
      throw new Error('database unavailable');
    });
    const summary = await h.scanner.scan(now, config);
    expect(summary.failedSources).toEqual(['spot_fills']);
    expect(h.prisma.futuresExecution.findMany).toHaveBeenCalled();
  });
});
