jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
  };
});

import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { resolveMarketSession } from '../orders/market-calendar.policy';
import { KoscomError } from '../providers/koscom/koscom.config';
import {
  FOUR_HOURS_MS,
  MarketCandleLongSyncService,
  cryptoWindow,
  enumerateCompletedKrxSessions,
  planCryptoFetch,
} from './market-candle-long-sync.service';
import type { KrxTenMinuteRow } from './market-candle-krx-history';

const DAY = 86_400_000;
const TEN_MIN = 600_000;

type Row = {
  assetId?: string;
  futuresInstrumentId?: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
  amount: Prisma.Decimal | string | null;
  isClosed: boolean;
  sourceProvider?: string;
  contractSymbol?: string;
  sourceUpdatedAt: Date;
};

/** In-memory stand-in for both candle repositories (keyed like the DB). */
function memoryRepository(seriesField: 'assetId' | 'futuresInstrumentId') {
  const rows = new Map<string, Row>();
  const key = (row: Row) =>
    `${row[seriesField]}|${row.interval}|${row.openTime.getTime()}`;
  return {
    rows,
    upsertMany: jest.fn((input: Row[]) => {
      for (const row of input) rows.set(key(row), { ...row });
      return Promise.resolve({ writtenCount: input.length });
    }),
    findRange: jest.fn(
      (params: {
        assetId?: string;
        futuresInstrumentId?: string;
        interval: string;
        from: Date;
        to: Date;
      }) =>
        Promise.resolve(
          [...rows.values()]
            .filter(
              (row) =>
                row[seriesField] === params[seriesField] &&
                row.interval === params.interval &&
                row.openTime >= params.from &&
                row.openTime < params.to,
            )
            .sort((a, b) => a.openTime.getTime() - b.openTime.getTime())
            .map((row) => ({
              ...row,
              open: new Prisma.Decimal(row.open),
              high: new Prisma.Decimal(row.high),
              low: new Prisma.Decimal(row.low),
              close: new Prisma.Decimal(row.close),
              volume: new Prisma.Decimal(row.volume),
              amount:
                row.amount === null ? null : new Prisma.Decimal(row.amount),
            })),
        ),
    ),
  };
}

/** Deterministic END-labelled 10-minute rows of one real KRX session. */
function tenMinuteRows(date: string, seed = 0): KrxTenMinuteRow[] {
  const session = resolveMarketSession('KRX', date);
  if (!session) throw new Error(`no session ${date}`);
  const rows: KrxTenMinuteRow[] = [];
  let index = 0;
  for (
    let label = session.openTime.getTime() + TEN_MIN;
    label <= session.closeTime.getTime();
    label += TEN_MIN
  ) {
    const auction = label === session.closeTime.getTime();
    const open = 50000 + seed * 100 + index;
    rows.push({
      label: new Date(label),
      open: String(open),
      high: String(auction ? open : open + 3),
      low: String(auction ? open : open - 3),
      close: String(auction ? open : open + 1),
      volume: '10',
      amount: String(10 * open),
    });
    index += 1;
  }
  return rows;
}

function dailyRow(date: string, rows: KrxTenMinuteRow[]) {
  return {
    value: {
      stck_bsop_date: date,
      stck_oprc: rows[0].open,
      stck_hgpr: String(Math.max(...rows.map((r) => Number(r.high)))),
      stck_lwpr: String(Math.min(...rows.map((r) => Number(r.low)))),
      stck_clpr: rows[rows.length - 1].close,
      acml_vol: '999999',
      acml_tr_pbmn: '1',
    },
    receivedAt: new Date(),
    sequence: 0,
  };
}

function seedOf(date: string) {
  return Number(date.slice(4)) % 97;
}

