import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveMarketSession,
  inspectMarketSessionsInRange,
  type MarketSessionWindow,
} from '../../orders/market-calendar.policy';
import {
  createBoundedAbortSignal,
  formatZonedCursor,
  validateFetchInput,
  zonedDateTimeToUtc,
} from '../kis/candles/kis-candle-time';
import type {
  KisCandleAdapterResult,
  KisCandleFetchInput,
  KisRawCandleRow,
} from '../kis/candles/kis-candle.types';
import type {
  KisPeriodPageInput,
  KisPeriodPageResult,
} from '../kis/candles/kis-period-candle.types';
import {
  KoscomClient,
  koscomRecord,
  type KoscomResponse,
} from './koscom.client';
import {
  KoscomError,
  readKoscomConfig,
  type KoscomMarket,
} from './koscom.config';
import { KoscomMarketMapService } from './koscom-market-map.service';
import { koscomTime, koscomDecimal, koscomText } from './koscom-normalizer';

/** One END-labelled KOSCOM 10-minute row: `label` closes [label-10m, label). */
export type KoscomTenMinuteRow = {
  label: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string;
};

export type KoscomTenMinuteSessionPage = {
  rows: KoscomTenMinuteRow[];
  /** Rows whose time/OHLCV could not be parsed (the caller holds the day). */
  invalidRows: number;
  providerReturnedRows: number;
  receivedAt: Date;
};

/** Translate at the provider boundary; retain existing calendar/Decimal builders. */
@Injectable()
export class KoscomCandleAdapter {
  constructor(
    private readonly client: KoscomClient,
    private readonly markets: KoscomMarketMapService,
  ) {}

