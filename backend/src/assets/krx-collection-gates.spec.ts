jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal },
    AssetType: { domestic_stock: 'domestic_stock' },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  };
});

import { Prisma } from '../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveMarketSession,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import type { PrismaService } from '../prisma/prisma.service';
import { resolveKisDailyPeriodWindows } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { kstDate } from './krx-candle-collection.policy';
import {
  readKrxCentralCandlesConfig,
  type KrxCollectionCohort,
} from './krx-central-candles.config';
import { KrxCollectionGateDiagnostics } from './krx-collection-gates';
import { planKrxTenMinuteBuckets } from './market-candle-krx-history';
import type {
  CandleCoverageEvidence,
  MarketCandleSyncStateRepository,
} from './market-candle-sync-state.repository';

const ASSET = { id: 'asset-1', symbol: '005930' };
const DAY_MS = 24 * 60 * 60_000;
// 18:00 KST: today's session is closed, so its daily bar is expected too.
const NOW_1D = new Date('2026-10-15T09:00:00.000Z');
// The 96-session 4h window then holds the CSAT day (2025-11-13, 10:00–16:30),
// the 2025-12-31 closure and the 2026-01-02 delayed open (10:00).
const NOW_4H = new Date('2026-01-20T09:00:00.000Z');

type Row = {
  openTime: Date;
  closeTime: Date;
  isClosed: boolean;
  sourceProvider: string;
  sourceUpdatedAt: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal | null;
};

function bar(openTime: Date, closeTime: Date, over: Partial<Row> = {}): Row {
  return {
    openTime,
    closeTime,
    isClosed: true,
    sourceProvider: 'koscom_history',
    sourceUpdatedAt: closeTime,
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(110),
    low: new Prisma.Decimal(90),
    close: new Prisma.Decimal(105),
    volume: new Prisma.Decimal(1000),
    amount: new Prisma.Decimal(100_000),
    ...over,
  };
}

const kstMidnight = (date: string) => new Date(`${date}T00:00:00+09:00`);

/** The closed daily windows of the 576-session window (calendar truth). */
function dailyWindows(now: Date) {
  const first = findPreviousMarketSession(
    { assetType: 'domestic_stock', market: 'KRX' },
    now,
    576,
  )!;
  return resolveKisDailyPeriodWindows('KRX', kstMidnight(first.localDate), now)!
    .filter((window) => window.closedAt <= now)
    .map((window) => ({ ...window, date: kstDate(window.openTime.getTime()) }));
}

/** Confirmed bars: closed, received 20 minutes after the session close. */
function dailyBars(now: Date): Row[] {
  return dailyWindows(now).map((window) =>
    bar(window.openTime, window.closeTime, {
      sourceUpdatedAt: new Date(window.closedAt.getTime() + 20 * 60_000),
    }),
  );
}

/** The 96 sessions before `now`'s KST date, oldest first. */
function fourHourSessions(now: Date): MarketSessionWindow[] {
  const sessions: MarketSessionWindow[] = [];
  for (let back = 1; sessions.length < 96; back += 1) {
    const date = kstDate(now.getTime() - back * DAY_MS).replaceAll('-', '');
    const session = resolveMarketSession('KRX', date);
    if (session) sessions.push(session);
  }
  return sessions.reverse();
}

function plannedRows(
  session: MarketSessionWindow,
  over: Partial<Row> = {},
): Row[] {
  return planKrxTenMinuteBuckets(session).map((bucket) =>
    bar(bucket.openTime, bucket.closeTime, {
      sourceProvider: 'koscom_history_10m',
      ...over,
    }),
  );
}