function createService(extra: { redis?: object; krxCentral?: object } = {}) {
  const prisma = {
    asset: { findMany: jest.fn() },
    futuresInstrument: { findMany: jest.fn() },
  };
  const repository = memoryRepository('assetId');
  const futuresRepository = memoryRepository('futuresInstrumentId');
  const locks = {
    acquire: jest.fn().mockResolvedValue({ acquired: true, handle: {} }),
    renewIfDue: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
  const cache = {
    invalidateAsset: jest.fn().mockResolvedValue({ status: 'ok' }),
  };
  const spotCandles = { fetchKlinesPage: jest.fn() };
  const usdmCandles = { fetchKlinesPage: jest.fn() };
  const requestedTenMinuteDates: string[] = [];
  const koscom = {
    fetchPeriodPage: jest.fn((input: { fromDate: string; endDate: string }) => {
      const rows: ReturnType<typeof dailyRow>[] = [];
      for (
        let ms = Date.UTC(
          Number(input.fromDate.slice(0, 4)),
          Number(input.fromDate.slice(4, 6)) - 1,
          Number(input.fromDate.slice(6, 8)),
        );
        ;
        ms += DAY
      ) {
        const date = new Date(ms)
          .toISOString()
          .slice(0, 10)
          .replaceAll('-', '');
        if (date > input.endDate) break;
        if (!resolveMarketSession('KRX', date)) continue;
        rows.push(dailyRow(date, tenMinuteRows(date, seedOf(date))));
      }
      return Promise.resolve({
        state: 'ok',
        rows,
        providerReturnedRows: rows.length,
      });
    }),
    fetchDomesticTenMinuteSession: jest.fn((input: { date: string }) => {
      requestedTenMinuteDates.push(input.date);
      return Promise.resolve({
        rows: tenMinuteRows(input.date, seedOf(input.date)),
        invalidRows: 0,
        providerReturnedRows: 39,
        receivedAt: new Date('2026-10-12T07:30:00.000Z'),
      });
    }),
  };
  const koscomClient = {
    getLastObservedRateLimit: jest.fn().mockReturnValue(null),
  };
  const service = new MarketCandleLongSyncService(
    prisma as never,
    repository as never,
    futuresRepository as never,
    locks as never,
    cache as never,
    spotCandles as never,
    usdmCandles as never,
    koscom as never,
    koscomClient as never,
    extra.redis as never,
    extra.krxCentral as never,
  );
  return {
    service,
    prisma,
    repository,
    futuresRepository,
    locks,
    cache,
    spotCandles,
    usdmCandles,
    koscom,
    koscomClient,
    requestedTenMinuteDates,
  };
}

describe('long-range 4h windows', () => {
  it('spans exactly 576 closed UTC 4h buckets for 96 days', () => {
    const window = cryptoWindow(new Date('2026-10-13T10:30:00.000Z'), 96);
    expect(window.closedTo.toISOString()).toBe('2026-10-13T08:00:00.000Z');
    expect(window.currentTo.toISOString()).toBe('2026-10-13T12:00:00.000Z');
    const plan = planCryptoFetch(
      window,
      [],
      new Date('2026-10-13T10:30:00Z'),
      false,
    );
    expect(plan.expected).toBe(576);
    expect(plan.missing).toBe(576);
    expect(plan.fetchFrom?.toISOString()).toBe(window.from.toISOString());
  });

  it('fetches nothing when complete, the first gap otherwise, and re-confirms a bucket fetched right at its close', () => {
    const now = new Date('2026-10-13T10:30:00.000Z');
    const window = cryptoWindow(now, 2);
    const stored: {
      openTime: Date;
      closeTime: Date;
      isClosed: boolean;
      sourceUpdatedAt: Date;
    }[] = [];
    for (
      let t = window.from.getTime();
      t < window.closedTo.getTime();
      t += FOUR_HOURS_MS
    ) {
      stored.push({
        openTime: new Date(t),
        closeTime: new Date(t + FOUR_HOURS_MS),
        isClosed: true,
        sourceUpdatedAt: new Date(t + FOUR_HOURS_MS + 10 * 60_000),
      });
    }
    expect(planCryptoFetch(window, stored, now, false).fetchFrom).toBeNull();
    const gap = stored.filter((_, index) => index !== 3);
    expect(planCryptoFetch(window, gap, now, false).fetchFrom?.getTime()).toBe(
      stored[3].openTime.getTime(),
    );
    const justClosed = stored.map((row, index) =>
      index === stored.length - 1
        ? { ...row, sourceUpdatedAt: new Date(row.closeTime.getTime() + 1000) }
        : row,
    );
    expect(
      planCryptoFetch(window, justClosed, now, false).fetchFrom?.getTime(),
    ).toBe(stored[stored.length - 1].openTime.getTime());
    // Futures also refresh a stale (or missing) current bucket.
    expect(
      planCryptoFetch(window, stored, now, true).fetchFrom?.getTime(),
    ).toBe(window.closedTo.getTime());
  });

  it('enumerates completed KRX sessions from the calendar, never a holiday', () => {
    const at1620 = new Date('2026-10-13T07:20:00.000Z');
    const { sessions } = enumerateCompletedKrxSessions(at1620, 97);
    expect(sessions.length).toBe(97);
    expect(sessions[0].localDate).toBe('2026-05-20');
    expect(sessions.at(-1)?.localDate).toBe('2026-10-13');
    expect(sessions.some((s) => s.localDate === '2026-10-09')).toBe(false);
    // Before today's close (+ grace) today is not a completed session.
    const midday = enumerateCompletedKrxSessions(
      new Date('2026-10-13T03:00:00.000Z'),
      1,
    );
    expect(midday.sessions[0].localDate).toBe('2026-10-12');
  });
});

describe('MarketCandleLongSyncService — KRX (KOSCOM 10-minute history)', () => {
  const asset = { id: 'krx-1', symbol: '005930', market: 'KRX' };
  // 2026-10-12 16:20 KST: the window of 98 completed sessions reaches back to
  // 2026-05-18, which is 97 trading days before the 10-12 reference day.
  const now = new Date('2026-10-12T07:20:00.000Z');

  it('backfills 97 trading days back, verified per session, without requesting the holiday', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    const summary = await h.service.syncKrx({
      mode: 'backfill',
      now,
      sessions: 98,
      krx: { minCallIntervalMs: 0 },
    });
    expect(summary.stopReason).toBeNull();
    expect(summary.series[0].status).toBe('synced');
    expect(summary.series[0].missingBefore).toBe(98);
    expect(summary.series[0].rowsWritten).toBe(196);
    // 1 daily-history call (≤100 sessions) + 98 ten-minute calls.
    expect(summary.series[0].providerCalls).toBe(99);
    expect(summary.totals.providerCalls).toBe(99);
    expect(h.koscom.fetchPeriodPage).toHaveBeenCalledTimes(1);
    expect(h.koscom.fetchDomesticTenMinuteSession).toHaveBeenCalledTimes(98);
    expect(h.requestedTenMinuteDates[0]).toBe('20260518');
    expect(h.requestedTenMinuteDates.includes('20261009')).toBe(false);
    const stored = [...h.repository.rows.values()];
    expect(stored.every((row) => row.interval === '4h')).toBe(true);
    expect(
      stored.every((row) => row.sourceProvider === 'koscom_history_10m'),
    ).toBe(true);
    expect(h.cache.invalidateAsset).toHaveBeenCalledWith('krx-1');
  });

  it('stops at the call cap and resumes without refetching stored sessions', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    const first = await h.service.syncKrx({
      mode: 'backfill',
      now,
      sessions: 98,
      krx: { minCallIntervalMs: 0, maxCalls: 41 },
    });
    expect(first.stopReason).toBe('call_cap');
    expect(first.series[0].status).toBe('partial');
    // A planned budget stop is not a failure: no error code, run not failed.
    expect(first.series[0].errorCode).toBeNull();
    expect(first.totals.failed).toBe(0);
    expect(first.runFailed).toBe(false);
    expect(h.repository.rows.size).toBe(80); // 40 sessions × 2 buckets
    h.koscom.fetchDomesticTenMinuteSession.mockClear();
    const second = await h.service.syncKrx({
      mode: 'backfill',
      now,
      sessions: 98,
      krx: { minCallIntervalMs: 0 },
    });
    expect(second.series[0].missingBefore).toBe(58);
    expect(h.koscom.fetchDomesticTenMinuteSession).toHaveBeenCalledTimes(58);
    expect(second.series[0].status).toBe('synced');
    expect(h.repository.rows.size).toBe(196);
  });

  it('stops before the next call once the observed KOSCOM daily remainder reaches the reserve', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    h.koscomClient.getLastObservedRateLimit.mockReturnValue({
      limitDay: 50_000,
      remainingDay: 19_999,
      observedAt: new Date(Date.now() + 1000),
    });
    const summary = await h.service.syncKrx({
      mode: 'backfill',
      now,
      sessions: 98,
      krx: { minCallIntervalMs: 0, minRemainingDaily: 20_000 },
    });
    expect(summary.stopReason).toBe('quota_reserve');
    expect(summary.observedRemainingDaily).toBe(19_999);
    expect(summary.totals.failed).toBe(0);
    expect(summary.runFailed).toBe(false);
    // Only the first (daily) call went out before the reserve was observed.
    expect(h.koscom.fetchDomesticTenMinuteSession).not.toHaveBeenCalled();
  });

  it('holds a session whose rows do not match its dated daily bar and stores the rest', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    h.koscom.fetchDomesticTenMinuteSession.mockImplementation(
      (input: { date: string }) =>
        Promise.resolve({
          // 2026-10-12 answers with 10-08's data (re-returned previous session).
          rows:
            input.date === '20261012'
              ? tenMinuteRows('20261008', seedOf('20261008')).map((row) => ({
                  ...row,
                  label: new Date(row.label.getTime() + 4 * DAY),
                }))
              : tenMinuteRows(input.date, seedOf(input.date)),
          invalidRows: 0,
          providerReturnedRows: 39,
          receivedAt: new Date('2026-10-12T07:30:00.000Z'),
        }),
    );
    const summary = await h.service.syncKrx({
      mode: 'backfill',
      now,
      sessions: 3,
      krx: { minCallIntervalMs: 0 },
    });
    expect(summary.series[0].held).toEqual([
      expect.objectContaining({
        date: '20261012',
        reason: 'DAILY_OHLC_MISMATCH',
      }),
    ]);
    expect(summary.series[0].rowsWritten).toBe(4);
    expect(summary.series[0].status).toBe('partial');
    // A held session is a data outcome, not a failed run.
    expect(summary.series[0].errorCode).toBeNull();
    expect(summary.runFailed).toBe(false);
  });

  it('keeps incremental runs off the daily endpoint: missing dated bars stay pending at zero calls', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    const summary = await h.service.syncKrx({ mode: 'incremental', now });
    expect(summary.series[0].pending.length).toBe(5);
    expect(summary.series[0].pending[0].reason).toBe(
      'DAILY_REFERENCE_UNAVAILABLE',
    );
    expect(h.koscom.fetchPeriodPage).not.toHaveBeenCalled();
    expect(h.koscom.fetchDomesticTenMinuteSession).not.toHaveBeenCalled();
  });

  it('uses stored koscom_history daily bars captured after the close and ignores KIS or pre-close bars', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    const rows = tenMinuteRows('20261012', seedOf('20261012'));
    const daily = dailyRow('20261012', rows).value;
    const base = {
      assetId: asset.id,
      interval: '1d',
      openTime: new Date('2026-10-11T15:00:00.000Z'),
      closeTime: new Date('2026-10-12T15:00:00.000Z'),
      open: daily.stck_oprc,
      high: daily.stck_hgpr,
      low: daily.stck_lwpr,
      close: daily.stck_clpr,
      volume: daily.acml_vol,
      amount: null,
      isClosed: true,
    };
    await h.repository.upsertMany([
      {
        ...base,
        sourceProvider: 'koscom_history',
        sourceUpdatedAt: new Date('2026-10-12T07:00:00.000Z'),
      },
    ]);
    const summary = await h.service.syncKrx({
      mode: 'incremental',
      now,
      sessions: 1,
    });
    expect(summary.series[0].status).toBe('synced');
    expect(h.koscom.fetchDomesticTenMinuteSession).toHaveBeenCalledTimes(1);

    const kis = createService();
    kis.prisma.asset.findMany.mockResolvedValue([asset]);
    await kis.repository.upsertMany([
      {
        ...base,
        sourceProvider: 'kis_domestic_period',
        sourceUpdatedAt: new Date('2026-10-12T07:00:00.000Z'),
      },
    ]);
    const kisSummary = await kis.service.syncKrx({
      mode: 'incremental',
      now,
      sessions: 1,
    });
    expect(kisSummary.series[0].pending.length).toBe(1);

    const early = createService();
    early.prisma.asset.findMany.mockResolvedValue([asset]);
    await early.repository.upsertMany([
      {
        ...base,
        sourceProvider: 'koscom_history',
        sourceUpdatedAt: new Date('2026-10-12T06:00:00.000Z'),
      },
    ]);
    const earlySummary = await early.service.syncKrx({
      mode: 'incremental',
      now,
      sessions: 1,
    });
    expect(earlySummary.series[0].pending.length).toBe(1);
  });

  it('central mode (F23): a held session is retried once on a later trading day, then left to the operator backfill', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const store = new Map<string, string>();
    const redis = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      setWithTtl: jest.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
    };
    const h = createService({ redis, krxCentral: { enabled: true } });
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    // 10-12 always answers with another session's data (held); 10-13 and
    // 10-14 are clean, each captured after its close.
    h.koscom.fetchDomesticTenMinuteSession.mockImplementation(
      (input: { date: string }) => {
        h.requestedTenMinuteDates.push(input.date);
        return Promise.resolve({
          rows:
            input.date === '20261012'
              ? tenMinuteRows('20261008', seedOf('20261008')).map((row) => ({
                  ...row,
                  label: new Date(row.label.getTime() + 4 * DAY),
                }))
              : tenMinuteRows(input.date, seedOf(input.date)),
          invalidRows: 0,
          providerReturnedRows: 39,
          receivedAt: new Date(
            `${input.date.slice(0, 4)}-${input.date.slice(4, 6)}-${input.date.slice(6, 8)}T07:30:00.000Z`,
          ),
        });
      },
    );
    const seedDaily = async (date: string) => {
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      const daily = dailyRow(date, tenMinuteRows(date, seedOf(date))).value;
      const open = Date.parse(`${iso}T00:00:00+09:00`);
      await h.repository.upsertMany([
        {
          assetId: asset.id,
          interval: '1d',
          openTime: new Date(open),
          closeTime: new Date(open + DAY),
          open: daily.stck_oprc,
          high: daily.stck_hgpr,
          low: daily.stck_lwpr,
          close: daily.stck_clpr,
          volume: daily.acml_vol,
          amount: null,
          isClosed: true,
          sourceProvider: 'koscom_history',
          sourceUpdatedAt: new Date(`${iso}T07:00:00.000Z`),
        },
      ]);
    };
    const calls = (date: string) =>
      h.requestedTenMinuteDates.filter((entry) => entry === date).length;
    const pendingReasons = (summary: { series: { pending: unknown[] }[] }) =>
      (summary.series[0].pending as { date: string; reason: string }[]).map(
        (entry) => `${entry.date}:${entry.reason}`,
      );
    await seedDaily('20261012');
    await seedDaily('20261013');
    await seedDaily('20261014');

    const first = await h.service.syncKrx({
      mode: 'incremental',
      now,
      sessions: 1,
    });
    expect(first.series[0].held.length).toBe(1);
    expect(calls('20261012')).toBe(1);
    // Same trading day: backed off, no provider call.
    const again = await h.service.syncKrx({
      mode: 'incremental',
      now,
      sessions: 1,
    });
    expect(pendingReasons(again)).toEqual(['20261012:HELD_BACKOFF']);
    expect(calls('20261012')).toBe(1);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes('krx_long4h_session_held'),
      ),
    ).toBe(false);

    // Next trading day: one retry, held again → alerted, then never again.
    const nextDay = await h.service.syncKrx({
      mode: 'incremental',
      now: new Date('2026-10-13T07:20:00.000Z'),
      sessions: 2,
    });
    expect(calls('20261012')).toBe(2);
    expect(calls('20261013')).toBe(1);
    expect(nextDay.series[0].held.map((entry) => entry.date)).toEqual([
      '20261012',
    ]);
    const alerts = warn.mock.calls.filter((call) =>
      String(call[0]).includes('krx_long4h_session_held'),
    );
    expect(alerts.length).toBe(1);
    const later = await h.service.syncKrx({
      mode: 'incremental',
      now: new Date('2026-10-14T07:20:00.000Z'),
      sessions: 3,
    });
    expect(calls('20261012')).toBe(2);
    expect(pendingReasons(later)).toEqual(['20261012:HELD_BACKOFF']);

    // The operator backfill ignores the backoff.
    await h.service.syncKrx({
      mode: 'backfill',
      now: new Date('2026-10-14T07:20:00.000Z'),
      sessions: 3,
      krx: { minCallIntervalMs: 0 },
    });
    expect(calls('20261012')).toBe(3);
    warn.mockRestore();
  });

  it('keeps the old retry-every-run behaviour without the central collection', async () => {
    const h = createService({
      redis: { get: jest.fn(), setWithTtl: jest.fn() },
      krxCentral: { enabled: false },
    });
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    h.koscom.fetchDomesticTenMinuteSession.mockImplementation(() =>
      Promise.resolve({
        rows: tenMinuteRows('20261008', seedOf('20261008')).map((row) => ({
          ...row,
          label: new Date(row.label.getTime() + 4 * DAY),
        })),
        invalidRows: 0,
        providerReturnedRows: 39,
        receivedAt: new Date('2026-10-12T07:30:00.000Z'),
      }),
    );
    const daily = dailyRow(
      '20261012',
      tenMinuteRows('20261012', seedOf('20261012')),
    ).value;
    await h.repository.upsertMany([
      {
        assetId: asset.id,
        interval: '1d',
        openTime: new Date('2026-10-11T15:00:00.000Z'),
        closeTime: new Date('2026-10-12T15:00:00.000Z'),
        open: daily.stck_oprc,
        high: daily.stck_hgpr,
        low: daily.stck_lwpr,
        close: daily.stck_clpr,
        volume: daily.acml_vol,
        amount: null,
        isClosed: true,
        sourceProvider: 'koscom_history',
        sourceUpdatedAt: new Date('2026-10-12T07:00:00.000Z'),
      },
    ]);
    await h.service.syncKrx({ mode: 'incremental', now, sessions: 1 });
    await h.service.syncKrx({ mode: 'incremental', now, sessions: 1 });
    expect(h.koscom.fetchDomesticTenMinuteSession).toHaveBeenCalledTimes(2);
  });

  it('refuses to run during the regular session and stops the run on a KOSCOM rate limit', async () => {
    const h = createService();
    const open = await h.service.syncKrx({
      mode: 'backfill',
      now: new Date('2026-10-13T02:00:00.000Z'),
    });
    expect(open.stopReason).toBe('krx_session_open');
    expect(open.runFailed).toBe(false);
    expect(h.prisma.asset.findMany).not.toHaveBeenCalled();

    const limited = createService();
    limited.prisma.asset.findMany.mockResolvedValue([
      asset,
      { ...asset, id: 'krx-2', symbol: '000660' },
    ]);
    limited.koscom.fetchDomesticTenMinuteSession.mockRejectedValue(
      new KoscomError('KOSCOM_RATE_LIMITED'),
    );
    const summary = await limited.service.syncKrx({
      mode: 'backfill',
      now,
      sessions: 3,
      krx: { minCallIntervalMs: 0 },
    });
    expect(summary.stopReason).toBe('provider_unavailable');
    expect(summary.series.length).toBe(1);
    expect(summary.series[0].status).toBe('failed');
    expect(summary.series[0].errorCode).toBe('KOSCOM_RATE_LIMITED');
    expect(summary.totals.failed).toBe(1);
    expect(summary.totals.notStarted).toBe(1);
    expect(summary.runFailed).toBe(true);
    expect(limited.koscom.fetchDomesticTenMinuteSession).toHaveBeenCalledTimes(
      1,
    );
  });

  it('plans without provider calls or writes in dry-run', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([asset]);
    const summary = await h.service.syncKrx({
      mode: 'backfill',
      now,
      sessions: 98,
      dryRun: true,
    });
    expect(summary.series[0].status).toBe('planned');
    expect(summary.series[0].providerCalls).toBe(99);
    expect(h.koscom.fetchPeriodPage).not.toHaveBeenCalled();
    expect(h.koscom.fetchDomesticTenMinuteSession).not.toHaveBeenCalled();
    expect(h.repository.upsertMany).not.toHaveBeenCalled();
    expect(h.locks.acquire).not.toHaveBeenCalled();
  });
});