  /**
   * KRX 1m rows for [from, to). Runtime paths read today's session only.
   * Operator backfills opt into past sessions with
   * KOSCOM_INTRADAY_HISTORY_SESSIONS (see fetchVerifiedOneMinuteHistory);
   * `todayOnly` keeps that history branch from re-entering itself.
   */
  async fetchDomesticOneMinuteRows(
    input: KisCandleFetchInput,
    todayOnly = false,
  ): Promise<KisCandleAdapterResult> {
    const limits = validateFetchInput(input);
    const now = input.now ?? new Date();
    const empty = (
      stopReason: KisCandleAdapterResult['stopReason'],
      complete = false,
    ): KisCandleAdapterResult => ({
      rows: [],
      pagesFetched: 0,
      providerReturnedRows: 0,
      duplicateRows: 0,
      complete,
      stopReason,
      oldestOpenTime: null,
      latestOpenTime: null,
    });
    if (input.signal?.aborted) return empty('canceled');
    const effectiveTo = new Date(Math.min(input.to.getTime(), now.getTime()));
    if (effectiveTo <= input.from) return empty('expected_no_data', true);
    const range = inspectMarketSessionsInRange(
      { assetType: 'domestic_stock', market: 'KRX' },
      input.from,
      effectiveTo,
    );
    if (!range.calendarCovered) return empty('calendar_unavailable');
    if (!range.hasTradingSession) return empty('expected_no_data', true);
    const historySessions = todayOnly
      ? 0
      : readKoscomConfig().intradayHistorySessions;
    if (historySessions > 0)
      return this.fetchVerifiedOneMinuteHistory(
        input,
        limits,
        now,
        effectiveTo,
        historySessions,
      );
    // Runtime reads trust only today's intraday response: rows carry no date,
    // so a past date needs the daily corroboration of the history branch.
    const date = formatZonedCursor(now, 'Asia/Seoul').date;
    const session = resolveMarketSession('KRX', date);
    if (!session || effectiveTo <= session.openTime)
      return empty('provider_exhausted');
    const fromMs = Math.max(input.from.getTime(), session.openTime.getTime());
    const toMs = Math.min(effectiveTo.getTime(), session.closeTime.getTime());
    if (fromMs >= toMs) return empty('expected_no_data', true);
    const bounded = createBoundedAbortSignal(
      input.signal,
      limits.maxDurationMs,
    );
    const rows = new Map<number, KisRawCandleRow>();
    const conflicts = new Set<number>();
    let pagesFetched = 0,
      providerReturnedRows = 0,
      duplicateRows = 0,
      malformed = false;
    let endMs = Math.floor(toMs / 60000) * 60000;
    let stopReason: KisCandleAdapterResult['stopReason'] = 'target_reached';
    try {
      let market;
      try {
        market = await this.markets.resolve(
          input.asset.symbol,
          input.asset.marketCode === 'J' ? 'KRX' : input.asset.marketCode,
          bounded.signal,
        );
      } catch (error) {
        if (bounded.signal.aborted)
          return empty(input.signal?.aborted ? 'canceled' : 'max_duration');
        throw error;
      }
      // At most 95 completed one-minute bars + endpoint inclusivity (<100).
      // These are documented time-window requests, not continuation tokens.
      while (endMs > fromMs) {
        if (pagesFetched >= limits.maxPages) {
          stopReason = 'max_pages';
          break;
        }
        if (rows.size >= limits.maxRows) {
          stopReason = 'max_rows';
          break;
        }
        const startMs = Math.max(
          Math.floor(fromMs / 60000) * 60000,
          endMs - 95 * 60000,
        );
        let response: KoscomResponse;
        try {
          response = await this.client.get(
            `/v3/market/realtime/${market}/stocks/${input.asset.symbol}/intraday`,
            {
              inddCycleTpCd: '60',
              inqStrtDd: date,
              strtTm: formatZonedCursor(
                new Date(startMs),
                'Asia/Seoul',
              ).time.slice(0, 4),
              endTm: formatZonedCursor(
                new Date(endMs),
                'Asia/Seoul',
              ).time.slice(0, 4),
            },
            bounded.signal,
          );
        } catch (error) {
          if (bounded.signal.aborted) {
            stopReason = input.signal?.aborted ? 'canceled' : 'max_duration';
            break;
          }
          throw error;
        }
        pagesFetched++;
        if (
          response.result.isuSrtCd !== input.asset.symbol ||
          !Array.isArray(response.result.hisLists) ||
          response.result.hisLists.length > 100
        )
          throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
            'KOSCOM_MALFORMED_CANDLES',
          );
        if (
          response.result.trdDd !== undefined &&
          response.result.trdDd !== date
        )
          throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
            'KOSCOM_CANDLE_DATE_MISMATCH',
          );
        providerReturnedRows += response.result.hisLists.length;
        for (const item of response.result.hisLists) {
          try {
            const row = koscomRecord(item);
            // Official examples begin with 09:10 for the first 10-minute
            // interval: inddTm labels the interval END. Store minute opens.
            const end = koscomTime(date, row.inddTm);
            if (end.getTime() % 60000 !== 0)
              throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
                'KOSCOM_INVALID_TIME',
              );
            const openTime = new Date(end.getTime() - 60000);
            if (
              openTime.getTime() < startMs ||
              end.getTime() > endMs ||
              end > now ||
              end > response.receivedAt
            )
              continue;
            const stamp = formatZonedCursor(openTime, 'Asia/Seoul');
            const values = ohlcv(row, true);
            const value = {
              stck_bsop_date: stamp.date,
              stck_cntg_hour: stamp.time,
              stck_oprc: values.open,
              stck_hgpr: values.high,
              stck_lwpr: values.low,
              stck_prpr: values.close,
              cntg_vol: values.volume,
              cntg_tr_pbmn: values.amount,
            };
            const key = openTime.getTime();
            if (conflicts.has(key)) {
              duplicateRows++;
              continue;
            }
            const previous = rows.get(key);
            if (previous) {
              duplicateRows++;
              if (JSON.stringify(previous.value) !== JSON.stringify(value)) {
                rows.delete(key);
                conflicts.add(key);
                malformed = true;
              }
              continue;
            }
            if (rows.size < limits.maxRows)
              rows.set(key, {
                value,
                receivedAt: response.receivedAt,
                sequence: rows.size,
              });
          } catch {
            malformed = true;
          }
        }
        if (!response.result.hisLists.length) {
          stopReason = 'empty_page';
          break;
        }
        endMs = startMs;
      }
    } finally {
      bounded.clear();
    }
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    const expected = Math.max(
      0,
      Math.floor(toMs / 60000) - Math.ceil(fromMs / 60000),
    );
    const complete =
      stopReason === 'target_reached' &&
      !malformed &&
      ordered.length === expected &&
      input.from >= session.openTime;
    if (malformed) stopReason = 'malformed_response';
    else if (!complete && stopReason === 'target_reached')
      stopReason = 'provider_exhausted';
    return {
      rows: ordered.map(([, row]) => row),
      pagesFetched,
      providerReturnedRows,
      duplicateRows,
      complete,
      stopReason,
      oldestOpenTime: ordered.length ? new Date(ordered[0][0]) : null,
      latestOpenTime: ordered.length ? new Date(ordered.at(-1)![0]) : null,
    };
  }

  /**
   * Past KRX sessions of 1m rows for an operator backfill (2026-10-17).
   *
   * Live probe (005930/042700, 1–25 sessions back): a past date returns the
   * whole session in five 95-minute windows — 390 END-labelled rows, the
   * 15:21–15:29 auction minutes flat with zero volume and the 15:30 row the
   * closing auction — and no date field at all; a holiday request returns the
   * previous session verbatim (10m probe, 2026-10-13). A session is therefore
   * kept only when every minute arrived and its rows corroborate the DATED
   * daily bar of that date (`corroborateKoscomMinuteSession`). Any other
   * session is held: its rows are dropped, the sweep goes on to older
   * sessions and the result is never `complete`, so no coverage is claimed.
   * Sessions older than `maxSessionsBack` end the sweep (provider_exhausted).
   * Today's session, if in range, is read by the runtime path unchanged.
   */
  private async fetchVerifiedOneMinuteHistory(
    input: KisCandleFetchInput,
    limits: ReturnType<typeof validateFetchInput>,
    now: Date,
    effectiveTo: Date,
    maxSessionsBack: number,
  ): Promise<KisCandleAdapterResult> {
    const calendarAsset = {
      assetType: 'domestic_stock',
      market: 'KRX',
    } as const;
    const today = formatZonedCursor(now, 'Asia/Seoul').date;
    const oldestAllowed = findPreviousMarketSession(
      calendarAsset,
      now,
      maxSessionsBack,
    );
    const sessions: MarketSessionWindow[] = [];
    const firstDate = formatZonedCursor(input.from, 'Asia/Seoul').date;
    for (
      let date = formatZonedCursor(
        new Date(effectiveTo.getTime() - 1),
        'Asia/Seoul',
      ).date;
      date >= firstDate;
      date = previousCompactDate(date)
    ) {
      const session = resolveMarketSession('KRX', date);
      if (
        session &&
        session.openTime < effectiveTo &&
        session.closeTime > input.from
      )
        sessions.push(session);
    }
    const result: KisCandleAdapterResult = {
      rows: [],
      pagesFetched: 0,
      providerReturnedRows: 0,
      duplicateRows: 0,
      complete: false,
      stopReason: 'target_reached',
      oldestOpenTime: null,
      latestOpenTime: null,
    };
    if (!oldestAllowed)
      return { ...result, stopReason: 'calendar_unavailable' };
    const kept: { openTime: number; row: KisRawCandleRow }[] = [];
    let complete = true;
    const bounded = createBoundedAbortSignal(
      input.signal,
      limits.maxDurationMs,
    );
    const stopped = () =>
      input.signal?.aborted ? ('canceled' as const) : ('max_duration' as const);
    try {
      let market: KoscomMarket | null = null;
      for (const session of sessions) {
        const sessionDate = compactDate(session.localDate);
        if (sessionDate === today) {
          const current = await this.fetchDomesticOneMinuteRows(
            {
              ...input,
              from: new Date(
                Math.max(input.from.getTime(), session.openTime.getTime()),
              ),
              to: effectiveTo,
            },
            true,
          );
          result.pagesFetched += current.pagesFetched;
          result.providerReturnedRows += current.providerReturnedRows;
          result.duplicateRows += current.duplicateRows;
          for (const row of current.rows)
            kept.push({ openTime: minuteOpenTime(row), row });
          if (!current.complete) complete = false;
          if (
            current.stopReason !== 'target_reached' &&
            current.stopReason !== 'provider_exhausted' &&
            current.stopReason !== 'expected_no_data'
          ) {
            result.stopReason = current.stopReason;
            break;
          }
          continue;
        }
        if (session.localDate < oldestAllowed.localDate) {
          result.stopReason = 'provider_exhausted';
          complete = false;
          break;
        }
        // Five intraday windows plus one dated daily call per session.
        if (result.pagesFetched + 6 > limits.maxPages) {
          result.stopReason = 'max_pages';
          complete = false;
          break;
        }
        if (bounded.signal.aborted) {
          result.stopReason = stopped();
          complete = false;
          break;
        }
        try {
          market ??= await this.markets.resolve(
            input.asset.symbol,
            input.asset.marketCode === 'J' ? 'KRX' : input.asset.marketCode,
            bounded.signal,
          );
          const minutes = await this.fetchWholePastSession(
            market,
            input.asset.symbol,
            session,
            bounded.signal,
          );
          result.pagesFetched += minutes.pagesFetched;
          result.providerReturnedRows += minutes.providerReturnedRows;
          result.duplicateRows += minutes.duplicateRows;
          const previous = findPreviousMarketSession(
            calendarAsset,
            session.openTime,
            1,
          );
          let verified = false;
          if (minutes.whole && previous) {
            const daily = await this.fetchPeriodPage({
              asset: input.asset,
              interval: '1d',
              fromDate: compactDate(previous.localDate),
              endDate: sessionDate,
              signal: bounded.signal,
            });
            result.pagesFetched += 1;
            const bar = (date: string) => {
              const value = daily.rows.find(
                (row) => row.value.stck_bsop_date === date,
              )?.value;
              return value
                ? {
                    open: String(value.stck_oprc),
                    high: String(value.stck_hgpr),
                    low: String(value.stck_lwpr),
                    close: String(value.stck_clpr),
                    volume: String(value.acml_vol),
                  }
                : null;
            };
            const dated = bar(sessionDate);
            verified =
              dated !== null &&
              corroborateKoscomMinuteSession(
                minutes.rows.map((entry) => entry.values),
                dated,
                bar(compactDate(previous.localDate)),
              );
          }
          if (!verified) {
            complete = false;
            continue;
          }
          for (const entry of minutes.rows) {
            if (
              entry.openTime < input.from.getTime() ||
              entry.openTime >= effectiveTo.getTime()
            )
              continue;
            kept.push({
              openTime: entry.openTime,
              row: oneMinuteRawRow(
                entry.openTime,
                entry.values,
                minutes.receivedAt,
              ),
            });
          }
        } catch (error) {
          if (bounded.signal.aborted) {
            result.stopReason = stopped();
            complete = false;
            break;
          }
          throw error;
        }
      }
    } finally {
      bounded.clear();
    }
    kept.sort((a, b) => a.openTime - b.openTime);
    const capped = kept.slice(0, limits.maxRows);
    if (capped.length < kept.length) {
      result.stopReason = 'max_rows';
      complete = false;
    }
    return {
      ...result,
      rows: capped.map((entry, sequence) => ({ ...entry.row, sequence })),
      complete: complete && result.stopReason === 'target_reached',
      oldestOpenTime: capped.length ? new Date(capped[0].openTime) : null,
      latestOpenTime: capped.length ? new Date(capped.at(-1)!.openTime) : null,
    };
  }

  /** Every window of one past session; `whole` = all minutes, none conflicting. */
  private async fetchWholePastSession(
    market: KoscomMarket,
    symbol: string,
    session: MarketSessionWindow,
    signal: AbortSignal,
  ) {
    const date = compactDate(session.localDate);
    const openMs = session.openTime.getTime();
    const closeMs = session.closeTime.getTime();
    const rows = new Map<number, ReturnType<typeof ohlcv>>();
    const conflicts = new Set<number>();
    let pagesFetched = 0,
      providerReturnedRows = 0,
      duplicateRows = 0,
      malformed = false,
      receivedAt = new Date(0);
    for (let endMs = closeMs; endMs > openMs; ) {
      const startMs = Math.max(openMs, endMs - 95 * 60000);
      const response = await this.client.get(
        `/v3/market/realtime/${market}/stocks/${symbol}/intraday`,
        {
          inddCycleTpCd: '60',
          inqStrtDd: date,
          strtTm: formatZonedCursor(new Date(startMs), 'Asia/Seoul').time.slice(
            0,
            4,
          ),
          endTm: formatZonedCursor(new Date(endMs), 'Asia/Seoul').time.slice(
            0,
            4,
          ),
        },
        signal,
      );
      pagesFetched++;
      if (
        response.result.isuSrtCd !== symbol ||
        !Array.isArray(response.result.hisLists) ||
        response.result.hisLists.length > 100
      )
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_MALFORMED_CANDLES',
        );
      if (response.result.trdDd !== undefined && response.result.trdDd !== date)
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_CANDLE_DATE_MISMATCH',
        );
      receivedAt = response.receivedAt;
      providerReturnedRows += response.result.hisLists.length;
      for (const item of response.result.hisLists) {
        try {
          const row = koscomRecord(item);
          const end = koscomTime(date, row.inddTm);
          const openTime = end.getTime() - 60000;
          if (end.getTime() % 60000 !== 0) {
            malformed = true;
            continue;
          }
          // Window edges overlap like the runtime path: skip, never repair.
          if (openTime < startMs || end.getTime() > endMs) continue;
          const values = ohlcv(row, true);
          if (conflicts.has(openTime)) {
            duplicateRows++;
            continue;
          }
          const previous = rows.get(openTime);
          if (previous) {
            duplicateRows++;
            if (JSON.stringify(previous) !== JSON.stringify(values)) {
              rows.delete(openTime);
              conflicts.add(openTime);
              malformed = true;
            }
            continue;
          }
          rows.set(openTime, values);
        } catch {
          malformed = true;
        }
      }
      endMs = startMs;
    }
    const ordered = [...rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([openTime, values]) => ({ openTime, values }));
    return {
      rows: ordered,
      whole: !malformed && ordered.length === (closeMs - openMs) / 60000,
      pagesFetched,
      providerReturnedRows,
      duplicateRows,
      receivedAt,
    };
  }

  /**
   * One KRX session of KOSCOM 10-minute history (`inddCycleTpCd=600`).
   *
   * Live-verified 2026-10-13 (docs/investigations/2026-10-13-koscom-10m-date-quota):
   * one request returns the whole regular session (39 rows, 09:10…15:20 plus
   * the 15:30 closing-auction row), also 96–97 sessions back. Rows carry no
   * date and a holiday request returned the PREVIOUS session unchanged, so this
   * method only translates the response: the caller must ask for calendar
   * sessions only and must verify the rows against the dated daily bar before
   * trusting them. Row-level parse failures are counted, never repaired.
   */
  async fetchDomesticTenMinuteSession(input: {
    asset: { symbol: string; marketCode: string };
    /** Exchange-local trading date, YYYYMMDD. */
    date: string;
    /** Exchange-local session bounds, HHmm. */
    openHHmm: string;
    closeHHmm: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<KoscomTenMinuteSessionPage> {
    if (
      !/^\d{8}$/.test(input.date) ||
      !/^\d{4}$/.test(input.openHHmm) ||
      !/^\d{4}$/.test(input.closeHHmm) ||
      input.openHHmm >= input.closeHHmm
    )
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_INVALID_DATE_RANGE',
      );
    const bounded = createBoundedAbortSignal(
      input.signal,
      input.timeoutMs ?? 15000,
    );
    let response: KoscomResponse;
    try {
      const market = await this.markets.resolve(
        input.asset.symbol,
        input.asset.marketCode === 'J' ? 'KRX' : input.asset.marketCode,
        bounded.signal,
      );
      response = await this.client.get(
        `/v3/market/realtime/${market}/stocks/${input.asset.symbol}/intraday`,
        {
          inddCycleTpCd: '600',
          inqStrtDd: input.date,
          strtTm: input.openHHmm,
          endTm: input.closeHHmm,
        },
        bounded.signal,
      );
    } finally {
      bounded.clear();
    }
    const result = response.result;
    if (
      result.isuSrtCd !== input.asset.symbol ||
      !Array.isArray(result.hisLists) ||
      result.hisLists.length > 100
    )
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_MALFORMED_CANDLES',
      );
    if (result.trdDd !== undefined && result.trdDd !== input.date)
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_CANDLE_DATE_MISMATCH',
      );
    const rows: KoscomTenMinuteRow[] = [];
    let invalidRows = 0;
    for (const item of result.hisLists) {
      try {
        const row = koscomRecord(item);
        const label = koscomTime(input.date, row.inddTm);
        if (label.getTime() % 60000 !== 0)
          throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
            'KOSCOM_INVALID_TIME',
          );
        rows.push({ label, ...ohlcv(row, true) });
      } catch {
        invalidRows++;
      }
    }
    rows.sort((a, b) => a.label.getTime() - b.label.getTime());
    return {
      rows,
      invalidRows,
      providerReturnedRows: result.hisLists.length,
      receivedAt: response.receivedAt,
    };
  }

  async fetchPeriodPage(
    input: KisPeriodPageInput,
  ): Promise<KisPeriodPageResult> {
    if (
      !/^\d{8}$/.test(input.fromDate) ||
      !/^\d{8}$/.test(input.endDate) ||
      input.fromDate > input.endDate
    )
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_INVALID_DATE_RANGE',
      );
    const bounded = createBoundedAbortSignal(
      input.signal,
      input.timeoutMs ?? 15000,
    );
    let response: KoscomResponse;
    try {
      const market = await this.markets.resolve(
        input.asset.symbol,
        input.asset.marketCode === 'J' ? 'KRX' : input.asset.marketCode,
        bounded.signal,
      );
      response = await this.client.get(
        `/v3/market/closed/${market}/${input.asset.symbol}/history`,
        {
          trnsmCycleTpCd: input.interval === '1d' ? 'D' : 'W',
          inqStrtDd: input.fromDate,
          inqEndDd: input.endDate,
          reqCnt: '100',
        },
        bounded.signal,
      );
    } finally {
      bounded.clear();
    }
    const result = response.result;
    if (
      result.isuSrtCd !== input.asset.symbol ||
      !Array.isArray(result.hisLists) ||
      result.hisLists.length > 100
    )
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_MALFORMED_CANDLES',
      );
    const rows: KisRawCandleRow[] = [];
    const seen = new Map<string, string>();
    for (const item of result.hisLists) {
      const row = koscomRecord(item),
        date = koscomText(row.trdDd);
      if (
        !/^\d{8}$/.test(date) ||
        date < input.fromDate ||
        date > input.endDate ||
        date > formatZonedCursor(response.receivedAt, 'Asia/Seoul').date ||
        !resolveMarketSession('KRX', date)
      )
        throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
          'KOSCOM_CANDLE_DATE_MISMATCH',
        );
      const values = ohlcv(row, false);
      const serialized = JSON.stringify(values);
      if (seen.has(date)) {
        if (seen.get(date) !== serialized)
          throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
            'KOSCOM_CONFLICTING_CANDLES',
          );
        continue;
      }
      seen.set(date, serialized);
      rows.push({
        value: {
          stck_bsop_date: date,
          stck_oprc: values.open,
          stck_hgpr: values.high,
          stck_lwpr: values.low,
          stck_clpr: values.close,
          acml_vol: values.volume,
          acml_tr_pbmn: values.amount,
        },
        receivedAt: response.receivedAt,
        sequence: rows.length,
      });
    }
    const dates = rows.map((r) => String(r.value.stck_bsop_date)).sort();
    return {
      state: 'ok',
      rows,
      providerReturnedRows: result.hisLists.length,
      blankRows: 0,
      oldestDate: dates[0] ?? null,
      latestDate: dates.at(-1) ?? null,
      trCont: null,
    };
  }

  async master(symbol: string, assetMarket: string) {
    const market = await this.markets.resolve(symbol, assetMarket);
    const response = await this.client.get(
      `/v3/market/closed/${market}/${symbol}/master`,
    );
    if (response.result.isuSrtCd !== symbol)
      throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
        'KOSCOM_SYMBOL_MISMATCH',
      );
    return response;
  }
}