function harness(input: {
  now: Date;
  daily?: Row[];
  fourHour?: Row[];
  holds?: { asset_id: string; session_date: string; reason: string }[];
  coverage?: Partial<CandleCoverageEvidence>;
  cohorts?: KrxCollectionCohort[];
}) {
  const stored = { '1d': input.daily ?? [], '4h': input.fourHour ?? [] };
  const prisma = {
    asset: { findMany: jest.fn().mockResolvedValue([ASSET]) },
    marketCandle: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: {
            interval: '1d' | '4h';
            openTime: { gte: Date; lt: Date };
          };
        }) =>
          Promise.resolve(
            stored[where.interval]
              .filter(
                (row) =>
                  row.openTime >= where.openTime.gte &&
                  row.openTime < where.openTime.lt,
              )
              .sort((a, b) => a.openTime.getTime() - b.openTime.getTime()),
          ),
      ),
    },
    marketCandleSyncState: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue(input.holds ?? []),
  };
  const states = {
    findCandleCoverage: jest.fn().mockResolvedValue({
      startsAtRequestedFrom: true,
      contiguousCoveredTo: input.now,
      newestCompletedAt: input.now,
      hasInteriorGap: false,
      ...input.coverage,
    }),
    findCheckpointsOverlapping: jest.fn().mockResolvedValue([]),
  };
  const gates = new KrxCollectionGateDiagnostics(
    prisma as unknown as PrismaService,
    states as unknown as MarketCandleSyncStateRepository,
    readKrxCentralCandlesConfig(
      { KOSCOM_CENTRAL_CANDLES_ENABLED: 'false' },
      input.cohorts ?? [],
    ),
  );
  return { gates, prisma };
}

async function g4h(input: Parameters<typeof harness>[0]) {
  const [asset] = await harness(input).gates.g4h({ now: input.now });
  return asset;
}