describe('MarketCandleLongSyncService — Binance Spot and USDⓈ-M', () => {
  const now = new Date('2026-10-13T10:30:00.000Z');

  function klines(from: Date, to: Date, now: Date, base: number) {
    const candles = [];
    for (let t = from.getTime(); t < to.getTime(); t += FOUR_HOURS_MS) {
      candles.push({
        openTime: new Date(t),
        closeTime: new Date(t + FOUR_HOURS_MS),
        open: new Prisma.Decimal(base),
        high: new Prisma.Decimal(base + 2),
        low: new Prisma.Decimal(base - 2),
        close: new Prisma.Decimal(base + 1),
        volume: new Prisma.Decimal(5),
        amount: new Prisma.Decimal(500),
        isClosed: t + FOUR_HOURS_MS - 1 < now.getTime(),
        sourceUpdatedAt: now,
      });
    }
    return candles;
  }

  it('stores Spot native 4h (closed buckets only) in market_candles and never touches the futures store', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([
      { id: 'btc-spot', symbol: 'BTCUSDT' },
    ]);
    h.spotCandles.fetchKlinesPage.mockImplementation(
      (input: { from: Date; to: Date; now: Date }) =>
        Promise.resolve({
          candles: klines(input.from, input.to, input.now, 100),
          nextCursor: null,
          stopReason: 'target_reached',
        }),
    );
    const summary = await h.service.syncSpot({ mode: 'backfill', now });
    expect(summary.series[0].rowsWritten).toBe(576);
    const [call] = h.spotCandles.fetchKlinesPage.mock.calls[0] as unknown as [
      { interval: string; symbol: string },
    ];
    expect(call.interval).toBe('4h');
    expect(call.symbol).toBe('BTCUSDT');
    const stored = [...h.repository.rows.values()];
    expect(stored.every((row) => row.isClosed && row.interval === '4h')).toBe(
      true,
    );
    expect(stored.every((row) => row.sourceProvider === 'binance_klines')).toBe(
      true,
    );
    expect(h.futuresRepository.upsertMany).not.toHaveBeenCalled();
    expect(h.usdmCandles.fetchKlinesPage).not.toHaveBeenCalled();
    const again = await h.service.syncSpot({ mode: 'backfill', now });
    expect(again.series[0].status).toBe('up_to_date');
    expect(h.spotCandles.fetchKlinesPage).toHaveBeenCalledTimes(1);
  });

  it('stores USDⓈ-M contract 4h per instrument (incl. the provisional bucket) and skips unverified contracts', async () => {
    const h = createService();
    const contract = (symbol: string) => ({
      symbol,
      pair: symbol,
      baseAsset: symbol.replace(/USDT$/u, ''),
      contractType: 'PERPETUAL',
      status: 'TRADING',
      quoteAsset: 'USDT',
      marginAsset: 'USDT',
      underlyingType: 'COIN',
    });
    const instrument = (id: string, symbol: string, verified = true) => ({
      id,
      isActive: true,
      productType: 'synthetic_perpetual',
      settlementCurrency: 'USD',
      markContractJson: verified ? contract(symbol) : null,
      underlyingAsset: { symbol, market: 'BINANCE', assetType: 'crypto' },
    });
    h.prisma.futuresInstrument.findMany.mockResolvedValue([
      instrument('fut-btc', 'BTCUSDT'),
      // Futures-only underlying: its own Asset row, never a Spot product.
      instrument('fut-hype', 'HYPEUSDT'),
      instrument('fut-eth', 'ETHUSDT', false),
    ]);
    h.usdmCandles.fetchKlinesPage.mockImplementation(
      (input: { symbol: string; from: Date; to: Date; now: Date }) =>
        Promise.resolve({
          candles: klines(
            input.from,
            input.to,
            input.now,
            input.symbol === 'BTCUSDT' ? 60000 : 30,
          ),
          nextCursor: null,
          stopReason: 'target_reached',
        }),
    );
    const summary = await h.service.syncFutures({ mode: 'backfill', now });
    const bySymbol = Object.fromEntries(
      summary.series.map((s) => [s.symbol, s]),
    );
    expect(bySymbol.ETHUSDT.status).toBe('skipped');
    expect(bySymbol.ETHUSDT.errorCode).toBe('CONTRACT_UNVERIFIED');
    // A deliberate skip is not a failure.
    expect(summary.totals.failed).toBe(0);
    expect(summary.runFailed).toBe(false);
    expect(bySymbol.BTCUSDT.rowsWritten).toBe(577);
    expect(bySymbol.HYPEUSDT.rowsWritten).toBe(577);
    const rows = [...h.futuresRepository.rows.values()];
    expect(new Set(rows.map((row) => row.futuresInstrumentId))).toEqual(
      new Set(['fut-btc', 'fut-hype']),
    );
    expect(
      rows.every(
        (row) =>
          row.contractSymbol === 'BTCUSDT' || row.contractSymbol === 'HYPEUSDT',
      ),
    ).toBe(true);
    const current = rows.filter((row) => !row.isClosed);
    expect(current.length).toBe(2);
    expect(current[0].openTime.toISOString()).toBe('2026-10-13T08:00:00.000Z');
    // Contract data never lands in the Spot store.
    expect(h.repository.upsertMany).not.toHaveBeenCalled();
    expect(h.spotCandles.fetchKlinesPage).not.toHaveBeenCalled();
  });
});