export function ohlcv(row: Record<string, unknown>, intraday: boolean) {
  const open = koscomDecimal(row[intraday ? 'inddOpnprc' : 'opnprc'], true);
  const high = koscomDecimal(row[intraday ? 'inddHgprc' : 'hgprc'], true);
  const low = koscomDecimal(row[intraday ? 'inddLwprc' : 'lwprc'], true);
  const close = koscomDecimal(row[intraday ? 'inddClsprc' : 'trdPrc'], true);
  const volume = koscomDecimal(row[intraday ? 'inddTrdvol' : 'accTrdvol']);
  const amount = koscomDecimal(row[intraday ? 'inddTrdval' : 'accTrdval']);
  if (
    high.lt(open) ||
    high.lt(close) ||
    high.lt(low) ||
    low.gt(open) ||
    low.gt(close)
  )
    throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
      'KOSCOM_INVALID_OHLC',
    );
  return {
    open: open.toFixed(),
    high: high.toFixed(),
    low: low.toFixed(),
    close: close.toFixed(),
    volume: volume.toFixed(),
    amount: amount.toFixed(),
  };
}

type SessionBar = {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

/**
 * Whether one past session of undated KOSCOM 1m rows (ordered, whole
 * session) belongs to the dated daily bar: the session's O/H/L/C equal the
 * daily O/H/L/C exactly (round-2 rule `DATED_DAILY_OHLC_EXACT`), the minute
 * volume does not exceed the daily volume (the daily also counts off-session
 * trades), and the previous session's daily differs — otherwise a
 * "previous session returned again" response could not be told apart.
 * Both sources are KOSCOM: corroboration, never independent date proof.
 */
export function corroborateKoscomMinuteSession(
  minutes: readonly SessionBar[],
  daily: SessionBar,
  previousDaily: SessionBar | null,
): boolean {
  if (!minutes.length || !previousDaily) return false;
  const d = (value: string) => new Prisma.Decimal(value);
  let high = d(minutes[0].high);
  let low = d(minutes[0].low);
  let volume = d('0');
  for (const minute of minutes) {
    if (d(minute.high).gt(high)) high = d(minute.high);
    if (d(minute.low).lt(low)) low = d(minute.low);
    volume = volume.plus(minute.volume);
  }
  const sameOhlc = (a: SessionBar, b: SessionBar) =>
    d(a.open).eq(b.open) &&
    d(a.high).eq(b.high) &&
    d(a.low).eq(b.low) &&
    d(a.close).eq(b.close);
  return (
    sameOhlc(
      {
        open: minutes[0].open,
        high: high.toFixed(),
        low: low.toFixed(),
        close: minutes.at(-1)!.close,
        volume: volume.toFixed(),
      },
      daily,
    ) &&
    volume.lte(daily.volume) &&
    !sameOhlc(daily, previousDaily)
  );
}

/** Calendar `localDate` (YYYY-MM-DD) → the KOSCOM YYYYMMDD form. */
function compactDate(localDate: string): string {
  return localDate.replaceAll('-', '');
}

function previousCompactDate(date: string): string {
  return new Date(
    Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) -
      86_400_000,
  )
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '');
}

function minuteOpenTime(row: KisRawCandleRow): number {
  const instant = zonedDateTimeToUtc(
    String(row.value.stck_bsop_date),
    String(row.value.stck_cntg_hour),
    'Asia/Seoul',
  );
  if (!instant)
    throw /* @diagnosticSurface internal: Fixed provider categories handled by candle HTTP, stream supervision or ingestion summaries. */ new KoscomError(
      'KOSCOM_INVALID_TIME',
    );
  return instant.getTime();
}

/** The same raw shape the runtime 1m path hands to the KIS normalizer. */
function oneMinuteRawRow(
  openTime: number,
  values: ReturnType<typeof ohlcv>,
  receivedAt: Date,
): KisRawCandleRow {
  const stamp = formatZonedCursor(new Date(openTime), 'Asia/Seoul');
  return {
    value: {
      stck_bsop_date: stamp.date,
      stck_cntg_hour: stamp.time,
      stck_oprc: values.open,
      stck_hgpr: values.high,
      stck_lwpr: values.low,
      stck_prpr: values.close,
      cntg_vol: values.volume,
      cntg_tr_pbmn: values.amount,
    },
    receivedAt,
    sequence: 0,
  };
}