describe('G4-H 1d readiness (576 sessions, §5.4)', () => {
  const windows = dailyWindows(NOW_1D);
  const dates = windows.map((window) => window.date);

  it('follows the calendar: 576 previous sessions plus today after the close, holidays excluded', () => {
    expect(windows.length).toBe(577);
    expect(dates.at(-1)).toBe('2026-10-15');
    for (const holiday of ['2024-12-31', '2025-10-06', '2025-12-31'])
      expect(dates.includes(holiday)).toBe(false);
    // A delayed open keeps the regular 15:30 close.
    const delayed = windows.find((window) => window.date === '2025-01-02')!;
    expect(delayed.closedAt.toISOString()).toBe('2025-01-02T06:30:00.000Z');
  });

  it('is ready with complete coverage and one confirmed bar per closed session', async () => {
    const asset = await g4h({ now: NOW_1D, daily: dailyBars(NOW_1D) });
    expect(asset.daily).toEqual({
      state: 'ready',
      windowFrom: kstMidnight(dates[0]).toISOString(),
      calendarAvailable: true,
      // KRX 2024 was audited against KRX's own notices (Q14, 2026-10-15).
      provisionalCalendarYears: [],
      coverageComplete: true,
      sessionsExpected: 577,
      confirmed: 577,
      missing: { count: 0, dates: [] },
      unconfirmed: { count: 0, sessions: [] },
      unexpected: { count: 0, dates: [] },
    });
  });

  it('names a provisional calendar year the window rests on (KRX 2027 until audited)', async () => {
    // 18:00 KST 2027-03-02: the 576-session window spans 2024-11 … 2027-03.
    const now = new Date('2027-03-02T09:00:00.000Z');
    const asset = await g4h({ now, daily: dailyBars(now) });
    expect(asset.daily.state).toBe('ready');
    expect(asset.daily.provisionalCalendarYears).toEqual([2027]);
  });

  it('a complete checkpoint without its bars is not ready (oldest, middle and newest)', async () => {
    const gone = new Set([dates[0], '2025-06-02', dates.at(-1)!]);
    const asset = await g4h({
      now: NOW_1D,
      daily: dailyBars(NOW_1D).filter(
        (row) => !gone.has(kstDate(row.openTime.getTime())),
      ),
    });
    expect(asset.daily.coverageComplete).toBe(true);
    expect(asset.daily.state).toBe('incomplete');
    expect(asset.daily.confirmed).toBe(574);
    expect(asset.daily.missing).toEqual({
      count: 3,
      dates: [dates[0], '2025-06-02', '2026-10-15'],
    });
  });

  it('bars alone are not ready either: the checkpoint union must cover the window', async () => {
    const asset = await g4h({
      now: NOW_1D,
      daily: dailyBars(NOW_1D),
      coverage: { hasInteriorGap: true },
    });
    expect(asset.daily.confirmed).toBe(577);
    expect(asset.daily.coverageComplete).toBe(false);
    expect(asset.daily.state).toBe('incomplete');
  });

  it('reports unclosed, early, misdated-close, foreign-source and malformed bars as unconfirmed', async () => {
    const mutate: Record<string, (row: Row) => Row> = {
      '2024-08-01': (row) => ({ ...row, isClosed: false }),
      '2024-12-30': (row) => ({
        ...row,
        sourceUpdatedAt: new Date(Date.parse('2024-12-30T06:29:00.000Z')),
      }),
      '2025-01-02': (row) => ({
        ...row,
        closeTime: new Date(row.closeTime.getTime() + 60 * 60_000),
      }),
      '2026-01-02': (row) => ({
        ...row,
        sourceProvider: 'kis_domestic_minute',
      }),
      '2026-03-03': (row) => ({ ...row, low: new Prisma.Decimal(120) }),
    };
    const asset = await g4h({
      now: NOW_1D,
      daily: dailyBars(NOW_1D).map((row) => {
        const change = mutate[kstDate(row.openTime.getTime())];
        return change ? change(row) : row;
      }),
    });
    expect(asset.daily.state).toBe('incomplete');
    expect(asset.daily.missing.count).toBe(0);
    expect(asset.daily.unconfirmed).toEqual({
      count: 5,
      sessions: [
        { date: '2024-08-01', defects: ['not_closed'] },
        { date: '2024-12-30', defects: ['updated_before_close'] },
        { date: '2025-01-02', defects: ['close_time'] },
        { date: '2026-01-02', defects: ['source'] },
        { date: '2026-03-03', defects: ['ohlcv'] },
      ],
    });
  });

  it('accepts a closed KIS period bar (closed KIS rows are never overwritten by KOSCOM)', async () => {
    const asset = await g4h({
      now: NOW_1D,
      daily: dailyBars(NOW_1D).map((row, index) =>
        index % 7 === 0
          ? { ...row, sourceProvider: 'kis_domestic_period' }
          : row,
      ),
    });
    expect(asset.daily.state).toBe('ready');
    expect(asset.daily.confirmed).toBe(577);
  });

  it('a bar dated on a holiday or an off-grid second bar on a session date is unexpected', async () => {
    const asset = await g4h({
      now: NOW_1D,
      daily: [
        ...dailyBars(NOW_1D),
        bar(kstMidnight('2025-12-31'), kstMidnight('2026-01-01')),
        bar(
          new Date('2026-03-10T00:00:00.000Z'),
          new Date('2026-03-11T00:00:00.000Z'),
        ),
      ],
    });
    expect(asset.daily.confirmed).toBe(577);
    expect(asset.daily.state).toBe('incomplete');
    expect(asset.daily.unexpected).toEqual({
      count: 2,
      dates: ['2025-12-30T15:00:00.000Z', '2026-03-10T00:00:00.000Z'],
    });
  });

  it('fails closed without calendar data for the whole window', async () => {
    const asset = await g4h({ now: new Date('2028-03-02T09:00:00.000Z') });
    expect(asset.daily.calendarAvailable).toBe(false);
    expect(asset.daily.state).toBe('incomplete');
  });
});