describe('MarketCandleLongSyncService — run outcome', () => {
  const krxAsset = { id: 'krx-1', symbol: '005930', market: 'KRX' };
  // 2026-10-12 16:20 KST (see the KRX suite above).
  const krxNow = new Date('2026-10-12T07:20:00.000Z');
  const spotNow = new Date('2026-10-13T10:30:00.000Z');

  function closedSpotPage(from: Date, buckets: number, stopReason: string) {
    const candles = Array.from({ length: buckets }, (_, i) => {
      const openMs = from.getTime() + i * FOUR_HOURS_MS;
      return {
        openTime: new Date(openMs),
        closeTime: new Date(openMs + FOUR_HOURS_MS),
        open: new Prisma.Decimal(100),
        high: new Prisma.Decimal(102),
        low: new Prisma.Decimal(98),
        close: new Prisma.Decimal(101),
        volume: new Prisma.Decimal(5),
        amount: new Prisma.Decimal(500),
        isClosed: true,
        sourceUpdatedAt: spotNow,
      };
    });
    return { candles, nextCursor: null, stopReason };
  }

  it.each([
    ['unavailable', 'LOCK_UNAVAILABLE'],
    ['busy', 'LOCK_BUSY'],
  ] as const)(
    'fails a series whose lock is %s instead of skipping it',
    async (reason, code) => {
      const h = createService();
      h.prisma.asset.findMany.mockResolvedValue([
        { id: 'btc-spot', symbol: 'BTCUSDT' },
      ]);
      h.locks.acquire.mockResolvedValue({ acquired: false, reason });
      const summary = await h.service.syncSpot({
        mode: 'backfill',
        now: spotNow,
      });
      expect(summary.series[0].status).toBe('failed');
      expect(summary.series[0].errorCode).toBe(code);
      expect(summary.totals.failed).toBe(1);
      expect(summary.runFailed).toBe(true);
      expect(h.spotCandles.fetchKlinesPage).not.toHaveBeenCalled();
    },
  );

  it('keeps the written range of a Spot series that ends on a malformed page and fails the run', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([
      { id: 'btc-spot', symbol: 'BTCUSDT' },
    ]);
    h.spotCandles.fetchKlinesPage.mockImplementation((input: { from: Date }) =>
      Promise.resolve(closedSpotPage(input.from, 10, 'malformed_response')),
    );
    const summary = await h.service.syncSpot({
      mode: 'backfill',
      now: spotNow,
    });
    expect(summary.series[0].status).toBe('partial');
    expect(summary.series[0].rowsWritten).toBe(10);
    expect(summary.series[0].errorCode).toBe('PROVIDER_MALFORMED_RESPONSE');
    expect(summary.totals.failed).toBe(1);
    expect(summary.runFailed).toBe(true);
  });

  it('fails a KRX series refused on its daily references and leaves the rest not started', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([
      krxAsset,
      { ...krxAsset, id: 'krx-2', symbol: '000660' },
    ]);
    h.koscom.fetchPeriodPage.mockRejectedValue(
      new KoscomError('KOSCOM_AUTH_FAILED'),
    );
    const summary = await h.service.syncKrx({
      mode: 'backfill',
      now: krxNow,
      sessions: 3,
      krx: { minCallIntervalMs: 0 },
    });
    expect(summary.stopReason).toBe('provider_unavailable');
    expect(summary.series.length).toBe(1);
    expect(summary.series[0].status).toBe('failed');
    expect(summary.series[0].errorCode).toBe('KOSCOM_AUTH_FAILED');
    expect(summary.totals.notStarted).toBe(1);
    expect(summary.runFailed).toBe(true);
    expect(h.koscom.fetchDomesticTenMinuteSession).not.toHaveBeenCalled();
  });

  it('fails the run on a KOSCOM HTTP failure even after other sessions were verified', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([krxAsset]);
    const verified =
      h.koscom.fetchDomesticTenMinuteSession.getMockImplementation();
    h.koscom.fetchDomesticTenMinuteSession.mockImplementation(
      (input: { date: string }) =>
        input.date === '20261012'
          ? Promise.reject(new KoscomError('KOSCOM_HTTP_FAILED', true))
          : verified!(input),
    );
    const summary = await h.service.syncKrx({
      mode: 'backfill',
      now: krxNow,
      sessions: 3,
      krx: { minCallIntervalMs: 0 },
    });
    expect(summary.series[0].status).toBe('partial');
    expect(summary.series[0].rowsWritten).toBe(4);
    expect(summary.series[0].pending.length).toBe(1);
    expect(summary.series[0].pending[0].reason).toBe('KOSCOM_HTTP_FAILED');
    expect(summary.series[0].errorCode).toBe('KOSCOM_HTTP_FAILED');
    expect(summary.totals.failed).toBe(1);
    expect(summary.runFailed).toBe(true);
  });

  it('marks a KRX series interrupted and fails the run when it is canceled mid-series', async () => {
    const h = createService();
    h.prisma.asset.findMany.mockResolvedValue([krxAsset]);
    const controller = new AbortController();
    const verified =
      h.koscom.fetchDomesticTenMinuteSession.getMockImplementation();
    let calls = 0;
    h.koscom.fetchDomesticTenMinuteSession.mockImplementation(
      (input: { date: string }) => {
        calls += 1;
        if (calls === 2) controller.abort();
        return verified!(input);
      },
    );
    const summary = await h.service.syncKrx({
      mode: 'backfill',
      now: krxNow,
      sessions: 5,
      krx: { minCallIntervalMs: 0 },
      signal: controller.signal,
    });
    expect(summary.stopReason).toBe('canceled');
    expect(summary.series[0].status).toBe('partial');
    expect(summary.series[0].rowsWritten).toBe(4);
    expect(summary.series[0].errorCode).toBe('INTERRUPTED');
    expect(summary.totals.failed).toBe(1);
    expect(summary.runFailed).toBe(true);
  });
});