describe('G4-H 4h readiness (96 sessions, the long sync rule)', () => {
  const sessions = fourHourSessions(NOW_4H);
  const byDate = new Map(sessions.map((s) => [s.localDate, s]));
  const allRows = () => sessions.flatMap((session) => plannedRows(session));
  const without = (date: string) =>
    allRows().filter((row) => kstDate(row.openTime.getTime()) !== date);

  it('plans buckets from the calendar session: regular, CSAT and delayed-open days', () => {
    const plan = (date: string) =>
      planKrxTenMinuteBuckets(byDate.get(date)!).map(
        (bucket) =>
          `${bucket.openTime.toISOString().slice(11, 16)}-${bucket.closeTime.toISOString().slice(11, 16)}`,
      );
    expect(plan('2025-11-12')).toEqual(['00:00-04:00', '04:00-06:30']);
    expect(plan('2025-11-13')).toEqual(['01:00-05:00', '05:00-07:30']);
    expect(plan('2026-01-02')).toEqual(['01:00-05:00', '05:00-06:30']);
    expect(byDate.has('2025-12-31')).toBe(false);
  });

  it('is ready when every session is exactly its plan', async () => {
    const asset = await g4h({ now: NOW_4H, fourHour: allRows() });
    expect(asset.fourHour).toEqual({
      state: 'ready',
      calendarAvailable: true,
      provisionalCalendarYears: [],
      sessionsExpected: 96,
      complete: 96,
      held: [],
      partial: { count: 0, sessions: [] },
      missing: { count: 0, dates: [] },
      unexpected: { count: 0, dates: [] },
    });
  });

  it('a regular-hours plan stored for the CSAT day is partial', async () => {
    const regular = byDate.get('2025-11-12')!;
    const shifted = plannedRows(regular).map((row) => ({
      ...row,
      openTime: new Date(row.openTime.getTime() + DAY_MS),
      closeTime: new Date(row.closeTime.getTime() + DAY_MS),
    }));
    const asset = await g4h({
      now: NOW_4H,
      fourHour: [...without('2025-11-13'), ...shifted],
    });
    expect(asset.fourHour.state).toBe('incomplete');
    expect(asset.fourHour.complete).toBe(95);
    expect(asset.fourHour.partial).toEqual({
      count: 1,
      sessions: [
        { date: '2025-11-13', defects: ['missing_bucket', 'off_plan'] },
      ],
    });
  });

  it('names the one missing session among 96', async () => {
    const asset = await g4h({ now: NOW_4H, fourHour: without('2025-12-15') });
    expect(asset.fourHour.state).toBe('incomplete');
    expect(asset.fourHour.complete).toBe(95);
    expect(asset.fourHour.missing).toEqual({
      count: 1,
      dates: ['2025-12-15'],
    });
  });

  it('a missing bucket, an unclosed row, a foreign source and a duplicate are partial', async () => {
    const [a, b, c, d] = [
      sessions[10],
      sessions[11],
      sessions[12],
      sessions[13],
    ];
    const touched = new Set([a, b, c, d].map((s) => s.localDate));
    const [aFirst] = plannedRows(a);
    const [bFirst, bSecond] = plannedRows(b);
    const [cFirst, cSecond] = plannedRows(c);
    const dRows = plannedRows(d);
    const asset = await g4h({
      now: NOW_4H,
      fourHour: [
        ...allRows().filter(
          (row) => !touched.has(kstDate(row.openTime.getTime())),
        ),
        aFirst,
        bFirst,
        { ...bSecond, isClosed: false },
        { ...cFirst, sourceProvider: 'kis_domestic_minute' },
        cSecond,
        ...dRows,
        {
          ...dRows[0],
          openTime: new Date(dRows[0].openTime.getTime() + 10 * 60_000),
        },
      ],
    });
    expect(asset.fourHour.state).toBe('incomplete');
    expect(asset.fourHour.complete).toBe(92);
    expect(asset.fourHour.partial).toEqual({
      count: 4,
      sessions: [
        { date: a.localDate, defects: ['missing_bucket'] },
        { date: b.localDate, defects: ['missing_bucket', 'not_closed'] },
        { date: c.localDate, defects: ['missing_bucket', 'source'] },
        { date: d.localDate, defects: ['off_plan'] },
      ],
    });
  });

  it('a recorded held session (nothing stored) is held, never ready', async () => {
    const date = sessions[20].localDate;
    const { gates, prisma } = harness({
      now: NOW_4H,
      fourHour: without(date),
      holds: [
        {
          asset_id: ASSET.id,
          session_date: date.replaceAll('-', ''),
          reason: 'DAILY_OHLC_MISMATCH',
        },
      ],
    });
    const [asset] = await gates.g4h({ now: NOW_4H });
    expect(asset.fourHour.state).toBe('held');
    expect(asset.fourHour.complete).toBe(95);
    expect(asset.fourHour.held).toEqual([
      { date, reason: 'DAILY_OHLC_MISMATCH' },
    ]);
    // Held records are read from runs since the window's oldest session.
    const call = prisma.$queryRaw.mock.calls[0] as unknown[];
    expect((call[1] as Date).toISOString()).toBe(
      sessions[0].openTime.toISOString(),
    );
    expect(call[2]).toEqual([ASSET.id]);
  });

  it('a held session with stored rows stays partial', async () => {
    const date = sessions[21].localDate;
    const [first] = plannedRows(sessions[21]);
    const asset = await g4h({
      now: NOW_4H,
      fourHour: [...without(date), first],
      holds: [
        {
          asset_id: ASSET.id,
          session_date: date.replaceAll('-', ''),
          reason: 'MISSING_REQUIRED_ROWS',
        },
      ],
    });
    expect(asset.fourHour.state).toBe('incomplete');
    expect(asset.fourHour.held).toEqual([]);
    expect(asset.fourHour.partial.count).toBe(1);
  });

  it('a row dated on a holiday is unexpected', async () => {
    const asset = await g4h({
      now: NOW_4H,
      fourHour: [
        ...allRows(),
        bar(
          new Date('2025-12-31T00:00:00.000Z'),
          new Date('2025-12-31T04:00:00.000Z'),
          { sourceProvider: 'koscom_history_10m' },
        ),
      ],
    });
    expect(asset.fourHour.complete).toBe(96);
    expect(asset.fourHour.state).toBe('incomplete');
    expect(asset.fourHour.unexpected).toEqual({
      count: 1,
      dates: ['2025-12-31'],
    });
  });

  it('fails closed at a date without calendar data', async () => {
    const asset = await g4h({ now: new Date('2028-01-10T09:00:00.000Z') });
    expect(asset.fourHour.calendarAvailable).toBe(false);
    expect(asset.fourHour.state).toBe('incomplete');
  });
});

describe('G4-I evidence', () => {
  it('measures nothing with an empty cohort registry (the other flags pass vacuously)', async () => {
    const report = await harness({ now: NOW_1D }).gates.g4i({ now: NOW_1D });
    expect(report.pass.measured).toBe(false);
    expect(report.pass.concealmentZero).toBe(true);
    expect(report.totals.obligated).toBe(0);
  });

  it('measures once a recorded obligation start has obligated slots', async () => {
    const report = await harness({
      now: NOW_1D,
      cohorts: [
        {
          id: 'cohort-1',
          obligationStart: '2026-10-11T15:00:00.000Z', // 2026-10-12 00:00 KST
          symbols: [ASSET.symbol],
        },
      ],
    }).gates.g4i({ now: NOW_1D });
    expect(report.pass.measured).toBe(true);
    expect(report.totals.obligated > 0).toBe(true);
  });
});

describe('asset selection', () => {
  type AssetWhere = { isActive?: boolean; id?: { in: string[] } };
  const selected = (prisma: ReturnType<typeof harness>['prisma']) =>
    (prisma.asset.findMany.mock.calls[0] as [{ where: AssetWhere }])[0].where;

  it('lets G4-H judge explicitly listed assets before their activation', async () => {
    const { gates, prisma } = harness({ now: NOW_1D });
    await gates.g4h({ now: NOW_1D, assetIds: [ASSET.id] });
    const where = selected(prisma);
    expect('isActive' in where).toBe(false);
    expect(where.id?.in.join(',')).toBe(ASSET.id);
  });

  it('keeps G4-H on active assets without an explicit list', async () => {
    const { gates, prisma } = harness({ now: NOW_1D });
    await gates.g4h({ now: NOW_1D });
    expect(selected(prisma).isActive).toBe(true);
  });

  it('keeps G4-I on active assets even for an explicit list (only they carry an obligation)', async () => {
    const { gates, prisma } = harness({ now: NOW_1D });
    await gates.g4i({ now: NOW_1D, assetIds: [ASSET.id] });
    const where = selected(prisma);
    expect(where.isActive).toBe(true);
    expect(where.id?.in.join(',')).toBe(ASSET.id);
  });
});
